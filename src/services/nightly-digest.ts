import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { attackStatsDigestLines } from '../domain/attack-stats-report.js';
import { groundedNumbers, ungroundedNumber } from './analytics-narrative.js';
import { attackStatsForDigest, regionsForLocations, type AttackStatsDigestEntry } from './attack-stats.js';
import { codexChat, type CodexClientDeps } from './codex-client.js';
import { codexFeatureEnabled } from './codex-settings.js';

interface DigestAssessment {
  chat_id: string;
  id: string;
  location_id: string;
  location_name: string;
  threat_type: string;
  risk_score: string;
  risk_level: string;
  indicative_percent: number | null;
  assessment_confidence: string;
  explanation: Record<string, unknown>;
  generated_at: Date;
  horizon_end: Date;
  /**
   * Скільки з врахованих сигналів цієї оцінки підняла модель, а не правила. Заповнює
   * {@link modelSignalCounts} після основного запиту; поле необовʼязкове саме тому, що воно
   * дописується згодом, і відсутнє значення означає «жодного», а не «невідомо» — оцінка без
   * жодного модельного сигналу не потрапляє у відповідь того запиту взагалі.
   */
  model_signals?: number;
}

function kyivParts(now: Date): { date: string; minutes: number; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  const hour = Number(value('hour')); const minute = Number(value('minute'));
  return { date: `${value('year')}-${value('month')}-${value('day')}`, minutes: hour * 60 + minute, time: `${value('hour')}:${value('minute')}` };
}

// ------------------------------------------------------------------------------------------------
// The optional one-sentence opener written by a model
// ------------------------------------------------------------------------------------------------
//
// Що читає людина о 23:20 — це список оцінок, який згенерував детермінований рушій ризику. Модель
// не пише жодного числа з цього списку; вона лише може додати один підсумковий рядок
// під переліком, який стисло каже, на що дивитися першим. Вимкнена — дайджест точно такий, яким був завжди.
//
// Чого цей коментар не казав, доки міг: модель не пише числа, але з увімкненим
// `analytical_threats_enabled` (migration 040) вона може ПІДНЯТИ сигнал, з якого це число зібрано —
// внесок 0.3 у `risk_signals` (src/repositories/events.ts). Для читача це різні речі: «індекс
// порахували з того, що повідомили джерела» і «частину індексу порахували з того, що припустила
// модель». Тому нижче рахується, скільки саме сигналів модельні, і це число їде в payload разом із
// готовим реченням про нього — див. {@link modelSignalCounts} і {@link modelSignalDisclosure}.

export interface DigestFacts {
  time: string;
  locations: Array<{
    locationName: string; threatType: string; level: string; indicativePercent: number | null;
    score: string;
    /** Скільки сигналів під цією оцінкою дала модель. 0 — коли жодного. */
    modelSignals: number;
  }>;
  omitted: number;
  /** Скільки модельних сигналів у всьому переліку. 0 — коли жодного. */
  modelSignals: number;
}

/** Рівно ті факти, які потрапляють у повідомлення. Модель не бачить нічого понад це. */
export function digestFacts(rows: DigestAssessment[], omitted: number, time: string): DigestFacts {
  return {
    time,
    locations: rows.map((row) => ({
      locationName: row.location_name,
      threatType: row.threat_type,
      level: row.risk_level,
      indicativePercent: row.indicative_percent,
      score: row.risk_score,
      modelSignals: row.model_signals ?? 0
    })),
    omitted,
    modelSignals: rows.reduce((sum, row) => sum + (row.model_signals ?? 0), 0)
  };
}

