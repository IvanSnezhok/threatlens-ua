import { Counter, Histogram, type Registry } from 'prom-client';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import {
  CLASSIFIER_VERSION, THREAT_EVENT_TITLES, significanceRejection, type LocationLexeme
} from '../domain/classifier.js';
import { THREAT_LABELS, resolveModelPlace } from '../domain/model-place.js';
import { THREAT_TIMINGS, expectedWindow, type ThreatTiming } from '../domain/threat-timing.js';
import { THREAT_TYPES, type ClassifiedMessage, type NormalizedMessage, type ThreatType } from '../types.js';
import { codexChat, type CodexChatRequest, type CodexChatResult } from './codex-client.js';
import { imageDataUrl, transcribeAudio } from './media-enrichment.js';
import { loadLocationContexts, renderContextsForPrompt } from './model-context.js';
import {
  deterministicVerdict, disagreementFields, loadShadowContext, type ShadowContextMessage
} from './shadow-classifier.js';

/**
 * Codex як ОСНОВНИЙ класифікатор повідомлень (міграція 049, `codex_settings.classifier_mode='codex'`).
 *
 * ================================================================================================
 * Що змінилося порівняно з тіньовим класифікатором
 * ================================================================================================
 *
 * `./shadow-classifier.ts` записує другу думку після того, як правила вирішили. Цей модуль ставить
 * модель ПЕРЕД рішенням: `./ingestion.ts` у режимі `codex` чекає на вердикт і будує з нього
 * класифікацію, з якої `ingestThreat` робить подію — з доказовістю ДЖЕРЕЛА, бо твердження лишається
 * твердженням джерела, а модель лише прочитала його (`classified_by='codex'`, не `origin='model'`).
 * Правила лишаються запасним шляхом: модель недоступна, повільна, поза бюджетом, невпевнена чи
 * відповіла непридатним — класифікують правила, і повідомлення не губиться. І правила лишаються
 * ЄДИНИМ джерелом відбоїв: модель може стверджувати й уточнювати, але не може оголосити, що загрози
 * більше немає (`./ingestion.ts` обробляє de-escalation до виклику моделі).
 *
 * Понад клас і локації модель відповідає на два питання, яких правила не ставлять:
 *
 *  - **Коли** загроза актуальна: зараз / протягом години / увечері / протягом доби / протягом двох
 *    діб (`src/domain/threat-timing.ts`). «МіГ-31К злетів» — протягом години; «увечері очікується
 *    масований удар» — увечері; «вибухи в місті» — зараз.
 *  - **Наскільки ймовірно**, що загроза реалізується для названих місць у цьому вікні (0..1).
 *
 * Обидва їдуть на подію, на карту, в бот і в архів класифікацій. Це рішення власника 18.08.2026 —
 * див. шапку міграції 049.
 *
 * ================================================================================================
 * Контекст для кожного запиту
 * ================================================================================================
 *
 * Модель бачить: поточний київський час, джерело (назва, рівень), попередні повідомлення того самого
 * каналу (як тіньовий класифікатор), підказку правил (клас і назви місць за каталогом — щоб модель
 * писала назви так, як їх читає каталог) і КОНТЕКСТИ ЛОКАЦІЙ (`./model-context.ts`): що повідомляли
 * про ці місця раніше, які були тривоги, що вирішувалося. Після вердикту сюди ж дописується новий
 * запис — для наступного повідомлення.
 *
 * ================================================================================================
 * Межі, які тримає конструкція, а не домовленість
 * ================================================================================================
 *
 *  - Модель називає місце, але ніколи не ідентифікатор: кожна назва проходить через
 *    `resolveModelPlace` над бойовим каталогом — не впізнав, дві кандидатури, вся Україна — назва
 *    відкидається (`src/domain/model-place.ts`).
 *  - Придушення (правила бачили загрозу, модель — ні) вимагає впевненості не нижче
 *    {@link SUPPRESSION_MIN_CONFIDENCE}: хибне «не загроза» коштує попередження, хибне «загроза» —
 *    зайвий рядок; асиметрія та сама, що й у ретроспективному гейті.
 *  - Нижче `CODEX_PRIMARY_MIN_CONFIDENCE` вердикт записується для звірки, а публікує класифікація
 *    правил.
 *  - Кожен виклик обмежений у часі (`CODEX_PRIMARY_TIMEOUT_MS`), за бюджетом на хвилину й за
 *    кількістю одночасних — повідомлення, яке чекає на модель, ще не на карті.
 */

