export const THREAT_TYPES = [
  'uav', 'ballistic_missile', 'cruise_missile', 'guided_air_bomb',
  'aviation', 'mlrs', 'artillery', 'mortar', 'combined', 'unknown'
] as const;
export type ThreatType = typeof THREAT_TYPES[number];
export type EvidenceLevel = 'official' | 'confirmed' | 'monitoring' | 'unverified';
/**
 * Зона поза Україною, з якої джерело повідомило походження загрози.
 *
 * Живе тут, а не в `src/domain/origin-zones.ts`, щоб напрям залежності лишався один: `types.ts` не
 * імпортує нічого й не має починати. Каталог зон із координатами та патернами читає цей тип, а не
 * навпаки.
 */
export type OriginZoneId = 'black_sea' | 'azov_sea';
/**
 * Who authored a threat event — the deterministic rules, or a promoted model verdict.
 *
 * Deliberately NOT folded into {@link EvidenceLevel}. That type answers "how well corroborated",
 * and a fifth value there would be read by every existing consumer as a fifth rung of the same
 * ladder: `strongestEvidence` in `src/repositories/events.ts` would have to rank it against
 * `official`, and `CONFIRMING_EVIDENCE` in `web/app.js` would have to decide whether it confirms.
 * The two axes are independent — a model event is always `unverified`, but an `unverified` event is
 * usually a human channel nobody has corroborated yet — so they are two columns and two types.
 *
 * The vocabulary is the pair migrations 016 and 034 already use for the same distinction — a model
 * either wrote this or it did not; see `migrations/041_threat_event_origin.sql`.
 */
export type ThreatOrigin = 'deterministic' | 'model';
/**
 * Коли загроза актуальна за словами джерела (міграція 049). `now` — звичайна жива загроза, як кожна
 * подія правил; решта — очікувані, з вікном `expectedFrom..expectedUntil`. Словник живе тут, бо його
 * читають і подія, і API, і бот; правила відмінювання й вікна — у `src/domain/threat-timing.ts`.
 */
export const THREAT_TIMINGS = ['now', 'within_hour', 'evening', 'within_day', 'within_two_days'] as const;
export type ThreatTiming = (typeof THREAT_TIMINGS)[number];
/** Хто збудував класифікацію події: правила чи модель у режимі `classifier_mode=codex`. */
export type ClassifiedBy = 'rules' | 'codex';
export type RelationType = 'explicit_threat' | 'mentioned' | 'reported_direction' | 'official_alert' | 'aftermath';

/**
 * Колір, яким влада уточнює ВЖЕ оголошену тривогу (диференційоване оповіщення, з 06.09.2026).
 *
 * Це ПРИКМЕТА тривоги, а не її тотожність. `null` — звичайне, найчастіше значення: тривога без
 * кольору показується точно так, як показувалася завжди. Рівень ніколи не бере участі в рішенні
 * «тривога є чи немає»: він не вмикає тривоги, не вимикає її і не може зробити ввімкнену
 * вимкненою — див. «Межі безпеки» в `CONTEXT.md`.
 *
 * Порядок у кортежі — від слабшого до сильнішого, і на нього спирається правило «береться
 * НАЙСИЛЬНІШИЙ із тих, хто тримає тривогу»: індекс у цьому масиві І Є силою рівня, тож додати
 * третій колір означає вставити його на своє місце тут, а не дописати окрему таблицю рангів.
 */
export const ALERT_LEVELS = ['yellow', 'red'] as const;
export type AlertLevel = (typeof ALERT_LEVELS)[number];

/**
 * Чим саме загрожують, за словами того, хто назвав рівень: дронова, ракетна чи ракетно-дронова.
 *
 * Окремо від {@link AlertLevel}, бо це дві незалежні осі: жовтий завжди дроновий, а червоний буває
 * будь-яким із трьох. Звести їх в одне значення означало б або втратити «масована дронова», або
 * вигадати рівень, якого влада не оголошувала. `null` — «джерело не сказало», і це не те саме, що
 * «загрози немає».
 *
 * Тут НЕМАЄ порядку сили: `drones_missiles` не «сильніше» за `missiles`, і жодне правило не
 * порівнює ці значення між собою — розбіжність двох джерел на одному рівні дає `null`.
 */