/**
 * Скільки з врахованих сигналів кожної оцінки підняла модель.
 *
 * Ознака модельного походження береться з `shadow_classifications.analytical_event_id`
 * (migrations/040_model_analytical_threats.sql:13-18), а не з `threat_events.origin`
 * (migrations/041_threat_event_origin.sql), і це не байдужий вибір. `origin` описує АВТОРСТВО ПОДІЇ
 * і навмисно не скидається, коли в модельну подію пізніше вливається повідомлення людини
 * (src/repositories/events.ts, гілка UPDATE). Через `origin` кожен такий людський сигнал
 * порахувався б як модельний — і дайджест сказав би читачеві, що припущенням є те, що насправді
 * повідомило джерело. Тут же питання інше: не «хто створив подію», а «хто підняв ЦЕЙ сигнал», а на
 * нього відповідає лише рядок тіньової класифікації того самого повідомлення: `analytical_event_id`
 * непорожній рівно тоді, коли вердикт моделі пройшов усі охоронці й став подією.
 *
 * Окремим запитом, а не скалярним підзапитом у переліку оцінок вище: той перелік — добуток підписок
 * на оцінки, і одна оцінка по Києву повторюється в ньому стільки разів, скільки людей підписано на
 * Київ. Підзапит рахував би те саме число тисячі разів; тут ідентифікатори спершу згорнуто в
 * множину, і рахунок робиться один раз на оцінку.
 *
 * Обидві сторони запиту йдуть по індексах, які вже є: `ANY($1::uuid[])` — по первинному ключу
 * `risk_assessment_signals(assessment_id,signal_id)` (migrations/001_init.sql:156-162), EXISTS — по
 * `shadow_classifications (source_message_id, classifier_version)`
 * (migrations/020_shadow_classifications.sql:58). Жодного нового індексу це не потребує; EXISTS
 * замість JOIN — щоб дві версії класифікатора над одним повідомленням не подвоїли лічильник.
 */
export async function modelSignalCounts(assessmentIds: string[]): Promise<Map<string, number>> {
  if (!assessmentIds.length) return new Map();
  const counts = await pool.query<{ assessment_id: string; model_signals: number }>(
    `SELECT ras.assessment_id::text AS assessment_id, count(*)::int AS model_signals
       FROM risk_assessment_signals ras
       JOIN risk_signals rs ON rs.id=ras.signal_id
      WHERE ras.assessment_id = ANY($1::uuid[])
        AND EXISTS (SELECT 1 FROM shadow_classifications sc
                     WHERE sc.source_message_id=rs.source_message_id
                       AND sc.analytical_event_id IS NOT NULL)
      GROUP BY 1`,
    [assessmentIds]
  );
  return new Map(counts.rows.map((row) => [row.assessment_id, row.model_signals]));
}

/**
 * Речення про модельний внесок — або нічого.
 *
 * Порогу тут немає навмисно: один модельний сигнал у переліку так само означає, що частину індексу
 * зібрано з припущення, як і десять. А от порожня згадка («модельних сигналів: 0») знецінює саме те
 * попередження, заради якого рядок існує, тому нуль дає `null`, і повідомлення лишається таким,
 * яким було завжди.
 *
 * Окремого перемикача цей рядок не має, і не має свідомо. Модельні сигнали взагалі існують лише
 * тоді, коли оператор увімкнув `analytical_threats_enabled` (migration 040, DEFAULT false), — тобто
 * за замовчуванням рахунок дорівнює нулю й ніхто нічого нового не бачить. Вимикач, який ховає
 * попередження, але лишає самі модельні сигнали в індексі, був би гіршим за його відсутність:
 * попередження, яке можна вимкнути окремо від того, про що воно попереджає, — це не попередження.
 */
export function modelSignalDisclosure(modelSignals: number): string | null {
  if (modelSignals <= 0) return null;
  return `Частину сигналів (${modelSignals}) дала модель — вони не підтверджені джерелом.`;
}

const DIGEST_SYSTEM_PROMPT = [
  'Ти пишеш ОДНЕ речення українською для нічного зведення системи повітряних загроз.',
  'Тобі надано готовий список оцінок. Твоє завдання — спокійно назвати, на що звернути увагу першим.',
  'Заборонено: вигадувати числа, назви місць чи типи загроз, яких немає у вхідному JSON.',
  'Заборонено: прогнозувати ціль, влучання, маршрут, час удару або безпеку конкретного місця.',
  'Заборонено: паніка, заклики, оклики, канцелярит. Тон — рівний і стриманий.',
  'Поверни лише JSON: {"summary": string} довжиною до 220 символів.'
].join(' ');

export interface DigestSummary {
  text: string | null;
  aiGenerated: boolean;
  /** Чому моделі не вийшло. null — коли вийшло або коли її й не питали. */
  rejectionReason: string | null;
}

const NO_SUMMARY: DigestSummary = { text: null, aiGenerated: false, rejectionReason: null };

export interface DigestSummaryDeps extends CodexClientDeps {
  /** Перевірка перемикача. Підмінюється в тестах, щоб не тягнути базу в юніт-тест. */
  featureEnabled?: () => Promise<boolean>;
}