export const CODEX_CLASSIFIER_VERSION = 'codex-primary-v1';
export const CODEX_CLASSIFIER_PROMPT_VERSION = 'codex-classifier-v1';

/** Придушення тверджень правил вимагає більше впевненості, ніж власне твердження. */
export const SUPPRESSION_MIN_CONFIDENCE = 0.7;

// ------------------------------------------------------------------------------------------------
// Метрики
// ------------------------------------------------------------------------------------------------

export type PrimaryOutcomeLabel =
  | 'classified' | 'suppressed' | 'fallback_disabled' | 'fallback_busy' | 'fallback_rate_limited'
  | 'fallback_timeout' | 'fallback_model_failed' | 'fallback_unparsable' | 'fallback_low_confidence'
  | 'fallback_no_locations' | 'fallback_empty';

export const codexPrimaryOutcomes = new Counter({
  name: 'threatlens_codex_classifier_outcomes_total',
  help: 'Primary Codex classification outcomes: classified, suppressed, or which fallback to the rules',
  labelNames: ['outcome'],
  registers: []
});

export const codexPrimaryDuration = new Histogram({
  name: 'threatlens_codex_classifier_duration_seconds',
  help: 'Wall-clock of one primary classification call, fallbacks included',
  buckets: [0.5, 1, 2, 4, 8, 12, 20, 40, 90],
  registers: []
});

export function registerCodexClassifierMetrics(registry: Registry): void {
  if (!registry.getSingleMetric('threatlens_codex_classifier_outcomes_total')) registry.registerMetric(codexPrimaryOutcomes);
  if (!registry.getSingleMetric('threatlens_codex_classifier_duration_seconds')) registry.registerMetric(codexPrimaryDuration);
}

// ------------------------------------------------------------------------------------------------
// Бюджети
// ------------------------------------------------------------------------------------------------

let minuteWindow: number[] = [];
let inFlight = 0;

function withinMinuteBudget(now: number): boolean {
  const limit = config.CODEX_PRIMARY_MAX_PER_MINUTE;
  minuteWindow = minuteWindow.filter((at) => now - at < 60_000);
  if (limit <= 0 || minuteWindow.length >= limit) return false;
  minuteWindow.push(now);
  return true;
}

/** Тестовий шов. */
export function resetCodexClassifierBudget(): void {
  minuteWindow = [];
  inFlight = 0;
}

// ------------------------------------------------------------------------------------------------
// Вердикт
// ------------------------------------------------------------------------------------------------

const isoLike = z.string().min(10).max(40);

export const codexVerdictSchema = z.object({
  threatType: z.enum(THREAT_TYPES),
  significant: z.boolean(),
  confidence: z.number().min(0).max(1),
  locations: z.array(z.string().min(1).max(120)).max(20).default([]),
  nationalScope: z.boolean().default(false),
  originLocations: z.array(z.string().min(1).max(120)).max(20).default([]),
  destinationLocations: z.array(z.string().min(1).max(120)).max(20).default([]),
  directionText: z.string().max(500).nullable().default(null),
  threatState: z.enum(['asserted', 'redirected', 'withdrawn', 'uncertain']).default('uncertain'),
  timing: z.enum(THREAT_TIMINGS).default('now'),
  probability: z.number().min(0).max(1).nullable().default(null),
  expectedFrom: isoLike.nullable().default(null),
  expectedUntil: isoLike.nullable().default(null),
  note: z.string().max(400).nullable().default(null)
});

