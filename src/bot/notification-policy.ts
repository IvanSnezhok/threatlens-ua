import { createHash } from 'node:crypto';

/**
 * "Send, edit, or stay quiet?" — decided against what a chat was *last told*, not against what was
 * last computed.
 *
 * The distinction is the whole point of this module. A live threat re-emits `threat.updated` on
 * every channel message that lands on it, and the risk pipeline recomputes an assessment every
 * fifteen minutes; comparing each new computation with the previous computation therefore produces
 * a stream of near-identical pushes. Comparing it with the last *published* state produces a
 * message only when a subscriber's picture of the world would actually change.
 *
 * Everything here is pure so the transition table can be tested exhaustively: the caller loads the
 * published state from `notification_state`, calls a decision function, and only then touches the
 * outbox.
 */

// ------------------------------------------------------------------------------------------------
// Scales
// ------------------------------------------------------------------------------------------------

export const EVIDENCE_ORDER = ['unverified', 'monitoring', 'confirmed', 'official'] as const;
export type EvidenceLevel = typeof EVIDENCE_ORDER[number];

/** Unknown levels rank as the weakest, so a bad value can never be read as an escalation. */
export function evidenceRank(level: string | null | undefined): number {
  const index = EVIDENCE_ORDER.indexOf(String(level ?? '') as EvidenceLevel);
  return index < 0 ? 0 : index;
}

export const RISK_ORDER = ['background', 'elevated', 'significant', 'high', 'very_high'] as const;
export type RiskLevel = typeof RISK_ORDER[number];

export function riskRank(level: string | null | undefined): number {
  const index = RISK_ORDER.indexOf(String(level ?? '') as RiskLevel);
  return index < 0 ? 0 : index;
}

// ------------------------------------------------------------------------------------------------
// Thresholds
// ------------------------------------------------------------------------------------------------

/**
 * A validity window that creeps forward by a few minutes is the normal breathing of a monitoring
 * source restating the same threat. Twenty minutes is the point where "still standing" becomes
 * information a person would want: it is long enough to outlive that breathing and short enough to
 * reach someone before the previous window they were told about runs out.
 */
export const VALIDITY_EXTENSION_MINUTES = 20;

/**
 * Analytics hysteresis. The 0.5 threshold in `src/services/risk.ts` decides whether an assessment is
 * worth *storing* as a new published row; this one decides whether it is worth *waking a person up*.
 * They are deliberately different numbers with different jobs — a score that oscillates across the
 * storage threshold must not turn into a message every fifteen minutes.
 */
export const ASSESSMENT_SCORE_DELTA = 1.0;

/** Floor between two analytics pushes for one (location, chat), bypassed only by a level increase. */
export const ASSESSMENT_COOLDOWN_MINUTES = 30;

// ------------------------------------------------------------------------------------------------
// Threats
// ------------------------------------------------------------------------------------------------

export interface ThreatSnapshot {
  threatType: string;
  evidenceLevel: string;
  /** Every location the threat is currently attached to; order does not matter. */
  locationIds: string[];
  /** ISO timestamp, or null when the source gave no validity window. */
  validUntil: string | null;
}

export interface ThreatPublishedState {
  threatType: string | null;
  evidenceLevel: string | null;
  /** As stored: the sorted, comma-joined location ids of the published version. */
  geographyKey: string | null;
  validUntil: string | null;
  contentHash: string | null;
  telegramMessageId: number | null;
}

export type ThreatChange =
  | 'initial'
  | 'evidence_raised'
  | 'threat_type_changed'
  | 'geography_changed'
  | 'validity_extended';

export interface ThreatDecision {
  action: 'send' | 'edit' | 'skip';
  /**
   * `initial`   — first message about this threat for this chat, full format.
   * `escalation`— evidence level went up; always a fresh message, it must arrive with a sound.
   * `change`    — the threat itself changed (type or geography); also a fresh message.
   * `soft`      — only the validity window moved; edits the existing message when there is one.
   * `none`      — nothing to say.
   */
  kind: 'initial' | 'escalation' | 'change' | 'soft' | 'none';
  changes: ThreatChange[];
  reason: string;
  editMessageId: number | null;
}

/** Sorted, comma-joined location ids: the scalar form of a threat's geography. */
export function geographyKey(locationIds: readonly string[]): string {
  return [...new Set(locationIds)].sort().join(',');
}

