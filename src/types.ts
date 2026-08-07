export const THREAT_TYPES = [
  'uav', 'ballistic_missile', 'cruise_missile', 'guided_air_bomb',
  'aviation', 'mlrs', 'artillery', 'mortar', 'combined', 'unknown'
] as const;
export type ThreatType = typeof THREAT_TYPES[number];
export type EvidenceLevel = 'official' | 'confirmed' | 'monitoring' | 'unverified';
export type RelationType = 'explicit_threat' | 'mentioned' | 'reported_direction' | 'official_alert' | 'aftermath';

export interface NormalizedMessage {
  sourceId: string;
  externalId: string;
  publishedAt: Date;
  editedAt?: Date;
  text: string;
  rawPayload: Record<string, unknown>;
}

export interface ClassifiedMessage {
  threatType: ThreatType;
  signalThreatTypes: ThreatType[];
  locations: Array<{ id: string; relationType: RelationType; name: string }>;
  nationalScope: boolean;
  indicators: string[];
  directionText?: string;
  title: string;
  summary: string;
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