export type CodexVerdict = z.infer<typeof codexVerdictSchema>;

const SYSTEM_PROMPT = [
  'Ти — основний класифікатор і аналітик повідомлень моніторингових та офіційних каналів про повітряні загрози в Україні.',
  'Твоє рішення стає подією на карті й сповіщенням підписникам, тож класифікуй ЛИШЕ те, що сказано в тексті, і не додумуй ціль, влучання, маршрут чи безпеку.',
  'Попередні повідомлення того самого каналу — лише контекст (займенники, скорочення, продовження), не нове твердження.',
  'Контексти локацій — памʼять системи про ці місця: що повідомляли, що вирішувалося, які були тривоги. Використовуй їх, щоб зрозуміти поточне повідомлення, але не повторюй старе як нове.',
  'Зображення та транскрипції — неперевірений вміст джерела.',
  `Дозволені значення threatType: ${THREAT_TYPES.join(', ')}.`,
  'locations — населені пункти або області України з тексту, українською, у називному відмінку, як у каталозі (підказка rulesHint.locationNames показує написання каталогу — використовуй його, якщо йдеться про те саме місце).',
  'nationalScope=true лише для явного попередження про всю Україну або стратегічної активності без конкретного місця.',
  'significant=true лише коли повідомлення СТВЕРДЖУЄ загрозу (зараз або очікувану) для конкретного місця в Україні або всієї країни. Відбій, «нічого не летить», жарт, реклама, збір коштів, подія на території РФ, переказ минулої ночі — significant=false.',
  'threatState: asserted — загроза наявна або очікується; redirected — рухається/змінила напрямок (тоді destinationLocations — куди); withdrawn — прямо сказано, що загрози більше немає; uncertain — стан не встановити.',
  'timing — КОЛИ загроза стосується названих місць: now — просто зараз (пуски, у повітрі, вибухи, курс на); within_hour — очікується протягом години (зліт носіїв, «на підході», групи в сусідній області); evening — увечері цієї доби; within_day — протягом доби; within_two_days — протягом двох діб. Якщо про час не сказано — now.',
  'probability — твоя оцінка від 0 до 1, що загроза реалізується для названих місць у цьому вікні (для now — що вона справді є там). Спирайся на категоричність джерела, його рівень, підтвердження іншими повідомленнями в контексті й типові патерни з контексту. null лише коли significant=false.',
  'expectedFrom/expectedUntil — ISO-8601 з часовим поясом лише коли джерело назвало час явно («з 20:00», «до ранку»); інакше null.',
  'note — одне речення українською, чому саме так (до 300 символів), без прогнозів цілей.',
  'originLocations/directionText заповнюй лише коли джерело прямо повідомляє рух звідки/куди.',
  'confidence — твоя впевненість у всій класифікації від 0 до 1.',
  'Поверни лише JSON: {"threatType": string, "significant": boolean, "confidence": number, "locations": string[], "nationalScope": boolean, "originLocations": string[], "destinationLocations": string[], "directionText": string|null, "threatState": "asserted"|"redirected"|"withdrawn"|"uncertain", "timing": "now"|"within_hour"|"evening"|"within_day"|"within_two_days", "probability": number|null, "expectedFrom": string|null, "expectedUntil": string|null, "note": string|null}.'
].join(' ');

const TEXT_LIMIT = 2000;

// ------------------------------------------------------------------------------------------------
// Вхід і вихід
// ------------------------------------------------------------------------------------------------

export interface CodexClassifyInput {
  message: NormalizedMessage;
  sourceMessageHint?: string;
  /** Що прочитали правила з цього ж повідомлення — підказка й запасний шлях. */
  rules: ClassifiedMessage;
  lexemes: LocationLexeme[];
  source?: { name: string; tier: string; official: boolean } | null;
}