export const ALERT_KINDS = ['drones', 'missiles', 'drones_missiles'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/**
 * Єдине місце, де чуже значення стає значенням домену.
 *
 * Апстрім, який завтра вигадає четвертий колір, не має права розширити наш перелік: невідоме
 * значення стає `null` і далі не їде. `null` тут безпечний за побудовою — він означає рівно
 * «кольору не назвали», а це стан, який кожна поверхня вже вміє показувати.
 *
 * Функція, а не тип, і саме в цьому файлі: перевірка й перелік мають жити разом, інакше вони
 * розійдуться. `types.ts` нічого не імпортує, і ці дві функції нічого не імпортують теж.
 */
export function asAlertLevel(value: unknown): AlertLevel | null {
  return ALERT_LEVELS.find((level) => level === value) ?? null;
}

export function asAlertKind(value: unknown): AlertKind | null {
  return ALERT_KINDS.find((kind) => kind === value) ?? null;
}

/**
 * Сильніший із двох рівнів — правило «береться НАЙСИЛЬНІШИЙ», в одному місці й у єдиному
 * екземплярі.
 *
 * `null` слабший за будь-який колір, тож «одне джерело мовчить, друге каже red» дає red, а не
 * мовчання. Три шляхи згортають рівні цим правилом і мусять робити це однаково: дві мітки фіда, що
 * впали в один рядок каталогу; два рядки джерел, що впали в одну локацію; і зведення по всіх
 * джерелах, що тримають тривогу. Розійтися їм не можна — обережність тут дорожча за консенсус, і
 * саме тому це функція, а не три порівняння.
 *
 * Сила рівня — це його індекс у {@link ALERT_LEVELS}; «кольору не назвали» отримує -1, тобто
 * слабше за все, що назвали. Третій колір, вставлений у кортеж на своє місце, працює тут сам.
 */
export function strongerAlertLevel(left: AlertLevel | null, right: AlertLevel | null): AlertLevel | null {
  const rightRank = right === null ? -1 : ALERT_LEVELS.indexOf(right);
  const leftRank = left === null ? -1 : ALERT_LEVELS.indexOf(left);
  return rightRank > leftRank ? right : left;
}

/**
 * How the public presentation is timed. Nothing here gates collection, classification, audit,
 * `/ops`, `/metrics` or Telegram delivery — see `src/services/publication.ts`.
 */
export const PUBLICATION_MODES = ['live', 'delayed_15s'] as const;
export type PublicationMode = (typeof PUBLICATION_MODES)[number];

/**
 * Bounded Telegram media carried to the model classification pipeline.
 *
 * The deterministic classifier intentionally reads `text` only. Media-derived text or labels are
 * model evidence and may be reviewed in `/ops`. With the separate analytical-threat switch on, a
 * high-confidence assertion with verified geography may create an `unverified` event; media can
 * never create/cancel an official alert or withdraw a threat.
 */
export interface MessageMediaAttachment {
  kind: 'image' | 'audio';
  mimeType: string;
  bytes: Uint8Array;
  fileName?: string;
}

export interface NormalizedMessage {
  sourceId: string;
  externalId: string;
  publishedAt: Date;
  editedAt?: Date;
  text: string;
  rawPayload: Record<string, unknown>;
  media?: MessageMediaAttachment[];
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
  /**
   * Зона, з якої джерело повідомило походження загрози, або `null`.
   *
   * Це ЄДИНА географія поза Україною, яку система визнає, і вона зчитується з тексту, а не
   * виводиться з класу зброї: повідомлення про зліт авіації не називає аеродрому, тож зона, здогадана
   * за типом індикатора, була б нашим припущенням у вигляді карти. Див. `src/domain/origin-zones.ts`.
   */
  originZone?: OriginZoneId | null;
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
  /**
   * Beside `evidenceLevel`, never instead of it. `web/app.js` reads the pair: `unverified` alone
   * prints «не перевірено», and `unverified` + `model` adds «оцінка моделі», because those are two
   * different claims and the map used to make them look identical.
   */
  origin: ThreatOrigin;
  /**
   * Актуальність, ймовірність і вікно очікування (міграція 049). `now` з `probability: null` — подія
   * правил, точно така, як була. Очікувана подія (`timing` ≠ now) — не жива загроза зараз: карта
   * не заливає нею територію, картка й бот підписують її «очікується …», і саме за цими полями.
   */
  timing: ThreatTiming;
  probability: number | null;
  expectedFrom: string | null;
  expectedUntil: string | null;
  classifiedBy: ClassifiedBy;
  assessmentNote: string | null;
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
