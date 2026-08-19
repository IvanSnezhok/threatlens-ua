import { Counter, type Registry } from 'prom-client';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { estimateTokens, trimToTokens } from '../domain/token-estimate.js';
import { codexChat, type CodexChatRequest, type CodexChatResult } from './codex-client.js';
import { eventHub, type SystemEvent } from './sse.js';

/**
 * Контекст по локації для кожного запиту до моделі.
 *
 * ================================================================================================
 * Що це
 * ================================================================================================
 *
 * Один хронологічний текст на локацію — область, район, місто або «ua» для національного масштабу:
 * що повідомляли про це місце, що вирішили правила й модель, коли починалися і закінчувалися
 * офіційні тривоги. Він їде у кожен запит моделі, що стосується цієї локації — класифікація
 * повідомлення (`./codex-classifier.ts`), оцінка ризику (`./risk.ts`) — у межах бюджету токенів на
 * запит, найконкретніше місце першим, потім область, потім країна, усередині кожного — найсвіжіше.
 *
 * Це рішення власника (18.08.2026): модель має знати історію місця, а не читати кожне повідомлення з
 * нуля. Стеля — сто тисяч токенів на локацію; за нею контекст стискає сама модель: «стиснути,
 * неактуальне відкинути». Розмір оцінюється без токенізатора (`src/domain/token-estimate.ts`),
 * свідомо з запасом, тож стискання настає раніше стелі, а не пізніше.
 *
 * ================================================================================================
 * Форма: append-only текст, стискання — заміна префікса
 * ================================================================================================
 *
 * Кожен запис — один рядок із часовою міткою, що ДОПИСУЄТЬСЯ в кінець. Це дає дві речі: запис з
 * будь-якого шляху (класифікація, тривоги, вердикти) — один UPDATE без читання, і безпечне стискання
 * під конкурентними записами: стискання бере знімок тексту, просить модель стиснути знімок, а потім
 * пише «стислий знімок + усе, що дописали після знімка». Втратити запис неможливо; подвоїти — теж,
 * бо хвіст рахується від довжини знімка над тим самим append-only рядком.
 *
 * Якщо модель стиснути не змогла (немає сесії, збій, таймаут), контекст РІЖЕТЬСЯ детерміновано до
 * стелі — найстаріші рядки геть. Контекст ніколи не росте без межі, хоч би що сталося з моделлю.
 *
 * ================================================================================================
 * Чого тут немає
 * ================================================================================================
 *
 * Жодного публічного читача. Контекст читає лише модель; він не йде ні в API, ні на карту, ні в
 * бот. І жодного права: це памʼять для запиту, а не рішення. Рішення ухвалюють ті, хто цей контекст
 * читає, і кожне з них має власні межі.
 */

// ------------------------------------------------------------------------------------------------
// Метрики
// ------------------------------------------------------------------------------------------------

export const modelContextOps = new Counter({
  name: 'threatlens_model_context_operations_total',
  help: 'Per-location model context operations by kind: append, compacted, trimmed, compaction_failed, pruned',
  labelNames: ['kind'],
  registers: []
});

export function registerModelContextMetrics(registry: Registry): void {
  if (!registry.getSingleMetric('threatlens_model_context_operations_total')) registry.registerMetric(modelContextOps);
}

// ------------------------------------------------------------------------------------------------
// Записи
// ------------------------------------------------------------------------------------------------