export interface ModelAssessment {
  model: string;
  classifierVersion: string;
  confidence: number;
  timing: ThreatTiming;
  probability: number | null;
  expectedFrom: Date;
  expectedUntil: Date;
  note: string | null;
  /** Для запису в контекст і в архів: що саме сказала модель. */
  verdict: CodexVerdict;
}

export type CodexClassifyOutcome =
  | { status: 'classified'; classified: ClassifiedMessage; assessment: ModelAssessment; contextLocationIds: string[] }
  /** Модель упевнено каже «не загроза» там, де правила бачили загрозу, або навпаки нічого не знайшла. */
  | { status: 'suppressed'; classified: ClassifiedMessage; assessment: ModelAssessment; contextLocationIds: string[] }
  | { status: 'fallback'; reason: Exclude<PrimaryOutcomeLabel, 'classified' | 'suppressed'>; contextLocationIds: string[] };

export interface CodexClassifyOptions {
  chat?: (request: CodexChatRequest) => Promise<CodexChatResult>;
  now?: () => Date;
  loadPrevious?: (message: NormalizedMessage, sourceMessageId?: string) => Promise<ShadowContextMessage[]>;
  loadContexts?: typeof loadLocationContexts;
  transcribe?: typeof transcribeAudio;
  /** Заявлений режим — викликач уже прочитав `classifier_mode`; тут лише для тестів. */
  enabled?: boolean;
}

let classifierDefaults: CodexClassifyOptions = {};

/** Тестовий шов для шляху, який будить `ingestion.ts` без параметрів. */
export function setCodexClassifierDefaults(options: CodexClassifyOptions): void {
  classifierDefaults = options;
}

export function resetCodexClassifier(): void {
  classifierDefaults = {};
  resetCodexClassifierBudget();
}

/** Області над переданими локаціями (і самі області, якщо передано їх) — для контексту. */
async function oblastAncestors(locationIds: readonly string[]): Promise<string[]> {
  if (!locationIds.length) return [];
  const result = await pool.query<{ id: string }>(
    `WITH RECURSIVE climb(id, parent_id, type, depth) AS (
       SELECT l.id, l.parent_id, l.type, 0 FROM locations l WHERE l.id = ANY($1::text[])
       UNION ALL
       SELECT p.id, p.parent_id, p.type, c.depth + 1 FROM climb c JOIN locations p ON p.id = c.parent_id
        WHERE c.type NOT IN ('oblast','special_city','country') AND c.depth < 8
     )
     SELECT DISTINCT id FROM climb WHERE type IN ('oblast','special_city')`,
    [[...locationIds]]
  ).catch(() => ({ rows: [] as Array<{ id: string }> }));
  return result.rows.map((row) => row.id);
}

/** Локації для контексту запиту: найконкретніші (з правил) → їхні області → країна. */
export async function contextLocationIdsFor(rules: ClassifiedMessage): Promise<string[]> {
  const specific = rules.locations.map((location) => location.id);
  const oblasts = await oblastAncestors(specific);
  const ordered: string[] = [];
  for (const id of [...specific, ...oblasts, 'ua']) if (!ordered.includes(id)) ordered.push(id);
  return ordered;
}

function kyivNow(at: Date): string {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: config.APP_TIMEZONE, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(at);
}

function parseIso(value: string | null): Date | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Класифікація з вердикту: клас, стан і час — від моделі; географія — через каталог; заголовок і
 * зведення — тими самими словами, що й у правил.
 */
