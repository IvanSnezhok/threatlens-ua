import { Counter, type Registry } from 'prom-client';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { peakReportedCounts } from '../domain/reported-counts.js';
import { RAID_OUTCOMES, raidOutcomePhrase, raidOutcomes, type RaidOutcome } from '../domain/raid-outcome.js';
import { cachedLocationLexemes, relatedLocationIds, relatedLocationsCte } from '../repositories/events.js';
import { namedLocations } from '../domain/classifier.js';

/**
 * Розбір атаки — після відбою, а не під час тривоги.
 *
 * ================================================================================================
 * Що це і коли зʼявляється
 * ================================================================================================
 *
 * Рішення власника 20.08.2026: попередження під час удару має бути коротким — де ціль і що робити,
 * — а розбір того, чим саме атакували, читач має отримати ПІСЛЯ відбою, коли в нього зʼявився час
 * читати. Це друга половина тієї самої зміни, що стиснула термінове повідомлення до трьох рядків
 * (`src/bot/outbox.ts`): пояснення нікуди не поділося, воно переїхало туди, де його читають.
 *
 * Розбір будується на вікні офіційної тривоги — від `alert_periods.started_at` до `ended_at` — над
 * тим місцем, для якого тривогу оголошували, і всім, що під ним у каталозі. Він не будується під
 * час тривоги й не має власного розкладу: подія «відбій» — його єдиний привід.
 *
 * ================================================================================================
 * Три числа, і чому кожне з них саме таке
 * ================================================================================================
 *
 * **Скільки повідомлень.** Рахунок повідомлень каналів, і текст каже це вголос. Правило з
 * `CONTEXT.md` і `./attack-analytics.ts` — рахувати повідомлення, а не засоби — тут не послаблене:
 * «14 повідомлень про ударні БпЛА» є твердженням про наш архів і перевіряється по ньому.
 *
 * **Скільки цілей.** Єдине число про засоби, яке тут узагалі можливе, — це число, яке назвало САМЕ
 * джерело («10 шахедів курсом на Київщину»). Воно береться дослівно, ніколи не додається між
 * повідомленнями і підписується як цитата: «канали називали до 10» (`src/domain/reported-counts.ts`
 * пояснює, чому сума була б вигадкою). Джерела не назвали кількості — рядка немає, і це чесна й
 * найчастіша відповідь.
 *
 * **Де влучання чи збиття.** Не влучання, а СЛОВА про нього: «повідомляли про вибухи»,
 * «повідомляли про роботу ППО» (`src/domain/raid-outcome.ts`). Ми маємо пости каналів, а не дані
 * обʼєктового контролю, і різниця між цими двома реченнями — це вся різниця між переказом і
 * вигадкою.
 *
 * ================================================================================================
 * Чому проходів по архіву два, а не один
 * ================================================================================================
 *
 * Тому що найцінніше для розбору повідомлення не є твердженням про загрозу. «Вибухи в Полтаві» і
 * «Працює ППО на Полтавщині» правила класифікують як `unrecognized/not_an_assertion` — і мають
 * рацію: вибух не є загрозою, що наближається, і попереджати про нього нема кого. Наслідок для
 * архіву той, що така згадка не має ні події, ні звʼязку з місцем: `message_classifications` не
 * зберігає локацій, вони живуть на події.
 *
 * Тож перший прохід читає повідомлення, які СТВЕРДЖУВАЛИ загрозу, — через їхні події й місця на
 * них; це класи й кількості. Другий читає сирі тексти вікна й шукає в них маркери наслідків, а
 * місця для них розпізнає тим самим матчером каталогу, що й класифікатор (`namedLocations` у
 * `src/domain/classifier.ts`), відкидаючи все, що не належить території цієї тривоги. Один прохід
 * замість двох означав би розбір без жодного слова про вибухи — тобто без відповіді на питання, яке
 * читач і ставить уранці.
 *
 * ================================================================================================
 * Чого тут немає
 * ================================================================================================
 *
 * Майбутнього часу — жодного речення. Це опис закритого вікна, і кожен рядок стоїть у минулому.
 * Права щось змінити — теж: жоден запит нижче не пише в `threat_events`, `alert_periods`,
 * `alert_source_states`, `risk_signals` чи `system_event_log`. Розбір читає архів і складає текст;
 * він не може ні продовжити тривогу, ні оголосити відбій, ні створити подію.
 *
 * І моделі. Кожне речення тут детерміноване й переараховується з тих самих рядків архіву — з тієї ж
 * причини, з якої детермінований висновок у `./attack-analytics.ts`: розбір читають після того, як
 * усе скінчилося, і його цінність саме в тому, що його можна перевірити, а не в тому, як він
 * написаний.
 */