/**
 * Один рядок від моделі — або нічого.
 *
 * Ніколи не кидає винятків і ніколи не затримує чергу назавжди: усе, що може піти не так, дає
 * `{ text: null }`, і дайджест іде в тому вигляді, у якому йшов би без моделі. Числа, які модель
 * написала, перевіряються тим самим механізмом, що й наратив аналітики: одне негрунтоване число
 * відкидає весь рядок, бо читач не має способу відрізнити вигадану цифру від справжньої.
 */
export async function digestSummary(facts: DigestFacts, deps: DigestSummaryDeps = {}): Promise<DigestSummary> {
  if (!facts.locations.length) return NO_SUMMARY;
  const enabled = await (deps.featureEnabled ?? (() => codexFeatureEnabled('digest')))();
  if (!enabled) return NO_SUMMARY;

  const result = await codexChat({
    promptVersion: 'nightly-digest-v1',
    surface: 'digest',
    system: DIGEST_SYSTEM_PROMPT,
    user: JSON.stringify(facts),
    json: true,
    auditInput: facts
  }, deps);
  if (!result.ok) return { text: null, aiGenerated: false, rejectionReason: result.reason };

  let summary: unknown;
  try {
    summary = (JSON.parse(result.content) as { summary?: unknown }).summary;
  } catch {
    return { text: null, aiGenerated: false, rejectionReason: 'unparsable_json' };
  }
  if (typeof summary !== 'string' || !summary.trim() || summary.length > 220) {
    return { text: null, aiGenerated: false, rejectionReason: 'unusable_summary' };
  }
  const invented = ungroundedNumber(summary, groundedNumbers(facts));
  if (invented) return { text: null, aiGenerated: false, rejectionReason: `ungrounded_number:${invented}` };
  return { text: summary.trim(), aiGenerated: true, rejectionReason: null };
}

// ------------------------------------------------------------------------------------------------
// Статистика ударів і ймовірності по регіонах підписника
// ------------------------------------------------------------------------------------------------
//
// Другий блок зведення, з міграції 048. Це НЕ оцінка ризику й не сигнал: це добовий продукт моделі —
// скільки днів із атаками було по області за період, який середній інтервал і яка звідси
// пуассонівська ймовірність на найближчі ночі, — зібраний з відкритих джерел і перерахований
// детерміновано (`src/domain/attack-stats-report.ts`). Він їде в тому самому повідомленні, що й
// оцінки, бо це той самий час і той самий читач; але власним блоком, з власним дисклеймером першим
// рядком, і після оцінок — оцінки лишаються тим, заради чого повідомлення надіслано.
//
// Чат отримує зведення, якщо в нього є АБО оцінки, АБО статистика по його регіонах: спокійний вечір
// без оцінок — це саме той вечір, коли підписник хоче почути, що каже базова частота. Для чату без
// жодного з двох нічого не змінилося — він і далі не отримує нічого.

export interface DigestAttackStats {
  regionId: string;
  regionName: string;
  reportId: string;
  generatedAt: string;
  model: string | null;
  verification: 'passed' | 'inconsistent' | 'rejected' | 'skipped';
  /** Готові рядки без HTML; форматувальник екранує сам. */
  lines: string[];
  disclaimer: string;
}

export function digestAttackStatsEntry(entry: AttackStatsDigestEntry): DigestAttackStats {
  return {
    regionId: entry.regionId,
    regionName: entry.regionName,
    reportId: entry.reportId,
    generatedAt: entry.finishedAt,
    model: entry.model,
    verification: entry.verification,
    lines: attackStatsDigestLines(entry.summary),
    disclaimer: entry.summary.disclaimer
  };
}

/**
 * Статистика по регіонах кожного чату, якому сьогодні ще не надсилали. Три запити на весь прогін, а не
 * на чат: підписки (обмежені їхньою кількістю й тим самим NOT EXISTS, що й перелік оцінок), область над
 * кожною підписаною локацією і найсвіжіший придатний звіт по кожній області. Порожня мапа — звичайний
 * стан інсталяції з вимкненим перемикачем, і коштує вона один запит.
 */