function stamp(at: Date, timezone = config.APP_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(at);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`;
}

/** Один рядок контексту: без переносів, з міткою часу за Києвом, обмеженої довжини. */
export function contextLine(at: Date, text: string, maxChars = config.MODEL_CONTEXT_ENTRY_CHARS + 160): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return `[${stamp(at)}] ${flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat}`;
}

/** Уривок повідомлення джерела для запису: один рядок, до `MODEL_CONTEXT_ENTRY_CHARS` символів. */
export function contextExcerpt(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > config.MODEL_CONTEXT_ENTRY_CHARS ? `${flat.slice(0, config.MODEL_CONTEXT_ENTRY_CHARS)}…` : flat;
}

/**
 * Дописує один рядок у контекст кожної з локацій. Один UPSERT на локацію, без читання. Локації, що не
 * існують у каталозі, пропускаються FK-ом — `ON CONFLICT` їх не рятує, тож рядок пишеться через
 * `INSERT … SELECT … WHERE EXISTS`.
 */
export async function appendLocationContext(locationIds: readonly string[], line: string): Promise<void> {
  if (!config.MODEL_CONTEXT_ENABLED || !line.trim()) return;
  const ids = [...new Set(locationIds.filter(Boolean))];
  if (!ids.length) return;
  const tokens = estimateTokens(line) + 1;
  const result = await pool.query<{ location_id: string; estimated_tokens: number }>(
    `INSERT INTO model_location_contexts(location_id, content, estimated_tokens, entries, updated_at)
     SELECT l.id, $2, $3, 1, now() FROM locations l WHERE l.id = ANY($1::text[])
     ON CONFLICT (location_id) DO UPDATE SET
       content = CASE WHEN model_location_contexts.content = '' THEN EXCLUDED.content
                      ELSE model_location_contexts.content || E'\\n' || EXCLUDED.content END,
       estimated_tokens = model_location_contexts.estimated_tokens + EXCLUDED.estimated_tokens,
       entries = model_location_contexts.entries + 1,
       updated_at = now()
     RETURNING location_id, estimated_tokens`,
    [ids, line, tokens]
  ).catch(() => ({ rows: [] as Array<{ location_id: string; estimated_tokens: number }> }));
  modelContextOps.inc({ kind: 'append' }, result.rows.length || 1);
  for (const row of result.rows) {
    if (row.estimated_tokens > config.MODEL_CONTEXT_MAX_TOKENS) scheduleCompaction(row.location_id);
  }
}

// ------------------------------------------------------------------------------------------------
// Читання в запит
// ------------------------------------------------------------------------------------------------

export interface LoadedLocationContext {
  locationId: string;
  name: string;
  /** Текст у межах виділеної частки бюджету — хвіст (найсвіжіше), якщо довелося різати. */
  text: string;
  tokens: number;
  truncated: boolean;
}

/**
 * Контексти для запиту, у порядку переданих ідентифікаторів (викликач ставить найконкретніше
 * першим), у межах спільного бюджету токенів. Порожні й відсутні рядки не повертаються.
 */
export async function loadLocationContexts(
  locationIds: readonly string[], budgetTokens = config.MODEL_CONTEXT_REQUEST_TOKENS
): Promise<LoadedLocationContext[]> {
  if (!config.MODEL_CONTEXT_ENABLED) return [];
  const ids = [...new Set(locationIds.filter(Boolean))];
  if (!ids.length) return [];
  const result = await pool.query<{ location_id: string; name: string; content: string; estimated_tokens: number }>(
    `SELECT c.location_id, l.name_uk AS name, c.content, c.estimated_tokens
       FROM model_location_contexts c JOIN locations l ON l.id = c.location_id
      WHERE c.location_id = ANY($1::text[]) AND c.content <> ''`,
    [ids]
  ).catch(() => ({ rows: [] as Array<{ location_id: string; name: string; content: string; estimated_tokens: number }> }));
  const byId = new Map(result.rows.map((row) => [row.location_id, row]));
  const out: LoadedLocationContext[] = [];
  let remaining = Math.max(0, budgetTokens);
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || remaining <= 0) continue;
    const wanted = Math.max(row.estimated_tokens, estimateTokens(row.content));
    const allowed = Math.min(wanted, remaining);
    const text = wanted > allowed ? trimToTokens(row.content, allowed) : row.content;
    const tokens = estimateTokens(text);
    out.push({ locationId: id, name: row.name, text, tokens, truncated: wanted > allowed });
    remaining -= tokens;
  }
  return out;
}

/** Готовий блок для промту: заголовок на локацію, текст як є. Порожній масив — порожній рядок. */
export function renderContextsForPrompt(contexts: readonly LoadedLocationContext[]): string {
  if (!contexts.length) return '';
  return contexts.map((context) =>
    `### Контекст: ${context.name} (${context.locationId})${context.truncated ? ' — показано лише найсвіжіше' : ''}\n${context.text}`
  ).join('\n\n');
}

