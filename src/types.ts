export const THREAT_TYPES = [
  'uav', 'ballistic_missile', 'cruise_missile', 'guided_air_bomb',
  'aviation', 'mlrs', 'artillery', 'mortar', 'combined', 'unknown'
] as const;
export type ThreatType = typeof THREAT_TYPES[number];
export type EvidenceLevel = 'official' | 'confirmed' | 'monitoring' | 'unverified';
export type RelationType = 'explicit_threat' | 'mentioned' | 'reported_direction' | 'official_alert' | 'aftermath';

/**
 * How the public presentation is timed. Nothing here gates collection, classification, audit,
 * `/ops`, `/metrics` or Telegram delivery — see `src/services/publication.ts`.
 */
export const PUBLICATION_MODES = ['live', 'delayed_15s'] as const;
export type PublicationMode = (typeof PUBLICATION_MODES)[number];

export interface NormalizedMessage {
  sourceId: string;
  externalId: string;
  publishedAt: Date;
  editedAt?: Date;
  text: string;
  rawPayload: Record<string, unknown>;
}

/**
 * What a message is doing, as opposed to what it is about.
 *
 * A monitoring channel does not only assert threats. It also withdraws them — "ТУшки неактивні",
 * "ціль знищена", "не відмічаємо ознак застосування стратегічної авіації" — and it reports a threat
 * moving past one place towards another. Both were previously indistinguishable from an assertion:
 * a denial matched the same threat vocabulary it was denying and was published as a warning.
 *
 * `de_escalation` never carries a threat event. `redirect` does: the message is a threat assertion
 * about the place being approached, and simultaneously a withdrawal for the place being passed.
 */
export type MessageIntent = 'threat' | 'redirect' | 'de_escalation' | 'none';

/**
 * What a message withdraws, as far as it can be read from the text.
 *
 * Deliberately allowed to be empty on both axes. "Нічого не летить" from a Kyiv-only channel and the
 * same words from a national monitor withdraw very different things, and the text carries nothing
 * that distinguishes them; `coverage: 'unspecified'` says exactly that instead of inventing a scope.
 * A consumer that acts on a retraction must decide what an unscoped withdrawal is worth — the
 * publisher's own coverage is a property of the source row, not of the message.
 */
export interface Retraction {
  /** Threat types the message withdraws. Empty when it names none. */
  threatTypes: ThreatType[];
  /** Locations the withdrawal applies to. Empty when the message names none. */
  locations: Array<{ id: string; name: string }>;
  coverage: 'located' | 'unspecified';
}

export interface ClassifiedMessage {
  intent: MessageIntent;
  threatType: ThreatType;
  signalThreatTypes: ThreatType[];
  locations: Array<{ id: string; relationType: RelationType; name: string }>;
  nationalScope: boolean;
  indicators: string[];
  directionText?: string;
  title: string;
  summary: string;
  /** Present for `de_escalation` and `redirect`. Never a state change on its own. */
  retraction?: Retraction;
  /**
   * What the `v5` retrospection rules made of the message, when they made anything of it at all.
   *
   * Absent on the overwhelming majority of traffic. `vetoed` means the rules read a report about a
   * period that has ended and refused to raise anything — {@link significanceRejection} answers
   * `retrospective` and the pipeline archives the message. `suspect` is the grey band: the
   * classification is untouched and the message publishes, and the field exists only so
   * `src/services/retrospective-gate.ts` knows it may put one question to a model first.
   *
   * There is no third value, and in particular no value that makes a message *more* significant
   * than the rest of this classification already says it is.
   */
  retrospective?: { verdict: 'suspect' | 'vetoed'; markers: string[] };
}

export interface LiveEvent {
  id: string;
  threatType: ThreatType;
  status: string;
  evidenceLevel: EvidenceLevel;
  title: string;
  summary: string;
  startedAt: string;
  lastObservedAt: string;
  validUntil: string | null;
  directionText: string | null;
  geometry: { type: string; coordinates: unknown } | null;
  geometrySemantics: string | null;
  locations: Array<{ id: string; name: string; relationType: RelationType; latitude: number | null; longitude: number | null }>;
  sources: Array<{ name: string; url: string | null; publishedAt: string }>;
}