export async function digestAttackStats(digestDate: string): Promise<Map<string, DigestAttackStats[]>> {
  const subscriptions = await pool.query<{ chat_id: string; location_id: string }>(
    `SELECT s.chat_id::text, s.location_id
       FROM subscriptions s
       JOIN telegram_users u ON u.chat_id=s.chat_id AND u.enabled=true
      WHERE s.enabled=true AND s.notify_analytics=true
        AND NOT EXISTS (SELECT 1 FROM nightly_digest_runs r WHERE r.digest_date=$1 AND r.chat_id=s.chat_id)`,
    [digestDate]
  );
  if (!subscriptions.rows.length) return new Map();
  const regionOf = await regionsForLocations([...new Set(subscriptions.rows.map((row) => row.location_id))]);
  const entries = await attackStatsForDigest([...new Set(regionOf.values())]);
  if (!entries.size) return new Map();
  const byChat = new Map<string, Map<string, DigestAttackStats>>();
  for (const row of subscriptions.rows) {
    const regionId = regionOf.get(row.location_id);
    const entry = regionId ? entries.get(regionId) : undefined;
    if (!entry) continue;
    const regions = byChat.get(row.chat_id) ?? new Map<string, DigestAttackStats>();
    if (!regions.has(entry.regionId)) regions.set(entry.regionId, digestAttackStatsEntry(entry));
    byChat.set(row.chat_id, regions);
  }
  return new Map([...byChat].map(([chatId, regions]) => [
    chatId, [...regions.values()].sort((a, b) => a.regionName.localeCompare(b.regionName, 'uk'))
  ]));
}

