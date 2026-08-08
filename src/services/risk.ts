import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { CLASSIFIER_VERSION, riskLevel } from '../domain/classifier.js';
import { trustModifier } from './source-trust.js';

const modelAssessmentSchema = z.object({
  locationId: z.string(),
  threatType: z.string(),
  horizonHours: z.literal(6),
  score: z.number().finite().min(0).max(10),
  confidence: z.enum(['low', 'medium', 'high']),
  supportingSignalIds: z.array(z.string()).max(100),
  raisingFactors: z.array(z.string().min(1).max(240)).max(8),
  limitingFactors: z.array(z.string().min(1).max(240)).max(8),
  summary: z.string().min(1).max(800)
});

export type ModelAssessment = z.infer<typeof modelAssessmentSchema>;

export interface RiskSignalRow {
  id: string;
  signal_type: string;
  source_tier: 'A' | 'B' | 'C';
  independence_group: string;
  reliability: number | string;
  freshness: number | string;
  geographic_relevance: number | string;
  contribution: number | string;
  observed_at: Date;
  /**
   * Current measured trust of the publisher behind this signal, 0..1, from `source_trust_current`.
   * `null`/absent means the nightly worker in `./source-trust.ts` has never scored it — which is a
   * normal state, not a defect, and is worth exactly a modifier of 1.0.
   */
  source_trust?: number | string | null;
  source_id?: string | null;
  effective_contribution?: number;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/**
 * Людські назви типів сигналу.
 *
 * `risk_signals.signal_type` — це або назва індикатора з класифікатора (вона вже написана
 * українською: «зліт стратегічної авіації»), або технічна назва зв'язку повідомлення з територією
 * (`explicit_threat`, `child_location_signal`). Друге ніколи не писалося для людини, і саме воно
 * протікало в інтерфейс сирим ідентифікатором. Мапа перекладає лише технічні значення, а назви
 * індикаторів проходять крізь неї без змін — вони вже кращі за будь-який переклад.
 *
 * Дзеркальна копія цієї мапи живе у web/app.js: фронтенд — окремий бандл і не імпортує з src/,
 * тож єдиний спосіб не показати сире значення там — повторити відповідності. Змінюєш тут — зміни й там.
 */
const signalTypeLabels: Record<string, string> = {
  explicit_threat: 'пряма загроза цій території',
  reported_direction: 'ціль рухається в цьому напрямку',
  mentioned: 'територію згадано в повідомленні',
  official_alert: 'офіційна тривога',
  aftermath: 'повідомлення про наслідки на місці',
  national_posture: 'загальнонаціональне попередження',
  child_location_signal: 'сигнал із населеного пункту всередині території'
};

export function signalTypeLabel(signalType: string): string {
  return signalTypeLabels[signalType] ?? signalType;
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = count % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

interface SignalGroup {
  signalType: string;
  count: number;
  weight: number;
}

/**
 * Однотипні повідомлення — це один аргумент, а не п'ять.
 *
 * Раніше кожен сигнал ставав окремим рядком «чинників», і три повідомлення про той самий напрямок
 * читалися як три різні причини. Групування за типом лишає рівно стільки причин, скільки їх є
 * насправді, а вага групи — сума внесків, бо саме сума й формує індекс.
 */
function groupSignals(signals: RiskSignalRow[]): SignalGroup[] {
  const groups = new Map<string, SignalGroup>();
  for (const signal of signals) {
    const group = groups.get(signal.signal_type)
      ?? { signalType: signal.signal_type, count: 0, weight: 0 };
    group.count += 1;
    group.weight += signal.effective_contribution ?? effectiveContribution(signal);
    groups.set(signal.signal_type, group);
  }
  return [...groups.values()].sort((a, b) => b.weight - a.weight);
}

/**
 * What one signal is worth right now: its own weight, the reliability recorded when it was ingested,
 * a two-hour half-life on its age, and how much the publisher has earned the benefit of the doubt.
 *
 * The trust term is a *modifier*, bounded to [0.6, 1.2] by {@link trustModifier}, and the bounds are
 * the whole design. The assessment has to stay complete and correct without the trust layer: before
 * this feature there was no `source_trust` row anywhere, the modifier was effectively 1.0, and every
 * index the system published was a real index. A floor of 0.6 keeps that true in the bad direction —
 * a source with a poor month is discounted, never silenced, because a threat reported only by an
 * imperfect channel must still reach the map. A ceiling of 1.2 keeps it true in the good direction —
 * a well-behaved channel is amplified by a fifth at most, so trust can never carry a location on its
 * own, and the tier guardrails in {@link clampAssessment} still decide what the index may reach.
 *
 * Anything wider would make the measurement the assessment. Trust modulates; it does not dominate.
 */
export function effectiveContribution(signal: RiskSignalRow, now = Date.now()): number {
  const ageHours = Math.max(0, (now - new Date(signal.observed_at).getTime()) / 3_600_000);
  const freshnessDecay = 2 ** (-ageHours / 2);
  const trust = signal.source_trust == null ? null : Number(signal.source_trust);
  return Number(signal.contribution) * Number(signal.reliability) * freshnessDecay * trustModifier(trust);
}

const threatLabels: Record<string, string> = {
  uav: 'ударних БпЛА', ballistic_missile: 'балістичних ракет',
  cruise_missile: 'крилатих ракет', guided_air_bomb: 'керованих авіаційних бомб',
  aviation: 'активності авіації', mlrs: 'РСЗВ', artillery: 'артилерійського обстрілу',
  mortar: 'мінометного обстрілу', combined: 'комбінованої загрози', unknown: 'невизначеної загрози'
};

/**
 * Пояснення, яке читає людина, а не список технічних полів.
 *
 * Раніше «чинниками» тут ставали самі значення `signal_type`, і в картку оцінки потрапляв рядок
 * штибу `child_location_signal`. Тепер кожен чинник — завершене речення про те, що саме повідомили
 * джерела й скільки разів; це той самий текст, який іде і в Telegram-дайджест, тож він мусить
 * читатися без жодного контексту інтерфейсу.
 */
export function fallbackAssessment(
  location: { id: string; name_uk: string },
  threatType: string,
  signals: RiskSignalRow[]
): ModelAssessment {
  const score = Math.min(10, signals.reduce((sum, signal) => sum + (signal.effective_contribution ?? effectiveContribution(signal)), 0));
  const independent = new Set(signals.map((signal) => signal.independence_group)).size;
  const tiers = new Set(signals.map((signal) => signal.source_tier));
  const groups = groupSignals(signals);
  const raisingFactors = groups.slice(0, 3).map((group) => {
    const messages = `${group.count} ${plural(group.count, 'повідомлення', 'повідомлення', 'повідомлень')}`;
    // Назва сигналу відкриває речення, бо саме вона є твердженням: «Пряма загроза цій території —
    // 3 повідомлення за останні години». Обгортка на кшталт «Джерела повідомляють про це:» додавала
    // займенник без антецедента і робила фразу нечитабельною саме там, де вона мусить читатися з ходу.
    const label = signalTypeLabel(group.signalType);
    return `${label.charAt(0).toUpperCase()}${label.slice(1)} — ${messages} за останні години.`;
  });
  if (tiers.has('A')) raisingFactors.push('Серед джерел є офіційне повідомлення.');
  if (independent >= 2) raisingFactors.push('Повідомлення надійшли щонайменше з двох незалежних груп джерел.');

  const threatLabel = threatLabels[threatType] ?? threatType;
  const messageCount = `${signals.length} ${plural(signals.length, 'публічного повідомлення', 'публічних повідомлень', 'публічних повідомлень')}`;
  return {
    locationId: location.id,
    threatType,
    horizonHours: 6,
    score,
    confidence: independent >= 2 ? 'medium' : 'low',
    supportingSignalIds: signals.map((signal) => signal.id),
    raisingFactors: unique(raisingFactors).slice(0, 5),
    limitingFactors: [
      'Оцінку зроблено за сталим правилом без зовнішньої моделі: воно враховує лише кількість повідомлень, їхню давність, надійність джерела та те, наскільки повідомлення стосується саме цієї території.',
      independent < 2
        ? 'Усе тримається на одній групі джерел — помилка в ній зсуне весь індекс.'
        : 'Система дивиться лише на шість годин уперед і не бачить, що буде далі.'
    ],
    summary: `Оцінка загрози ${threatLabel} для території «${location.name_uk}» на найближчі шість годин. Індекс зібрано з ${messageCount} за останні години з поправкою на давність, надійність джерела та те, наскільки повідомлення стосується саме цієї території.`
  };
}

export function clampAssessment(candidate: ModelAssessment, signals: RiskSignalRow[], locationId: string, threatType: string): ModelAssessment {
  const tiers = new Set(signals.map((signal) => signal.source_tier));
  const independent = new Set(signals.map((signal) => signal.independence_group)).size;
  const validIds = new Set(signals.map((signal) => signal.id));
  let maximum = 10;
  let confidence = candidate.confidence;
  const limitingFactors = [...candidate.limitingFactors];

  if (tiers.size === 1 && tiers.has('C')) {
    maximum = 3.9;
    confidence = 'low';
    limitingFactors.push('Усі повідомлення — з допоміжних каналів, тож індекс навмисно обмежено зверху.');
  } else if (!tiers.has('A')) {
    maximum = 5.9;
    limitingFactors.push('Офіційного повідомлення поки немає, тож індекс навмисно обмежено зверху.');
  }
  if (independent < 2) {
    confidence = 'low';
    limitingFactors.push('Другої незалежної групи джерел, яка підтвердила б те саме, поки немає.');
  } else if (confidence === 'high' && !tiers.has('A')) confidence = 'medium';

  return {
    ...candidate,
    locationId,
    threatType,
    horizonHours: 6,
    score: Math.max(0, Math.min(maximum, candidate.score)),
    confidence,
    supportingSignalIds: candidate.supportingSignalIds.filter((id) => validIds.has(id)),
    raisingFactors: unique(candidate.raisingFactors).slice(0, 8),
    limitingFactors: unique(limitingFactors).slice(0, 8)
  };
}

async function recordFailedRun(input: unknown, error: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO ai_runs(model,prompt_version,input,status,error,surface,classifier_version,
                         validation_status,fallback_reason)
     VALUES ($1,'v2',$2,'failed',$3,'risk',$4,'skipped',$3)`,
    [config.AI_MODEL || 'rule-fallback-v2', JSON.stringify(input), String(error).slice(0, 800),
      CLASSIFIER_VERSION]
  );
}

/**
 * One group's assessment, from the configured model when this pass is allowed to spend it.
 *
 * `allowModel` is a *budget*, not a feature switch. The model is called once per
 * `(location_id, threat_type)` group and one nationwide message fans out to every oblast for six
 * hours, so a caller that runs far more often than the fifteen-minute scheduler has to be able to
 * say "re-score everything, but not with the model this time". Declining it is not a degradation of
 * the contract: {@link fallbackAssessment} is the deployed default wherever `AI_*` is unset and
 * already produces a complete, clamped, Ukrainian assessment.
 */
async function callModel(
  location: { id: string; name_uk: string }, threatType: string, signals: RiskSignalRow[],
  allowModel: boolean
): Promise<ModelAssessment> {
  if (!allowModel || !config.AI_BASE_URL || !config.AI_API_KEY || !config.AI_MODEL) {
    return fallbackAssessment(location, threatType, signals);
  }
  const input = {
    location: { id: location.id, name: location.name_uk },
    threatType,
    horizonHours: 6,
    signals: signals.map((signal) => ({
      id: signal.id,
      type: signal.signal_type,
      tier: signal.source_tier,
      reliability: Number(signal.reliability),
      geographicRelevance: Number(signal.geographic_relevance),
      // Already folded into `effectiveContribution`; shown separately so the audit log in `ai_runs`
      // records what the model was told rather than only what it was given.
      sourceTrust: signal.source_trust == null ? null : Number(signal.source_trust),
      effectiveContribution: signal.effective_contribution,
      observedAt: signal.observed_at
    }))
  };
  const started = Date.now();
  try {
    const response = await fetch(`${config.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.AI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.AI_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          // Текст із цієї відповіді потрапляє людині в очі без редагування — і в картку на карті, і в
          // Telegram. Тому від моделі вимагається не перелік полів, а завершені українські речення:
          // «reported_direction» у списку чинників було б таким самим витоком технічної назви, як і
          // раніше в інтерфейсі.
          { role: 'system', content: 'Return only JSON. Assess the relative risk that an official warning of the specified type will appear for this location within six hours. This is an index, not a statistical probability. Never infer an impact, target, exact route, or safety. Required fields: locationId, threatType, horizonHours=6, score 0-10, confidence low|medium|high, supportingSignalIds, raisingFactors, limitingFactors, summary. Write summary, raisingFactors and limitingFactors in Ukrainian, as complete calm sentences a civilian can read aloud; never emit raw field names, signal type identifiers, English terms or numeric weights in them.' },
          { role: 'user', content: JSON.stringify(input) }
        ]
      }),
      signal: AbortSignal.timeout(config.AI_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`AI endpoint ${response.status}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI endpoint returned empty content');
    const parsed = modelAssessmentSchema.parse(JSON.parse(content));
    // `validation_status` is `'skipped'` rather than `'passed'`: the risk path has no grounding
    // check to pass. `clampAssessment` bounds the score afterwards, which is a policy, not a
    // verdict on the model's arithmetic, and claiming `'passed'` here would make a filter over the
    // column mean two different things depending on the writer.
    await pool.query(
      `INSERT INTO ai_runs(model,prompt_version,input,output,status,duration_ms,surface,
                           classifier_version,validation_status,fallback_reason)
       VALUES ($1,'v2',$2,$3,'success',$4,'risk',$5,'skipped',NULL)`,
      [config.AI_MODEL, JSON.stringify(input), JSON.stringify(parsed), Date.now() - started,
        CLASSIFIER_VERSION]
    );
    return parsed;
  } catch (error) {
    await recordFailedRun(input, error);
    return fallbackAssessment(location, threatType, signals);
  }
}

/**
 * One risk pass at a time, per process.
 *
 * {@link runRiskAssessmentsPass} expires, regroups, re-scores and supersedes; two passes interleaved
 * would supersede each other's rows and could publish an older score last. Three writers exist now —
 * `startRiskScheduler`, `POST /ops/run-assessment` and the event-driven recompute — and until this
 * flag the first two already raced with no guard at all outside the scheduler's own closure.
 *
 * In memory and not in the database, for the reason `shadow-classifier.ts` states about its budget:
 * single replica is the deployed shape, and a guard that needs a round trip to decide whether to do
 * work is not a guard.
 */
let riskRunInFlight = false;

export interface RiskRunOutcome {
  published: number;
  /** True when another writer held the pass and this call did nothing. */
  skipped: boolean;
}

export interface RiskRunOptions {
  /**
   * Whether this pass may spend the configured `AI_*` model, one call per group.
   *
   * Defaults to **true**, so `startRiskScheduler` and `POST /ops/run-assessment` — both of which run
   * at most every fifteen minutes — are unchanged. The event-driven recompute passes `false` on the
   * intermediate passes it runs in between, because it can run up to once a minute and the model leg
   * has no other bound. See the risk leg of `recomputeAnalytics` for the cadence this implements.
   */
  allowModel?: boolean;
}

/**
 * The guarded entry point. It exists separately from {@link runRiskAssessments} because the
 * analytics scheduler has to count a blocked leg
 * (`threatlens_analytics_recompute_total{outcome="skipped_overlap"}`) and
 * `Promise<number>` cannot express "blocked" — while changing that signature would move
 * `POST /ops/run-assessment`, and importing the scheduler's counter here would close a cycle.
 */
export async function runRiskAssessmentsGuarded(options: RiskRunOptions = {}): Promise<RiskRunOutcome> {
  if (riskRunInFlight) return { published: 0, skipped: true };
  riskRunInFlight = true;
  try {
    return { published: await runRiskAssessmentsPass(options.allowModel ?? true), skipped: false };
  } finally {
    riskRunInFlight = false;
  }
}

/** Unchanged signature: `POST /ops/run-assessment` and `startRiskScheduler` still call this. */
export async function runRiskAssessments(): Promise<number> {
  return (await runRiskAssessmentsGuarded()).published;
}

/** Test seam: a suite that aborts mid-pass must not leave the next file's first call blocked. */
export function resetRiskRunGuard(): void {
  riskRunInFlight = false;
}

async function runRiskAssessmentsPass(allowModel: boolean): Promise<number> {
  const modelVersion = config.AI_MODEL || 'rule-fallback-v2';
  await pool.query(
    `UPDATE risk_assessments SET expires_at=now()
     WHERE superseded_by IS NULL AND expires_at > now()
       AND (model_version <> $1 OR methodology_version <> 'v2')`,
    [modelVersion]
  );
  const groups = await pool.query<{ location_id: string; threat_type: string; signal_ids: string[] }>(
    `SELECT location_id,threat_type,array_agg(id) signal_ids
     FROM risk_signals WHERE expires_at > now() AND location_id IS NOT NULL
     GROUP BY location_id,threat_type`
  );
  let published = 0;
  for (const group of groups.rows) {
    const location = (await pool.query<{ id: string; name_uk: string }>(
      `SELECT id,name_uk FROM locations WHERE id=$1`, [group.location_id]
    )).rows[0];
    if (!location) continue;
    // The trust join is LEFT twice over — a signal may have no source message (the demo source), and
    // a source may have no trust row yet. Both cases arrive as NULL and are read as "no measurement",
    // which `effectiveContribution` scores as a modifier of exactly 1.0.
    const rawSignals = (await pool.query<RiskSignalRow>(
      `SELECT rs.*, sm.source_id, t.trust AS source_trust
       FROM risk_signals rs
       LEFT JOIN source_messages sm ON sm.id=rs.source_message_id
       LEFT JOIN source_trust_current t ON t.source_id=sm.source_id
       WHERE rs.id=ANY($1::uuid[]) ORDER BY rs.observed_at DESC`, [group.signal_ids]
    )).rows;
    const signals = rawSignals.map((signal) => ({ ...signal, effective_contribution: effectiveContribution(signal) }));
    try {
      const raw = await callModel(location, group.threat_type, signals, allowModel);
      const assessment = clampAssessment(raw, signals, group.location_id, group.threat_type);
      const previous = await pool.query(
        `SELECT * FROM risk_assessments WHERE location_id=$1 AND threat_type=$2 AND published=true
         AND superseded_by IS NULL ORDER BY generated_at DESC LIMIT 1`, [group.location_id, group.threat_type]
      );
      const previousRow = previous.rows[0];
      const nextLevel = riskLevel(assessment.score);
      const material = !previousRow || previousRow.risk_level !== nextLevel
        || previousRow.methodology_version !== 'v2'
        || previousRow.model_version !== modelVersion
        || Math.abs(Number(previousRow.risk_score) - assessment.score) >= 0.5;
      if (previousRow && Math.abs(Number(previousRow.risk_score) - assessment.score) > 3
        && !signals.some((signal) => signal.source_tier === 'A')) continue;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<{ id: string }>(
          `INSERT INTO risk_assessments(location_id,threat_type,horizon_start,horizon_end,risk_score,risk_level,
            assessment_confidence,model_version,methodology_version,indicative_percent,explanation,expires_at,published)
           VALUES ($1,$2,now(),now()+interval '6 hours',$3,$4,$5,$6,'v2',$7,$8,now()+interval '6 hours',$9) RETURNING id`,
          [group.location_id, group.threat_type, assessment.score.toFixed(1), nextLevel, assessment.confidence,
            modelVersion, Math.round(assessment.score * 10), JSON.stringify({
              summary: assessment.summary,
              raisingFactors: assessment.raisingFactors,
              limitingFactors: assessment.limitingFactors,
              caveat: 'Індикативний відсоток — це позначка на шкалі індексу, а не статистична ймовірність удару. Низький рівень не означає безпеку: офіційна тривога може бути оголошена без жодного попереднього сигналу.'
            }), material]
        );
        const assessmentId = result.rows[0]!.id;
        for (const signal of signals) {
          await client.query(
            `INSERT INTO risk_assessment_signals(assessment_id,signal_id,contribution,explanation)
             VALUES ($1,$2,$3,$4)`,
            [assessmentId, signal.id, signal.effective_contribution, signal.signal_type]
          );
        }
        if (material) {
          if (previousRow) await client.query(`UPDATE risk_assessments SET superseded_by=$2 WHERE id=$1`, [previousRow.id, assessmentId]);
          await client.query(`INSERT INTO system_event_log(event_type,payload) VALUES ('assessment.updated',$1)`,
            [JSON.stringify({ assessmentId, locationId: group.location_id })]);
          published += 1;
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      await recordFailedRun({ group }, error);
    }
  }
  return published;
}

export function startRiskScheduler(log: { info: Function; error: Function }): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const published = await runRiskAssessments();
      log.info({ published }, 'risk assessment run finished');
    } catch (error) {
      log.error({ error }, 'risk assessment run failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, 15 * 60_000);
  timer.unref();
  setTimeout(run, 3_000).unref();
  return () => clearInterval(timer);
}