export const attackDebriefs = new Counter({
  name: 'threatlens_attack_debriefs_total',
  help: 'Post-all-clear attack debriefs, by outcome: composed, empty (nothing was reported), or failed',
  labelNames: ['outcome'],
  registers: []
});

export function registerAttackDebriefMetrics(registry: Registry): void {
  if (!registry.getSingleMetric('threatlens_attack_debriefs_total')) registry.registerMetric(attackDebriefs);
}

/** Скільки місць і класів потрапляє в один розбір. Читають його зранку, а не в укритті. */
const MAX_PLACES_PER_OUTCOME = 4;
const MAX_CLASSES = 4;
/** Скільки текстів повідомлень читається в память заради цитованих чисел і маркерів наслідків. */
const MAX_TEXTS = 400;

const THREAT_WORDS: Record<string, string> = {
  uav: 'ударні БпЛА', ballistic_missile: 'балістика', cruise_missile: 'крилаті ракети',
  guided_air_bomb: 'КАБи', aviation: 'авіація', mlrs: 'РСЗВ', artillery: 'артилерія',
  mortar: 'обстріли', combined: 'комбінована загроза', unknown: 'невизначена загроза'
};

export interface AttackDebrief {
  alertPeriodId: string;
  locationId: string;
  locationName: string;
  startedAt: Date;
  endedAt: Date;
  /** Хвилини тривоги, цілим числом. */
  durationMinutes: number;
  /** Скільки ПОВІДОМЛЕНЬ каналів припало на кожен клас, від найчастішого. */
  classes: Array<{ label: string; messages: number }>;
  /** Найбільше, що назвало одне повідомлення, по класах. Порожньо — джерела кількості не називали. */
  reported: Array<{ label: string; count: number }>;
  /** Маркери наслідків і місця, при яких вони прозвучали. */
  outcomes: Array<{ outcome: RaidOutcome; phrase: string; places: string[] }>;
  /** Скільки повідомлень усього лягло в основу розбору. Нуль означає «розбору немає». */
  messages: number;
}

interface DebriefRow {
  raw_text: string;
  threat_type: string | null;
}

/**
 * ПЕРШИЙ прохід: повідомлення, які стверджували загрозу над цим місцем або під ним.
 *
 * Ієрархія обходиться тим самим `relatedLocationsCte`, яким користуються підписки й публічні
 * читання: обласна тривога має зібрати повідомлення про міста всередині області, а міська —
 * обласні згадки, що накривають це місто. Власне порівняння `parent_id` тут відповідало б на інше
 * питання, ніж решта системи відповідає про ті самі два місця.
 */
async function debriefRows(locationId: string, from: Date, to: Date): Promise<DebriefRow[]> {
  const result = await pool.query<DebriefRow>(
    `${relatedLocationsCte()}
     SELECT sm.raw_text, mc.threat_type
       FROM message_classifications mc
       JOIN source_messages sm ON sm.id = mc.source_message_id
      WHERE mc.published_at >= $2 AND mc.published_at < $3
        AND mc.decision = ANY($4::text[])
        AND EXISTS (
          SELECT 1 FROM threat_event_locations el
           JOIN related_locations r ON r.id = el.location_id
          WHERE el.event_id = mc.event_id
        )
      ORDER BY mc.published_at
      LIMIT $5`,
    [locationId, from, to, ['event_created', 'event_merged', 'redirect'], MAX_TEXTS]
  );
  return result.rows;
}

/**
 * ДРУГИЙ прохід: сирі тексти вікна, у яких може стояти слово про наслідки.
 *
 * Без звʼязку з місцем і без класифікації — їх у цих повідомленнях немає, і саме тому тут беруться
 * сирі рядки. Фільтр за часом іде по `published_at`, як і в першому проході: розбір описує вікно
 * тривоги за годинником джерел, а не за нашим годинником прийому.
 *
 * `LIMIT` — не оптимізація, а межа памʼяті: під час масованої атаки в одне вікно може впасти кілька
 * тисяч повідомлень, і розбір, який читає їх усі, стає найдорожчою операцією ночі рівно в ту
 * хвилину, коли черга сповіщень найзавантаженіша.
 */
async function outcomeMentions(from: Date, to: Date): Promise<Array<{ raw_text: string }>> {
  const result = await pool.query<{ raw_text: string }>(
    `SELECT sm.raw_text FROM source_messages sm
      WHERE sm.published_at >= $1 AND sm.published_at < $2
      ORDER BY sm.published_at LIMIT $3`,
    [from, to, MAX_TEXTS]
  );
  return result.rows;
}