export async function enqueueNightlyDigests(now = new Date()): Promise<number> {
  const current = kyivParts(now);
  const [targetHour, targetMinute] = config.NIGHTLY_DIGEST_TIME.split(':').map(Number);
  if (current.minutes < targetHour! * 60 + targetMinute!) return 0;

  // NOT EXISTS нижче — не оптимізація читабельності, а межа памʼяті: планувальник будить цю функцію
  // щопівхвилини аж до опівночі, і без фільтра кожен тик після першого успішного прогону
  // матеріалізував би повний добуток підписки × чинні оцінки (аж до 10⁵–10⁶ рядків із JSONB
  // `explanation` у кожному) лише для того, щоб цикл нижче їх пропустив.
  const assessments = await pool.query<DigestAssessment>(
    `SELECT DISTINCT s.chat_id::text,a.id,a.location_id,l.name_uk AS location_name,a.threat_type,
            a.risk_score,a.risk_level,a.indicative_percent,a.assessment_confidence,a.explanation,
            a.generated_at,a.horizon_end
     FROM subscriptions s
     JOIN telegram_users u ON u.chat_id=s.chat_id AND u.enabled=true
     JOIN locations l ON l.id=s.location_id
     JOIN risk_assessments a ON a.location_id=s.location_id AND a.published=true
       AND a.superseded_by IS NULL AND a.expires_at>now()
       AND (s.threat_type='*' OR s.threat_type=a.threat_type)
     WHERE s.enabled=true AND s.notify_analytics=true
       AND NOT EXISTS (SELECT 1 FROM nightly_digest_runs r
                        WHERE r.digest_date=$1 AND r.chat_id=s.chat_id)
     ORDER BY s.chat_id::text,a.risk_score DESC,a.generated_at DESC`,
    [current.date]
  );
  // Одне звернення до бази на всі оцінки цього прогону — і лише тоді, коли є про що питати. Порожній
  // перелік тут — звичайний стан кожного тику після першого успішного прогону за ніч (усіх підписників
  // уже відсіяв NOT EXISTS вище), тож зайвого запиту в цьому циклі не зʼявляється.
  const modelSignals = await modelSignalCounts([...new Set(assessments.rows.map((row) => row.id))]);
  const grouped = new Map<string, DigestAssessment[]>();
  for (const assessment of assessments.rows) {
    assessment.model_signals = modelSignals.get(assessment.id) ?? 0;
    const rows = grouped.get(assessment.chat_id) ?? [];
    rows.push(assessment); grouped.set(assessment.chat_id, rows);
  }

  // Кому дайджест уже надіслано сьогодні — з'ясовуємо ДО циклу, а не всередині транзакції.
  // Планувальник будить цю функцію щопівхвилини аж до півночі, тож після першого успішного прогону
  // всі підписники вже claimed і робота зводиться до `ON CONFLICT DO NOTHING`. Без цього списку
  // модель питали б заново на кожному тику — десятки разів за ніч, за дані, які нікуди не підуть.
  // Вставка з ON CONFLICT нижче лишається справжнім захистом від гонки; це — лише економія.
  const alreadySent = await pool.query<{ chat_id: string }>(
    'SELECT chat_id::text FROM nightly_digest_runs WHERE digest_date=$1', [current.date]
  );
  const sent = new Set(alreadySent.rows.map((row) => row.chat_id));

  // Статистика ударів по регіонах — для тих самих чатів, тим самим фільтром «сьогодні ще не
  // надсилали». Чат зі статистикою, але без жодної чинної оцінки, теж отримує зведення (див. блок
  // вище); чат без обох не отримує нічого, як і раніше.
  const attackStats = await digestAttackStats(current.date);
  const recipients = new Set<string>([...grouped.keys(), ...attackStats.keys()]);

  let queued = 0;
  // Один виклик моделі на КОМБІНАЦІЮ оцінок, а не на підписника. Тисяча людей, підписаних на Київ,
  // отримує той самий перелік, і питати модель тисячу разів про однакові дані означало б витратити
  // квоту акаунта на буквальні дублікати. Кеш живе рівно один прогін: наступного вечора дані інші.
  const summaries = new Map<string, DigestSummary>();

  for (const chatId of recipients) {
    if (sent.has(chatId)) continue;
    const rows = grouped.get(chatId) ?? [];
    const selected = rows.slice(0, 12);
    const facts = digestFacts(selected, Math.max(0, rows.length - selected.length), current.time);
    const key = JSON.stringify(facts);
    let summary = summaries.get(key);
    if (!summary) {
      summary = await digestSummary(facts);
      summaries.set(key, summary);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query(
        `INSERT INTO nightly_digest_runs(digest_date,chat_id) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`, [current.date, chatId]
      );
      if (!claimed.rowCount) { await client.query('ROLLBACK'); continue; }
      const outbox = await client.query<{ id: string }>(
        `INSERT INTO notification_outbox(assessment_id,chat_id,notification_type,idempotency_key,priority,payload)
         VALUES ($1,$2,'nightly_digest',$3,4,$4) RETURNING id`,
        // `assessment_id` порожній, коли зведення складається з самої статистики — міграція 048
        // дозволяє це рівно для `nightly_digest`.
        [selected[0]?.id ?? null, chatId, `nightly:${current.date}:${chatId}`, JSON.stringify({
          generatedTime: current.time,
          date: current.date,
          assessments: selected.map((row) => ({
            locationName: row.location_name, threatType: row.threat_type, score: row.risk_score,
            level: row.risk_level, indicativePercent: row.indicative_percent,
            confidence: row.assessment_confidence, explanation: row.explanation,
            horizonEnd: row.horizon_end,
            // Порядково, а не лише підсумком: попередження про модельний внесок стосується не всього
            // переліку однаково, і форматувальник має мати чим позначити саме ту оцінку, у якій цей
            // внесок є. Нуль тут — звичайний стан рядка, а не відсутність даних.
            modelSignals: row.model_signals ?? 0
          })),
          omitted: facts.omitted,
          // Позначка їде разом із текстом, а не виводиться з його наявності: повідомлення форматує
          // інший модуль, і він не має здогадуватися, звідки взявся рядок.
          aiSummary: summary.text,
          aiGenerated: summary.aiGenerated,
          // Атрибуція модельного внеску — і числом, і вже готовим реченням. Число тут тому, що воно
          // потрапило в оцінки й має бути видимим у payload для розбору інциденту заднім числом;
          // речення — тому, що формулювання попередження належить тому, хто знає, що саме модель
          // зробила, а не форматувальнику повідомлень. `null` означає «модельних сигналів не було»,
          // і саме на цьому `null` форматувальник має мовчати: порожня згадка знецінює попередження.
          modelSignals: facts.modelSignals,
          modelDisclosure: modelSignalDisclosure(facts.modelSignals),
          // Статистика ударів і ймовірності по регіонах підписника — готовими рядками з дисклеймером,
          // щоб форматувальник не перераховував нічого й не вигадував формулювань. Порожній масив —
          // звичайний стан, коли перемикач вимкнено або звітів по цих регіонах ще немає.
          attackStats: attackStats.get(chatId) ?? []
        })]
      );
      await client.query(
        `UPDATE nightly_digest_runs SET outbox_id=$3 WHERE digest_date=$1 AND chat_id=$2`,
        [current.date, chatId, outbox.rows[0]!.id]
      );
      await client.query('COMMIT');
      queued += 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return queued;
}

export function startNightlyDigestScheduler(log: { info: Function; error: Function }): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const queued = await enqueueNightlyDigests();
      if (queued) log.info({ queued }, 'nightly digests queued');
    } catch (error) {
      log.error({ error }, 'nightly digest scheduling failed');
    } finally { running = false; }
  };
  const timer = setInterval(run, 30_000);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