export function parseGeographyKey(key: string | null | undefined): string[] {
  return String(key ?? '').split(',').filter(Boolean);
}

/**
 * Fingerprint of the fields a message would mention. Summary text is deliberately excluded: a source
 * rewording the same warning is not news, and hashing it would defeat the short-circuit below.
 */
export function threatContentHash(snapshot: ThreatSnapshot): string {
  return createHash('sha1').update(JSON.stringify([
    snapshot.threatType, snapshot.evidenceLevel, geographyKey(snapshot.locationIds), snapshot.validUntil ?? ''
  ])).digest('hex');
}

/**
 * What the chat now knows, after the message this decision produced.
 *
 * Not simply the current snapshot. The table records *what a chat was told*, and a delta message only
 * ever states what changed, so the fields it stayed silent about must keep their published value:
 *
 *  - a weakened evidence level is never announced (see {@link decideThreatNotification}), so writing
 *    it down would let the level climbing back to where it already was read as a fresh escalation;
 *  - a threat that stops covering a raion is not announced either, so dropping the raion from the
 *    published geography would turn its return into "new directions" for someone already warned;
 *  - a shortened validity window is silence for the same reason, and recording it would make the
 *    original deadline look like an extension when the source restates it.
 *
 * Threat type is not merged: any change to it is always delivered, so the new value is genuinely what
 * the chat was told.
 */
export function mergePublishedState(previous: ThreatPublishedState | null, next: ThreatSnapshot): ThreatSnapshot {
  if (!previous) return { ...next, locationIds: [...new Set(next.locationIds)] };
  return {
    threatType: next.threatType,
    evidenceLevel: evidenceRank(next.evidenceLevel) >= evidenceRank(previous.evidenceLevel)
      ? next.evidenceLevel : String(previous.evidenceLevel),
    locationIds: [...new Set([...parseGeographyKey(previous.geographyKey), ...next.locationIds])],
    validUntil: laterMoment(previous.validUntil, next.validUntil)
  };
}

/** The later of two ISO timestamps; unparsable or missing values lose to a usable one. */
function laterMoment(a: string | null, b: string | null): string | null {
  const left = a ? new Date(a).getTime() : NaN;
  const right = b ? new Date(b).getTime() : NaN;
  if (Number.isNaN(left)) return Number.isNaN(right) ? null : b;
  if (Number.isNaN(right)) return a;
  return right >= left ? b : a;
}

function minutesBetween(from: string | null, to: string | null): number | null {
  if (!to) return null;
  const next = new Date(to).getTime();
  if (Number.isNaN(next)) return null;
  if (!from) return Number.POSITIVE_INFINITY;
  const previous = new Date(from).getTime();
  if (Number.isNaN(previous)) return Number.POSITIVE_INFINITY;
  return (next - previous) / 60_000;
}

/**
 * The rule set from the product side, in order:
 *
 *  1. never told this chat about the threat  -> full message;
 *  2. evidence level rose                    -> new message (escalation);
 *  3. threat type or geography changed       -> new message;
 *  4. validity extended by > 20 minutes      -> edit the standing message, or send if there is none;
 *  5. anything else, including a plain re-confirmation or a *weakened* evidence level -> silence.
 *
 * A downgrade is silence rather than a message on purpose: telling people "this is now less certain"
 * invites them to leave shelter on the strength of a monitoring-grade doubt. The threat expiring is
 * handled elsewhere, and an all-clear only ever comes from an official source.
 */
