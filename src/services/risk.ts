import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { riskLevel } from '../domain/classifier.js';

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
  effective_contribution?: number;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function effectiveContribution(signal: RiskSignalRow, now = Date.now()): number {
  const ageHours = Math.max(0, (now - new Date(signal.observed_at).getTime()) / 3_600_000);
  const freshnessDecay = 2 ** (-ageHours / 2);
  return Number(signal.contribution) * Number(signal.reliability) * freshnessDecay;
}

function fallbackAssessment(locationId: string, threatType: string, signals: RiskSignalRow[]): ModelAssessment {
  const score = Math.min(10, signals.reduce((sum, signal) => sum + (signal.effective_contribution ?? effectiveContribution(signal)), 0));
  const independent = new Set(signals.map((signal) => signal.independence_group)).size;
  const raisingFactors = unique(signals
    .sort((a, b) => (b.effective_contribution ?? 0) - (a.effective_contribution ?? 0))
    .map((signal) => signal.signal_type)).slice(0, 5);
  return {
    locationId,
    threatType,
    horizonHours: 6,
    score,
    confidence: independent >= 2 ? 'medium' : 'low',
    supportingSignalIds: signals.map((signal) => signal.id),
    raisingFactors,
    limitingFactors: [
      'Використано детерміновану модель без зовнішнього AI',
      independent < 2 ? 'Менше двох незалежних груп джерел' : 'Оцінка обмежена шестигодинним горизонтом'
    ],
    summary: 'Індекс сформовано з актуальних публічних сигналів з урахуванням давності, надійності та географічної релевантності.'
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
    limitingFactors.push('Лише допоміжні джерела рівня C: індекс обмежено');
  } else if (!tiers.has('A')) {
    maximum = 5.9;
    limitingFactors.push('Немає офіційного джерела рівня A: індекс обмежено');
  }
  if (independent < 2) {
    confidence = 'low';
    limitingFactors.push('Немає підтвердження другою незалежною групою джерел');
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
    `INSERT INTO ai_runs(model,prompt_version,input,status,error) VALUES ($1,'v2',$2,'failed',$3)`,
    [config.AI_MODEL || 'rule-fallback-v2', JSON.stringify(input), String(error).slice(0, 800)]
  );
}

async function callModel(location: { id: string; name_uk: string }, threatType: string, signals: RiskSignalRow[]): Promise<ModelAssessment> {
  if (!config.AI_BASE_URL || !config.AI_API_KEY || !config.AI_MODEL) {
    return fallbackAssessment(location.id, threatType, signals);
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
          { role: 'system', content: 'Return only JSON. Assess the relative risk that an official warning of the specified type will appear for this location within six hours. This is an index, not a statistical probability. Never infer an impact, target, exact route, or safety. Required fields: locationId, threatType, horizonHours=6, score 0-10, confidence low|medium|high, supportingSignalIds, raisingFactors, limitingFactors, summary.' },
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
    await pool.query(
      `INSERT INTO ai_runs(model,prompt_version,input,output,status,duration_ms) VALUES ($1,'v2',$2,$3,'success',$4)`,
      [config.AI_MODEL, JSON.stringify(input), JSON.stringify(parsed), Date.now() - started]
    );
    return parsed;
  } catch (error) {
    await recordFailedRun(input, error);
    return fallbackAssessment(location.id, threatType, signals);
  }
}

export async function runRiskAssessments(): Promise<number> {
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
    const rawSignals = (await pool.query<RiskSignalRow>(
      `SELECT * FROM risk_signals WHERE id=ANY($1::uuid[]) ORDER BY observed_at DESC`, [group.signal_ids]
    )).rows;
    const signals = rawSignals.map((signal) => ({ ...signal, effective_contribution: effectiveContribution(signal) }));
    try {
      const raw = await callModel(location, group.threat_type, signals);
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
              caveat: 'Індикативний відсоток є шкалою індексу, а не статистичною ймовірністю.'
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