export function classificationFromVerdict(
  verdict: CodexVerdict, rules: ClassifiedMessage, lexemes: LocationLexeme[], sourceText: string
): { classified: ClassifiedMessage; resolvedLocations: number } {
  const redirected = verdict.threatState === 'redirected';
  const names = redirected && verdict.destinationLocations.length ? verdict.destinationLocations : verdict.locations;
  const resolved = new Map<string, { id: string; name: string }>();
  if (verdict.threatType !== 'unknown') {
    for (const name of names) {
      const place = resolveModelPlace(name, verdict.threatType, lexemes);
      if (place) resolved.set(place.id, place);
    }
  }
  // Каталог не прочитав жодної назви моделі, а правила місце бачили — географія правил, клас моделі.
  const locations = resolved.size
    ? [...resolved.values()].map((place) => ({
        ...place, relationType: redirected ? 'reported_direction' as const : 'explicit_threat' as const
      }))
    : rules.locations.map((location) => ({ id: location.id, name: location.name, relationType: location.relationType }));
  const threatType = verdict.threatType;
  const label = threatType === 'unknown' ? 'загрози' : THREAT_LABELS[threatType];
  const placeNames = verdict.nationalScope ? 'вся Україна' : locations.map((location) => location.name).join(', ');
  const excerpt = sourceText.replace(/\s+/gu, ' ').trim().slice(0, 500);
  const classified: ClassifiedMessage = {
    intent: 'threat',
    threatType,
    signalThreatTypes: threatType === 'unknown' ? ['unknown'] : [threatType],
    locations,
    nationalScope: verdict.nationalScope && !locations.length,
    // Перший індикатор стає `risk_signals.signal_type`; правила дають свої, модель — власну мітку.
    indicators: ['model_classified', ...rules.indicators.filter((name) => name !== 'model_classified')],
    directionText: verdict.directionText ?? rules.directionText,
    originZone: rules.originZone ?? null,
    title: THREAT_EVENT_TITLES[threatType],
    summary: excerpt || `Загроза ${label} для ${placeNames}.`
  };
  return { classified, resolvedLocations: resolved.size };
}

function notSignificant(rules: ClassifiedMessage, sourceText: string): ClassifiedMessage {
  return {
    intent: 'none',
    threatType: 'unknown',
    signalThreatTypes: [],
    locations: [],
    nationalScope: false,
    indicators: ['model_classified'],
    originZone: rules.originZone ?? null,
    title: THREAT_EVENT_TITLES.unknown,
    summary: sourceText.replace(/\s+/gu, ' ').trim().slice(0, 500)
  };
}

async function recordComparison(
  input: CodexClassifyInput, sourceMessageId: string | null, verdict: CodexVerdict, model: string, contextIds: string[]
): Promise<void> {
  if (!sourceMessageId) return;
  const rules = deterministicVerdict(input.rules);
  const fields = disagreementFields(rules, verdict);
  await pool.query(
    `INSERT INTO shadow_classifications(
       source_message_id, classifier_version, published_at,
       deterministic_threat_type, deterministic_locations, deterministic_significant,
       model, model_threat_type, model_locations, model_significant, model_confidence,
       agrees, disagreement_fields, message_text, model_analysis, context_message_ids, media_kinds)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (source_message_id, classifier_version) DO NOTHING`,
    [
      sourceMessageId, CLASSIFIER_VERSION, input.message.publishedAt,
      rules.threatType, rules.locationNames, rules.significant,
      model, verdict.threatType, verdict.locations, verdict.significant, verdict.confidence,
      fields.length === 0, fields, input.message.text.slice(0, TEXT_LIMIT),
      JSON.stringify({ ...verdict, primary: true, contextLocationIds: contextIds }), [],
      (input.message.media ?? []).map((item) => item.kind)
    ]
  ).catch(() => undefined);
}

/**
 * Один вердикт моделі для одного повідомлення — або запасний шлях. Ніколи не кидає.
 *
 * `sourceMessageId` потрібен лише для рядка звірки; ingestion викликає це ДО запису повідомлення
 * (повідомлення пишеться разом із подією в одній транзакції), тому звірка записується пізніше через
 * {@link recordPrimaryComparison}.
 */