// ------------------------------------------------------------------------------------------------
// Стискання
// ------------------------------------------------------------------------------------------------

export const CONTEXT_COMPACTION_PROMPT_VERSION = 'context-compaction-v1';

const COMPACTION_SYSTEM_PROMPT = [
  'Ти ведеш робочий контекст аналітика повітряних загроз по одній локації в Україні.',
  'Тобі дано хронологічний журнал записів про цю локацію: повідомлення джерел, рішення класифікатора,',
  'офіційні тривоги та їх відбої. Журнал переріс стелю. Стисни його, зберігши все, що допоможе',
  'правильно оцінити НАСТУПНІ повідомлення про цю локацію:',
  '— останні 48 годин лиши детально, хронологічно, з мітками часу;',
  '— старіше згорни в стислі підсумки по добах: скільки атак, якими засобами, у які години, з яких напрямків;',
  '— збережи стійкі патерни (типові години початку, напрямки підльоту, класи зброї, частоту, джерела, що повідомляють першими);',
  '— викинь неактуальне: дублікати, відбої давно минулих тривог, службові повідомлення, усе, що не впливає на оцінку;',
  '— не вигадуй нічого, чого немає в журналі; не додавай прогнозів.',
  'Поверни лише стислий текст журналу, українською, без вступу й пояснень. Формат записів збережи: [YYYY-MM-DD HH:MM] текст.'
].join(' ');

const pendingCompactions = new Set<string>();
let compacting = false;

export interface CompactionDeps {
  chat?: (request: CodexChatRequest) => Promise<CodexChatResult>;
  now?: () => Date;
}

let compactionDefaults: CompactionDeps = {};

/** Тестовий шов: заглушка моделі для стискання, яке будить `appendLocationContext`. */
export function setModelContextDefaults(deps: CompactionDeps): void {
  compactionDefaults = deps;
}

export function scheduleCompaction(locationId: string): void {
  pendingCompactions.add(locationId);
  void drainCompactions();
}

async function drainCompactions(): Promise<void> {
  if (compacting) return;
  compacting = true;
  try {
    for (;;) {
      const next = pendingCompactions.values().next();
      if (next.done) break;
      pendingCompactions.delete(next.value);
      await compactLocationContext(next.value, compactionDefaults).catch(() => undefined);
    }
  } finally {
    compacting = false;
  }
}

export type CompactionOutcome = 'compacted' | 'trimmed' | 'skipped' | 'not_needed';

/**
 * Стискає контекст однієї локації моделлю, або ріже детерміновано, якщо модель не відповіла.
 *
 * Заявка — `compacting_since`: дві стискалки однієї локації не йдуть паралельно, а покинута заявка
 * (процес упав посеред) звільняється за тридцять хвилин.
 */