export function decideThreatNotification(
  previous: ThreatPublishedState | null,
  next: ThreatSnapshot,
  options: { extensionMinutes?: number } = {}
): ThreatDecision {
  if (!previous) {
    return { action: 'send', kind: 'initial', changes: ['initial'], reason: 'перше сповіщення про цю загрозу', editMessageId: null };
  }
  const messageId = previous.telegramMessageId ?? null;
  if (previous.contentHash && previous.contentHash === threatContentHash(next)) {
    return { action: 'skip', kind: 'none', changes: [], reason: 'стан збігається з надісланим', editMessageId: messageId };
  }

  const extensionMinutes = options.extensionMinutes ?? VALIDITY_EXTENSION_MINUTES;
  const changes: ThreatChange[] = [];
  if (evidenceRank(next.evidenceLevel) > evidenceRank(previous.evidenceLevel)) changes.push('evidence_raised');
  if (previous.threatType && next.threatType !== previous.threatType) changes.push('threat_type_changed');
  // Only *added* locations count. A threat that stops covering a raion is not something to push a
  // notification about — the person there is already careful, and the withdrawal path owns that case.
  const known = new Set(parseGeographyKey(previous.geographyKey));
  if (known.size && next.locationIds.some((id) => !known.has(id))) changes.push('geography_changed');
  const extendedBy = minutesBetween(previous.validUntil, next.validUntil);
  if (extendedBy !== null && extendedBy > extensionMinutes) changes.push('validity_extended');

  if (!changes.length) {
    return { action: 'skip', kind: 'none', changes: [], reason: 'повторне підтвердження без змін', editMessageId: messageId };
  }
  if (changes.includes('evidence_raised')) {
    return { action: 'send', kind: 'escalation', changes, reason: 'доказовість підвищено', editMessageId: messageId };
  }
  if (changes.includes('threat_type_changed') || changes.includes('geography_changed')) {
    return { action: 'send', kind: 'change', changes, reason: 'змінився характер або географія загрози', editMessageId: messageId };
  }
  // Extension only. Editing keeps one message per threat in the chat instead of a ladder of
  // "still standing" pushes; without a known message id there is nothing to edit, so it is sent.
  return messageId
    ? { action: 'edit', kind: 'soft', changes, reason: 'продовжено вікно дії', editMessageId: messageId }
    : { action: 'send', kind: 'soft', changes, reason: 'продовжено вікно дії, немає що редагувати', editMessageId: null };
}

// ------------------------------------------------------------------------------------------------
// Analytics
// ------------------------------------------------------------------------------------------------

export interface AssessmentSnapshot {
  riskLevel: string;
  score: number;
  /** ISO timestamp of the assessment, used as "now" for the cooldown. */
  at: string;
}

export interface AssessmentPublishedState {
  riskLevel: string | null;
  score: number | null;
  /** ISO timestamp of the last analytics message queued for this (location, chat). */
  notifiedAt: string | null;
}

export interface AssessmentDecision {
  action: 'send' | 'skip';
  kind: 'initial' | 'escalation' | 'deescalation' | 'drift' | 'none';
  /** True for de-escalations: worth recording, not worth a sound at night. */
  silent: boolean;
  reason: string;
}

/**
 * Hysteresis plus a cooldown, both measured against the last *published* assessment for this chat.
 *
 *  - a level increase always goes out, immediately, cooldown or not;
 *  - a level decrease goes out silently, subject to the cooldown;
 *  - the same level with a score moving by at least 1.0 goes out, subject to the cooldown;
 *  - everything else is silence.
 */
export function decideAssessmentNotification(
  previous: AssessmentPublishedState | null,
  next: AssessmentSnapshot,
  options: { cooldownMinutes?: number; scoreDelta?: number } = {}
): AssessmentDecision {
  if (!previous || previous.riskLevel === null) {
    return { action: 'send', kind: 'initial', silent: false, reason: 'перша оцінка для цього чату' };
  }
  const cooldownMinutes = options.cooldownMinutes ?? ASSESSMENT_COOLDOWN_MINUTES;
  const scoreDelta = options.scoreDelta ?? ASSESSMENT_SCORE_DELTA;

  const previousRank = riskRank(previous.riskLevel);
  const nextRank = riskRank(next.riskLevel);
  if (nextRank > previousRank) {
    return { action: 'send', kind: 'escalation', silent: false, reason: 'рівень ризику підвищився' };
  }

  const elapsed = minutesBetween(previous.notifiedAt, next.at);
  const withinCooldown = elapsed !== null && elapsed < cooldownMinutes;

  if (nextRank < previousRank) {
    return withinCooldown
      ? { action: 'skip', kind: 'none', silent: false, reason: 'зниження рівня в межах паузи' }
      : { action: 'send', kind: 'deescalation', silent: true, reason: 'рівень ризику знизився' };
  }
  const drift = Math.abs(next.score - Number(previous.score ?? 0));
  if (drift < scoreDelta) {
    return { action: 'skip', kind: 'none', silent: false, reason: 'зміна індексу менша за поріг' };
  }
  return withinCooldown
    ? { action: 'skip', kind: 'none', silent: false, reason: 'зміна індексу в межах паузи' }
    : { action: 'send', kind: 'drift', silent: false, reason: 'індекс змінився в межах того самого рівня' };
}