export async function classifyWithCodex(
  input: CodexClassifyInput, options: CodexClassifyOptions = classifierDefaults
): Promise<CodexClassifyOutcome> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const finish = (outcome: CodexClassifyOutcome): CodexClassifyOutcome => {
    codexPrimaryDuration.observe((now().getTime() - startedAt.getTime()) / 1000);
    codexPrimaryOutcomes.inc({ outcome: outcome.status === 'fallback' ? outcome.reason : outcome.status });
    return outcome;
  };
  const contextLocationIds = await contextLocationIdsFor(input.rules).catch(() => ['ua']);
  const fallback = (reason: Exclude<PrimaryOutcomeLabel, 'classified' | 'suppressed'>): CodexClassifyOutcome =>
    finish({ status: 'fallback', reason, contextLocationIds });

  if (options.enabled === false) return fallback('fallback_disabled');
  const text = input.message.text.trim();
  if (!text && !input.message.media?.length) return fallback('fallback_empty');
  if (inFlight >= config.CODEX_PRIMARY_MAX_CONCURRENT) return fallback('fallback_busy');
  if (!withinMinuteBudget(startedAt.getTime())) return fallback('fallback_rate_limited');

  inFlight += 1;
  try {
    const [previous, contexts] = await Promise.all([
      (options.loadPrevious ?? ((message: NormalizedMessage) => loadShadowContext({
        sourceMessageId: '00000000-0000-0000-0000-000000000000', sourceId: message.sourceId,
        publishedAt: message.publishedAt, text: message.text, classified: input.rules
      })))(input.message).catch(() => [] as ShadowContextMessage[]),
      (options.loadContexts ?? loadLocationContexts)(contextLocationIds).catch(() => [])
    ]);
    const transcribe = options.transcribe ?? transcribeAudio;
    const transcripts: string[] = [];
    for (const media of input.message.media ?? []) {
      if (media.kind !== 'audio') continue;
      const result = await transcribe(media).catch(() => ({ ok: false as const }));
      if (result.ok && result.text) transcripts.push(result.text);
    }
    const images = (input.message.media ?? [])
      .map(imageDataUrl).filter((dataUrl): dataUrl is string => Boolean(dataUrl))
      .slice(0, 2).map((dataUrl) => ({ dataUrl, detail: 'high' as const }));
    if (!text && !transcripts.length && !images.length) return fallback('fallback_empty');

    const rulesHint = {
      intent: input.rules.intent,
      threatType: input.rules.threatType,
      locationNames: input.rules.locations.map((location) => location.name),
      nationalScope: input.rules.nationalScope,
      directionText: input.rules.directionText ?? null
    };
    const facts = {
      now: kyivNow(startedAt),
      source: input.source ?? { name: input.message.sourceId, tier: 'C', official: false },
      previousMessages: previous.map((item) => ({ at: item.publishedAt.toISOString(), text: item.text })),
      currentMessage: text.slice(0, TEXT_LIMIT),
      audioTranscripts: transcripts,
      rulesHint
    };
    const contextBlock = renderContextsForPrompt(contexts);
    const user = (contextBlock ? `## Контексти локацій\n${contextBlock}\n\n` : '')
      + `## Повідомлення для класифікації\n${JSON.stringify(facts)}`;

    const chat = options.chat ?? ((request: CodexChatRequest) => codexChat(request));
    const result = await chat({
      promptVersion: CODEX_CLASSIFIER_PROMPT_VERSION,
      surface: 'classifier',
      classifierVersion: CODEX_CLASSIFIER_VERSION,
      system: SYSTEM_PROMPT,
      user,
      images,
      json: true,
      timeoutMs: config.CODEX_PRIMARY_TIMEOUT_MS,
      auditInput: {
        ...facts, contextLocationIds,
        contextTokens: contexts.reduce((sum, context) => sum + context.tokens, 0),
        mediaKinds: (input.message.media ?? []).map((item) => item.kind)
      }
    }).catch((error: unknown): CodexChatResult => ({
      ok: false, reason: 'transport_error', detail: String(error).slice(0, 200), model: null, durationMs: 0
    }));
    if (!result.ok) {
      return fallback(/abort|timeout/i.test(result.detail) ? 'fallback_timeout' : 'fallback_model_failed');
    }
    let verdict: CodexVerdict;
    try {
      verdict = codexVerdictSchema.parse(JSON.parse(result.content) as unknown);
    } catch {
      return fallback('fallback_unparsable');
    }
    // Звірка з правилами пишеться тим, хто знає id повідомлення (ingestion), — див. нижче; тут лише
    // повертаємо все, що для неї треба, через `assessment.verdict`.
    const windowBase = expectedWindow(verdict.timing, input.message.publishedAt, config.APP_TIMEZONE, {
      from: parseIso(verdict.expectedFrom), until: parseIso(verdict.expectedUntil)
    });
    const assessment: ModelAssessment = {
      model: result.model,
      classifierVersion: CODEX_CLASSIFIER_VERSION,
      confidence: verdict.confidence,
      timing: verdict.timing,
      probability: verdict.significant ? verdict.probability : null,
      expectedFrom: windowBase.from,
      expectedUntil: windowBase.until,
      note: verdict.note?.trim() || null,
      verdict
    };
    if (verdict.confidence < config.CODEX_PRIMARY_MIN_CONFIDENCE) return fallback('fallback_low_confidence');

    const rulesSignificant = significanceRejection(input.rules) === null;
    const asserting = verdict.significant && verdict.threatType !== 'unknown'
      && (verdict.threatState === 'asserted' || verdict.threatState === 'redirected');
    if (!asserting) {
      // «Не загроза» проти правил, що бачили загрозу, — придушення; воно вимагає більшої впевненості.
      if (rulesSignificant && verdict.confidence < SUPPRESSION_MIN_CONFIDENCE) return fallback('fallback_low_confidence');
      return finish({ status: 'suppressed', classified: notSignificant(input.rules, text), assessment, contextLocationIds });
    }
    const built = classificationFromVerdict(verdict, input.rules, input.lexemes, text);
    if (!built.classified.locations.length && !built.classified.nationalScope) {
      // Модель стверджує загрозу, але ні її назви, ні правила не дали місця: правила скажуть
      // `no_location` самі, а вердикт лишиться у звірці.
      return fallback('fallback_no_locations');
    }
    return finish({ status: 'classified', classified: built.classified, assessment, contextLocationIds });
  } catch {
    return fallback('fallback_model_failed');
  } finally {
    inFlight = Math.max(0, inFlight - 1);
  }
}