export async function compactLocationContext(locationId: string, deps: CompactionDeps = {}): Promise<CompactionOutcome> {
  const claimed = await pool.query<{ content: string; estimated_tokens: number }>(
    `UPDATE model_location_contexts SET compacting_since = now()
      WHERE location_id = $1 AND estimated_tokens > $2
        AND (compacting_since IS NULL OR compacting_since < now() - interval '30 minutes')
      RETURNING content, estimated_tokens`,
    [locationId, config.MODEL_CONTEXT_MAX_TOKENS]
  );
  const snapshot = claimed.rows[0];
  if (!snapshot) return 'not_needed';
  const release = async () => pool.query(
    `UPDATE model_location_contexts SET compacting_since = NULL WHERE location_id = $1`, [locationId]
  ).catch(() => undefined);

  try {
    const chat = deps.chat ?? ((request: CodexChatRequest) => codexChat(request));
    const target = config.MODEL_CONTEXT_COMPACT_TO_TOKENS;
    const result = await chat({
      promptVersion: CONTEXT_COMPACTION_PROMPT_VERSION,
      surface: 'context_compaction',
      system: `${COMPACTION_SYSTEM_PROMPT} Цільовий обсяг — приблизно ${target} токенів або менше.`,
      user: snapshot.content,
      json: false,
      timeoutMs: config.MODEL_CONTEXT_COMPACTION_TIMEOUT_MS > 0 ? config.MODEL_CONTEXT_COMPACTION_TIMEOUT_MS : null,
      auditInput: { locationId, estimatedTokens: snapshot.estimated_tokens, targetTokens: target, chars: snapshot.content.length }
    }).catch((error: unknown): CodexChatResult => ({
      ok: false, reason: 'transport_error', detail: String(error).slice(0, 200), model: null, durationMs: 0
    }));

    let compacted: string | null = null;
    if (result.ok && result.content.trim()) {
      compacted = result.content.trim();
      // Модель могла не вкластися: різати детерміновано до стелі — гірше, ніж стислий текст, але
      // краще, ніж контекст понад стелю.
      if (estimateTokens(compacted) > config.MODEL_CONTEXT_MAX_TOKENS) compacted = trimToTokens(compacted, target);
    }
    const outcome: CompactionOutcome = compacted ? 'compacted' : 'trimmed';
    const head = compacted ?? trimToTokens(snapshot.content, target);

    // Хвіст — усе, що дописали ПІСЛЯ знімка: текст append-only, тож це рівно те, що стоїть за
    // довжиною знімка в поточному рядку. Довжина — у кодових точках, як рахує Postgres `length()`:
    // JS-`length` рахує сурогатні пари емодзі двічі, і зсув на кожен емодзі в журналі різав би хвіст
    // посеред символу.
    const snapshotChars = Array.from(snapshot.content).length;
    await pool.query(
      `UPDATE model_location_contexts SET
         content = $2 || CASE WHEN length(content) > $3 THEN substr(content, $3 + 1) ELSE '' END,
         estimated_tokens = $4 + GREATEST(0, estimated_tokens - $5),
         compactions = compactions + CASE WHEN $6::boolean THEN 1 ELSE 0 END,
         compacted_at = CASE WHEN $6::boolean THEN now() ELSE compacted_at END,
         compacting_since = NULL, updated_at = now()
       WHERE location_id = $1`,
      [locationId, head, snapshotChars, estimateTokens(head), snapshot.estimated_tokens, outcome === 'compacted']
    );
    // Перерахунок без накопиченої похибки: після заміни оцінка рахується від самого тексту.
    await pool.query(
      `UPDATE model_location_contexts SET estimated_tokens = $2 WHERE location_id = $1`,
      [locationId, await recountTokens(locationId)]
    ).catch(() => undefined);
    modelContextOps.inc({ kind: outcome });
    if (!compacted) modelContextOps.inc({ kind: 'compaction_failed' });
    return outcome;
  } catch {
    await release();
    modelContextOps.inc({ kind: 'compaction_failed' });
    return 'skipped';
  }
}

async function recountTokens(locationId: string): Promise<number> {
  const row = await pool.query<{ content: string }>(
    `SELECT content FROM model_location_contexts WHERE location_id = $1`, [locationId]
  );
  return estimateTokens(row.rows[0]?.content ?? '');
}

// ------------------------------------------------------------------------------------------------
// Тривоги й господарство
// ------------------------------------------------------------------------------------------------