/**
 * Остання ЗАКРИТА тривога над цим місцем за добу, або `null`.
 *
 * Ієрархія береться тим самим обходом, що й усюди: тривога над областю є останньою тривогою і для
 * міста в ній, а міська — для області над ним. Вікно в добу — не оптимізація, а зміст: розбір
 * відповідає на питання «що це щойно було», і позавчорашня тривога на нього не відповідає.
 */
export async function lastEndedAlertPeriod(locationId: string, now = new Date()): Promise<string | null> {
  const result = await pool.query<{ id: string }>(
    `${relatedLocationsCte()}
     SELECT ap.id FROM alert_periods ap
      WHERE ap.status='ended' AND ap.ended_at IS NOT NULL AND ap.ended_at > $2::timestamptz - interval '24 hours'
        AND EXISTS (SELECT 1 FROM related_locations r WHERE r.id=ap.location_id)
      ORDER BY ap.ended_at DESC LIMIT 1`,
    [locationId, now]
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Найсвіжіший розбір, вартий показу, коли місце не назване.
 *
 * Публічна сторінка аналізу питає «що було останнім», не називаючи території, і найсвіжіша закрита
 * тривога на це питання здебільшого не відповідає: тривог у країні за добу сотні, і більшість із них
 * минають без жодного повідомлення каналів. Тому береться не остання, а остання ВАРТА показу — з
 * обмеженого числа кандидатів, щоб питання без відповіді коштувало обмеженої роботи, а не обходу
 * всіх тривог за добу.
 *
 * Кандидати впорядковані за часом відбою, тож перший знайдений і є найсвіжішим.
 */
export async function latestWorthwhileDebrief(candidates = 10, now = new Date()): Promise<AttackDebrief | null> {
  const recent = await pool.query<{ id: string }>(
    `SELECT id FROM alert_periods
      WHERE status='ended' AND ended_at IS NOT NULL AND ended_at > $1::timestamptz - interval '24 hours'
      ORDER BY ended_at DESC LIMIT $2`,
    [now, Math.max(1, candidates)]
  );
  for (const row of recent.rows) {
    const debrief = await buildAttackDebrief(row.id).catch(() => null);
    if (debriefWorthShowing(debrief)) return debrief;
  }
  return null;
}

/**
 * Складає розбір однієї закритої тривоги, або `null`, коли складати нема з чого.
 *
 * `null` — не помилка, а найчастіший результат: більшість тривог минають без жодного повідомлення
 * моніторингових каналів про це місце, і розбір, який у такому разі написав би «повідомлень: 0»,
 * був би листом заради листа.
 */
export async function buildAttackDebrief(alertPeriodId: string): Promise<AttackDebrief | null> {
  const period = await pool.query<{
    location_id: string; name_uk: string; started_at: Date; ended_at: Date | null; status: string;
  }>(
    `SELECT p.location_id, l.name_uk, p.started_at, p.ended_at, p.status
       FROM alert_periods p JOIN locations l ON l.id = p.location_id WHERE p.id = $1`,
    [alertPeriodId]
  );
  const row = period.rows[0];
  // Розбір існує лише для ЗАКРИТОЇ тривоги. Тривога, що триває, — це те, про що читач має думати
  // зараз, а не читати аналіз; і вікно в неї ще не закрите, тож будь-яке число було б проміжним.
  if (!row || row.status !== 'ended' || !row.ended_at) return null;

  const [asserted, mentions, related] = await Promise.all([
    debriefRows(row.location_id, row.started_at, row.ended_at),
    outcomeMentions(row.started_at, row.ended_at),
    relatedLocationIds(row.location_id)
  ]);
  const inScope = new Set(related);
  const lexemes = await cachedLocationLexemes();

  const byClass = new Map<string, number>();
  for (const message of asserted) {
    const threatType = message.threat_type ?? 'unknown';
    byClass.set(threatType, (byClass.get(threatType) ?? 0) + 1);
  }

  // Другий прохід. Маркер сам по собі нічого не дає: «вибухи» без місця могли бути де завгодно в
  // країні, і приписати їх території цієї тривоги означало б вигадати те, чого джерело не казало.
  // Тому в розбір потрапляє лише та згадка, у якій джерело НАЗВАЛО місце з цієї території.
  const outcomePlaces = new Map<RaidOutcome, Set<string>>();
  const outcomeTexts: string[] = [];
  for (const mention of mentions) {
    const markers = raidOutcomes(mention.raw_text);
    if (!markers.length) continue;
    const places = namedLocations(mention.raw_text, lexemes).filter((place) => inScope.has(place.id));
    if (!places.length) continue;
    outcomeTexts.push(mention.raw_text);
    for (const marker of markers) {
      const known = outcomePlaces.get(marker) ?? new Set<string>();
      for (const place of places) known.add(place.name);
      outcomePlaces.set(marker, known);
    }
  }

  const messages = asserted.length + outcomeTexts.length;
  if (!messages) {
    attackDebriefs.inc({ outcome: 'empty' });
    return null;
  }

  const durationMinutes = Math.max(0, Math.round((row.ended_at.getTime() - row.started_at.getTime()) / 60_000));
  attackDebriefs.inc({ outcome: 'composed' });
  return {
    alertPeriodId,
    locationId: row.location_id,
    locationName: row.name_uk,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMinutes,
    classes: [...byClass.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, MAX_CLASSES)
      .map(([threatType, messages]) => ({ label: THREAT_WORDS[threatType] ?? threatType, messages })),
    // Числа беруться з ОБОХ проходів: «10 шахедів» може стояти й у пості, який правила не визнали
    // твердженням. `peakReportedCounts` однаково не додає їх між собою.
    reported: peakReportedCounts([...asserted.map((message) => message.raw_text), ...outcomeTexts])
      .map((peak) => ({ label: peak.label, count: peak.count })),
    // Порядок маркерів — сталий, з домену, а не з того, який трапився першим у пості: два розбори
    // однієї ночі мають читатися однаково.
    outcomes: RAID_OUTCOMES
      .filter((outcome) => outcomePlaces.has(outcome))
      .map((outcome) => ({
        outcome,
        phrase: raidOutcomePhrase(outcome),
        places: [...outcomePlaces.get(outcome)!].sort((left, right) => left.localeCompare(right)).slice(0, MAX_PLACES_PER_OUTCOME)
      })),
    messages
  };
}

// ------------------------------------------------------------------------------------------------
// Текст
// ------------------------------------------------------------------------------------------------

function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = count % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} ${plural(minutes, 'хвилина', 'хвилини', 'хвилин')}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} ${plural(hours, 'година', 'години', 'годин')}${rest ? ` ${rest} хв` : ''}`;
}

/**
 * Розбір рядками, готовими до показу, — і кожен рядок називає, чиє це твердження.
 *
 * Формулювання належить цьому модулю, а не форматувальнику бота чи сторінці: рівно тут відомо, що
 * саме порахували, і рівно тут це можна назвати правильним словом. Бот і сторінка ці рядки лише
 * екранують — так само, як зроблено зі статистикою ударів (`./attack-stats.ts`).
 */
export function attackDebriefLines(debrief: AttackDebrief): string[] {
  const lines: string[] = [`Тривога тривала ${duration(debrief.durationMinutes)}.`];
  if (debrief.classes.length) {
    lines.push(`За цей час канали писали про: ${debrief.classes
      .map((entry) => `${entry.label} — ${entry.messages} ${plural(entry.messages, 'повідомлення', 'повідомлення', 'повідомлень')}`)
      .join('; ')}.`);
  }
  if (debrief.reported.length) {
    // «до N» і «в одному повідомленні» — обидва уточнення обовʼязкові: перше каже, що це стеля, а
    // не підсумок, друге — що числа не складалися. Без них рядок читався б як наш підрахунок.
    lines.push(`Кількість, яку називали самі джерела: ${debrief.reported
      .map((entry) => `${entry.label} — до ${entry.count}`)
      .join('; ')} (найбільше, назване в одному повідомленні; числа з різних повідомлень не додаються).`);
  }
  for (const outcome of debrief.outcomes) {
    lines.push(`${outcome.phrase[0]!.toUpperCase()}${outcome.phrase.slice(1)}: ${outcome.places.join(', ')}.`);
  }
  return lines;
}

/** Застереження, яке їде першим рядком розбору всюди, де його показують. */
export const ATTACK_DEBRIEF_DISCLAIMER =
  'Це підсумок повідомлень моніторингових каналів за час тривоги, а не офіційні дані про наслідки. '
  + 'Числа — те, що написали джерела; ми не рахуємо засобів і не встановлюємо місць влучань.';

/**
 * Чи варто взагалі показувати цей розбір.
 *
 * Одне повідомлення за тригодинну тривогу — це не розбір атаки, а один пост, який читач і так
 * бачив. Поріг стоїть тут, а не в кожного зі споживачів, щоб бот, команда й сторінка не розійшлися
 * в тому, що вважати вартим показу.
 */
export function debriefWorthShowing(debrief: AttackDebrief | null): debrief is AttackDebrief {
  return Boolean(debrief && debrief.messages >= config.ATTACK_DEBRIEF_MIN_MESSAGES);
}