/** Рядок звірки «правила проти моделі», коли повідомлення вже записане і має id. */
export async function recordPrimaryComparison(
  input: CodexClassifyInput, sourceMessageId: string, assessment: ModelAssessment, contextLocationIds: string[]
): Promise<void> {
  await recordComparison(input, sourceMessageId, assessment.verdict, assessment.model, contextLocationIds);
}

/** Запис у контекст локацій про вердикт — для наступного повідомлення про ці місця. */
export function contextLineForVerdict(
  source: { name: string } | null | undefined, sourceId: string, text: string, assessment: ModelAssessment | null,
  rules: ClassifiedMessage, decision: string, excerpt: (text: string) => string
): string {
  const who = source?.name ?? sourceId;
  const rulesPart = `правила: ${rules.intent}/${rules.threatType}${rules.locations.length ? ` (${rules.locations.map((location) => location.name).join(', ')})` : ''}`;
  const modelPart = assessment
    ? ` · модель: ${assessment.verdict.threatType}/${assessment.verdict.threatState}, ${assessment.timing}${
      assessment.probability !== null ? `, p=${assessment.probability.toFixed(2)}` : ''}, впевненість ${assessment.confidence.toFixed(2)}${
      assessment.verdict.locations.length ? ` (${assessment.verdict.locations.join(', ')})` : ''}${assessment.note ? ` — ${assessment.note}` : ''}`
    : '';
  return `${who}: «${excerpt(text)}» → ${decision}; ${rulesPart}${modelPart}`;
}

/** Експорт для консолі й тестів: клас → підпис, як у промоції. */
export { THREAT_LABELS };
export type { ThreatType };