export async function pruneLocationContexts(days = config.MODEL_CONTEXT_RETENTION_DAYS): Promise<number> {
  const result = await pool.query(
    `DELETE FROM model_location_contexts WHERE updated_at < now() - make_interval(days => $1::int)`, [days]
  );
  if (result.rowCount) modelContextOps.inc({ kind: 'pruned' }, result.rowCount);
  return result.rowCount ?? 0;
}

/**
 * Записує початок і кінець офіційної тривоги в контекст локації — з внутрішньої, незатримуваної
 * шини подій, тієї самої, яку слухає перерахунок аналітики. Назва локації читається один раз на подію.
 */
async function noteAlertEvent(event: SystemEvent): Promise<void> {
  const payload = event.payload as { locationId?: unknown } | null;
  const locationId = typeof payload?.locationId === 'string' ? payload.locationId : null;
  if (!locationId) return;
  const named = await pool.query<{ name_uk: string }>(`SELECT name_uk FROM locations WHERE id=$1`, [locationId])
    .catch(() => ({ rows: [] as Array<{ name_uk: string }> }));
  const name = named.rows[0]?.name_uk ?? locationId;
  const at = new Date(event.createdAt);
  const line = event.eventType === 'alert.started'
    ? contextLine(at, `ОФІЦІЙНА ТРИВОГА: початок — ${name}`)
    : contextLine(at, `ОФІЦІЙНА ТРИВОГА: відбій — ${name}`);
  await appendLocationContext([locationId], line);
}

const PRUNE_INTERVAL_MS = 6 * 3_600_000;

export function startModelContextScheduler(log: { info: Function; error: Function }): () => void {
  if (!config.MODEL_CONTEXT_ENABLED) return () => undefined;
  const handler = (event: SystemEvent) => {
    if (event.eventType !== 'alert.started' && event.eventType !== 'alert.ended') return;
    void noteAlertEvent(event).catch((error) => log.error({ error }, 'model context alert note failed'));
  };
  eventHub.on('internal-event', handler);
  const timer = setInterval(() => {
    void pruneLocationContexts()
      .then((pruned) => { if (pruned) log.info({ pruned }, 'model location contexts pruned'); })
      .catch((error) => log.error({ error }, 'model context prune failed'));
  }, PRUNE_INTERVAL_MS);
  timer.unref();
  return () => { eventHub.off('internal-event', handler); clearInterval(timer); };
}

/** Тестовий шов: скидає чергу стискань і залежності. */
export function resetModelContextWorker(): void {
  pendingCompactions.clear();
  compacting = false;
  compactionDefaults = {};
}

/** Стан для консолі: скільки рядків, найбільші контексти, коли востаннє стискали. */
export async function modelContextOverview(limit = 15): Promise<{
  rows: number; totalTokens: number;
  largest: Array<{ locationId: string; name: string; tokens: number; entries: number; compactions: number; compactedAt: string | null; updatedAt: string }>;
}> {
  const [totals, largest] = await Promise.all([
    pool.query<{ rows: string; tokens: string }>(
      `SELECT count(*)::text AS rows, COALESCE(sum(estimated_tokens),0)::text AS tokens FROM model_location_contexts`
    ),
    pool.query<{ location_id: string; name: string; estimated_tokens: number; entries: number; compactions: number; compacted_at: Date | null; updated_at: Date }>(
      `SELECT c.location_id, l.name_uk AS name, c.estimated_tokens, c.entries, c.compactions, c.compacted_at, c.updated_at
         FROM model_location_contexts c JOIN locations l ON l.id=c.location_id
        ORDER BY c.estimated_tokens DESC LIMIT $1`, [limit]
    )
  ]);
  return {
    rows: Number(totals.rows[0]?.rows ?? 0),
    totalTokens: Number(totals.rows[0]?.tokens ?? 0),
    largest: largest.rows.map((row) => ({
      locationId: row.location_id, name: row.name, tokens: row.estimated_tokens, entries: row.entries,
      compactions: row.compactions, compactedAt: row.compacted_at?.toISOString() ?? null, updatedAt: row.updated_at.toISOString()
    }))
  };
}
