import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';

const $ = (selector, root = document) => root.querySelector(selector);
const threatNames = {
  uav: 'Ударні БпЛА', ballistic_missile: 'Балістична загроза',
  cruise_missile: 'Крилаті ракети', guided_air_bomb: 'Керовані авіабомби',
  aviation: 'Активність авіації', mlrs: 'РСЗВ', artillery: 'Артилерія',
  mortar: 'Мінометний обстріл', combined: 'Комбінована загроза', unknown: 'Невизначена загроза'
};

// Дзеркальна копія каталогу іконок із src/domain/threat-icons.ts — фронтенд збирається окремим
// бандлом і не імпортує з src/. Змінюєш тут — зміни й там. Розбіжність тут не падає складанням:
// вона малює не ту іконку, тож її ловить тест дзеркала у src/api/vector-isolation.test.ts.
// Кожен path — ОДИН нерозривний рядковий літерал, без конкатенації через `+`. Тест дзеркала
// імпортує THREAT_ICON_PATHS у рантаймі й перевіряє includes() по тексту цього файлу; розбитий на
// частини рядок такої перевірки не пройде, і дзеркало лишилося б неперевіреним.
//
// Жоден гліф не є стрілкою, вектором або чимось, що показує на місце: стрілка на полігоні —
// це заява про передбачену ціль, а система цього не робить і каже так у восьми місцях.
const threatIconPaths = {
  ballistic_missile: 'M2.6 21.6 C3.9 13.6 7.6 7.6 13.6 4.4 C16.3 3.0 18.6 3.6 19.9 5.8 L17.5 7.2 C16.9 6.2 15.9 6.0 14.7 6.6 C9.6 9.3 6.4 14.4 5.1 21.6 Z M16.3 9.4 L23.1 9.4 L19.7 21.8 Z',
  guided_air_bomb: 'M12 21.6 C9.0 21.6 6.6 19.0 6.6 15.4 C6.6 10.6 9.0 5.4 12 1.8 C15.0 5.4 17.4 10.6 17.4 15.4 C17.4 19.0 15.0 21.6 12 21.6 Z M7.2 4.2 L12 8.0 L16.8 4.2 L16.8 6.6 L12 10.4 L7.2 6.6 Z M17.0 12.2 L22.6 10.4 L22.6 12.6 L17.0 14.2 Z',
  cruise_missile: 'M3.6 10.6 L17.8 10.6 C20.4 10.6 22.4 11.5 22.4 12.6 C22.4 13.7 20.4 14.6 17.8 14.6 L3.6 14.6 Z M10.6 10.6 L8.2 6.4 L11.0 6.4 L13.4 10.6 Z M10.6 14.6 L8.2 18.8 L11.0 18.8 L13.4 14.6 Z M3.6 10.6 L1.6 5.6 L4.4 5.6 L6.0 10.6 Z',
  combined: 'M13.2 3.2 L19.6 3.2 L16.6 14.4 Z M7.4 8.6 L13.0 20.2 L1.8 20.2 Z',
  mlrs: 'M2.6 19.2 L21.4 19.2 L21.4 21.8 L2.6 21.8 Z M6.8 3.4 L8.4 7.0 L8.4 18.2 L5.2 18.2 L5.2 7.0 Z M12 2.2 L13.6 5.8 L13.6 18.2 L10.4 18.2 L10.4 5.8 Z M17.2 3.4 L18.8 7.0 L18.8 18.2 L15.6 18.2 L15.6 7.0 Z',
  uav: 'M12 2.6 L22.4 17.2 L1.6 17.2 Z M10.6 6.4 L13.4 6.4 L13.4 21.4 L10.6 21.4 Z M4.6 21.4 L10.6 17.6 L10.6 21.4 Z M19.4 21.4 L13.4 17.6 L13.4 21.4 Z',
  artillery: 'M3.6 21.6 L20.4 21.6 L18.0 16.2 L6.0 16.2 Z M8.6 17.6 L11.0 15.2 L21.2 5.0 L18.8 7.4 Z',
  mortar: 'M4.2 20.0 L19.8 20.0 L19.8 22.4 L4.2 22.4 Z M6.6 19.3 L11.0 7.1 L15.0 8.5 L10.6 20.7 Z M14.6 1.6 C16.1 3.0 16.8 4.3 16.8 5.3 C16.8 6.6 15.8 7.5 14.6 7.5 C13.4 7.5 12.4 6.6 12.4 5.3 C12.4 4.3 13.1 3.0 14.6 1.6 Z',
  aviation: 'M12 1.6 C13.0 2.9 13.5 4.4 13.5 6.0 L13.5 20.0 C13.5 21.2 12.9 22.2 12 22.4 C11.1 22.2 10.5 21.2 10.5 20.0 L10.5 6.0 C10.5 4.4 11.0 2.9 12 1.6 Z M10.5 9.0 L0.8 15.4 L0.8 17.2 L10.5 14.6 Z M13.5 9.0 L23.2 15.4 L23.2 17.2 L13.5 14.6 Z M10.5 18.4 L5.6 21.0 L5.6 22.2 L10.5 21.0 Z M13.5 18.4 L18.4 21.0 L18.4 22.2 L13.5 21.0 Z',
  unknown: 'M6.4 2.8 H17.6 A3.6 3.6 0 0 1 21.2 6.4 V17.6 A3.6 3.6 0 0 1 17.6 21.2 H6.4 A3.6 3.6 0 0 1 2.8 17.6 V6.4 A3.6 3.6 0 0 1 6.4 2.8 Z M12.0 6.0 C9.8 6.0 8.2 7.5 8.2 9.6 H10.8 C10.8 8.8 11.3 8.3 12.0 8.3 C12.8 8.3 13.3 8.8 13.3 9.5 C13.3 10.2 12.9 10.7 12.1 11.3 C11.0 12.1 10.7 12.9 10.7 14.2 V14.8 H13.3 V14.4 C13.3 13.6 13.6 13.2 14.4 12.6 C15.5 11.8 15.9 10.9 15.9 9.5 C15.9 7.4 14.3 6.0 12.0 6.0 Z M10.6 16.4 H13.4 V19.2 H10.6 Z'
};
// Дзеркальна копія ICON_TONE_ARIA_UK із src/domain/threat-icons.ts. Змінюєш тут — зміни й там.
const threatIconAria = {
  consequence: 'повідомлено наслідки',
  confirmed: 'підтверджене джерело',
  reported: 'повідомлення моніторингу',
  analytic: 'аналітична оцінка, не тривога'
};
// Підпис іконки — це та сама назва класу, яку вже показує картка події. Окрема копія розійшлася б.
const threatIconLabels = threatNames;
// Короткі підписи ЛИШЕ для сітки легенди 2×5. «Мінометний обстріл» у колонці завширшки 130 px
// переноситься в три рядки й розвалює сітку, а легенда з десятьма різновисокими клітинками
// перестає читатися одним поглядом. Повна назва нікуди не дівається: вона лишається в aria-label
// і в title кожного рядка, тобто доступна і читачеві екрана, і курсору.
const threatIconShortLabels = {
  uav: 'БпЛА', ballistic_missile: 'Балістика', cruise_missile: 'Крилаті', guided_air_bomb: 'КАБ',
  aviation: 'Авіація', mlrs: 'РСЗВ', artillery: 'Артилерія', mortar: 'Міномети',
  combined: 'Комбінована', unknown: 'Невизначена'
};
const iconTones = ['consequence', 'confirmed', 'reported', 'analytic'];
// #ff4747 тут не зʼявляється ніколи: червоне зарезервоване за офіційною тривогою, а тривога —
// це заливка полігона, а не іконка. Іконка, що позичила б колір тривоги, дала б повідомленню
// моніторингу вигляд рішення держави.
const iconChipColor = { consequence: '#ffcf8a', confirmed: '#ff7a4d', reported: '#ff7a4d', analytic: '#8f9b94' };
const iconChipAlpha = { consequence: 1, confirmed: 1, reported: .72, analytic: 1 };
const iconImageId = (threatType, tone) => `ti-${threatType}-${tone}`;
const iconAriaLabel = (threatType, tone) => `${threatIconLabels[threatType] ?? threatType} — ${threatIconAria[tone]}`;
const ICON_CHIP_PX = 30;        // CSS px — фінальний розмір фішки на карті
const ICON_PIXEL_RATIO = 2;     // бітмап 60×60, як у occupation-hatch-pattern
const ICON_GLYPH_BOX = 18;      // CSS px — у цей квадрат вписується гліф
const ICON_GLYPH_GRID = 24;     // сітка, на якій намальовано path-рядки
// icon-offset вимірюється в пікселях, помножених на icon-size (тут 1), а НЕ в ширинах іконки:
// в емах кегля вимірюється лише text-offset, і саме для нього правильні ICON_BADGE_OFFSET.
// Крок 34 px проти фішки 30 px лишає 4 px проміжку — рівно стільки, щоб власний темний обвід
// фішки читався як роздільник на будь-якому масштабі.
const ICON_SLOT_OFFSETS = {
  1: [[0, 0]],
  2: [[-17, 0], [17, 0]],
  3: [[-34, 0], [0, 0], [34, 0]]
};
const ICON_BADGE_OFFSET = { 1: [1.9, 0], 2: [3.5, 0], 3: [5.5, 0] };
// Кегль бейджа. Названий, бо text-offset міряється в емах САМЕ цього кегля, і будь-який зсув
// бейджа, порахований у пікселях, доводиться ділити на нього.
const ICON_BADGE_TEXT_SIZE = 11;
// Стек території, яка не є областю, підіймається на один крок над обласним. Київ (ua-80) лежить
// усередині Київщини (ua-32), і їхні центроїди розходяться лише на 17 км — 6 px на стартовому
// масштабі 5.1 і 20 px на районному, тоді як сам стек із трьох фішок має 98 px завширшки. Обидва
// шари несуть icon-allow-overlap: true, тобто колізіям заборонено розводити їх самим, і без цього
// підйому два стеки з двома бейджами «+N» друкувалися б один поверх одного. Зсув у пікселях, а не
// в градусах: географічний нудж танув би з масштабом саме там, де стеки найближчі. Те саме розводить
// районний стек і стек його області на районному масштабі.
const ICON_TIER_LIFT = -34;
const MAX_ICON_SLOTS = 3;
// Усі чотири шари несуть той самий locationId на тій самій фічі, тож дотик по іконці, по проміжку
// між іконками або по бейджу «+N» відкриває ту саму панель. Саме тому 30-піксельна фішка є
// прийнятною ціллю для пальця: точність дотику тут не є вимогою.
const iconLayerIds = ['territory-icon-slot-0', 'territory-icon-slot-1', 'territory-icon-slot-2', 'territory-icon-badge'];
// Тон іконки належить тій самій групі перемикачів, що й полігон, який він пояснює. Перемикач
// «Тривоги» не ховає жодної іконки: офіційна тривога — це не іконка, це заливка.
const iconToneGroup = { consequence: 'consequences', confirmed: 'threats', reported: 'threats', analytic: 'assessments' };

const levelNames = { background: 'фоновий', elevated: 'підвищений', significant: 'значний', high: 'високий', very_high: 'дуже високий' };
const evidenceNames = { official: 'офіційно', confirmed: 'підтверджено', monitoring: 'моніторинг', unverified: 'не перевірено' };
const confidenceNames = { low: 'низька', medium: 'середня', high: 'висока' };
// Рівень джерела людині нічого не каже літерою. Назва каже все, а літера лишається в дужках для тих,
// хто читав методологію.
const tierNames = { A: 'офіційне джерело', B: 'моніторинговий канал', C: 'допоміжний канал' };
// Дзеркало signalTypeLabels із src/services/risk.ts — фронтенд збирається окремим бандлом і не
// імпортує з src/. Назви індикаторів («зліт стратегічної авіації») мапа пропускає без змін:
// класифікатор уже пише їх українською.
const signalTypeNames = {
  explicit_threat: 'пряма загроза цій території',
  reported_direction: 'ціль рухається в цьому напрямку',
  mentioned: 'територію згадано в повідомленні',
  official_alert: 'офіційна тривога',
  aftermath: 'повідомлення про наслідки на місці',
  national_posture: 'загальнонаціональне попередження',
  child_location_signal: 'сигнал із населеного пункту всередині території'
};
// Причини зміни статусу події зберігаються ідентифікаторами — у хронології їх читає людина.
const updateReasonNames = {
  stronger_evidence_received: 'надійшло вагоміше підтвердження',
  two_independent_tier_a_or_b_sources: 'підтвердили два незалежні джерела',
  source_message_edited: 'джерело відредагувало повідомлення',
  last_source_assertion_withdrawn: 'джерело відкликало повідомлення',
  validity_window_elapsed: 'минув строк дії повідомлення'
};
const statusNames = {
  active: 'триває', observed: 'спостерігається', confirmed: 'підтверджено',
  withdrawn: 'відкликано', corrected: 'виправлено', expired: 'втратила чинність'
};
const occupationLayerIds = ['occupation-fill', 'occupation-hatch', 'occupation-line', 'occupation-contested-line'];
const occupationColor = ['case', ['==',['get','status'],'occupied'], '#ff7a4d', ['==',['get','status'],'liberated'], '#72d6ca', '#8f9b94'];

// Вектор загрози — це ланцюг ПОВІДОМЛЕНЬ, а не траєкторія. Один відрізок = один перехід, у якого є
// джерело, час і рівень доказовості. Три різні шари ліній, бо MapLibre не вміє керувати
// line-dasharray за даними, а різниця між рівнями доказовості мусить бути видима, а не описана:
//   transit   — одне повідомлення ствердило сам рух («повз Бровари на Бориспіль»): суцільна лінія;
//   direction — повідомлено напрямок, але не прибуття: штрихова;
//   sequence  — два різні повідомлення в різний час; порядок наш, рух не стверджував ніхто: крапкова.
// Порядок у масиві збігається з порядком додавання шарів і, отже, з їхнім z-порядком.
const vectorLayerIds = ['threat-vector-sequence','threat-vector-direction','threat-vector-transit','threat-vector-nodes','threat-vector-order','threat-vector-arrowhead','threat-vector-class'];
const vectorColor = '#ff7a4d';
const vectorBasisLabels = {
  reported_transit: 'джерело повідомило сам рух',
  reported_direction: 'джерело повідомило напрямок',
  observation_sequence: 'послідовність окремих повідомлень'
};

// ВІСТРЯ = ЗАЯВА ПРО РУХ, і воно належить рівно тим двом рівням доказовості, де рух ствердило
// джерело. Це найважливіше правило цього файлу після самої заборони екстраполяції:
//
//   reported_transit   — «Балістика повз Полтаву на Харків»: одне повідомлення назвало і те, що
//                        минають, і те, до чого йдуть. Рух ствердив публікатор → суцільне вістря.
//   reported_direction — «у напрямку Харкова»: джерело назвало курс, але не прибуття. Рух ствердило,
//                        напрямок теж → вістря, але порожнє: контур замість заливки, бо прибуття
//                        ніхто не обіцяв.
//   observation_sequence — вістря НЕ ОТРИМУЄ НІКОЛИ. Порядок цих двох повідомлень наш, і стрілка
//                        на ньому була б твердженням, якого не робило жодне джерело. Крапкова лінія
//                        з номерами вузлів лишається єдиним, що показує послідовність.
//
// Відсутність ключа в цій таблиці — і є те правило. `vectorHeadCollection()` читає її, а не список
// винятків, тож новий рівень доказовості за замовчуванням лишається без стрілки.
const ARROW_BASIS_IMAGES = {
  reported_transit: 'threat-vector-arrow-solid',
  reported_direction: 'threat-vector-arrow-open'
};
const VECTOR_ARROW_PX = 16;        // CSS px — сторона бітмапа вістря
// Фішка класу стоїть ПІД головою ланцюга. Зсув саме вертикальний, а не вбік: вістря повернуте за
// курсом, і бічний зсув фішки то накривав би його, то відлітав від нього залежно від того курсу.
// А вниз, а не вгору, тому що над вузлом уже стоїть його номер (threat-vector-order, text-offset
// -1.3 em): фішка додається пізніше, тобто лежить вище, і зсунута вгору вона накрила б саме той
// номер, яким читається порядок повідомлень. +30 px лишає просвіт і над вістрям, і під номером на
// обох кінцях інтерполяції icon-size. Одиниці — пікселі, помножені на icon-size, як і в ICON_SLOT_OFFSETS.
const VECTOR_CLASS_OFFSET = [0, 30];

// Хороплет тривог. Заливка регіону, а не точка: офіційний канал оголошує тривогу на цілу територію,
// а в районів у каталозі KATOTTG узагалі немає координат, тож точка для них неможлива в принципі.
const alertColor = '#ff4747';
// Дзеркало --threat / --consequence / --analytic із web/styles.css. Карта й інтерфейс мусять
// називати ту саму річ тим самим кольором. Змінюєш тут — зміни й там.
// Червоний зарезервовано за офіційною тривогою: жоден інший стан його не бере.
const threatColor = '#ff7a4d';        // той самий відтінок, що й vectorColor, і з тієї ж причини
const consequenceColor = '#ffcf8a';
const analyticColor = '#8f9b94';
const alertLayerIds = ['alert-oblast-fill','alert-raion-fill','alert-raion-line','alert-oblast-line','alert-oblast-label','alert-raion-label'];
const threatLayerIds      = ['threat-oblast-fill','threat-raion-fill','threat-raion-line','threat-oblast-line'];
const consequenceLayerIds = ['consequence-oblast-fill','consequence-raion-fill','consequence-raion-line','consequence-oblast-line'];
const analyticLayerIds    = ['analytic-raion-line','analytic-oblast-line'];
// Районний полігон під курсором шукаємо в усіх районних заливках, а не лише в тривожній:
// вимкнений перемикач «Тривоги» не має відбирати можливість клікнути район.
const raionFillLayerIds   = ['alert-raion-fill','threat-raion-fill','consequence-raion-fill'];
// Район світиться на БУДЬ-ЯКОМУ масштабі, разом із областю й нарівні з нею. Тривогу оголошують на
// конкретні райони, і карта країни мусить показувати саме їх: залити цілу область через один її
// район означало б намалювати географію, якої джерело не називало. Тихі райони тієї самої області
// лишаються темними. Масштаб керує лише товщиною ліній і кеглем підписів — естетикою, а не складом
// того, що на карті стверджується.
//
// ICON_TIER_ZOOM лишився ЄДИНИМ порогом масштабу на карті: нижче за нього стеки іконок обласні,
// вище — районні. Це свідома асиметрія з полігонами, а не забутий залишок: гліф — заява про клас
// зброї над конкретною точкою, і 136 таких заяв оглядовий масштаб не витримує.
const ICON_TIER_ZOOM = 6.8;
// alert — тривогу оголошено дослівно на цю територію.
// unmapped — тривога в її частині, для якої контуру немає взагалі (місто, громада), тож детальнішої
//            картинки не буде; такий регіон світиться сам, інакше тривога зникла б із карти зовсім.
// partial — тривога лише в тій частині території, яка МАЄ власний контур. Цей стан більше не малює
//            нічого й ніде: за нього говорять засвічені районні полігони всередині. Ключі *Partial
//            далі пишуться у feature-state (див. territoryStateOf) — це машинно читаний запис про
//            похідне покриття, — але жоден вираз фарби їх не читає.
const alertFlag = ['boolean', ['feature-state', 'alert'], false];
const unmappedFlag = ['boolean', ['feature-state', 'unmapped'], false];
// Ті самі дві ролі, помножені на три інші сімейства станів. Назви ключів тривоги лишаються
// історичними (unmapped без префікса) саме тому, що вирази тривожних шарів мусять лишатися
// впізнаваними при читанні поруч із рештою.
const threatFlag            = ['boolean', ['feature-state', 'threat'], false];
const threatUnmappedFlag    = ['boolean', ['feature-state', 'threatUnmapped'], false];
const consequenceFlag         = ['boolean', ['feature-state', 'consequence'], false];
const consequenceUnmappedFlag = ['boolean', ['feature-state', 'consequenceUnmapped'], false];
const analyticFlag          = ['boolean', ['feature-state', 'analytic'], false];
const analyticUnmappedFlag  = ['boolean', ['feature-state', 'analyticUnmapped'], false];
// Аналітична оцінка — найслабший сигнал на карті. Там, де вже є тривога або загроза, вона мовчить
// повністю: два контури на одному полігоні читаються як два різні твердження про одне й те саме.
// Похідне покриття сюди не входить: воно тепер не малює нічого, тож і глушити ним пунктир не можна —
// інакше дослівно названа оцінка області зникала б через тривогу в одному сусідньому районі.
const strongerThanAnalytic = ['any',
  alertFlag, unmappedFlag, threatFlag, threatUnmappedFlag];
const crimeaSovereignty = ['==', ['get', 'sovereignty'], 'crimea-ukraine'];

let snapshot = null;
let map = null;
let config = null;
let locations = [];
let adminBoundaries = { type: 'FeatureCollection', features: [] };
let raionBoundaries = null;
let regionFeatures = new Map();
let oblastIds = new Set();
let raionIds = new Set();
let mapLayersReady = false;
const regionCentroids = new Map();
let countryBoundary = { type: 'FeatureCollection', features: [] };
let occupation = null;
let occupationVisible = true;
let occupationLayersReady = false;
let occupationLegendOpen = null;
let occupationFetchedAt = null;
let vectors = [];
let vectorLegendOpen = null;
// null — оператор ще не чіпав легенду, тобто вона згорнута. Три розгорнуті легенди накривали
// половину карти, тож стан «за замовчуванням» тепер один на всі ширини — закрито. Сам механізм
// не змінився: клік записує сюди булеве значення, і саме воно переживає перемальовування
// сторінки на кожну подію потоку.
let threatLegendOpen = null;
// Реєстрація сорока зображень і чотири шари, що їх малюють. Обидва прапорці скидаються разом із
// картою: map.addImage не переживає map.remove(), а карту знищують на кожному переході з маршруту.
let iconImagesReady = false;
let iconLayersReady = false;
let iconTier = null;           // 'oblast' | 'raion'
let openTerritoryId = null;
let aiRunsSurface = '';
let opsAuthorization = '';
let codexPollTimer = null;
// Опитування картки оновлення. Свій таймер, а не спільний із Codex: він мусить пережити те, що
// вимикає все інше — перезапуск самого застосунку під час оновлення.
let deployPollTimer = null;
// Останнє, що картка оновлення бачила. Потрібне рівно для одного стану: опит зірвався, і треба
// вирішити, чи це «сервер лежить», чи «сервер саме перезапускається, бо оновлення триває».
let lastDeployData = null;
// Порядок і вікно відомості покриття. На рівні модуля, а не в DOM, бо секція перемальовується
// цілком (кнопка «Оновити», зміна вікна), і вибір оператора не має права зникати разом із нею.
let coverageSort = 'messages-desc';
let coverageWindowDays = 7;
let lastReceived = null;
let refreshTimer = null;
let backendStatus = 'current';
// Маршрут, вміст якого зараз лежить у #app. Потрібен рівно одному місцю — консолі, яка не
// перемальовується від оновлення знімка: без нього прямий вхід на /ops лишив би #app порожнім,
// бо перший рендер після boot() приходить саме зі знімка.
let renderedRoute = null;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

// Єдиний шлях, яким консоль ходить у /ops/*. Обидва заголовки ставляться тут, і тільки тут.
//
// X-Requested-With — не автентифікація, а позначка «це запит застосунку, а не адресного рядка». За
// нею сервер (див. opsUnauthorized у src/api/ops-auth.ts) вирішує, чи додавати до 401 заголовок
// WWW-Authenticate. Без цієї позначки Chrome перехоплює 401 навіть на fetch(): показує власне сіре
// вікно логіна, промис не повертається до renderOps(), і форма «Вхід оператора» ніколи не
// малюється — прямий вхід на /ops лишався порожньою сторінкою за системним запитом пароля.
//
// Ставиться завжди, у тому числі на найпершому запиті без opsAuthorization: саме той 401 і був
// причиною вікна.
function opsFetch(url, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set('X-Requested-With', 'XMLHttpRequest');
  if (opsAuthorization) headers.set('Authorization', opsAuthorization);
  return fetch(url, { ...options, headers });
}

function basicAuthorization(username, password) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

function kyivTime(date = new Date()) {
  return new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

function shortTime(value) {
  return new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function timeAgo(value) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds} с тому`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} хв тому`;
  return `${Math.floor(seconds / 3600)} год тому`;
}

function localLocationId(shapeIso) {
  const overrides = { 'UA-09': 'ua-44', 'UA-30': 'ua-80', 'UA-40': 'ua-85', 'UA-77': 'ua-73' };
  return overrides[shapeIso] ?? shapeIso?.toLowerCase();
}

function enrichBoundaries(geojson) {
  const byId = new Map(locations.map((item) => [item.id, item]));
  return {
    ...geojson,
    features: geojson.features.map((feature) => {
      const locationId = localLocationId(feature.properties.shapeISO);
      const location = byId.get(locationId);
      return { ...feature, properties: {
        ...feature.properties, locationId,
        nameUk: location?.name_uk ?? feature.properties.shapeName,
        sovereignty: ['ua-43','ua-85'].includes(locationId) ? 'crimea-ukraine' : 'ukraine'
      } };
    })
  };
}

function cityCollection() {
  return { type: 'FeatureCollection', features: locations
    .filter((item) => ['city','special_city'].includes(item.type) && item.longitude != null && item.latitude != null)
    .map((item) => ({ type: 'Feature', id: item.id, geometry: { type: 'Point', coordinates: [item.longitude, item.latitude] },
      properties: { locationId: item.id, nameUk: item.name_uk, sovereignty: item.id === 'ua-85' ? 'crimea-ukraine' : 'ukraine' } })) };
}

function raionCollection() {
  return raionBoundaries ?? { type: 'FeatureCollection', features: [] };
}

// Індекс полігонів за locationId — джерело назв і точок для підписів тривог.
// Перебудовується лише коли приходить нова геометрія, а не на кожен тік потоку.
function indexRegionFeatures() {
  regionFeatures = new Map();
  regionCentroids.clear();
  oblastIds = new Set();
  raionIds = new Set();
  for (const feature of adminBoundaries.features) {
    const id = feature.properties?.locationId;
    if (!id) continue;
    regionFeatures.set(id, feature);
    oblastIds.add(id);
  }
  for (const feature of raionCollection().features) {
    const id = feature.properties?.locationId;
    if (!id || oblastIds.has(id)) continue;
    regionFeatures.set(id, feature);
    raionIds.add(id);
  }
}

function ringCentroid(ring) {
  let x = 0, y = 0, area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1]);
    area += cross; x += (ring[j][0] + ring[i][0]) * cross; y += (ring[j][1] + ring[i][1]) * cross;
  }
  return area ? [x / (3 * area), y / (3 * area)] : ring[0];
}

// Підпис ставимо в центроїд найбільшого кільця полігона. Координати з каталогу тут не годяться:
// у районів їх немає взагалі, а в областей вони вказують на адміністративний центр, а не на середину території.
function regionCentroid(id) {
  if (regionCentroids.has(id)) return regionCentroids.get(id);
  const geometry = regionFeatures.get(id)?.geometry;
  const polygons = geometry?.type === 'MultiPolygon' ? geometry.coordinates
    : geometry?.type === 'Polygon' ? [geometry.coordinates] : [];
  let ring = null, largest = 0;
  for (const polygon of polygons) {
    const outer = polygon?.[0];
    if (!Array.isArray(outer) || outer.length < 4) continue;
    let area = 0;
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) area += (outer[j][0] * outer[i][1]) - (outer[i][0] * outer[j][1]);
    if (Math.abs(area) > largest) { largest = Math.abs(area); ring = outer; }
  }
  const point = ring ? ringCentroid(ring) : null;
  regionCentroids.set(id, point);
  return point;
}

// Каталог локацій приходить один раз у boot() і більше не змінюється, тож індекси будуються
// ліниво й назавжди. Без цього кожен тік потоку перебудовував би три мапи по всьому каталогу.
let locationIndex = null;
function locationIndexes() {
  if (!locationIndex) locationIndex = {
    parents: new Map(locations.map((item) => [item.id, item.parent_id])),
    types:   new Map(locations.map((item) => [item.id, item.type])),
    names:   new Map(locations.map((item) => [item.id, item.name_uk]))
  };
  return locationIndex;
}
// Дзеркало LOCATION_HIERARCHY_MAX_DEPTH із src/repositories/events.ts. Каталог тритирівневий,
// вісім кроків — це запас на випадок зіпсованого parent_id, а не очікувана глибина.
const LOCATION_HIERARCHY_MAX_DEPTH = 8;

// Звʼязки, які СТВЕРДЖУЮТЬ загрозу саме для цієї території. `mentioned` сюди не входить свідомо:
// класифікатор ставить його для транзиту («повз Миколаїв» — щось пройшло повз, у бік того місця
// не цілилися) і як запасний варіант для будь-якого аліаса, знайденого в тексті. Помаранчева
// заливка на .28 — це твердження, якого джерело не робило. Такі локації лишаються в панелі
// території рядком «згадано джерелом»: втрачаємо не інформацію, а лише заяву.
// `official_alert` є в enum і у двох CHECK, але його не пише жоден код; ранжуємо як mentioned.
const ASSERTING_RELATIONS = new Set(['explicit_threat', 'reported_direction', 'aftermath']);
// Доказовість, за якої «наслідки» стають окремим штрихованим полігоном. Регулярка наслідків у
// relationFor() перевіряє ВЕСЬ текст повідомлення і ніколи не дивиться на аліас, тож у
// повідомленні «Вибухи в Одесі, ракети повз Миколаїв» aftermath дістається й Миколаєву.
// Найсильніша фактична заява на карті не має спиратися на найслабший рівень доказовості.
const CONFIRMING_EVIDENCE = new Set(['official', 'confirmed']);
// Аналітичний контур має власний поріг: background-оцінка не малює нічого. Поріг контуру нижчий
// за поріг ІКОНКИ (significant, етап 2) — пунктирний контур це підказка, гліф це заява.
const ANALYTIC_CONTOUR_FLOOR = new Set(['elevated', 'significant', 'high', 'very_high']);

/**
 * Стан територій за знімком: чотири незалежні сімейства, по три множини в кожному.
 *
 * direct   — територію названо дослівно (у повідомленні або в каталозі, який його розібрав);
 * covered  — предок названої території; на оглядовому масштабі без цього область виглядала б
 *            спокійною, поки в її районі триває тривога;
 * unmapped — найближчий предок із контуром, коли в самої названої території контуру немає
 *            (місто, громада). Він не гасне з наближенням: детальнішого шару, який його
 *            підмінить, не існує.
 *
 * Географію не вигадуємо: полігон засвічується лише для дослівно названої території або для її
 * найближчого предка з контуром. Загальнонаціональне попередження (location_id = 'ua') не дає
 * жодного полігона взагалі — 27 підсвічених областей були б твердженням, якого не робило жодне
 * джерело.
 */
function territoryCoverage() {
  const { parents, types } = locationIndexes();
  const family = () => ({ direct: new Set(), covered: new Set(), unmapped: new Set() });
  const coverage = { alert: family(), threat: family(), consequence: family(), analytic: family() };

  const claim = (fam, id) => {
    if (!id) return;
    // Країна — не територія на карті. Див. коментар вище.
    if (id === 'ua' || types.get(id) === 'country') return;
    fam.direct.add(id);
    const seen = new Set([id]);
    let anchored = regionFeatures.has(id);
    let parent = parents.get(id);
    let depth = 0;
    while (parent && !seen.has(parent) && depth < LOCATION_HIERARCHY_MAX_DEPTH) {
      seen.add(parent);
      depth += 1;
      fam.covered.add(parent);
      if (!anchored && regionFeatures.has(parent)) { anchored = true; fam.unmapped.add(parent); }
      parent = parents.get(parent);
    }
  };

  for (const alert of snapshot?.alerts ?? []) claim(coverage.alert, alert.location_id);

  for (const event of snapshot?.threats ?? []) {
    // liveThreats() агрегує locations[] через jsonb_agg(DISTINCT …), тож одна локація під двома
    // relation_type приходить двома записами. Згортаємо їх за id, інакше «наслідки» загубилися б
    // на другому записі, а перший порахувався б двічі.
    const byLocation = new Map();
    for (const loc of event.locations ?? []) {
      const previous = byLocation.get(loc.id) ?? { asserted: false, aftermath: false };
      byLocation.set(loc.id, {
        asserted: previous.asserted || ASSERTING_RELATIONS.has(loc.relationType),
        aftermath: previous.aftermath || loc.relationType === 'aftermath'
      });
    }
    const confirmed = CONFIRMING_EVIDENCE.has(event.evidenceLevel);
    for (const [id, state] of byLocation) {
      if (!state.asserted) continue;
      claim(coverage.threat, id);
      if (state.aftermath && confirmed) claim(coverage.consequence, id);
    }
  }

  for (const risk of snapshot?.assessments ?? []) {
    if (!ANALYTIC_CONTOUR_FLOOR.has(risk.risk_level)) continue;
    claim(coverage.analytic, risk.location_id);
  }
  return coverage;
}

function snapshotTerritories() {
  return snapshot?.territories ?? [];
}

// Найближча територія, для якої в браузері справді є контур. Сервер вважає район «таким, що має
// контур», за його типом, а браузер — за тим, чи приїхав ADM2: loadRaionBoundaries() лінива й
// ковтає власну помилку, а setFeatureState на неіснуючій фічі — мовчазний no-op. Без цього підйому
// районна загроза просто зникала б із карти, поки геометрія в польоті.
function nearestPolygonAncestor(id) {
  if (!id) return null;
  if (regionFeatures.has(id)) return id;
  for (const ancestor of ancestorsOf(id)) if (regionFeatures.has(ancestor)) return ancestor;
  return null;
}

// Найсильніше покриття сімейства: direct > unmapped > partial. Той самий порядок, яким сервер
// згортає кілька дослівно названих локацій в одну територію.
const COVERAGE_RANK = { direct: 2, unmapped: 1, partial: 0 };
function strongestCoverage(rows) {
  let best = null;
  for (const row of rows) {
    if (!best || (COVERAGE_RANK[row.coverage] ?? -1) > (COVERAGE_RANK[best] ?? -1)) best = row.coverage;
  }
  return best;
}

// TerritoryAssessment не несе location_id, а сукупне state.coverage могла підняти згадка, яка не
// малює нічого. Тож дослівно названу територію оцінки дістаємо з тієї самої оцінки у
// snapshot.assessments за її ідентифікатором — інакше пунктирний контур вийшов би яскравішим,
// ніж сказала модель.
function analyticCoverageOf(state) {
  const named = (snapshot?.assessments ?? [])
    .find((risk) => risk.id === state.assessment?.assessmentId)?.location_id;
  if (!named) return state.coverage;
  if (named === state.locationId) return 'direct';
  return nearestPolygonAncestor(named) === state.locationId ? 'unmapped' : 'partial';
}

/**
 * Ті самі чотири сімейства, але з готового серверного `territories[]`.
 *
 * Полігон засвічує СТАН, а не присутність рядка: alertActive / threatActive / consequences /
 * analyticStatus. Територія, яку джерело лише згадало, приходить у `territories[]` з
 * `asserted: false` — вона мусить бути в панелі рядком «Згадано джерелом» і не має світити нічого.
 *
 * Території без контуру (ADM2 ще в польоті або його немає взагалі) підіймаються до найближчого
 * предка з контуром і пишуть йому ключ *Unmapped: детальнішого шару, який його підмінить, там
 * не буде, тож він не гасне з наближенням.
 */
function territoryCoverageFromStates() {
  const family = () => ({ direct: new Set(), covered: new Set(), unmapped: new Set() });
  const coverage = { alert: family(), threat: family(), consequence: family(), analytic: family() };

  const claim = (fam, id, tone) => {
    const anchor = nearestPolygonAncestor(id);
    if (!anchor) return;
    if (anchor !== id) { fam.covered.add(anchor); fam.unmapped.add(anchor); return; }
    if (tone === 'direct') { fam.direct.add(id); return; }
    fam.covered.add(id);
    if (tone === 'unmapped') fam.unmapped.add(id);
  };

  for (const state of snapshotTerritories()) {
    if (state.alertActive) claim(coverage.alert, state.locationId, strongestCoverage(state.alerts ?? []) ?? state.coverage);
    const asserted = (state.threats ?? []).filter((threat) => threat.asserted);
    if (state.threatActive) claim(coverage.threat, state.locationId, strongestCoverage(asserted) ?? state.coverage);
    const consequences = (state.threats ?? []).filter((threat) => threat.consequence);
    if (state.consequences) claim(coverage.consequence, state.locationId, strongestCoverage(consequences) ?? state.coverage);
    // Поріг контуру (>= elevated) сервер уже застосував, ставлячи analyticStatus. Поріг ІКОНКИ
    // вищий (significant) і живе в icons[], тож контур і гліф лишаються двома різними заявами.
    if (state.analyticStatus && state.analyticStatus !== 'none') {
      claim(coverage.analytic, state.locationId, analyticCoverageOf(state));
    }
  }
  return coverage;
}

function alertLabelCollection(fam) {
  const { names } = locationIndexes();
  const features = [];
  const add = (id, tone) => {
    const point = regionCentroid(id);
    if (!point) return;
    const name = names.get(id) ?? regionFeatures.get(id)?.properties?.nameUk ?? '';
    features.push({ type: 'Feature', id: `al-${id}`, geometry: { type: 'Point', coordinates: point }, properties: {
      locationId: id, tone, level: oblastIds.has(id) ? 'oblast' : 'raion',
      label: String(name).replace(/\s+(область|район)$/u, '')
    } });
  };
  for (const id of fam.direct) add(id, 'direct');
  // Похідне покриття (`partial`) не підписується взагалі. Область, у якій названо район, не має ні
  // заливки, ні контуру — червона назва на весь її обшир стверджувала б рівно те, що заливку звідти
  // й прибрали. Фічі просто немає в джерелі: підпис із прозорістю 0 усе одно займав би місце в
  // колізіях і виштовхував би справжні районні назви за межі кадру.
  for (const id of fam.covered) if (!fam.direct.has(id) && fam.unmapped.has(id)) add(id, 'unmapped');
  return { type: 'FeatureCollection', features };
}

// Стан території накладається через feature-state: геометрія областей і районів (понад мегабайт)
// лишається незмінною, на кожен тік потоку змінюються лише кілька десятків прапорців.
// removeFeatureState({source}) стирає ВЕСЬ стан джерела, тож усі дванадцять ключів мусять
// записатися в цьому ж проході — інакше сімейство, записане окремо, буде стерте наступним тіком.
function territoryStateOf(id, coverage) {
  const state = {};
  const add = (fam, direct, unmapped, partial) => {
    if (fam.direct.has(id)) state[direct] = true;
    else if (fam.unmapped.has(id)) state[unmapped] = true;
    else if (fam.covered.has(id)) state[partial] = true;
  };
  add(coverage.alert,       'alert',       'unmapped',            'partial');
  add(coverage.threat,      'threat',      'threatUnmapped',      'threatPartial');
  add(coverage.consequence, 'consequence', 'consequenceUnmapped', 'consequencePartial');
  add(coverage.analytic,    'analytic',    'analyticUnmapped',    'analyticPartial');
  return state;
}

function applyTerritoryLayers() {
  if (!mapLayersReady || !map) return;
  // Знімок без `territories[]` — це старий сервер або частковий деплой, а не помилка. Тоді карту
  // веде розкладка хвилі 1: полігони лишаються, іконок просто немає. Деградація в бік меншої
  // кількості інформації, ніколи — у бік помилки.
  const coverage = snapshotTerritories().length ? territoryCoverageFromStates() : territoryCoverage();
  const touched = new Set();
  for (const fam of Object.values(coverage)) {
    for (const id of fam.direct) touched.add(id);
    for (const id of fam.covered) touched.add(id);
  }
  for (const [source, ids] of [['ukraine-admin', oblastIds], ['ukraine-raions', raionIds]]) {
    if (!map.getSource(source)) continue;
    map.removeFeatureState({ source });
    for (const id of touched) {
      if (!ids.has(id)) continue;
      const state = territoryStateOf(id, coverage);
      // Порожній стан не пишемо: removeFeatureState уже лишив фічу чистою, а зайвий виклик на
      // кожну з 136 районних фіч — це робота, яку не видно на екрані.
      if (Object.keys(state).length) map.setFeatureState({ source, id }, state);
    }
  }
  // Підписи лишаються ТІЛЬКИ тривожними: червона назва області для моніторингового повідомлення
  // стверджувала б більше, ніж сказало джерело. Назву території з іншим станом дає панель.
  map.getSource('alert-labels')?.setData(alertLabelCollection(coverage.alert));
}

// Районна геометрія вантажиться окремо й не блокує старт карти. Якщо файлу немає або він зіпсований,
// карта лишається повністю робочою на рівні областей: районну тривогу все одно видно як заливку
// батьківської області, бо nearestPolygonAncestor() не знаходить районної фічі й claim() записує
// область як `unmapped` — той самий стан, яким світяться міста й громади без власного контуру.
// Саме тому прибирання «часткової» заливки нічого не ламає в польоті: поки ADM2 не приїхав,
// тривога взагалі не буває «частковою», а коли приїхав — її несе сам район.
// Шари районів існують від самого початку й на будь-якому масштабі; поки джерело порожнє,
// вони просто нічого не малюють і наповнюються на місці, щойно setData() отримає геометрію.
async function loadRaionBoundaries() {
  try {
    const response = await fetch('/data/ukraine-adm2.geojson', { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('adm2 unavailable');
    const data = await response.json();
    if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features) || !data.features.length) throw new Error('adm2 malformed');
    raionBoundaries = data;
    indexRegionFeatures();
    map?.getSource('ukraine-raions')?.setData(raionCollection());
    applyTerritoryLayers();
    // Центроїдів районів не існує, поки не приїхав ADM2, тож стеки іконок для них треба
    // перевипустити саме тут: прибуття файлу асинхронне й нефатальне.
    updateTerritoryIcons();
  } catch { /* без районних контурів карта працює на рівні областей */ }
}

setInterval(() => { $('#clock strong').textContent = kyivTime(); updateFreshness(); }, 1000);

function updateFreshness() {
  if (!lastReceived) return;
  const age = (Date.now() - lastReceived.getTime()) / 1000;
  const publication = snapshot?.publication ?? null;   // відсутнє у старому payload
  const held = publication?.mode === 'delayed_15s';
  const strip = $('#system-strip');
  const backendProblem = backendStatus === 'degraded' || backendStatus === 'unconfigured';
  // «held» стоїть НИЖЧЕ за «delayed» і «stale»: свідома затримка оператора — це не несправність,
  // але справжня несправність поверх неї має лишатися видимою.
  strip.dataset.state = age > 180 || backendProblem ? 'stale'
    : age > 60 ? 'delayed'
      : held ? 'held' : 'current';
  $('#system-state').textContent = age > 180 ? 'ДАНІ ЗАСТАРІЛИ'
    : backendStatus === 'degraded' ? 'ОФІЦІЙНІ ДЖЕРЕЛА НЕДОСТУПНІ'
      : backendStatus === 'unconfigured' ? 'ДЖЕРЕЛА НЕ НАЛАШТОВАНІ'
        : age > 60 ? 'МОЖЛИВА ЗАТРИМКА'
          : held ? `ЗАТРИМКА ${publication?.delaySeconds ?? 15} С` : 'ДАНІ АКТУАЛЬНІ';
  // Три показники, яких вимагає дорожня карта: режим (у #system-state), фактична свіжість
  // («оновлено N с тому») і ЧАС ОСТАННЬОЇ ОПУБЛІКОВАНОЇ ПОДІЇ. Третій без цього рядка не мав би
  // жодного споживача взагалі: він рахувався у зрізі й показувався тільки в /ops.
  //
  // Час останньої події живе ПОЗА гілкою затримки: «оновлено N с тому» міряє вік запиту знімка, а
  // пасок опитує сервер щохвилини, тож у прямому режимі цей лічильник не старіє навіть тоді, коли
  // конвеєр публікації став. Єдиний показник, що відрізняє тишу від зупинки, — час останньої
  // опублікованої події, і в прямому режимі він потрібен читачеві не менше, ніж у затриманому.
  // Зріз лишається виключно затриманим: у прямому режимі cutoffAt дорівнює часу запиту.
  const eventAt = !publication ? ''
    : publication.lastPublishedEventAt
      ? ` · остання подія о ${shortTime(publication.lastPublishedEventAt)}`
      : ' · подій ще не було';
  $('#last-update').textContent = held
    ? `оновлено ${Math.round(age)} с тому · зріз о ${shortTime(publication.cutoffAt)}${eventAt}`
    : `оновлено ${Math.round(age)} с тому${eventAt}`;
}

async function loadSnapshot() {
  const response = await fetch('/api/v1/snapshot', { cache: 'no-store' });
  if (!response.ok) throw new Error('snapshot unavailable');
  snapshot = await response.json();
  backendStatus = snapshot.systemStatus;
  lastReceived = new Date();
  renderCurrentRoute({ fromSnapshot: true });
  updateFreshness();
  // Ланцюги — окремий запит: він важчий за знімок і не має права затримати першу картинку.
  void loadVectors();
}

function connectStream() {
  // Точка відновлення: без неї кожна подія, закомічена між зрізом знімка й рукостисканням потоку,
  // лишалася б невидимою для цієї вкладки, доки не прийде якась наступна. Сервер трактує ?since=
  // рівно як Last-Event-ID, а верхньою межею добору лишається зріз публікації — тож повз затримку
  // це не пропускає нічого.
  const source = new EventSource(`/api/v1/stream?since=${snapshot?.version ?? 0}`);
  source.addEventListener('connected', () => { lastReceived = new Date(); updateFreshness(); });
  const schedule = () => {
    lastReceived = new Date();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => loadSnapshot().catch(markOffline), 250);
  };
  // 'threat.withdrawn' and 'threat.expired' end a threat. Without them the map keeps drawing it
  // until some unrelated event happens to arrive, which is the one direction that must not lag.
  // 'publication.changed' і 'analytics.updated' — нові імена: іменовані події EventSource НЕ
  // падають у загальний обробник message, тож без цього рядка клієнт мовчки б їх ігнорував.
  ['alert.started','alert.ended','threat.created','threat.updated','threat.corrected','threat.withdrawn','threat.expired','assessment.updated','source.stale','source.recovered','publication.changed','analytics.updated'].forEach((name) => source.addEventListener(name, schedule));
  source.onerror = markOffline;
}

function markOffline() {
  $('#system-strip').dataset.state = 'stale';
  $('#system-state').textContent = 'ЗВʼЯЗОК ПЕРЕРВАНО';
  $('#last-update').textContent = 'показано останній відомий стан';
}

function activePage() {
  const path = location.pathname.replace(/\/$/, '') || '/';
  const route = path === '/tv' ? '/' : path;
  document.querySelectorAll('[data-route]').forEach((link) => link.classList.toggle('is-active', link.dataset.route === route));
  return route;
}

function eventCard(item, type) {
  if (type === 'alert') return `<article class="event-card priority" data-location="${item.location_id}">
    <div class="event-meta"><span>ОФІЦІЙНА ТРИВОГА</span><time>${shortTime(item.started_at)}</time></div>
    <h2>${escapeHtml(item.location_name)}</h2><p>Активне офіційне повідомлення. Дотримуйтеся вказівок служб.</p>
    <div class="event-foot"><b>ТРИВАЄ</b><span>${timeAgo(item.started_at)}</span></div></article>`;
  if (type === 'assessment') return `<article class="event-card analytical" data-assessment="${item.id}" data-location="${item.location_id}">
    <div class="event-meta"><span>АНАЛІТИЧНА ОЦІНКА</span><time>${shortTime(item.generated_at)}</time></div>
    <h2>${escapeHtml(item.location_name)}</h2><p>${threatNames[item.threat_type] ?? item.threat_type}</p>
    <div class="risk-row"><strong>${item.risk_score}<small>/10</small></strong><span>${levelNames[item.risk_level] ?? item.risk_level}<br><small>${item.indicative_percent ?? Math.round(item.risk_score * 10)}% індикативно · впевненість ${escapeHtml(confidenceNames[item.assessment_confidence] ?? item.assessment_confidence)}</small></span></div>
    <div class="event-foot"><b>НЕ Є ТРИВОГОЮ</b><span>до ${shortTime(item.horizon_end)}</span></div></article>`;
  return `<article class="event-card ${item.evidenceLevel}" data-event="${item.id}">
    <div class="event-meta"><span>${escapeHtml(evidenceNames[item.evidenceLevel] ?? item.evidenceLevel)}</span><time>${shortTime(item.lastObservedAt)}</time></div>
    <h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.summary)}</p>
    <div class="location-tags">${item.locations.map((loc) => `<span>${escapeHtml(loc.name)}</span>`).join('')}</div>
    <div class="event-foot"><b>${escapeHtml(threatNames[item.threatType] ?? item.threatType)}</b><span>${timeAgo(item.lastObservedAt)}</span></div></article>`;
}

function directionCollection() {
  return { type: 'FeatureCollection', features: snapshot.threats.filter((threat) => threat.geometry?.type === 'LineString').map((threat) => ({ type: 'Feature', id: threat.id, geometry: threat.geometry, properties: { title: threat.title } })) };
}

// ------------------------------------------------------------------------------------------------
// Вектори загроз — ланцюги повідомлень
// ------------------------------------------------------------------------------------------------
//
// Наявний шар direction-lines лишається недоторканим. Він малює threat_events.geometry — одну лінію
// на подію, з однаковим пунктиром і без розбору, звідки вона взялася. Ланцюг — інша річ: у нього
// власне джерело даних (/api/v1/vectors), власна одиниця (відрізок, а не подія) і, головне, кожен
// відрізок має різний рівень доказовості, який мусить читатися з карти. Розширити direction-lines
// означало б звалити дві семантики в одне джерело й втратити саме ту різницю, заради якої ланцюг і
// будується. Тому — окремі шари; порядок наявних не змінюється.

function vectorSegmentCollection() {
  const features = [];
  for (const vector of vectors) {
    for (const [order, segment] of (vector.segments ?? []).entries()) {
      // Відрізок без координат лишається у відповіді й у діалозі як факт, але не малюється:
      // у районів KATOTTG координат немає взагалі, і вигадана точка була б гіршою за її відсутність.
      if (!segment.drawable) continue;
      const from = vector.nodes[segment.from];
      const to = vector.nodes[segment.to];
      if (!from?.coordinates || !to?.coordinates) continue;
      features.push({ type: 'Feature', id: `vs-${vector.eventId}-${order}`,
        geometry: { type: 'LineString', coordinates: [from.coordinates, to.coordinates] },
        properties: { eventId: vector.eventId, basis: segment.basis, evidence: segment.evidenceLevel,
          approximate: from.coordinatePrecision === 'approximate' || to.coordinatePrecision === 'approximate',
          label: `${from.name} → ${to.name}` } });
    }
  }
  return { type: 'FeatureCollection', features };
}

function vectorNodeCollection() {
  const features = [];
  for (const vector of vectors) {
    if (!(vector.segments ?? []).some((segment) => segment.drawable)) continue;
    for (const node of vector.nodes ?? []) {
      if (!node.coordinates) continue;
      features.push({ type: 'Feature', id: `vn-${vector.eventId}-${node.index}`,
        geometry: { type: 'Point', coordinates: node.coordinates },
        properties: { eventId: vector.eventId, order: String(node.index + 1), name: node.name,
          approximate: node.coordinatePrecision === 'approximate' } });
    }
  }
  return { type: 'FeatureCollection', features };
}

// Ордината веб-Меркатора в тих самих одиницях, у яких абсциса дорівнює довготі в радіанах.
// Полюси в цій проєкції лежать у нескінченності, тож широта затиснута тим самим порогом
// ±85.051129°, яким її затискає й сам MapLibre.
function mercatorY(latitude) {
  const clamped = Math.max(-85.051129, Math.min(85.051129, latitude));
  return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI / 180) / 2));
}

/**
 * Курс відрізка в градусах за годинниковою стрілкою від півночі, 0 ⩽ кут < 360.
 *
 * Рахуємо саме в Меркаторі, а не по великому колу. MapLibre малює LineString прямою в проєкованих
 * координатах, тобто на екрані відрізок має СТАЛИЙ кут, тоді як початковий курс ортодромії з ним не
 * збігається: для відрізка строго на схід на широті 50° ортодромія дала б 89.6°, і вістря стояло б
 * під помітним кутом до власної лінії. Тут же відрізок на схід — це рівно 90°, на північ — 0°.
 *
 * `null` для відрізка нульової довжини: два різні місця з однією координатою (наприклад, два
 * центроїди, що збіглися) не мають напрямку, і стрілка з довільним кутом була б вигадкою.
 */
function segmentBearing(from, to) {
  const dx = (((to[0] - from[0]) + 540) % 360) - 180;    // найкоротший бік, а не через антимеридіан
  const dy = mercatorY(to[1]) - mercatorY(from[1]);
  if (!dx && !dy) return null;
  return ((Math.atan2(dx * Math.PI / 180, dy) * 180 / Math.PI) + 360) % 360;
}

// Тон фішки класу — те саме правило, що й у стеків територій (threatTone у
// src/domain/territory-state.ts): офіційне або підтверджене → 'confirmed', решта → 'reported'.
// 'consequence' і 'analytic' тут неможливі: ланцюг складено з тверджень про рух, а не з наслідків
// на місці й не з аналітичної оцінки.
function vectorClassTone(evidenceLevel) {
  return evidenceLevel === 'official' || evidenceLevel === 'confirmed' ? 'confirmed' : 'reported';
}

/**
 * Голови векторів: вістря на кінці кожного відрізка, рух у якому ствердило джерело, і рівно одна
 * фішка класу на ланцюг.
 *
 * Одне джерело на два шари, як `threat-vector-segments` уже тримає три лінійні шари: кардинальність
 * різна (вістер стільки, скільки стверджених відрізків; фішка одна), тож фічі розрізняє властивість
 * `kind`, а не окреме джерело.
 *
 * Фішка одна на ланцюг і стоїть у найновішій намальованій точці. Клас уздовж ланцюга не міняється
 * майже ніколи, і десять однакових фішок на десяти відрізках забрали б у карти оглядовий масштаб
 * заради повторення однієї й тієї самої заяви.
 *
 * Лінії напрямку (`threat.geometry` типу LineString) отримують те саме вістря й ту саму фішку. Свого
 * запиту для них не зʼявилося: `snapshot.threats[]` — це LiveEvent, у якого threatType і
 * evidenceLevel уже лежать поруч із геометрією, тож серверу тут не додано нічого.
 */
function vectorHeadCollection() {
  const features = [];
  const arrow = (id, point, bearing, image, basis, label) => ({
    type: 'Feature', id,
    geometry: { type: 'Point', coordinates: point },
    properties: { kind: 'arrow', arrow: image, bearing, basis, label }
  });
  // Текстового еквівалента фішка не несе, і це не пропуск: #map-aria описує СТАНИ ТЕРИТОРІЙ, а клас,
  // що рухається, уже названо в картці події — у списку «Активні події», який лишається канонічною
  // текстовою поверхнею, і в діалозі події рядком «Тип». Властивість aria тут лежала б мертвою й
  // виглядала б як доступність, якої насправді немає.
  const chip = (id, point, threatType, tone, label) => ({
    type: 'Feature', id,
    geometry: { type: 'Point', coordinates: point },
    properties: { kind: 'class', icon: iconImageId(threatType, tone), label }
  });

  for (const vector of vectors) {
    const drawable = (vector.segments ?? []).filter((segment) => segment.drawable);
    for (const [order, segment] of (vector.segments ?? []).entries()) {
      const image = ARROW_BASIS_IMAGES[segment.basis];
      if (!image || !segment.drawable) continue;
      const from = vector.nodes[segment.from];
      const to = vector.nodes[segment.to];
      if (!from?.coordinates || !to?.coordinates) continue;
      const bearing = segmentBearing(from.coordinates, to.coordinates);
      if (bearing === null) continue;
      features.push(arrow(`va-${vector.eventId}-${order}`, to.coordinates, bearing, image,
        segment.basis, `${from.name} → ${to.name}`));
    }
    const head = drawable[drawable.length - 1];
    const point = head ? vector.nodes[head.to] : null;
    if (!point?.coordinates) continue;
    features.push(chip(`vc-${vector.eventId}`, point.coordinates,
      head.threatType ?? vector.threatType ?? 'unknown', vectorClassTone(head.evidenceLevel),
      point.name));
  }

  for (const threat of snapshot?.threats ?? []) {
    const line = threat.geometry?.type === 'LineString' ? threat.geometry.coordinates ?? [] : [];
    const end = line[line.length - 1];
    const previous = line[line.length - 2];
    if (!end || !previous) continue;
    const bearing = segmentBearing(previous, end);
    if (bearing === null) continue;
    // Той самий рівень, що й у reported_direction ланцюга, і з тієї самої причини: геометрія події
    // будується з relation_type='reported_direction', тобто джерело назвало курс, а не прибуття.
    features.push(arrow(`da-${threat.id}`, end, bearing, ARROW_BASIS_IMAGES.reported_direction,
      'reported_direction', threat.title));
    features.push(chip(`dc-${threat.id}`, end, threat.threatType ?? 'unknown',
      vectorClassTone(threat.evidenceLevel), threat.title));
  }
  return { type: 'FeatureCollection', features };
}

async function loadVectors() {
  try {
    const response = await fetch('/api/v1/vectors', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error('vectors unavailable');
    const data = await response.json();
    if (!Array.isArray(data?.items)) throw new Error('vectors malformed');
    vectors = data.items;
  } catch {
    // Пояснювальний шар поверх маркерів, які карта вже малює: лишаємо попередній стан.
  }
  applyVectors();
}

function applyVectors() {
  if (mapLayersReady && map?.getSource('threat-vector-segments')) {
    map.getSource('threat-vector-segments').setData(vectorSegmentCollection());
    map.getSource('threat-vector-points')?.setData(vectorNodeCollection());
    // Голови приходять із ДВОХ джерел даних — /api/v1/vectors і snapshot.threats — тож їх
    // перевидає саме applyVectors(): і loadVectors(), і updateMap() проходять через нього.
    map.getSource('threat-vector-heads')?.setData(vectorHeadCollection());
  }
  renderVectorLegend();
}

/**
 * Вістря як бітмап: рівнобедрений трикутник носом СТРОГО ВГОРУ, тобто на північ при icon-rotate 0.
 * Кут дає icon-rotate, а не сорок заздалегідь повернутих картинок.
 *
 * Той самий синхронний шлях, що й occupation-hatch-pattern та сорок фішок класів: canvas →
 * ImageData → addImage. Асинхронна картинка змагалася б зі style.load, а глобальний обробник
 * styleimagemissing мовчки підставив би прозорий піксель 1×1 — і «стрілки немає» не відрізнялося б
 * від «стрілка не додалася».
 *
 * `filled` — рух ствердило одне повідомлення (reported_transit): суцільна заливка.
 * Порожній контур — повідомлено лише напрямок: та сама відмінність «форма, а не прозорість», якою
 * порожній вузол уже позначає наближену координату.
 */
function vectorArrowImage(filled) {
  const size = VECTOR_ARROW_PX * ICON_PIXEL_RATIO;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(ICON_PIXEL_RATIO, ICON_PIXEL_RATIO);
  const box = VECTOR_ARROW_PX;
  ctx.beginPath();
  ctx.moveTo(box / 2, 1.6);
  ctx.lineTo(box - 2.4, box - 2.2);
  ctx.lineTo(box / 2, box - 5.4);
  ctx.lineTo(2.4, box - 2.2);
  ctx.closePath();
  // Темний обвід іде першим і ширшим за саму фігуру: помаранчеве вістря лежить на помаранчевій
  // лінії й на помаранчевій заливці загрози, і без обводу зливається з обома.
  ctx.strokeStyle = '#06080c'; ctx.lineWidth = 2.6; ctx.lineJoin = 'round'; ctx.stroke();
  if (filled) {
    ctx.fillStyle = vectorColor; ctx.fill();
  }
  ctx.strokeStyle = vectorColor; ctx.lineWidth = filled ? 1 : 1.8; ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

/** Реєстрація передує шарам, як і в іконок територій. false → шар вістер не додається взагалі. */
function addVectorArrowImages(map) {
  for (const [filled, id] of [[true, ARROW_BASIS_IMAGES.reported_transit], [false, ARROW_BASIS_IMAGES.reported_direction]]) {
    if (map.hasImage(id)) continue;
    const image = vectorArrowImage(filled);
    if (!image) return false;
    map.addImage(id, image, { pixelRatio: ICON_PIXEL_RATIO });
  }
  return true;
}

function addVectorLayers() {
  // Якір: alert-oblast-label. Геометрія ланцюга лягає НАД заливками й контурами станів території, але
  // ПІД усіма підписами — обласними, районними, підписом суверенітету Криму й підписами міст. Жоден
  // наявний шар при цьому не зміщується: вставка «перед» існуючим шаром не переставляє нічого іншого.
  // Зверху ланцюга лишається тільки те, що додано без beforeId: лінія напрямку і, з етапу 2,
  // чотири шари іконок територій. Пояснювальна лінія не перекриває головного показника.
  const anchor = map.getLayer('alert-oblast-label') ? 'alert-oblast-label' : undefined;
  const basis = ['get','basis'];
  map.addSource('threat-vector-segments', { type: 'geojson', data: vectorSegmentCollection() });
  map.addSource('threat-vector-points', { type: 'geojson', data: vectorNodeCollection() });
  map.addLayer({ id: 'threat-vector-sequence', type: 'line', source: 'threat-vector-segments',
    filter: ['==', basis, 'observation_sequence'], layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': vectorColor, 'line-width': ['interpolate',['linear'],['zoom'],5,1.5,9,3],
      'line-opacity': .4, 'line-dasharray': [0.5,2.4] } }, anchor);
  map.addLayer({ id: 'threat-vector-direction', type: 'line', source: 'threat-vector-segments',
    filter: ['==', basis, 'reported_direction'], layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': vectorColor, 'line-width': ['interpolate',['linear'],['zoom'],5,2,9,3.6],
      'line-opacity': .7, 'line-dasharray': [3,1.6] } }, anchor);
  map.addLayer({ id: 'threat-vector-transit', type: 'line', source: 'threat-vector-segments',
    filter: ['==', basis, 'reported_transit'], layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': vectorColor, 'line-width': ['interpolate',['linear'],['zoom'],5,2.4,9,4.4],
      'line-opacity': .92 } }, anchor);
  // Порожнє коло = координати немає в каталозі й узято центроїд полігона району. Це наближення,
  // і воно позначене формою, а не лише в тексті легенди.
  map.addLayer({ id: 'threat-vector-nodes', type: 'circle', source: 'threat-vector-points', paint: {
    'circle-radius': ['interpolate',['linear'],['zoom'],5,3.2,9,6],
    'circle-color': ['case',['get','approximate'],'rgba(255,122,77,.10)',vectorColor],
    'circle-opacity': .9, 'circle-stroke-width': 1.6, 'circle-stroke-color': vectorColor, 'circle-stroke-opacity': .85
  } }, anchor);
  map.addLayer({ id: 'threat-vector-order', type: 'symbol', source: 'threat-vector-points', minzoom: 5.6, layout: {
    'text-field': ['get','order'], 'text-size': 10, 'text-offset': [0,-1.3], 'text-anchor': 'bottom',
    'text-font': ['Noto Sans Regular'], 'text-allow-overlap': true
  }, paint: { 'text-color': '#ffd9c9', 'text-halo-color': '#06080c', 'text-halo-width': 1.5 } }, anchor);
  // Голови ланцюга додаються ПІСЛЯ всієї сімʼї threat-vector-*, тобто над нею: вістря мусить лежати
  // на кінці своєї лінії, а не під нею. Якір той самий, тож підписи лишаються вище за все це.
  let arrowsReady = false;
  try { arrowsReady = addVectorArrowImages(map); } catch { arrowsReady = false; }
  map.addSource('threat-vector-heads', { type: 'geojson', data: vectorHeadCollection() });
  if (arrowsReady) {
    // icon-rotation-alignment: 'map' — вістря повертається РАЗОМ із картою, як і сама лінія;
    // у 'viewport' воно застигло б відносно екрана й розійшлося б із лінією на першому ж повороті.
    // allow-overlap: вістря — це і є заява про рух; погашене колізією, воно перетворило б
    // ствердження джерела на звичайну лінію. ignore-placement: але й нікого не відштовхує — воно
    // мале й пояснювальне, а місце на карті належить іконкам класів і підписам територій.
    map.addLayer({ id: 'threat-vector-arrowhead', type: 'symbol', source: 'threat-vector-heads',
      filter: ['==', ['get','kind'], 'arrow'], layout: {
        'icon-image': ['get','arrow'], 'icon-rotate': ['get','bearing'],
        'icon-rotation-alignment': 'map', 'icon-size': ['interpolate',['linear'],['zoom'],5,.72,9,1],
        'icon-allow-overlap': true, 'icon-ignore-placement': true
      } }, anchor);
  }
  if (iconImagesReady) {
    // Фішка класу — ті самі сорок зображень, що вже зареєстровані для стеків територій; другого
    // конвеєра іконок тут немає й не буде. На відміну від вістря вона ЗАЛЕЖИТЬ від колізії: клас
    // повторено в картці події й у стеку території, тож на оглядовому масштабі фішка має право
    // поступитися — а стеки територій лежать вище й тому виграють у неї місце.
    map.addLayer({ id: 'threat-vector-class', type: 'symbol', source: 'threat-vector-heads',
      filter: ['==', ['get','kind'], 'class'], layout: {
        'icon-image': ['get','icon'], 'icon-size': ['interpolate',['linear'],['zoom'],5,.62,9,.86],
        'icon-offset': VECTOR_CLASS_OFFSET, 'icon-padding': 4
      } }, anchor);
  }
}

function vectorLegendElement() {
  const panels = $('.map-panels');
  if (!panels) return null;
  let legend = $('#vector-legend');
  if (!legend) {
    // Легенду створює скрипт, а не розмітка: підпис має існувати рівно тоді, коли на карті справді
    // лежить хоч один ланцюг, і жодного разу раніше.
    legend = document.createElement('details');
    legend.id = 'vector-legend';
    legend.className = 'occupation-legend';
    legend.hidden = true;
    legend.addEventListener('toggle', () => { vectorLegendOpen = legend.open; });
    panels.append(legend);
  }
  return legend;
}

function renderVectorLegend() {
  const legend = vectorLegendElement();
  if (!legend) return;
  const drawn = vectorSegmentCollection().features.length;
  // Вістря лічимо окремо, бо їх дають ДВА джерела: ланцюги і лінії напрямку самих подій. Подія з
  // геометрією-лінією, у якої ланцюг ще не склався, лишила б карту зі стрілками й без жодного
  // рядка, який пояснює, що стрілка означає. Легенда мусить існувати рівно тоді, коли на карті є
  // хоч що-небудь із того, що вона пояснює.
  const pointed = vectorHeadCollection().features.filter((feature) => feature.properties.kind === 'arrow').length;
  const chains = vectors.filter((vector) => (vector.segments ?? []).some((segment) => segment.drawable)).length;
  const hidden = vectors.reduce((sum, vector) => sum + (vector.segments ?? []).filter((segment) => !segment.drawable).length, 0);
  legend.hidden = !drawn && !pointed;
  if (legend.hidden) return;
  legend.open = vectorLegendOpen ?? false;
  const swatch = (style) => `<i class="legend-swatch" style="height:0;border:0;border-top:2px solid ${vectorColor};${style}"></i>`;
  // Вістря в легенді дивиться праворуч, а не вгору: рядок легенди читається зліва направо, і
  // трикутник носом угору поруч із горизонтальною лінією прочитався б як окремий знак, а не як
  // кінець цієї лінії. На карті кут дає icon-rotate, тут напрямок не означає нічого.
  //
  // Кожне вістря — окремий рядок із власним значком у першій колонці. Вставлений усередину речення
  // гліф лишився б невидимим: .legend-icon дістає розміри лише як елемент флекса, тобто прямою
  // дитиною <li>, а всередині <span> це інлайновий <i> нульового розміру.
  const arrowSwatch = (filled) => `<i class="legend-icon" role="img" aria-hidden="true">`
    + `<svg viewBox="0 0 24 24" focusable="false"><path d="M3.4 2.6 L21.4 12 L3.4 21.4 L7.6 12 Z"`
    + ` fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg></i>`;
  const chipSwatch = `<i class="legend-swatch" style="border-radius:3px;border-color:${vectorColor};background:rgba(255,122,77,.22)"></i>`;
  const summary = drawn
    ? `${chains} ланцюг${chains === 1 ? '' : 'ів'} · ${drawn} відрізк${drawn === 1 ? '' : 'ів'}`
    : `${pointed} напрямк${pointed === 1 ? '' : 'ів'}`;
  legend.innerHTML = `<summary><i class="swatch threat"></i><span class="legend-title">Ланцюги повідомлень</span><span class="legend-sum">${summary}</span><span class="legend-caret" aria-hidden="true">▾</span></summary>
    <div class="legend-body">
      <p class="legend-warning">Це послідовність <b>повідомлень</b> із часом і джерелом, а не траєкторія польоту. Лінія показує, що і коли повідомили, а не куди прямує ціль. Система не прогнозує ціль, влучання або маршрут.</p>
      <ul class="legend-rows">
        <li>${swatch('opacity:.95')}<span>Суцільна — одне повідомлення ствердило сам рух («повз А на Б»).</span></li>
        <li>${swatch('border-top-style:dashed;opacity:.75')}<span>Штрихова — джерело повідомило напрямок, але не прибуття.</span></li>
        <li>${swatch('border-top-style:dotted;opacity:.5')}<span>Крапкова — різні повідомлення в різний час. Порядок наш; рух не стверджувало жодне джерело.</span></li>
        <li>${arrowSwatch(true)}<span>Вістря — рух ствердило саме джерело. Суцільне: одне повідомлення назвало і те, що минають, і те, до чого йдуть.</span></li>
        <li>${arrowSwatch(false)}<span>Порожнє вістря — джерело назвало курс, але не прибуття.</span></li>
        <li>${swatch('border-top-style:dotted;opacity:.5')}<span><b>На крапковій лінії вістря немає ніколи</b> — стрілка на ній була б твердженням про рух, якого не робило жодне джерело. Там лишаються номери точок: це порядок повідомлень, а не шлях.</span></li>
        <li>${chipSwatch}<span>Фішка на голові ланцюга — клас, який рухається за повідомленнями. Той самий гліф, що й у легенді «Загрози на карті».</span></li>
      </ul>
      <p class="legend-note">Порожнє коло — район без координат у каталозі KATOTTG: точку взято з центроїда полігона, це наближення до району, а не місце.${hidden ? ` ${hidden} відрізк${hidden === 1 ? '' : 'ів'} не намальовано взагалі — для цих територій контуру немає; вони лишаються в картці події текстом.` : ''}</p>
    </div>`;
}

function vectorChainHtml(vector) {
  if (!vector?.segments?.length) return '';
  const rows = vector.segments.map((segment) => {
    const from = vector.nodes[segment.from];
    const to = vector.nodes[segment.to];
    const gap = segment.elapsedSeconds ? `${Math.round(segment.elapsedSeconds / 60) || '<1'} хв` : 'те саме повідомлення';
    const corroboration = segment.independentEnds ? ' · незалежні джерела' : '';
    const approximate = [from, to].some((node) => node?.coordinatePrecision === 'approximate')
      ? '<small>Координата району наближена — центроїд полігона.</small>' : '';
    const undrawn = segment.drawable ? '' : '<small>Немає координат — на карті не показано.</small>';
    // Клас відрізка називаємо лише тоді, коли він РОЗІЙШОВСЯ з класом події: інакше це був би той
    // самий рядок під кожним переходом. Розбіжність же — справжня новина: повідомлення про БпЛА,
    // за яким ішло повідомлення про балістику на тій самій події.
    const drift = segment.threatType && segment.threatType !== vector.threatType
      ? `<br><small>Це повідомлення назвало клас: ${escapeHtml(threatNames[segment.threatType] ?? segment.threatType)}.</small>` : '';
    return `<li><time>${shortTime(segment.reportedAt)}</time> <b>${escapeHtml(from?.name ?? '?')} → ${escapeHtml(to?.name ?? '?')}</b>
      <span class="evidence ${escapeHtml(segment.evidenceLevel)}">${escapeHtml(evidenceNames[segment.evidenceLevel] ?? segment.evidenceLevel)}</span>
      <br><small>${escapeHtml(vectorBasisLabels[segment.basis] ?? segment.basis)} · ${escapeHtml(segment.source?.name ?? 'джерело не вказано')} · ${escapeHtml(gap)}${corroboration}</small>
      ${segment.statement ? `<br><small>«${escapeHtml(segment.statement)}»</small>` : ''}${drift}${approximate}${undrawn}</li>`;
  }).join('');
  const span = vector.span ?? {};
  // Клас відкриває рядок: перше питання про вектор — «що саме рухається», і воно має стояти перед
  // лічильниками джерел і переходів.
  const moving = vector.threatType
    ? `${escapeHtml(threatNames[vector.threatType] ?? vector.threatType)} · ` : '';
  return `<h3>Ланцюг повідомлень</h3>
    <p class="detail-summary">${moving}${span.sourceCount ?? 0} джерел${span.sourceCount === 1 ? 'о' : ''} за ${Math.max(1, Math.round((span.elapsedSeconds ?? 0) / 60))} хв · ${vector.nodes.length} точ${vector.nodes.length === 1 ? 'ка' : 'ок'} · ${vector.segments.length} перехід${vector.segments.length === 1 ? '' : 'ів'}</p>
    <ol class="update-list">${rows}</ol>
    <div class="safety-note"><strong>Це не траєкторія</strong><p>${escapeHtml(vector.disclaimer ?? '')}</p></div>`;
}

// Довідковий шар: тимчасово окуповані території України. Це не тривога і не оцінка ризику —
// він лягає під усі шари суверенітету, тож державний кордон і підпис Криму завжди зверху.
function occupationCollection() {
  return occupation?.geojson ?? { type: 'FeatureCollection', features: [] };
}

// Порожній шар лишається прихованим — так MapLibre не показує атрибуцію джерела, яке зараз нічого не малює.
function occupationActive() {
  return occupationVisible && occupationCollection().features.length > 0;
}

// Легенда й перемикач зʼявляються лише тоді, коли шар справді лежить на карті.
// Інакше інтерфейс обіцяв би окупацію, якої карта не малює (наприклад, коли стиль так і не завантажився).
function occupationOnMap() {
  return !!occupation && occupationLayersReady;
}

// Найнебезпечніший режим відмови — застарілий шар, що виглядає актуальним.
// Тому окрім прапорця сервера перевіряємо ще й те, чи клієнт узагалі зміг оновити дані:
// поріг збігається з OCCUPATION_STALE_AFTER_SECONDS на бекенді (6 годин).
function occupationStale() {
  if (!occupation) return false;
  if (occupation.stale) return true;
  return occupationFetchedAt != null && Date.now() - occupationFetchedAt > 21600000;
}

async function loadOccupation() {
  try {
    const response = await fetch('/api/v1/occupation', { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error('occupation unavailable');
    const data = await response.json();
    if (data?.geojson?.type !== 'FeatureCollection' || !Array.isArray(data.geojson.features)) throw new Error('occupation malformed');
    occupation = data;
    occupationFetchedAt = Date.now();
    applyOccupation();
  } catch {
    // Шар довідковий: лишаємо попередній стан, карта працює без нього.
    // Легенду все одно перемальовуємо — так невдале оновлення з часом проявиться як «дані застаріли».
    renderOccupationLegend();
  }
}

function applyOccupationVisibility() {
  const visibility = occupationActive() ? 'visible' : 'none';
  occupationLayerIds.forEach((id) => { if (map?.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility); });
}

function applyOccupation() {
  if (occupationLayersReady && map?.getSource('occupation-areas')) {
    map.getSource('occupation-areas').setData(occupationCollection());
    applyOccupationVisibility();
  }
  renderOccupationLegend();
}

function hatchPattern(color, alpha, direction = 'down') {
  const size = 24, canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let offset = -size; offset < size * 2; offset += size / 2) {
    // 'up' — дзеркальний кут до окупаційного штрихування. Два штрихування під одним кутом
    // на сусідніх полігонах читаються як один шар, і сенс різниці зникає.
    if (direction === 'up') { ctx.moveTo(offset, size); ctx.lineTo(offset + size, 0); }
    else { ctx.moveTo(offset, 0); ctx.lineTo(offset + size, size); }
  }
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

function addOccupationLayers() {
  occupationLayersReady = false;
  // Якір суверенітету — обовʼязкова умова. Якщо його немає, шар окупації не додається взагалі:
  // краще не показати окупацію, ніж покласти її поверх державного кордону й підпису Криму.
  if (!map.getLayer('ukraine-sovereignty-fill')) return;
  try {
    map.addSource('occupation-areas', { type: 'geojson', data: occupationCollection(),
      attribution: 'Окупація: <a href="https://deepstatemap.live" target="_blank" rel="noreferrer">DeepStateMap</a>' });
    // beforeId тримає весь шар нижче за ukraine-sovereignty-fill, ukraine-region-lines і ukraine-state-border
    map.addLayer({ id: 'occupation-fill', type: 'fill', source: 'occupation-areas', paint: {
      'fill-color': occupationColor,
      'fill-opacity': ['case',['==',['get','status'],'occupied'],.17,['==',['get','status'],'liberated'],.11,.19]
    } }, 'ukraine-sovereignty-fill');
    // Штрихування залежить від canvas: якщо візерунок не створився, лишаємо заливку й контури.
    try {
      if (!map.hasImage('occupation-hatch-pattern')) map.addImage('occupation-hatch-pattern', hatchPattern('#ff7a4d', .7), { pixelRatio: 2 });
      map.addLayer({ id: 'occupation-hatch', type: 'fill', source: 'occupation-areas', filter: ['==',['get','status'],'occupied'],
        paint: { 'fill-pattern': 'occupation-hatch-pattern', 'fill-opacity': .5 } }, 'ukraine-sovereignty-fill');
    } catch { /* без візерунка окуповані території лишаються позначені заливкою й контуром */ }
    map.addLayer({ id: 'occupation-line', type: 'line', source: 'occupation-areas', filter: ['!=',['get','status'],'contested'], paint: {
      'line-color': occupationColor, 'line-width': ['case',['==',['get','status'],'occupied'],1.1,.7], 'line-opacity': .5
    } }, 'ukraine-sovereignty-fill');
    map.addLayer({ id: 'occupation-contested-line', type: 'line', source: 'occupation-areas', filter: ['==',['get','status'],'contested'], paint: {
      'line-color': '#8f9b94', 'line-width': 1.1, 'line-dasharray': [2,2], 'line-opacity': .65
    } }, 'ukraine-sovereignty-fill');
    occupationLayersReady = true;
    applyOccupationVisibility();
  } catch { /* без цього шару карта лишається повністю робочою */ }
  renderOccupationLegend();
}

function renderOccupationLegend() {
  const onMap = occupationOnMap();
  const hasAreas = onMap && occupationCollection().features.length > 0;
  const stale = occupationStale();
  const toggle = $('.layer-toggle[data-layer="occupation"]');
  // Перемикати нічого, якщо контурів немає — тоді перемикач лишається схованим.
  if (toggle) {
    toggle.hidden = !hasAreas;
    toggle.classList.toggle('is-active', occupationVisible);
    toggle.classList.toggle('is-stale', stale);
  }
  const legend = $('#occupation-legend');
  if (!legend) return;
  legend.hidden = !onMap;
  if (!onMap) return;
  legend.classList.toggle('is-off', hasAreas && !occupationVisible);
  legend.classList.toggle('is-stale', stale);
  const attributionName = occupation.attribution?.name || 'DeepStateMap';
  const attributionUrl = safeUrl(occupation.attribution?.url) ?? 'https://deepstatemap.live';
  const rows = hasAreas
    ? `<ul class="legend-rows">
        <li><i class="legend-swatch occupied"></i><span>Тимчасово окупована територія України</span></li>
        <li><i class="legend-swatch contested"></i><span>Сіра зона — контроль не підтверджено</span></li>
        <li><i class="legend-swatch liberated"></i><span>Звільнена територія</span></li>
      </ul>`
    : '<p class="legend-empty">Контурів для цього зрізу не отримано. Решта карти працює у звичайному режимі.</p>';
  // Позначка «застаріло» і час зрізу стоять у самому summary: легенда згорнута за замовчуванням,
  // і застарілий шар не має жодного шансу виглядати актуальним, поки її ніхто не розгорнув.
  const captured = occupation.capturedLabel ? `станом на ${escapeHtml(occupation.capturedLabel)}` : 'час зрізу не вказано';
  const areas = occupationCollection().features.length;
  const summary = hasAreas ? `${areas} ${pluralUk(areas, 'контур', 'контури', 'контурів')} · ${captured}` : captured;
  legend.innerHTML = `<summary><i class="swatch occupation"></i><span class="legend-title">Окуповані території</span><span class="legend-sum">${summary}</span>${stale ? '<b class="legend-stale">застаріло</b>' : ''}<span class="legend-caret" aria-hidden="true">▾</span></summary>
    <div class="legend-body">
      ${stale ? '<p class="legend-warning">Шар не оновлювався надто довго. Лінія контролю могла змінитися — не покладайтеся на ці контури як на поточні.</p>' : ''}
      ${rows}
      <p class="legend-note">Окупація — тимчасовий фактичний стан на території України, а не зміна кордону. Державний кордон України залишається незмінним; АР Крим і Севастополь — територія України.</p>
      <p class="legend-source">Джерело шару: <a href="${escapeHtml(attributionUrl)}" target="_blank" rel="noreferrer">${escapeHtml(attributionName)} ↗</a></p>
    </div>`;
}

// ------------------------------------------------------------------------------------------------
// Іконки типів загроз — растеризація, джерело, шари
// ------------------------------------------------------------------------------------------------
//
// Canvas → ImageData → map.addImage, без SDF, по одному попередньо тонованому зображенню на пару
// (клас, тон). Той самий шлях, яким уже живе occupation-hatch-pattern, і обраний він з однієї
// причини: він СИНХРОННИЙ. new Image() з data:-адресою змагався б зі style.load, а глобальний
// обробник styleimagemissing підставляє на будь-який невідомий id прозорий піксель 1×1 мовчки, без
// жодного попередження в консолі, — тож запізніле зображення малювалося б як ніщо, і «іконки немає»
// не відрізнялося б від «іконка не додалася».

function roundedRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Одна фішка = один клас × один тон. Тон уже вкладено в пікселі: MapLibre не вміє фарбувати
// звичайне (не-SDF) зображення, і це свідомий обмін — 40 крихітних канвасів проти дистанційних
// полів, які довелося б рахувати самим.
function threatIconImage(threatType, tone) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ICON_CHIP_PX * ICON_PIXEL_RATIO;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(ICON_PIXEL_RATIO, ICON_PIXEL_RATIO);

  // 1. фішка
  roundedRectPath(ctx, 0.75, 0.75, ICON_CHIP_PX - 1.5, ICON_CHIP_PX - 1.5, 8);
  ctx.globalAlpha = iconChipAlpha[tone];
  ctx.fillStyle = iconChipColor[tone];
  ctx.fill();
  ctx.globalAlpha = 1;

  // 2. наслідки — штрихування під 45°, обрізане самою фішкою. Той самий словник, яким шар
  //    окупації вже позначає «територія у спірному стані»; кут протилежний, щоб два штрихування
  //    ніколи не злилися в одне.
  if (tone === 'consequence') {
    ctx.save();
    ctx.clip();
    ctx.globalAlpha = .25; ctx.strokeStyle = '#06080c'; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let offset = -ICON_CHIP_PX; offset < ICON_CHIP_PX * 2; offset += 6) {
      ctx.moveTo(offset, ICON_CHIP_PX); ctx.lineTo(offset + ICON_CHIP_PX, 0);
    }
    ctx.stroke();
    ctx.restore();
    roundedRectPath(ctx, 0.75, 0.75, ICON_CHIP_PX - 1.5, ICON_CHIP_PX - 1.5, 8);
  }

  // 3. обвід фішки — щоб помаранчева фішка читалася і на помаранчевій заливці загрози
  ctx.globalAlpha = .9; ctx.strokeStyle = '#06080c'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.globalAlpha = 1;

  // 4. повідомлене, але не підтверджене — пунктирне кільце. Форма, а не лише прозорість:
  //    прозорість на світлій підкладці не читається взагалі.
  if (tone === 'reported') {
    ctx.setLineDash([2, 2]);
    roundedRectPath(ctx, 3.25, 3.25, ICON_CHIP_PX - 6.5, ICON_CHIP_PX - 6.5, 5.5);
    ctx.globalAlpha = .85; ctx.strokeStyle = '#0b0d10'; ctx.lineWidth = 1; ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }

  // 5. гліф
  const scale = ICON_GLYPH_BOX / ICON_GLYPH_GRID;
  const inset = (ICON_CHIP_PX - ICON_GLYPH_BOX) / 2;
  ctx.save();
  ctx.translate(inset, inset);
  ctx.scale(scale, scale);
  ctx.fillStyle = '#0b0d10';
  ctx.fill(new Path2D(threatIconPaths[threatType] ?? threatIconPaths.unknown), 'evenodd');
  ctx.restore();

  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// Реєстрація ЗАВЖДИ передує додаванню шарів — див. коментар про styleimagemissing вище.
// map.addImage НЕ переживає map.remove(), а карту знищують на кожному переході з маршруту '/',
// тож це виклик усередині style.load, а не одноразова ініціалізація рівня модуля.
function addThreatIconImages(map) {
  let registered = 0;
  for (const threatType of Object.keys(threatIconPaths)) {
    for (const tone of iconTones) {
      const id = iconImageId(threatType, tone);
      if (map.hasImage(id)) { registered += 1; continue; }
      const image = threatIconImage(threatType, tone);
      if (!image) return false;
      map.addImage(id, image, { pixelRatio: ICON_PIXEL_RATIO });
      registered += 1;
    }
  }
  return registered === Object.keys(threatIconPaths).length * iconTones.length;
}

function iconFamilyVisible(tone) {
  const group = iconToneGroup[tone];
  const toggle = group ? $(`.layer-toggle[data-layer="${group}"]`) : null;
  return !toggle || toggle.classList.contains('is-active');
}

// «РСЗВ» мусить лишитися «РСЗВ». Опускаємо першу літеру лише тоді, коли друга вже мала.
function lowerFirstUk(value) {
  return /^[A-ZА-ЯЁІЇЄҐ][a-zа-яёіїєґ]/u.test(value) ? value[0].toLowerCase() + value.slice(1) : value;
}

// Рядок для читача екрана. Карта для нього — порожній <canvas>, тож стан територій мусить існувати
// текстом. Вісім територій, не більше: далі це вже не оперативна картина, а диктант.
function territoryAriaSentence(territory, shownIcons, overflow) {
  const parts = [];
  if (territory.alertActive) parts.push('офіційна тривога');
  for (const icon of shownIcons) parts.push(lowerFirstUk(icon.labelUk ?? threatIconLabels[icon.threatType] ?? icon.threatType));
  // Те саме число, що й у бейджі. Читач екрана і карта не мають права рахувати по-різному.
  if (overflow > 0) parts.push(`ще ${overflow} тип${pluralUk(overflow, '', 'и', 'ів')}`);
  return `${territory.name}: ${parts.join(', ')}.`;
}

// Пріоритет стека рахує сервер (`territories[].icons` + `iconOverflow`). Браузер його НЕ
// перераховує: інакше карта й тести сортували б за двома різними реалізаціями одного правила.
function territoryIconCollection() {
  const features = [];
  const tier = iconTier ?? 'oblast';
  for (const territory of snapshotTerritories()) {
    // Районні стеки зʼявляються лише коли районний шар уже читається; обласні (`direct` /
    // `unmapped`) лишаються на всіх масштабах — детальнішого шару, який їх підмінить, не існує,
    // і це та сама межа, за якою вже гасне обласний підпис тривоги.
    if (tier === 'oblast' && territory.tier === 'raion') continue;
    const point = regionCentroid(territory.locationId);
    if (!point) continue;                       // adm2 ще не приїхав або контуру немає взагалі
    const all = territory.icons ?? [];
    const visible = all.filter((icon) => iconFamilyVisible(icon.tone));
    if (!visible.length) continue;
    const slots = visible.slice(0, MAX_ICON_SLOTS);
    const offsets = ICON_SLOT_OFFSETS[slots.length];
    // «+N» рахує тільки те, що відрізало РАНЖУВАННЯ. Поки нічого не приховано, це число сервера.
    // Щойно перемикач прибрав хоч одного кандидата, серверне число більше не описує цей стек:
    // воно сказало б «+1» над стеком, у якому кандидатів було чотири, а показано два. Тоді «+N»
    // рахує лише те, що ранжування відрізало СЕРЕД іконок, які користувач вирішив бачити.
    // Іконка, яку вимкнув користувач, — це не «решта», це вибір.
    const hidden = all.length - visible.length;
    const overflow = hidden > 0
      ? Math.max(0, visible.length - MAX_ICON_SLOTS)
      : Math.max(0, visible.length - MAX_ICON_SLOTS) + (territory.iconOverflow ?? 0);
    // Столиця й район не діляться центроїдом з областю, всередині якої лежать, — див. ICON_TIER_LIFT.
    // Одиниці різні: off{n} потрапляє в icon-offset і міряється в пікселях, badgeOffset потрапляє
    // в text-offset і міряється в емах кегля бейджа, тож той самий підйом ділиться на кегль.
    const lift = territory.tier === 'oblast' ? 0 : ICON_TIER_LIFT;
    const badgeOffset = ICON_BADGE_OFFSET[slots.length];
    const properties = {
      locationId: territory.locationId,
      tier: territory.tier,
      overflow,
      overflowLabel: `+${overflow}`,
      // Зсув бейджа рахується від slots.length, тобто від іконок, які реально намальовано.
      badgeOffset: [badgeOffset[0], badgeOffset[1] + lift / ICON_BADGE_TEXT_SIZE],
      aria: territoryAriaSentence(territory, slots, overflow)
    };
    slots.forEach((icon, index) => {
      properties[`icon${index}`] = icon.iconId ?? iconImageId(icon.threatType, icon.tone);
      properties[`off${index}`] = [offsets[index][0], offsets[index][1] + lift];
    });
    features.push({ type: 'Feature', id: `ti-${territory.locationId}`,
      geometry: { type: 'Point', coordinates: point }, properties });
  }
  return { type: 'FeatureCollection', features };
}

// Спільний конструктор ЛИШЕ для layout: у ньому немає ні `map.addLayer(`, ні `id:`, тож парсер
// порядку шарів його не бачить і не мусить бачити.
// ['array','number',2,…] — явне твердження типу. `['get','off0']` має тип `value`, а icon-offset
// очікує array<number,2>; покладатися на неявне приведення означало б залежати від деталі
// реалізації парсера виразів.
const slotLayout = (index) => ({
  'icon-image': ['get', `icon${index}`],
  'icon-size': 1,
  'icon-offset': ['array', 'number', 2, ['get', `off${index}`]],
  // Стек, у якому колізія погасила один слот, БРЕХАВ БИ про те, що є на території.
  'icon-allow-overlap': true,
  // …але підписи він відштовхує: назва області має поступитися іконці, а не лягти на неї.
  'icon-ignore-placement': false,
  'icon-padding': 2
});

function addTerritoryIconLayers() {
  if (!iconImagesReady) return;   // без зображень шар малював би прозорі пікселі 1×1
  map.addSource('territory-icons', { type: 'geojson', data: territoryIconCollection() });
  // Три окремі виклики з рядковими літералами id. Фабрика тут неможлива: тест порядку шарів читає
  // ТЕКСТ виклику й шукає в ньому id: '…' в одинарних лапках.
  map.addLayer({ id: 'territory-icon-slot-0', type: 'symbol', source: 'territory-icons',
    filter: ['has', 'icon0'], layout: slotLayout(0) });
  map.addLayer({ id: 'territory-icon-slot-1', type: 'symbol', source: 'territory-icons',
    filter: ['has', 'icon1'], layout: slotLayout(1) });
  map.addLayer({ id: 'territory-icon-slot-2', type: 'symbol', source: 'territory-icons',
    filter: ['has', 'icon2'], layout: slotLayout(2) });
  // Шрифт бейджа приходить із того самого віддаленого джерела гліфів, що й шість наявних текстових
  // шарів. Якщо гліфи не завантажаться, бейдж мовчки зникне, а самі іконки — растрові зображення —
  // лишаться. Це правильна деградація: три найважливіші типи намальовані, втрачено лише «і ще N».
  map.addLayer({ id: 'territory-icon-badge', type: 'symbol', source: 'territory-icons',
    filter: ['>', ['get', 'overflow'], 0],
    layout: {
      'text-field': ['get', 'overflowLabel'], 'text-size': ICON_BADGE_TEXT_SIZE,
      'text-font': ['Noto Sans Regular'],
      'text-offset': ['array', 'number', 2, ['get', 'badgeOffset']],
      'text-allow-overlap': true
    },
    paint: { 'text-color': '#e9e7e0', 'text-halo-color': '#06080c', 'text-halo-width': 1.6 } });
  iconLayersReady = true;
}

function updateTerritoryIcons() {
  if (!mapLayersReady) return;
  // Растрові шари іконок можуть не існувати взагалі: canvas 2D або Path2D недоступні, addImage
  // кинув — і addTerritoryIconLayers() тихо вийшов. Це деградація в бік меншої кількості картинки,
  // а не в бік мовчання: текстовий еквівалент карти не має права залежати від того, чи вдалося
  // намалювати бітмапи, інакше читач екрана лишився б із порожнім #map-aria на живій карті.
  if (iconLayersReady) map.getSource('territory-icons')?.setData(territoryIconCollection());
  writeMapAria();
}

function writeMapAria() {
  const node = $('#map-aria');
  if (!node) return;
  const stacked = new Map(territoryIconCollection().features
    .map((feature) => [feature.properties.locationId, feature.properties.aria]));
  const tier = iconTier ?? 'oblast';
  // Офіційна тривога — це заливка, а не іконка, тож територія під самою лише тривогою не має фічі
  // в territory-icons узагалі. Будувати живу ділянку зі стеків означало б, що одна іконка де
  // завгодно на карті забирає в читача екрана геть усі тривоги: масова ніч із тривогами на
  // пʼятнадцяти областях і одним БпЛА над Одесою прочиталася б як одна Одеса. Речення для таких
  // територій складаємо тут, і тривоги йдуть першими — це найсильніший стан карти.
  const alerted = [];
  const rest = [];
  for (const territory of snapshotTerritories()) {
    // Та сама межа, що й у стеках: на оглядовому масштабі район не має ні іконки, ні речення.
    if (tier === 'oblast' && territory.tier === 'raion') continue;
    const line = stacked.get(territory.locationId)
      ?? (territory.alertActive ? territoryAriaSentence(territory, [], 0) : null);
    if (!line) continue;
    (territory.alertActive ? alerted : rest).push(line);
  }
  const all = [...alerted, ...rest];
  // Знімок без territories[] не дає жодного рядка, але тривоги в ньому є, і карта для читача
  // екрана не має права мовчати про них.
  const lines = all.length ? all.slice(0, 8) : (snapshot?.alerts ?? []).slice(0, 8)
    .map((alert) => `${alert.location_name}: офіційна тривога.`);
  const text = lines.length
    ? `${lines.join(' ')}${all.length > 8 ? ` Показано 8 територій із ${all.length}.` : ''}`
    : 'Активних позначок на карті немає.';
  // aria-live перечитує вузол при КОЖНІЙ зміні тексту, а знімок оновлюється до чотирьох разів на
  // секунду. Без цієї перевірки читач екрана під час хвилі говорив би без упину.
  if (node.textContent === text) return;
  node.textContent = text;
}

// Кодування чотирьох станів карти й десяти типів загроз. Тепер це ЄДИНЕ візуальне місце, де воно
// записане: підпис під картою більше не повторює ті самі шість речень, бо два формулювання одного
// кодування — це два кодування, і на 980 px одне з них зникало разом із поясненням.
//
// Легенда згорнута за замовчуванням на будь-якій ширині, тож увесь її зміст мусить бути й у
// текстовому еквіваленті карти (#map-legend-text, див. ensureMapOverlays) — інакше читач екрана
// отримав би менше, ніж дає одне натискання на «▾».
function renderThreatLegend() {
  const panels = $('.map-panels');
  if (!panels) return;
  let legend = $('#threat-legend');
  if (!legend) {
    legend = document.createElement('details');
    legend.id = 'threat-legend';
    legend.className = 'occupation-legend';
    legend.addEventListener('toggle', () => { threatLegendOpen = legend.open; });
    // Одразу під перемикачами шарів: легенда пояснює саме їх, а не шар окупації.
    panels.insertBefore(legend, $('.sovereignty-badge') ?? null);
  }
  legend.open = threatLegendOpen ?? false;
  // Гліф у легенді — той самий рядок path, що вже лежить у бандлі, вставлений інлайновим SVG:
  // ні data:-адреси, ні зайвого запиту. Тон беремо «підтверджене джерело» — це нейтральний
  // представник класу, а не заява про стан якоїсь конкретної території.
  //
  // Підпис короткий, повна назва — в title і в aria-label самого рядка: сітка 2×5 має тримати
  // однакову висоту клітинок, а перенесення «Мінометний обстріл» ламало саме її.
  const iconRow = (threatType) => {
    const short = threatIconShortLabels[threatType] ?? threatIconLabels[threatType] ?? threatType;
    const full = threatIconLabels[threatType] ?? threatType;
    const aria = iconAriaLabel(threatType, 'confirmed');
    return `<li title="${escapeHtml(full)}"><i class="legend-icon" role="img" aria-label="${escapeHtml(aria)}">`
      + `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">`
      + `<path fill="currentColor" fill-rule="evenodd" d="${threatIconPaths[threatType]}"/></svg>`
      + `</i><span>${escapeHtml(short)}</span></li>`;
  };
  legend.innerHTML = `<summary><i class="swatch threat"></i><span class="legend-title">Загрози на карті</span><span class="legend-sum">4 стани · 10 типів</span><span class="legend-caret" aria-hidden="true">▾</span></summary>
    <div class="legend-body">
      <ul class="legend-rows legend-states">
        <li><i class="legend-swatch state-alert"></i><span><b>Офіційна тривога</b>щільна червона заливка й контур</span></li>
        <li><i class="legend-swatch state-threat"></i><span><b>Активна загроза</b>помаранчева заливка, слабша за тривогу</span></li>
        <li><i class="legend-swatch state-consequence"></i><span><b>Атака або наслідки</b>штрихування</span></li>
        <li><i class="legend-swatch state-analytic"></i><span><b>Аналітична оцінка</b>сірий пунктир без заливки. Це не тривога</span></li>
      </ul>
      <ul class="legend-rows legend-icons">${Object.keys(threatIconPaths).map(iconRow).join('')}</ul>
      <p class="legend-note">Показано до трьох найважливіших типів; решта — у бейджі +N. Іконка не означає прогнозу цілі, а напрямки не є прогнозом траєкторії.</p>
      <p class="legend-note">Коли стан оголошено на окремі райони, світяться саме вони — на будь-якому
        масштабі; решта області лишається темною. Область заливається тоді, коли стан оголошено на
        всю неї або коли названо місце без власного контуру всередині неї.</p>
    </div>`;
}

// Живий регіон і плашка режиму публікації живуть у .map-stage, а не в public/index.html: той файл
// правлять інші гілки, а обидва вузли мають існувати рівно тоді, коли на екрані є карта.
function ensureMapOverlays() {
  const stage = $('.map-stage');
  if (!stage) return;
  if (!$('#map-aria')) {
    const node = document.createElement('div');
    node.id = 'map-aria';
    node.className = 'visually-hidden';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    stage.append(node);
  }
  // Текстовий еквівалент КОДУВАННЯ карти, на відміну від #map-aria, який перелічує території.
  // Розділені навмисно з двох причин. Перша: aria-live перечитує свій вузол на кожну зміну, а
  // постійне правило не має оголошуватися по чотири рази на секунду під час хвилі. Друга: легенда
  // тепер згорнута за замовчуванням, а підпису під картою більше немає — без цього вузла читач
  // екрана лишився б без пояснення заливок узагалі. Текст дослівно повторює #threat-legend.
  if (!$('#map-legend-text')) {
    const node = document.createElement('div');
    node.id = 'map-legend-text';
    node.className = 'visually-hidden';
    node.textContent = 'Кодування карти. Офіційна тривога — щільна червона заливка й контур. '
      + 'Активна загроза — помаранчева заливка, слабша за тривогу. '
      + 'Підтверджена атака або наслідки — штрихування. '
      + 'Аналітична оцінка — сірий пунктирний контур без заливки. Це не тривога. '
      + 'Коли стан оголошено на окремі райони, світяться саме вони — на будь-якому масштабі; '
      + 'решта області лишається темною. Іконка показує тип загрози, до трьох на територію; '
      + 'решта — у бейджі «плюс N». Клікніть територію, щоб побачити її стан. '
      + 'Напрямки не є прогнозом траєкторії.';
    stage.append(node);
  }
  if (!$('#publication-chip')) {
    const chip = document.createElement('p');
    chip.id = 'publication-chip';
    chip.className = 'map-chip';
    chip.setAttribute('role', 'status');
    chip.hidden = true;
    chip.textContent = 'Показ затримано на 15 с за рішенням оператора. Збір даних не затримується.';
    stage.append(chip);
  }
}

function updatePublicationChip() {
  const chip = $('#publication-chip');
  if (!chip) return;
  const publication = snapshot?.publication ?? null;
  // Тривалість затримки конфігурована (5–60 с), тож текст чіпа читає її зі зрізу, а не з константи.
  chip.textContent = `Показ затримано на ${publication?.delaySeconds ?? 15} с за рішенням оператора. Збір даних не затримується.`;
  chip.hidden = publication?.mode !== 'delayed_15s';
}

function initMap() {
  occupationLayersReady = false; // карту створюють наново лише при поверненні на маршрут карти — шари доводиться додавати з нуля
  mapLayersReady = false;
  iconImagesReady = false;
  iconLayersReady = false;
  iconTier = null;
  ensureMapOverlays();
  map = new maplibregl.Map({ container: 'map', style: config.mapStyleUrl, center: [31.2, 48.8], zoom: 5.1, attributionControl: false });
  map.on('styleimagemissing', (event) => {
    if (!map.hasImage(event.id)) map.addImage(event.id, { width: 1, height: 1, data: new Uint8Array([0,0,0,0]) });
  });
  // Єдиний обробник масштабу у файлі. MapLibre забороняє вираз ['zoom'] усередині filter, а згасання
  // прозорістю лишило б невидимі іконки займати місце в колізіях і виштовхувати справжні за межі
  // карти. Тому джерело просто перевипускається на межі іконкового масштабу.
  map.on('zoomend', () => {
    const next = map.getZoom() >= ICON_TIER_ZOOM ? 'raion' : 'oblast';
    if (next === iconTier) return;           // шторм панорамування нічого не коштує
    iconTier = next;
    updateTerritoryIcons();
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  // Саме 'style.load', а не 'load': 'load' чекає ще й на завантаження тайлів підкладки,
  // тож при повільному або недоступному tiles.openfreemap.org жоден наш шар не зʼявився б —
  // ні державний кордон, ні підпис Криму, ні окупація. Стиль розібрано — можна додавати шари.
  map.on('style.load', () => {
    // Сорок зображень реєструються ПЕРШИМИ, до будь-якого шару іконок. Якщо canvas недоступний або
    // addImage кинув — iconImagesReady лишається false, addTerritoryIconLayers() виходить одразу,
    // і жодного шару іконок немає взагалі. Полігони при цьому не змінюються: деградація в бік
    // меншої кількості інформації, ніколи — у бік помилки.
    try {
      iconImagesReady = addThreatIconImages(map);
    } catch { iconImagesReady = false; }
    map.addSource('ukraine-country', { type: 'geojson', data: countryBoundary });
    map.addSource('ukraine-admin', { type: 'geojson', data: adminBoundaries, promoteId: 'locationId' });
    // promoteId дослівно збігається з locations.id у базі — саме він робить можливим setFeatureState
    // замість перегенерації геометрії на кожен тік потоку.
    // Межі районів — похідна база даних з OpenStreetMap, яку ми самі роздаємо клієнтам за
    // /data/ukraine-adm2.geojson. ODbL вимагає окремої атрибуції: «© OpenStreetMap contributors»
    // від підкладки її не покриває, бо це інший продукт із іншим ланцюгом походження.
    map.addSource('ukraine-raions', { type: 'geojson', data: raionCollection(), promoteId: 'locationId',
      attribution: 'Межі: © учасники OpenStreetMap, <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noreferrer">ODbL 1.0</a>' });
    map.addSource('ukraine-cities', { type: 'geojson', data: cityCollection(), promoteId: 'locationId' });
    map.addSource('alert-labels', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('sovereignty-labels', { type: 'geojson', data: { type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [34.25,45.25] }, properties: { label: 'АР КРИМ · УКРАЇНА' } }
    ] } });
    // map.addImage не переживає map.remove(), а карту перестворюють на кожне повернення на маршрут
    // карти, тож реєстрація живе тут, а не в одноразовому модульному коді.
    // Якщо canvas недоступний — лишаємо суцільну заливку: менше інформації, але не помилка.
    let consequenceHatchReady = false;
    try {
      if (!map.hasImage('consequence-hatch-pattern')) {
        map.addImage('consequence-hatch-pattern', hatchPattern(consequenceColor, .85, 'up'), { pixelRatio: 2 });
      }
      consequenceHatchReady = true;
    } catch { /* без візерунка наслідки лишаються заливкою й контуром */ }
    // Один шар — один map.addLayer із власним літеральним id. Через це вибір між візерунком і
    // суцільним кольором робить помічник фарби, а не друга гілка з тим самим ідентифікатором.
    const consequenceFillPaint = (opacity) => ({
      ...(consequenceHatchReady
        ? { 'fill-pattern': 'consequence-hatch-pattern' }
        : { 'fill-color': consequenceColor }),
      'fill-opacity': opacity
    });
    map.addLayer({ id: 'ukraine-sovereignty-fill', type: 'fill', source: 'ukraine-country', paint: {
      'fill-color': '#72d6ca', 'fill-opacity': .035
    } });
    map.addLayer({ id: 'ukraine-region-fill', type: 'fill', source: 'ukraine-admin', paint: {
      'fill-color': ['case',['==',['get','sovereignty'],'crimea-ukraine'],'#e3b341','#72d6ca'],
      'fill-opacity': ['case',['==',['get','sovereignty'],'crimea-ukraine'],.11,.015]
    } });
    map.addLayer({ id: 'ukraine-region-lines', type: 'line', source: 'ukraine-admin', paint: {
      'line-color': ['case',['==',['get','sovereignty'],'crimea-ukraine'],'#e3b341','#72d6ca'],
      'line-width': ['case',['==',['get','sovereignty'],'crimea-ukraine'],1.5,.55], 'line-opacity': .62
    } });
    map.addLayer({ id: 'ukraine-state-border', type: 'line', source: 'ukraine-country', paint: {
      'line-color': '#e9e7e0', 'line-width': ['interpolate',['linear'],['zoom'],4,1.8,8,3.4], 'line-opacity': .95
    } });
    // ---- активна загроза -----------------------------------------------------------------------
    // Слабша за офіційну тривогу навмисно: це повідомлення моніторингу, а не рішення держави.
    // Заливка йде ПІД тривожну: додається раніше під тим самим якорем, тож червоне завжди виграє.
    map.addLayer({ id: 'threat-oblast-fill', type: 'fill', source: 'ukraine-admin', paint: {
      'fill-color': threatColor,
      'fill-opacity': ['case', threatFlag, .22, threatUnmappedFlag, .16, 0]
    } }, 'ukraine-sovereignty-fill');
    map.addLayer({ id: 'threat-raion-fill', type: 'fill', source: 'ukraine-raions', paint: {
      'fill-color': threatColor,
      'fill-opacity': ['case', threatFlag, .28, threatUnmappedFlag, .20, 0]
    } }, 'ukraine-sovereignty-fill');
    // Заливки тривоги йдуть під ukraine-sovereignty-fill і додаються ПЕРЕД addOccupationLayers(),
    // тож окупаційні шари вставляються поверх них і лишаються читабельними, як і раніше.
    // Золоте підсвічування суверенітету (ukraine-region-fill) теж лишається зверху — воно важливіше за колір тривоги.
    // Область заливається ЛИШЕ тоді, коли тривогу оголошено на всю неї (alert) або коли названо
    // місце без власного контуру всередині неї (unmapped) — там детальнішого шару не буде ніколи.
    // Область, у якій названо конкретні райони, не заливається взагалі: за неї говорять її ж
    // засвічені районні полігони, а тихі райони лишаються темними. Поки ADM2 у польоті, районних
    // фіч немає, і та сама тривога приходить сюди як `unmapped` (див. claim()) — область світиться,
    // тривога з карти не зникає.
    map.addLayer({ id: 'alert-oblast-fill', type: 'fill', source: 'ukraine-admin', paint: {
      'fill-color': alertColor,
      'fill-opacity': ['case', alertFlag, .34, unmappedFlag, .24, 0]
    } }, 'ukraine-sovereignty-fill');
    map.addLayer({ id: 'alert-raion-fill', type: 'fill', source: 'ukraine-raions', paint: {
      'fill-color': alertColor,
      'fill-opacity': ['case', alertFlag, .40, unmappedFlag, .28, 0]
    } }, 'ukraine-sovereignty-fill');
    // ---- підтверджена атака / наслідки ---------------------------------------------------------
    // Штрихування, а не колір: наслідки — це те, що ВЖЕ сталося, і воно не мусить конкурувати
    // з тривогою відтінком червоного. Лежить НАД тривогою: підтверджений удар важливіший за попередження.
    map.addLayer({ id: 'consequence-oblast-fill', type: 'fill', source: 'ukraine-admin',
      paint: consequenceFillPaint(['case', consequenceFlag, .55, consequenceUnmappedFlag, .40, 0])
    }, 'ukraine-sovereignty-fill');
    map.addLayer({ id: 'consequence-raion-fill', type: 'fill', source: 'ukraine-raions',
      paint: consequenceFillPaint(['case', consequenceFlag, .55, consequenceUnmappedFlag, .40, 0])
    }, 'ukraine-sovereignty-fill');
    addOccupationLayers();
    // ---- аналітична оцінка ---------------------------------------------------------------------
    // Три незалежні осі відмінності від офіційної тривоги: без заливки, пунктиром і сталевим кольором.
    // Жодна з них окремо не рятує — разом їх неможливо сплутати. Там, де є тривога або загроза,
    // прозорість примусово нульова: найслабший сигнал не перемальовує сильніший.
    // crimeaSovereignty перевіряється першим: районні фічі властивості sovereignty не мають узагалі,
    // тож на них ця гілка просто хибна, і той самий вираз працює на обох рівнях.
    // Один вираз на обидва рівні: похідне покриття не малює нічого, тож обласному й районному
    // пунктиру більше нічим відрізнятися.
    const analyticOpacity = ['case',
      crimeaSovereignty, 0,
      strongerThanAnalytic, 0,
      analyticFlag, .70, analyticUnmappedFlag, .50, 0];
    map.addLayer({ id: 'analytic-raion-line', type: 'line', source: 'ukraine-raions', paint: {
      'line-color': analyticColor, 'line-dasharray': [1,2],
      'line-width': ['interpolate',['linear'],['zoom'], 4, 1.0, 8, 2.0],
      'line-opacity': analyticOpacity
    } }, 'ukraine-region-lines');
    map.addLayer({ id: 'analytic-oblast-line', type: 'line', source: 'ukraine-admin', paint: {
      'line-color': analyticColor, 'line-dasharray': [1,2],
      'line-width': ['interpolate',['linear'],['zoom'], 4, 1.0, 8, 2.0],
      'line-opacity': analyticOpacity
    } }, 'ukraine-region-lines');
    // ---- активна загроза -----------------------------------------------------------------------
    // Товщина ліній — єдине, чим тут керує масштаб: на оглядовому масштабі 136 контурів по 1.4 px
    // зливаються в сітку й перебивають власні заливки. Прозорість від масштабу не залежить: те,
    // ЩО стверджує карта, не може змінюватися від того, наскільки користувач наблизив її.
    map.addLayer({ id: 'threat-raion-line', type: 'line', source: 'ukraine-raions', paint: {
      'line-color': threatColor,
      'line-width': ['interpolate',['linear'],['zoom'], 4, .4, 9, 1.4],
      'line-opacity': ['case', crimeaSovereignty, 0, threatFlag, .75, threatUnmappedFlag, .55, 0]
    } }, 'ukraine-region-lines');
    // Навколо Криму й Севастополя контуру не малюємо взагалі: там межа лишається золотою, бо це
    // підсвічування суверенітету. Стан там читається із заливки — так само, як робить тривога.
    map.addLayer({ id: 'threat-oblast-line', type: 'line', source: 'ukraine-admin', paint: {
      'line-color': threatColor,
      'line-width': ['interpolate',['linear'],['zoom'], 4, 1.1, 8, 2.2],
      'line-opacity': ['case', crimeaSovereignty, 0, threatFlag, .75, threatUnmappedFlag, .55, 0]
    } }, 'ukraine-region-lines');
    // Обидва контури тривоги лежать ПІД ukraine-region-lines: інакше червона межа перекрила б
    // золоту лінію суверенітету навколо Криму й Севастополя. Колір тривоги програє суверенітету.
    // Останнє в цьому шарі, що ще залежить від масштабу, — НЕЙТРАЛЬНА бірюзова сітка районних меж
    // (гілка за замовчуванням). Це підкладка, а не стан: на оглядовому масштабі 136 таких ліній
    // перебивали б ті кілька районів, заради яких карту й дивляться, тож вона проявляється лише
    // зблизька. Обидві державні гілки — alert і unmapped — на обох кінцях інтерполяції однакові,
    // тобто масштаб не змінює нічого з того, що карта стверджує.
    map.addLayer({ id: 'alert-raion-line', type: 'line', source: 'ukraine-raions', paint: {
      'line-color': ['case', alertFlag, alertColor, unmappedFlag, '#ff7a4d', '#72d6ca'],
      'line-width': ['interpolate',['linear'],['zoom'], 4, .35, 9, 1.3],
      'line-opacity': ['interpolate',['linear'],['zoom'],
        6,   ['case', alertFlag, .9, unmappedFlag, .66, 0],
        6.8, ['case', alertFlag, .9, unmappedFlag, .66, .22]]
    } }, 'ukraine-region-lines');
    // Навколо Криму й Севастополя червоний контур не малюємо взагалі: там межа має лишатися золотою,
    // бо це підсвічування суверенітету. Сама тривога там читається із заливки — так само, як усюди.
    // Області з тривогою лише в частині районів контуру не дістають теж — навіть волосяного:
    // обведена область читається як оголошена цілком, а це саме те твердження, якого джерело
    // не робило. Її межа лишається звичайною бірюзовою лінією ukraine-region-lines.
    map.addLayer({ id: 'alert-oblast-line', type: 'line', source: 'ukraine-admin', paint: {
      'line-color': alertColor,
      'line-width': ['interpolate',['linear'],['zoom'], 4, 1.3, 8, 2.6],
      'line-opacity': ['case', crimeaSovereignty, 0, alertFlag, .85, unmappedFlag, .58, 0]
    } }, 'ukraine-region-lines');
    // ---- підтверджена атака / наслідки ---------------------------------------------------------
    map.addLayer({ id: 'consequence-raion-line', type: 'line', source: 'ukraine-raions', paint: {
      'line-color': consequenceColor,
      'line-width': ['interpolate',['linear'],['zoom'], 4, 1.0, 9, 1.6],
      'line-opacity': ['case', crimeaSovereignty, 0, consequenceFlag, .9, consequenceUnmappedFlag, .7, 0]
    } }, 'ukraine-region-lines');
    map.addLayer({ id: 'consequence-oblast-line', type: 'line', source: 'ukraine-admin', paint: {
      'line-color': consequenceColor, 'line-width': 1.6,
      'line-opacity': ['case', crimeaSovereignty, 0, consequenceFlag, .9, consequenceUnmappedFlag, .7, 0]
    } }, 'ukraine-region-lines');
    map.addLayer({ id: 'city-hit', type: 'circle', source: 'ukraine-cities', minzoom: 5.7, paint: {
      'circle-radius': ['interpolate',['linear'],['zoom'],5.7,3,9,6], 'circle-color': '#72d6ca',
      'circle-opacity': .82, 'circle-stroke-color': '#06080c', 'circle-stroke-width': 1.5
    } });
    map.addLayer({ id: 'city-labels', type: 'symbol', source: 'ukraine-cities', minzoom: 7.2, layout: {
      'text-field': ['get','nameUk'], 'text-size': 10, 'text-offset': [0,1.15], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular']
    }, paint: { 'text-color': '#b6bbc2', 'text-halo-color': '#06080c', 'text-halo-width': 1.4 } });
    // text-allow-overlap гарантує, що підпис суверенітету намалюється завжди, хоч би скільки шарів лягло під ним;
    // text-ignore-placement лишається вимкненим, тож він, навпаки, відштовхує підписи тривог.
    // Ореол посилено до 2.6 px: під підписом тепер може лежати ще й заливка тривоги.
    map.addLayer({ id: 'crimea-ukraine-label', type: 'symbol', source: 'sovereignty-labels', minzoom: 4.2, layout: {
      'text-field': ['get','label'], 'text-size': ['interpolate',['linear'],['zoom'],4.2,10,7,14],
      'text-letter-spacing': .12, 'text-font': ['Noto Sans Regular'], 'text-allow-overlap': true, 'text-padding': 12
    }, paint: { 'text-color': '#e9e7e0', 'text-halo-color': '#06080c', 'text-halo-width': 2.6 } });
    // Підписи тривог лягають під підпис суверенітету; районний — над обласним,
    // щоб на великому масштабі точніша назва вигравала конкуренцію за місце.
    // Обидва шари підписують ЛИШЕ те, що засвічено: alertLabelCollection() більше не випускає фіч
    // похідного покриття, тож жодна прозорість тут ні від чого не залежить.
    map.addLayer({ id: 'alert-oblast-label', type: 'symbol', source: 'alert-labels', filter: ['==',['get','level'],'oblast'], layout: {
      'text-field': ['get','label'], 'text-size': ['interpolate',['linear'],['zoom'],4.5,11,8,14],
      'text-transform': 'uppercase', 'text-letter-spacing': .05, 'text-max-width': 7, 'text-padding': 6,
      'text-offset': [0,-1.4], 'text-font': ['Noto Sans Regular']
    }, paint: { 'text-color': '#ffe1d8', 'text-halo-color': '#06080c', 'text-halo-width': 1.9
    } }, 'crimea-ukraine-label');
    // Назва району читається на оглядовому масштабі — це головне, що робить окремий засвічений
    // район твердженням, а не плямою. Ні text-allow-overlap, ні text-ignore-placement тут немає й
    // не буде: проріджує підписи саме колізія MapLibre, і саме вона тримає оглядовий масштаб
    // чистим, коли тривога охоплює півкраїни. Ширший text-padding на оглядовому масштабі просить
    // її бути суворішою, менший зблизька — дозволяє показати всі.
    map.addLayer({ id: 'alert-raion-label', type: 'symbol', source: 'alert-labels', filter: ['==',['get','level'],'raion'], layout: {
      'text-field': ['get','label'], 'text-max-width': 8, 'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate',['linear'],['zoom'], 4.5, 9, 8, 11.5],
      'text-padding': ['interpolate',['linear'],['zoom'], 4.5, 9, 8, 4]
    }, paint: { 'text-color': '#ffd2c6', 'text-halo-color': '#06080c', 'text-halo-width': 1.7
    } }, 'crimea-ukraine-label');
    map.addSource('reported-directions', { type: 'geojson', data: directionCollection() });
    map.addLayer({ id: 'direction-lines', type: 'line', source: 'reported-directions', paint: { 'line-color': '#ff7a4d', 'line-width': 3, 'line-dasharray': [2,2], 'line-opacity': .8 } });
    addVectorLayers();
    addTerritoryIconLayers();
    // Один клік має відкрити одну панель. Обробник висить на кількох шарах, і MapLibre викликає його
    // окремо для кожного, у якому під точкою є фіча, — тож роботу робимо один раз на один DOM-клік
    // (originalEvent у всіх викликах той самий обʼєкт) і самі вирішуємо, яка територія точніша:
    // іконка → місто → район → область. Стек іконок — найточніша заява про територію на карті,
    // тож він виграє в усіх. Вимкнений перемикач просто знижує точність, а не ламає клік.
    //
    // DOM-клік забирає собі ТОЙ виклик, який справді відкриває панель, — тобто прапорець ставиться
    // після всіх перевірок точності, а не на вході. Порядок, у якому MapLibre викликає обробники,
    // ніде не задокументований: у 5.24 він збігається з порядком реєстрації, а там найгрубіший шар
    // (ukraine-region-fill накриває всю країну) стоїть попереду і районних заливок, і city-hit.
    // Прапорець, поставлений на вході, віддавав би клік саме йому — він виходив би по перевірці
    // точності, а точніші шари вже не мали б шансу, і над районом чи містом не відкривалося б
    // нічого. Так виграє найточніший шар за будь-якого порядку викликів, а три районні заливки над
    // одним полігоном усе одно відкривають рівно одну панель: перша з них ставить прапорець.
    //
    // Районні заливки існують на будь-якому масштабі й повертаються з queryRenderedFeatures навіть
    // там, де fill-opacity дорівнює 0: запит перевіряє геометрію й видимість шару, а не прозорість
    // фарби. Тому на всій країні під кожним кліком лежить районний полігон, і без другої ознаки
    // район забирав би клік у області геть усюди — зокрема там, де на ньому не оголошено нічого.
    //
    // Ознака — сам feature-state. applyTerritoryLayers() стирає стан джерела цілком і записує лише
    // непорожні набори, тож тихий район не має ЖОДНОГО ключа, а засвічений має щонайменше один.
    // Звідси правило в обидва боки: район без стану поступається області, район зі станом виграє.
    // Точність від цього не падає — панель області однаково називає засвічені райони всередині.
    //
    // queryRenderedFeatures кидає виняток на неіснуючому шарі, а шарів іконок може не бути взагалі
    // (canvas недоступний), тож список фільтруємо перед кожним запитом.
    const liveLayers = (ids) => ids.filter((id) => map.getLayer(id));
    const litFeature = (feature) => Object.keys(feature?.state ?? {}).length > 0;
    let lastTerritoryClick = null;
    const openTerritory = (event) => {
      if (event.originalEvent && event.originalEvent === lastTerritoryClick) return;
      const feature = event.features?.[0];
      const layerId = feature?.layer?.id;
      const locationId = feature?.properties?.locationId;
      if (!locationId) return;
      const onIcon = iconLayerIds.includes(layerId);
      if (!onIcon && map.queryRenderedFeatures(event.point, { layers: liveLayers(iconLayerIds) }).length) return;
      if (!onIcon && layerId !== 'city-hit' && map.queryRenderedFeatures(event.point, { layers: liveLayers(['city-hit']) }).length) return;
      const litRaion = map.queryRenderedFeatures(event.point, { layers: liveLayers(raionFillLayerIds) }).some(litFeature);
      if (layerId === 'ukraine-region-fill' && litRaion) return;
      if (raionFillLayerIds.includes(layerId) && !litRaion) return;
      lastTerritoryClick = event.originalEvent ?? null;
      void showTerritoryPanel(locationId);
    };
    for (const layer of [...iconLayerIds, 'ukraine-region-fill', ...raionFillLayerIds, 'city-hit']) {
      map.on('click', layer, openTerritory);
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    }
    mapLayersReady = true;
    applyTerritoryLayers();
    applyVectors();
    iconTier = map.getZoom() >= ICON_TIER_ZOOM ? 'raion' : 'oblast';
    updateTerritoryIcons();
  });
  $('#fit-ukraine').addEventListener('click', () => map.fitBounds([[21.5,43.2],[41.2,52.5]], { padding: 36, duration: 700 }));
}

function updateMap() {
  if (!mapLayersReady) return;
  map.getSource('reported-directions')?.setData(directionCollection());
  applyTerritoryLayers();
  applyVectors();
  updateTerritoryIcons();
  refreshOpenTerritoryPanel();
}

function safeUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

function openDetail(title, kicker, body) {
  let dialog = $('#detail-dialog');
  if (!dialog) {
    dialog = document.createElement('dialog'); dialog.id = 'detail-dialog'; dialog.className = 'detail-dialog';
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
    document.body.append(dialog);
  }
  // id на <h2> — те, на що вказує aria-labelledby діалогу: без нього читач екрана оголошує
  // модальне вікно без назви території, яку щойно натиснули.
  dialog.innerHTML = `<div class="detail-head"><div><p>${escapeHtml(kicker)}</p><h2 id="detail-title">${escapeHtml(title)}</h2></div><button aria-label="Закрити">×</button></div><div class="detail-body">${body}</div>`;
  dialog.querySelector('button').addEventListener('click', () => dialog.close());
  dialog.showModal();
  return dialog;
}

function signalTypeName(type) {
  return signalTypeNames[type] ?? type ?? 'тип сигналу не вказано';
}

// `observed_at` теоретично може не розпарситися, а «55 років тому» на картці загрози виглядає як
// зламана система, а не як відсутнє поле.
function agoOrUnknown(timestamp) {
  return timestamp ? timeAgo(timestamp) : 'час не вказано';
}

function tierName(tier) {
  return tierNames[tier] ? `${tierNames[tier]} (${tier})` : `джерело рівня ${tier ?? '—'}`;
}

// Речення, а не фрагмент: чинники приходять і від моделі, і від сталого правила, і жоден із двох
// не гарантує ні великої літери, ні крапки.
function sentence(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const capitalised = text[0].toUpperCase() + text.slice(1);
  return /[.!?…»]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

function pluralUk(count, one, few, many) {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = count % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

// «внесок 0.35» — це число з внутрішньої шкали, у якої немає одиниці виміру й немає стелі, зрозумілої
// ззовні. Людині потрібне порівняння, а не значення: сильніше чи слабше за решту. Пороги взято з
// того, як внесок формується насправді (базові 2.5 / 1.5 / 0.6 за рівнем джерела, помножені на
// релевантність, надійність і згасання за давністю).
function influenceWord(contribution) {
  const value = Number(contribution);
  if (!Number.isFinite(value)) return 'вплив не визначено';
  if (value >= 1.2) return 'значний вплив';
  if (value >= 0.5) return 'помірний вплив';
  return 'слабкий вплив';
}

// Слово, а не число. Читач картки вирішує, чи йти в укриття, і «0.63» тут не допомагає нікому:
// число натякає на точність, якої місячний вимір не має. Сирі числа лишаються нижче, у згорнутих
// техдеталях, де їх перевіряють, а не читають під час тривоги.
//
// Порядок навмисно від найобережнішого слова до найспокійнішого: якщо в групі є і знижене джерело,
// і високе, першим має стояти застереження, а не похвала.
const trustWordOrder = ['знижена', 'звичайна', 'висока'];

function groupTrustNote(group) {
  const words = [...(group.trust ?? [])].sort((a, b) => trustWordOrder.indexOf(a) - trustWordOrder.indexOf(b));
  if (!words.length) return '';
  const noun = words.length === 1 && group.sources.size <= 1 ? 'джерела' : 'джерел';
  return ` · довіра ${noun}: ${words.map((word) => escapeHtml(word)).join(', ')}`;
}

// Три повідомлення про той самий напрямок — це один аргумент, повторений тричі, а не три аргументи.
// Групування прибирає з картки саме ту «плутанину з факторів», через яку її неможливо було читати.
function groupAssessmentSignals(signals = []) {
  const groups = new Map();
  for (const signal of signals) {
    const key = signal.signal_type ?? 'unknown';
    const group = groups.get(key) ?? {
      key, label: signalTypeName(key), count: 0, weight: 0, latest: 0, sources: new Set(), tiers: new Set(), trust: new Set()
    };
    group.count += 1;
    group.weight += Number(signal.contribution) || 0;
    group.latest = Math.max(group.latest, new Date(signal.observed_at).getTime() || 0);
    if (signal.source_name) group.sources.add(signal.source_name);
    if (signal.source_tier) group.tiers.add(signal.source_tier);
    // Слово приходить із сервера (`trustLabel` у src/services/source-trust.ts), щоб межа «високої»
    // довіри мала одне визначення на всі поверхні. Джерела без нічного розрахунку не додають нічого:
    // «невідомо» в цьому рядку читалося б як застереження, хоча означає лише відсутність виміру.
    if (signal.source_trust_label) group.trust.add(signal.source_trust_label);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.weight - a.weight);
}

// Звідки береться впевненість — питання, на яке картка мусить відповідати сама. Слово «низька» без
// причини читається як дефект системи, хоча насправді це чесний опис доказової бази.
function confidenceExplanation(item, groups) {
  const tiers = new Set(groups.flatMap((group) => [...group.tiers]));
  const sources = new Set(groups.flatMap((group) => [...group.sources]));
  const reasons = [];
  if (tiers.size && !tiers.has('A')) reasons.push('офіційного повідомлення серед джерел поки немає');
  if (tiers.size === 1 && tiers.has('C')) reasons.push('усі повідомлення надійшли з допоміжних каналів');
  if (sources.size === 1) reasons.push('усе спирається на одне джерело');
  if (!reasons.length) {
    reasons.push(tiers.has('A')
      ? 'серед джерел є офіційне повідомлення'
      : 'повідомлення надійшли з кількох незалежних каналів');
  }
  const level = confidenceNames[item.assessment_confidence] ?? item.assessment_confidence ?? 'не визначена';
  return `Впевненість системи — ${level}: ${reasons.join('; ')}.`;
}

async function showThreatDetails(id) {
  // Ланцюг тягнемо паралельно й ніколи не даємо йому зламати картку: без нього подія читається так
  // само, як читалася до появи векторів.
  const [response, vector] = await Promise.all([
    fetch(`/api/v1/threats/${encodeURIComponent(id)}`),
    fetch(`/api/v1/threats/${encodeURIComponent(id)}/vector`).then((r) => r.ok ? r.json() : null).catch(() => null)
  ]);
  if (!response.ok) return openDetail('Подію не знайдено', 'Помилка', '<p>Дані могли бути архівовані або виправлені.</p>');
  const item = await response.json();
  const sources = item.evidence.map((source) => {
    const url = safeUrl(source.public_url);
    return `<article class="evidence-row"><div><span>${escapeHtml(tierName(source.tier))} · ${source.official ? 'офіційне' : 'неофіційне'}</span><strong>${escapeHtml(source.name)}</strong></div><time>${escapeHtml(agoOrUnknown(new Date(source.published_at).getTime()))} · ${escapeHtml(new Date(source.published_at).toLocaleString('uk-UA'))}</time><p>${escapeHtml(source.raw_text)}</p>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Першоджерело ↗</a>` : ''}</article>`;
  }).join('') || '<p>Публічних доказів ще немає.</p>';
  // Причина зміни й новий статус зберігаються ідентифікаторами; у хронології події їх читає людина,
  // тож ідентифікатор лишається лише тоді, коли назви для нього ще немає.
  const updates = item.updates.map((update) => `<li><time>${escapeHtml(agoOrUnknown(new Date(update.created_at).getTime()))}</time> <b>${escapeHtml(sentence(updateReasonNames[update.reason] ?? update.reason))}</b><br><small>стан: ${escapeHtml(statusNames[update.new_status] ?? update.new_status)} · доказовість: ${escapeHtml(evidenceNames[update.new_evidence_level] ?? update.new_evidence_level)}</small></li>`).join('');
  openDetail(item.title, evidenceNames[item.evidence_level] ?? item.evidence_level,
    `<p class="detail-summary">${escapeHtml(item.summary)}</p><dl><div><dt>Тип</dt><dd>${escapeHtml(threatNames[item.threat_type] ?? item.threat_type ?? 'не визначено')}</dd></div><div><dt>Остання згадка</dt><dd>${escapeHtml(agoOrUnknown(new Date(item.last_observed_at).getTime()))}</dd></div><div><dt>Дійсна до</dt><dd>${item.valid_until ? escapeHtml(shortTime(item.valid_until)) : 'не визначено'}</dd></div><div><dt>Напрямок</dt><dd>${escapeHtml(item.direction_text || 'не повідомлявся')}</dd></div></dl>${vectorChainHtml(vector)}<h3>Джерела</h3>${sources}${updates ? `<h3>Історія змін</h3><ol class="update-list">${updates}</ol>` : ''}<div class="safety-note"><strong>Геометрія не є прогнозом</strong><p>Система показує лише дослівно повідомлену територію або напрямок і не екстраполює маршрут.</p></div>`);
}

async function showAssessmentDetails(id) {
  const response = await fetch(`/api/v1/assessments/${encodeURIComponent(id)}`);
  if (!response.ok) return openDetail('Оцінку не знайдено', 'Помилка', '<p>Оцінка могла втратити актуальність.</p>');
  const item = await response.json();
  const explanation = item.explanation ?? {};
  const groups = groupAssessmentSignals(item.signals);
  const threat = threatNames[item.threat_type] ?? item.threat_type;
  const level = levelNames[item.risk_level] ?? item.risk_level;

  // Три абзаци відповідають на три питання поспіль: що і де, з чого це зроблено, наскільки система
  // впевнена. Далі йде компактний блок причин — він повторює головне списком, бо під час тривоги
  // картку читають по діагоналі.
  const opening = `Це аналітична оцінка, а не тривога. Для території «${item.location_name}» система оцінює загрозу «${threat}» на найближчі шість годин як ${level} — ${item.risk_score} з 10.`;
  const reasonSource = (explanation.raisingFactors ?? []).filter(Boolean);
  const reasons = (reasonSource.length
    ? reasonSource
    : groups.map((group) => `${group.label} — ${group.count} ${pluralUk(group.count, 'повідомлення', 'повідомлення', 'повідомлень')}, найсвіжіше ${agoOrUnknown(group.latest)}`)
  ).slice(0, 3).map((reason) => `<li>${escapeHtml(sentence(reason))}</li>`).join('');
  const changes = (explanation.limitingFactors ?? []).filter(Boolean).slice(0, 4)
    .map((factor) => `<li>${escapeHtml(sentence(factor))}</li>`).join('');

  const signalGroups = groups.map((group) => {
    const sources = [...group.sources];
    const sourceLine = sources.length
      ? `${sources.slice(0, 3).map((name) => escapeHtml(name)).join(', ')}${sources.length > 3 ? ` та ще ${sources.length - 3}` : ''}`
      : 'джерело не вказано';
    return `<li class="signal-group"><strong>${escapeHtml(group.label)}</strong>
      <span>${group.count} ${pluralUk(group.count, 'повідомлення', 'повідомлення', 'повідомлень')} · ${escapeHtml(influenceWord(group.weight))}</span>
      <small>найсвіжіше ${escapeHtml(agoOrUnknown(group.latest))} · ${sourceLine}${groupTrustNote(group)}</small></li>`;
  }).join('') || '<li class="signal-group"><strong>Сигналів не залишилося</strong><small>Повідомлення, з яких зроблено оцінку, втратили чинність.</small></li>';

  // Сирі числа нікуди не зникають — вони переїжджають під <details>. Тут вони перевіряються, а не
  // читаються: людині під час тривоги не потрібні ні версія методології, ні георелевантність 0.65.
  const technical = item.signals.map((signal) => `<li><span>${escapeHtml(signal.signal_type)}</span>
    <span>${escapeHtml(tierName(signal.source_tier))} · внесок ${Number(signal.contribution).toFixed(2)} · надійність ${Number(signal.reliability).toFixed(2)} · георелевантність ${Number(signal.geographic_relevance).toFixed(2)}${signal.source_trust == null ? '' : ` · довіра джерела ${Number(signal.source_trust).toFixed(2)}`}</span>
    <time>${escapeHtml(new Date(signal.observed_at).toLocaleString('uk-UA'))}</time></li>`).join('');

  // Пояснення до числа довіри показуємо лише тоді, коли саме число десь є: інакше це абзац про
  // механізм, який на цій картці не спрацював жодного разу.
  const trustNote = item.signals.some((signal) => signal.source_trust != null)
    ? '<p class="legend-note">Довіра — це виміряна за 30 днів поведінка каналу: відкликані твердження, підтвердження іншими незалежними групами, першість повідомлень і читабельність. Вона не змінює рівень джерела і не знімає обмежень індексу за рівнями — лише модулює внесок сигналу в межах від 0.6 до 1.2. Без виміру внесок береться повністю.</p>'
    : '';

  openDetail(`${item.location_name}: ${threat}`, 'Аналітична оцінка, не тривога',
    `<div class="detail-score"><strong>${escapeHtml(item.risk_score)}<small>/10</small></strong><span>${escapeHtml(level)} рівень<br>впевненість ${escapeHtml(confidenceNames[item.assessment_confidence] ?? item.assessment_confidence)}</span></div>
     <div class="assessment-story">
       <p>${escapeHtml(opening)}</p>
       ${explanation.summary ? `<p>${escapeHtml(sentence(explanation.summary))}</p>` : ''}
       <p>${escapeHtml(confidenceExplanation(item, groups))}</p>
     </div>
     ${reasons ? `<h3>З чого зроблено висновок</h3><ul class="reason-list">${reasons}</ul>` : ''}
     ${changes ? `<h3>Що може змінити оцінку</h3><ul class="reason-list is-muted">${changes}</ul>` : ''}
     <h3>Повідомлення, на яких тримається оцінка</h3>
     <ul class="signal-groups">${signalGroups}</ul>
     <details class="tech-details"><summary>Технічні деталі</summary>
       <dl><div><dt>Горизонт</dt><dd>${escapeHtml(new Date(item.horizon_start).toLocaleString('uk-UA'))} — ${escapeHtml(new Date(item.horizon_end).toLocaleString('uk-UA'))}</dd></div>
       <div><dt>Індикативний рівень</dt><dd>${escapeHtml(String(item.indicative_percent ?? Math.round(item.risk_score * 10)))}% за шкалою індексу</dd></div>
       <div><dt>Методологія · модель</dt><dd>${escapeHtml(item.methodology_version)} · ${escapeHtml(item.model_version)}</dd></div></dl>
       ${technical ? `<ul class="tech-signals">${technical}</ul>` : ''}
       ${trustNote}
     </details>
     <div class="safety-note"><strong>Не статистична ймовірність</strong><p>${escapeHtml(explanation.caveat || 'Це відносний індекс публічних повідомлень, а не ймовірність удару. Низький рівень не означає безпеку.')}</p></div>`);
}

// Ланцюг предків будується один раз на локацію: каталог після boot() не змінюється, а панель
// звіряє з ним кожну подію знімка.
const ancestorChains = new Map();
function ancestorsOf(id) {
  if (ancestorChains.has(id)) return ancestorChains.get(id);
  const { parents } = locationIndexes();
  const chain = [];
  const seen = new Set([id]);
  let parent = parents.get(id);
  let depth = 0;
  while (parent && !seen.has(parent) && depth < LOCATION_HIERARCHY_MAX_DEPTH) {
    seen.add(parent);
    depth += 1;
    chain.push(parent);
    parent = parents.get(parent);
  }
  ancestorChains.set(id, chain);
  return chain;
}

function territoryRelation(locationId, namedId) {
  if (!namedId) return null;
  // Той самий виняток, що й у territoryCoverage(): країна — не територія. Загальнонаціональне
  // попередження не належить жодній конкретній області, і рядок «названо: Україна» в панелі однієї
  // з двадцяти семи областей був би тим самим твердженням, якого не робило жодне джерело.
  if (namedId === 'ua' || locationIndexes().types.get(namedId) === 'country') return null;
  if (namedId === locationId) return 'direct';
  if (ancestorsOf(namedId).includes(locationId)) return 'inside';
  if (ancestorsOf(locationId).includes(namedId)) return 'above';
  return null;
}

// Найточніша заява виграє: дослівно названа територія, потім щось усередині неї, потім ширша.
const TERRITORY_RELATION_RANK = { direct: 0, inside: 1, above: 2 };

function territoryName(id) {
  const { names } = locationIndexes();
  return names.get(id) ?? regionFeatures.get(id)?.properties?.nameUk ?? 'Територія';
}

/**
 * Тіло панелі для знімка БЕЗ `territories[]` — старий сервер або частковий деплой.
 *
 * Подія належить території трьома різними способами, і плутати їх не можна:
 *   direct — джерело назвало саме цю територію;
 *   inside — джерело назвало щось усередині неї (район в області, місто в районі);
 *   above  — джерело назвало ширшу територію (область, коли відкрито район).
 * У двох останніх випадках дослівна назва показується поруч: користувач мусить бачити, ЩО саме
 * сказало джерело, а не наш висновок про територію.
 *
 * Будується синхронно зі знімка, який уже лежить у памʼяті: панель відкривається за кліком по
 * полігону, і мережевий похід за тим, що вже прийшло потоком, був би затримкою без причини.
 */
function territoryLegacyHtml(locationId) {
  const alerts = (snapshot?.alerts ?? [])
    .map((alert) => ({ alert, relation: territoryRelation(locationId, alert.location_id) }))
    .filter((row) => row.relation)
    .sort((a, b) => TERRITORY_RELATION_RANK[a.relation] - TERRITORY_RELATION_RANK[b.relation]
      || new Date(a.alert.started_at) - new Date(b.alert.started_at));
  const alertRow = alerts[0];
  const alertBlock = alertRow
    ? `<p class="territory-alert">Офіційна тривога з ${escapeHtml(shortTime(alertRow.alert.started_at))} · ${escapeHtml(timeAgo(alertRow.alert.started_at))}</p>
       ${alertRow.alert.location_id === locationId ? '' : `<p class="territory-named">Оголошено для: ${escapeHtml(territoryName(alertRow.alert.location_id))}</p>`}`
    : '';

  // Ті самі три правила, що й у territoryCoverage(): ствердження дає полігон, згадка — лише рядок,
  // наслідки потребують підтверджувальної доказовості. Панель нічого не додає до карти й нічого не
  // приховує від неї.
  const threats = [];
  for (const event of snapshot?.threats ?? []) {
    let asserted = null, mentioned = null, aftermath = false;
    for (const loc of event.locations ?? []) {
      const relation = territoryRelation(locationId, loc.id);
      if (!relation) continue;
      if (ASSERTING_RELATIONS.has(loc.relationType)) {
        if (!asserted || TERRITORY_RELATION_RANK[relation] < TERRITORY_RELATION_RANK[asserted.relation]) asserted = { relation, id: loc.id };
        if (loc.relationType === 'aftermath') aftermath = true;
      } else if (!mentioned || TERRITORY_RELATION_RANK[relation] < TERRITORY_RELATION_RANK[mentioned.relation]) {
        mentioned = { relation, id: loc.id };
      }
    }
    const named = asserted ?? mentioned;
    if (!named) continue;
    threats.push({ event, named, asserted: !!asserted, consequence: aftermath && CONFIRMING_EVIDENCE.has(event.evidenceLevel) });
  }
  threats.sort((a, b) => Number(b.asserted) - Number(a.asserted)
    || new Date(b.event.lastObservedAt) - new Date(a.event.lastObservedAt));

  const threatRows = threats.map(({ event, named, asserted }) => {
    const namedNote = asserted
      ? (named.id === locationId ? '' : `<small>Названо: ${escapeHtml(territoryName(named.id))}</small>`)
      : `<small>Згадано джерелом${named.id === locationId ? '' : `: ${escapeHtml(territoryName(named.id))}`}</small>`;
    return `<li class="territory-state-row" data-event="${escapeHtml(event.id)}">
      <b>${escapeHtml(threatNames[event.threatType] ?? event.threatType)}</b>
      <span>${escapeHtml(statusNames[event.status] ?? event.status)} · ${escapeHtml(evidenceNames[event.evidenceLevel] ?? event.evidenceLevel)} · останнє підтвердження ${escapeHtml(agoOrUnknown(event.lastObservedAt))}</span>
      ${namedNote}
      ${event.directionText ? `<small>Напрямок повідомлено джерелом: ${escapeHtml(event.directionText)}</small>` : ''}
    </li>`;
  }).join('');
  const consequence = threats.some((row) => row.consequence)
    ? '<p class="territory-consequence">Повідомлено про наслідки на території.</p>' : '';

  const assessment = (snapshot?.assessments ?? [])
    .map((risk) => ({ risk, relation: territoryRelation(locationId, risk.location_id) }))
    .filter((row) => row.relation)
    .sort((a, b) => TERRITORY_RELATION_RANK[a.relation] - TERRITORY_RELATION_RANK[b.relation]
      || Number(b.risk.risk_score) - Number(a.risk.risk_score))[0]?.risk;
  const assessmentBlock = assessment
    ? `<div class="territory-state-row is-analytic" data-assessment="${escapeHtml(assessment.id)}">
        <b>Аналітична оцінка, не тривога</b>
        <span>${escapeHtml(threatNames[assessment.threat_type] ?? assessment.threat_type)} · ${escapeHtml(String(assessment.risk_score))}/10 · ${escapeHtml(levelNames[assessment.risk_level] ?? assessment.risk_level)} · ${escapeHtml(String(assessment.indicative_percent ?? Math.round(assessment.risk_score * 10)))}% індикативно · впевненість ${escapeHtml(confidenceNames[assessment.assessment_confidence] ?? assessment.assessment_confidence)} · до ${escapeHtml(shortTime(assessment.horizon_end))}</span>
        ${assessment.location_id === locationId ? '' : `<small>Оцінено для: ${escapeHtml(territoryName(assessment.location_id))}</small>`}
      </div>`
    : '';

  // Тиша — теж стан, і вона мусить бути сказана словами. Порожня панель читалася б як збій.
  const empty = alertBlock || threatRows || assessmentBlock ? ''
    : `<div class="empty-state"><strong>Активних повідомлень для цієї території немає</strong>
        <p>Це не означає відсутність загрози. Стежте за офіційними каналами.</p></div>`;

  // Плашку показуємо лише під офіційною тривогою: звичайний стан у цьому домі виглядає мовчазним.
  return `${alertRow ? '<span class="codex-state is-bad">Офіційна тривога</span>' : ''}
     ${alertBlock}
     ${threatRows ? `<ul class="territory-state-list">${threatRows}</ul>` : ''}
     ${consequence}
     ${assessmentBlock}
     ${empty}
     <div class="safety-note"><strong>Це не прогноз траєкторії</strong>
       <p>Система показує лише дослівно повідомлену територію або напрямок і не екстраполює маршрут.</p></div>
     <button class="text-button" data-territory-history>Повна історія території →</button>`;
}

// ------------------------------------------------------------------------------------------------
// Панель стану території
// ------------------------------------------------------------------------------------------------
//
// Будується цілком зі знімка, який уже лежить у памʼяті: мережевий похід за тим, що вже прийшло
// потоком, був би затримкою без причини. Мережу чіпає лише вкладка «Історія», і лише один раз.

const TERRITORY_COVERAGE_WORDS = {
  direct: 'названо джерелом',
  partial: 'тривога або загроза в частині території',
  unmapped: 'найближча територія з контуром'
};

// Джерела беремо з тих самих подій знімка, на які вказує eventIds. Без запиту: панель — це зріз
// стану, а не окрема сторінка.
function territoryThreatSources(threat) {
  const byId = new Map((snapshot?.threats ?? []).map((event) => [event.id, event]));
  const names = [];
  for (const id of threat.eventIds ?? []) {
    for (const source of byId.get(id)?.sources ?? []) {
      if (source?.name && !names.includes(source.name)) names.push(source.name);
    }
  }
  if (!names.length) return 'джерело не вказано';
  return names.slice(0, 3).map((name) => escapeHtml(name)).join(', ')
    + (names.length > 3 ? ` та ще ${names.length - 3}` : '');
}

// `status` — це стан СТАНОМ НА ЗРІЗ, і він завжди один із трьох живих. Панель ніколи не покаже
// «відкликано» поруч із помаранчевим полігоном: розкрити термінальний підпис раніше за кадр
// потоку, який його несе, означало б дати ранній відбій.
function territoryThreatRow(threat) {
  const label = threatNames[threat.threatType] ?? threat.threatType;
  const eventId = threat.eventIds?.[0] ?? '';
  if (!threat.asserted) {
    return `<li><button type="button" class="territory-threat is-mentioned" data-event="${escapeHtml(eventId)}">
      <span class="tt-head"><b>${escapeHtml(label)}</b><em>згадано</em></span>
      <span class="tt-meta">Джерело назвало цю територію, але не повідомило про загрозу саме для неї.</span>
    </button></li>`;
  }
  const tone = threat.consequence ? 'consequence'
    : CONFIRMING_EVIDENCE.has(threat.evidenceLevel) ? 'confirmed' : 'reported';
  // `count` — це `threat.events.size` сервера, тобто нормалізовані ПОДІЇ цього класу на території,
  // а не повідомлення джерел. Одна подія збирає під себе скільки завгодно повідомлень, і саме тому
  // рядок «підтверджено» може мати count = 1: підтвердження вимагає двох незалежних груп джерел на
  // ОДНІЙ події. Назвати це число повідомленнями означало б занизити доказову базу полігона —
  // поруч у тому самому рядку стоять назви трьох каналів, а картка події показує кожне повідомлення.
  const count = Number(threat.count) || 0;
  return `<li><button type="button" class="territory-threat" data-event="${escapeHtml(eventId)}" aria-label="${escapeHtml(iconAriaLabel(threat.threatType, tone))}">
    <span class="tt-head"><b>${escapeHtml(label)}</b><em>${escapeHtml(statusNames[threat.status] ?? threat.status)} · ${escapeHtml(evidenceNames[threat.evidenceLevel] ?? threat.evidenceLevel)}</em></span>
    <span class="tt-meta">останнє підтвердження ${escapeHtml(agoOrUnknown(threat.lastConfirmedAt))} · ${count} ${pluralUk(count, 'подія', 'події', 'подій')}</span>
    <span class="tt-sources">${territoryThreatSources(threat)}</span>
    ${threat.directionText ? `<span class="tt-direction">напрямок повідомлено джерелом: «${escapeHtml(threat.directionText)}»</span>` : ''}
  </button></li>`;
}

function territoryAssessmentBlock(assessment) {
  if (!assessment) return '';
  const percent = assessment.indicativePercent ?? Math.round(Number(assessment.riskScore) * 10);
  return `<h3>Аналітична оцінка</h3>
    <button type="button" class="territory-assessment" data-assessment="${escapeHtml(assessment.assessmentId)}">
      <span class="ta-kicker">Аналітична оцінка, не тривога</span>
      <span class="ta-score"><strong>${escapeHtml(String(assessment.riskScore))}<small>/10</small></strong><span>${escapeHtml(levelNames[assessment.riskLevel] ?? assessment.riskLevel)} · ${escapeHtml(String(percent))}% індикативно · впевненість ${escapeHtml(confidenceNames[assessment.assessmentConfidence] ?? assessment.assessmentConfidence)}</span></span>
      <span class="ta-meta">${escapeHtml(threatNames[assessment.threatType] ?? assessment.threatType)} · горизонт до ${escapeHtml(shortTime(assessment.horizonEnd))}</span>
    </button>`;
}

function territoryLiveHtml(territory, locationId) {
  if (!territory) return territoryLegacyHtml(locationId);
  const asserted = (territory.threats ?? []).filter((threat) => threat.asserted);
  const mentioned = (territory.threats ?? []).filter((threat) => !threat.asserted);
  const namedAlert = (territory.alerts ?? [])[0];
  const alertBlock = territory.alertActive && territory.alertSince
    ? `<p class="territory-alert">Офіційна тривога з ${escapeHtml(shortTime(territory.alertSince))} · ${escapeHtml(timeAgo(territory.alertSince))}
        ${namedAlert && namedAlert.locationId !== locationId ? `<small>Джерело назвало: ${escapeHtml(namedAlert.locationName)}</small>` : ''}</p>`
    : '';
  const publication = snapshot?.publication ?? null;
  const held = publication?.mode === 'delayed_15s'
    ? `<p class="territory-publication">Затриманий режим. Стан на ${escapeHtml(shortTime(publication.cutoffAt))}.</p>`
    : '';
  // Тиша — теж стан, і вона мусить бути сказана словами. Порожня панель читалася б як збій.
  const empty = territory.alertActive || asserted.length || territory.assessment ? ''
    : `<div class="empty-state"><strong>Активних загроз на цій території немає</strong>
        <p>Це не означає відсутність загрози. Стежте за офіційними каналами.</p></div>`;
  // `coverage` — це ДОСЯЖНІСТЬ, а не стан: область стає `partial` і від самої лише згадки в її
  // районі, і від аналітичної оцінки на ньому, а полігон при цьому — правильно — не світиться.
  // Слово «тривога або загроза» має право звучати тільки там, де така тривога або ствердна загроза
  // справді є, інакше шапка панелі суперечила б і рядкові «Згадано джерелом», і власному
  // порожньому стану «Активних загроз на цій території немає» кількома рядками нижче — і робила б
  // це в тривожних словах над аналітичною оцінкою, чого дорожня карта прямо не дозволяє.
  const coverageWord = territory.coverage === 'partial' && !territory.alertActive && !territory.threatActive
    ? (territory.assessment ? 'аналітична оцінка в частині території' : 'згадано в частині території')
    : (TERRITORY_COVERAGE_WORDS[territory.coverage] ?? territory.coverage);
  return `<p class="territory-state">
      ${territory.alertActive ? '<span class="codex-state is-bad">Офіційна тривога</span>' : ''}
      <span class="territory-coverage">${escapeHtml(coverageWord)}</span>
    </p>
    ${alertBlock}
    ${asserted.length ? `<h3>Загрози</h3><ul class="territory-threats">${asserted.map(territoryThreatRow).join('')}</ul>` : ''}
    ${mentioned.length ? `<h3>Згадано джерелом</h3><ul class="territory-threats territory-threats-mentioned">${mentioned.map(territoryThreatRow).join('')}</ul>` : ''}
    ${territory.consequences ? '<p class="territory-consequence">Повідомлено про наслідки на території.</p>' : ''}
    ${territoryAssessmentBlock(territory.assessment)}
    ${empty}
    ${held}
    <div class="safety-note"><strong>Це не прогноз траєкторії</strong>
      <p>Система показує лише дослівно повідомлену територію або напрямок і не екстраполює маршрут.</p></div>`;
}

function territoryPanelBody(territory, locationId) {
  return `<div class="territory-tabs" role="tablist" aria-label="Розділи території">
      <button type="button" role="tab" id="tt-now" aria-controls="tp-now" aria-selected="true" class="is-active">Стан зараз</button>
      <button type="button" role="tab" id="tt-log" aria-controls="tp-log" aria-selected="false" tabindex="-1">Історія</button>
    </div>
    <div id="tp-now" role="tabpanel" aria-labelledby="tt-now" data-live>${territoryLiveHtml(territory, locationId)}</div>
    <div id="tp-log" role="tabpanel" aria-labelledby="tt-log" hidden><p class="territory-loading">Завантаження…</p></div>`;
}

async function showTerritoryPanel(locationId) {
  const territory = snapshotTerritories().find((item) => item.locationId === locationId);
  const name = territory?.name ?? territoryName(locationId);
  openTerritoryId = locationId;
  const dialog = openDetail(name, 'Територія', territoryPanelBody(territory, locationId));
  dialog.setAttribute('aria-labelledby', 'detail-title');
  dialog.addEventListener('close', () => { openTerritoryId = null; }, { once: true });
  wireTerritoryPanel(dialog, locationId);
  return dialog;
}

function wireTerritoryPanel(dialog, locationId) {
  // Обидва переходи, які раніше давав шар підписів подій, лишаються на місці — тепер вони живуть
  // у рядках панелі, а не в крапці на карті.
  dialog.querySelectorAll('[data-event]').forEach((node) => node.addEventListener('click', () => {
    if (node.dataset.event) void showThreatDetails(node.dataset.event);
  }));
  dialog.querySelectorAll('[data-assessment]').forEach((node) => node.addEventListener('click', () =>
    void showAssessmentDetails(node.dataset.assessment)));
  dialog.querySelector('[data-territory-history]')?.addEventListener('click', () => void showLocationHistory(locationId));

  // Вкладки живуть ПОЗА [data-live], тож перемальовування «Стану зараз» їх не замінює. Без цього
  // прапорця кожен тік знімка навішував би на них ще один комплект обробників, і за хвилину
  // відкритої панелі один клік викликав би select() десятки разів.
  const tablist = dialog.querySelector('[role="tablist"]');
  if (!tablist || tablist.dataset.wired) return;
  tablist.dataset.wired = '1';
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  const select = (tab) => {
    tabs.forEach((item) => {
      const on = item === tab;
      item.setAttribute('aria-selected', String(on));
      item.tabIndex = on ? 0 : -1;
      item.classList.toggle('is-active', on);
      const panel = dialog.querySelector(`#${item.getAttribute('aria-controls')}`);
      if (panel) panel.hidden = !on;
    });
    if (tab.id === 'tt-log') void loadTerritoryHistory(dialog, locationId);
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    // Стрілки між вкладками — стандартна клавіатурна поведінка tablist; без неї Tab провалюється
    // одразу в тіло панелі й до другої вкладки дістатися неможливо.
    tab.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = tabs[(index + step + tabs.length) % tabs.length];
      next.focus(); select(next);
    });
  });
}

async function loadTerritoryHistory(dialog, locationId) {
  const panel = dialog.querySelector('#tp-log');
  if (!panel || panel.dataset.loaded) return;
  panel.dataset.loaded = '1';
  const response = await fetch(`/api/v1/locations/${encodeURIComponent(locationId)}/timeline?limit=100`).catch(() => null);
  if (!response?.ok) {
    delete panel.dataset.loaded;   // друга спроба лишається можливою
    panel.innerHTML = '<p class="legend-note">Не вдалося завантажити історію.</p>';
    return;
  }
  const data = await response.json();
  panel.innerHTML = territoryHistoryHtml(data, locationId);
  wireTerritoryHistory(panel);
}

/**
 * Панель — це зріз стану, а не окрема сторінка: поки вона відкрита, стан зараз мусить лишатися
 * станом зараз. Перемальовуємо лише вкладку «Стан зараз» і лише тоді, коли фокус не всередині неї:
 * заміна innerHTML під пальцем скинула б фокус із кнопки, яку користувач саме читає.
 */
function refreshOpenTerritoryPanel() {
  if (!openTerritoryId) return;
  const dialog = $('#detail-dialog');
  const live = dialog?.querySelector('[data-live]');
  if (!live || live.hidden) return;
  if (live.contains(document.activeElement)) return;
  const territory = snapshotTerritories().find((item) => item.locationId === openTerritoryId);
  live.innerHTML = territoryLiveHtml(territory, openTerritoryId);
  wireTerritoryPanel(dialog, openTerritoryId);
}

// Розмітка хронології лишилася тією самою до байта: вкладка «Історія» і окремий діалог показують
// одне й те саме, бо це одна й та сама відповідь одного й того самого маршруту.
function territoryHistoryHtml(data, id) {
  const kindNames = { alert: 'офіційна тривога', threat: 'загроза', assessment: 'аналітика' };
  const items = data.items.map((item) => `<article class="territory-entry ${escapeHtml(item.kind)}" data-kind="${escapeHtml(item.kind)}" data-entry-id="${escapeHtml(item.id)}">
    <div><span>${escapeHtml(kindNames[item.kind] ?? item.kind)}</span><time>${new Date(item.happened_at).toLocaleString('uk-UA')}</time></div>
    <h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.summary)}</p>
    <footer><b>${escapeHtml(threatNames[item.threat_type] ?? item.threat_type)}</b>${item.risk_score != null ? `<strong>${escapeHtml(item.risk_score)}/10 · ${escapeHtml(levelNames[item.risk_level] ?? item.risk_level)}</strong>` : `<strong>${escapeHtml(item.evidence_level ?? item.status)}</strong>`}</footer>
  </article>`).join('') || '<div class="empty-state"><strong>Історія поки порожня</strong><p>Для цієї території ще немає збережених тривог, загроз або аналітичних попереджень.</p></div>';
  return `<div class="territory-summary"><div><strong>${data.counts.alerts}</strong><span>тривоги</span></div><div><strong>${data.counts.threats}</strong><span>загрози</span></div><div><strong>${data.counts.assessments}</strong><span>оцінки</span></div></div>
     <div class="territory-filters"><button class="is-active" data-territory-filter="all">Усе</button><button data-territory-filter="alert">Тривоги</button><button data-territory-filter="threat">Загрози</button><button data-territory-filter="assessment">Аналітика</button></div>
     <div class="territory-timeline">${items}</div>
     <a class="territory-all" href="/history?location=${encodeURIComponent(id)}" data-route="/history">Відкрити повну хронологію →</a>`;
}

function wireTerritoryHistory(root) {
  root.querySelectorAll('[data-territory-filter]').forEach((button) => button.addEventListener('click', () => {
    root.querySelectorAll('[data-territory-filter]').forEach((item) => item.classList.toggle('is-active', item === button));
    root.querySelectorAll('.territory-entry').forEach((entry) => { entry.hidden = button.dataset.territoryFilter !== 'all' && entry.dataset.kind !== button.dataset.territoryFilter; });
  }));
  root.querySelectorAll('.territory-entry').forEach((entry) => entry.addEventListener('click', () => {
    if (entry.dataset.kind === 'threat') void showThreatDetails(entry.dataset.entryId);
    if (entry.dataset.kind === 'assessment') void showAssessmentDetails(entry.dataset.entryId);
  }));
}

async function showLocationHistory(id) {
  const response = await fetch(`/api/v1/locations/${encodeURIComponent(id)}/timeline?limit=100`);
  if (!response.ok) return openDetail('Територію не знайдено', 'Помилка', '<p>Не вдалося завантажити історію.</p>');
  const data = await response.json();
  wireTerritoryHistory(openDetail(data.location.name_uk, 'Історія території', territoryHistoryHtml(data, id)));
}

function renderEventRail() {
  const items = [
    ...snapshot.alerts.map((item) => ({ type: 'alert', item })),
    ...snapshot.threats.map((item) => ({ type: 'threat', item })),
    ...snapshot.assessments.slice(0, 8).map((item) => ({ type: 'assessment', item }))
  ];
  $('#event-count').textContent = items.length;
  $('#event-list').innerHTML = items.length ? items.map(({ item, type }) => eventCard(item, type)).join('') : `<div class="empty-state"><strong>Немає активних офіційних повідомлень</strong><p>Це не означає відсутність загрози. Стежте за офіційними каналами.</p></div>`;
}

function renderMapPage() {
  // Карту не перестворюємо на кожен тік потоку: геометрія областей і районів важить понад мегабайт,
  // а стан тривог накладається через feature-state. Заразом користувач не втрачає масштаб і позицію,
  // на які щойно перевів карту, — раніше кожна подія SSE скидала вигляд на всю Україну.
  if (map && document.body.contains(map.getContainer())) {
    renderEventRail();
    updateMap();
    updatePublicationChip();
    renderOccupationLegend();
    return;
  }
  $('#app').replaceChildren($('#map-page').content.cloneNode(true));
  const telegramLink = document.querySelector('.telegram-cta');
  if (config.telegramBotUsername) {
    telegramLink.href = `https://t.me/${config.telegramBotUsername.replace(/^@/, '')}`;
  } else telegramLink.hidden = true;
  renderEventRail();
  initMap();
  $('.event-list').addEventListener('click', (event) => {
    const card = event.target.closest('.event-card'); if (!card) return;
    const id = card.dataset.event;
    const threat = snapshot.threats.find((item) => item.id === id);
    const loc = threat?.locations?.[0];
    if (loc?.longitude != null) map.flyTo({ center: [loc.longitude, loc.latitude], zoom: 7, duration: 700 });
    if (id) void showThreatDetails(id);
    const assessmentId = card.dataset.assessment;
    if (assessmentId) void showAssessmentDetails(assessmentId);
  });
  // Ланцюги й лінія повідомленого напрямку йдуть у групу «Загрози»: вони пояснюють ті самі події
  // й не заслуговують окремого перемикача.
  const layerGroups = {
    alerts:       alertLayerIds,
    threats:      [...threatLayerIds, 'direction-lines', ...vectorLayerIds],
    consequences: consequenceLayerIds,
    assessments:  analyticLayerIds
  };
  document.querySelectorAll('.layer-toggle').forEach((button) => button.addEventListener('click', () => {
    button.classList.toggle('is-active');
    const active = button.classList.contains('is-active');
    // Вигляд кнопки й те, що читає екранна читалка, мусять казати одне й те саме.
    button.setAttribute('aria-pressed', String(active));
    // Іконки — не пʼятий перемикач: кожен тон іде за своїм сімейством. Перевипускаємо джерело на
    // КОЖЕН клік, інакше стек іконок і полігони під ним казали б різне.
    updateTerritoryIcons();
    if (button.dataset.layer === 'occupation') {
      occupationVisible = active;
      applyOccupationVisibility();
      $('#occupation-legend')?.classList.toggle('is-off', !occupationVisible);
      return;
    }
    (layerGroups[button.dataset.layer] ?? []).forEach((layer) => map.getLayer(layer) && map.setLayoutProperty(layer, 'visibility', active ? 'visible' : 'none'));
  }));
  const legend = $('#occupation-legend');
  // Вибір користувача переживає перемальовування сторінки після кожної події потоку. За
  // замовчуванням — згорнуто на будь-якій ширині: стос легенд є покажчиком, а не документом.
  legend.open = occupationLegendOpen ?? false;
  legend.addEventListener('toggle', () => { occupationLegendOpen = legend.open; });
  renderThreatLegend();
  renderOccupationLegend();
  updatePublicationChip();
}

function contentShell(kicker, title, deck) {
  $('#app').replaceChildren($('#content-page').content.cloneNode(true));
  $('#page-kicker').textContent = kicker; $('#page-title').textContent = title; $('#page-deck').textContent = deck;
  return $('#page-content');
}

async function renderHistory() {
  const root = contentShell('Журнал подій', 'Хронологія', 'Нормалізовані повідомлення з часом, доказовістю та історією змін.');
  root.innerHTML = `<form class="filter-bar"><label>Територія<select name="location"><option value="">Усі</option>${locations.filter((item) => item.type !== 'country').map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name_uk)}</option>`).join('')}</select></label><label>Тип<select name="threatType"><option value="">Усі</option>${Object.entries(threatNames).map(([value,label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join('')}</select></label><label>Доказовість<select name="evidence"><option value="">Усі</option>${Object.entries(evidenceNames).map(([value,label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join('')}</select></label><label>Від<input type="date" name="from"></label><button>Застосувати</button></form><div class="timeline" id="history-results"><p>Завантаження…</p></div>`;
  const requestedLocation = new URLSearchParams(location.search).get('location');
  if (requestedLocation && locations.some((item) => item.id === requestedLocation)) $('.filter-bar [name="location"]', root).value = requestedLocation;
  const load = async () => {
    const form = $('.filter-bar', root); const params = new URLSearchParams({ limit: '100' });
    new FormData(form).forEach((value, key) => { if (value) params.set(key, key === 'from' ? `${value}T00:00:00.000Z` : String(value)); });
    const response = await fetch(`/api/v1/history?${params}`); const data = await response.json();
    $('#history-results', root).innerHTML = data.items?.map((item) => `<article data-event="${item.id}"><time>${new Date(item.started_at).toLocaleString('uk-UA')}</time><div><span class="evidence ${item.evidence_level}">${evidenceNames[item.evidence_level]}</span><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.summary)}</p><button class="text-button" data-detail="${item.id}">Джерела й зміни →</button></div></article>`).join('') || '<p>За цими фільтрами подій немає.</p>';
    document.querySelectorAll('[data-detail]').forEach((button) => button.addEventListener('click', () => void showThreatDetails(button.dataset.detail)));
  };
  $('.filter-bar', root).addEventListener('submit', (event) => { event.preventDefault(); void load(); });
  await load();
}

async function renderAnalytics() {
  const root = contentShell('Зведення', 'Аналітика за місяць', 'Тривалість офіційних тривог і кількість зафіксованих повідомлень — не кількість атак.');
  const locations = await fetch('/api/v1/locations').then((r) => r.json());
  const currentMonth = new Date().toISOString().slice(0, 7);
  root.innerHTML = `<form class="filter-bar"><label>Місяць<input type="month" name="month" value="${currentMonth}"></label><label>Територія<select name="location"><option value="">Усі</option>${locations.filter((item) => item.type !== 'country').map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name_uk)}</option>`).join('')}</select></label><button>Показати</button></form><div id="analytics-results"><p>Завантаження…</p></div>`;
  const load = async () => {
    const form = $('.filter-bar', root); const values = Object.fromEntries(new FormData(form));
    const params = new URLSearchParams({ month: `${values.month}-01` }); if (values.location) params.set('location', String(values.location));
    const response = await fetch(`/api/v1/analytics/monthly?${params}`); const data = await response.json(); const risk = snapshot.assessments.filter((item) => !values.location || item.location_id === values.location);
    const durationHours = data.alerts.reduce((sum, item) => sum + Number(item.total_duration?.hours ?? 0), 0);
    $('#analytics-results', root).innerHTML = `<div class="metric-grid"><div><span>Тривоги</span><strong>${data.alerts.reduce((s, x) => s + x.alerts_count, 0)}</strong><small>завершених інтервалів</small></div><div><span>Загрози</span><strong>${data.threats.reduce((s, x) => s + x.threat_events, 0)}</strong><small>зафіксованих подій</small></div><div><span>Оцінки</span><strong>${risk.length}</strong><small>актуальних горизонтів</small></div></div><div class="analytics-note">Підрахунок загроз означає кількість нормалізованих інформаційних подій, а не атак, пусків або влучань.</div><div class="assessment-table">${risk.map((item) => `<article data-assessment="${item.id}"><div><span>${escapeHtml(item.location_name)}</span><strong>${threatNames[item.threat_type] ?? item.threat_type}</strong></div><b>${item.risk_score}<small>/10</small></b><p>${levelNames[item.risk_level]} · ${item.indicative_percent ?? Math.round(item.risk_score * 10)}% індикативно · впевненість ${escapeHtml(confidenceNames[item.assessment_confidence] ?? item.assessment_confidence)}</p><button class="text-button">Пояснення →</button></article>`).join('') || '<p>Актуальних оцінок немає.</p>'}</div>`;
    document.querySelectorAll('.assessment-table [data-assessment]').forEach((card) => card.addEventListener('click', () => void showAssessmentDetails(card.dataset.assessment)));
  };
  $('.filter-bar', root).addEventListener('submit', (event) => { event.preventDefault(); void load(); }); await load();
}

// ------------------------------------------------------------------------------------------------
// Аналіз атак — агрегати з відкритих джерел за добу, тиждень і місяць
// ------------------------------------------------------------------------------------------------
//
// Сторінка навмисно не має жодного кольору, крім бурштинового застереження. Решта інтерфейсу
// домовилася, що колір означає небезпеку; тут небезпеки немає — тут ретроспектива, і зафарбована
// стовпчикова діаграма читалася б як сигнал, якого вона не несе. Довжина смуги вже кодує величину.
//
// Графіки — на CSS, без жодної бібліотеки. Не з ідеології, а тому, що всі три потрібні форми
// (горизонтальна смуга, добовий гребінець, шкала хвиль) — це прямокутник заданої довжини, а
// підключення бібліотеки заради прямокутника коштувало б більше, ніж уся сторінка важить зараз.

const attackPeriodNames = { day: 'Доба', week: 'Тиждень', month: 'Місяць' };

// Українське узгодження з числівником. Дзеркало plural() із src/services/attack-analytics.ts —
// цифри на цій сторінці приходять із сервера вже в реченнях, але підписи під ними складає браузер,
// і «1 подій» під акуратно порахованим числом знецінює саме число.
function attackPlural(count, one, few, many) {
  const absolute = Math.abs(count) % 100;
  if (absolute > 10 && absolute < 20) return many;
  const last = absolute % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}
const attackMessagesWord = (count) => attackPlural(count, 'повідомлення', 'повідомлення', 'повідомлень');
const attackEventsWord = (count) => attackPlural(count, 'подія', 'події', 'подій');
const attackTrendMarks = { rising: '▲', falling: '▼', steady: '·', new: '+', gone: '—' };

function attackDelta(row) {
  if (row.previousMessages === 0 && row.messages === 0) return '';
  // Без попереднього періоду ділити нема на що, і «+∞%» тут було б не числом, а фігурою мови.
  if (row.deltaPercent === null) return '<em class="trend new" title="у попередньому періоді згадок не було">уперше</em>';
  const mark = attackTrendMarks[row.trend] ?? '·';
  return `<em class="trend ${row.trend}" title="проти попереднього періоду">${mark} ${row.deltaPercent > 0 ? '+' : ''}${Math.round(row.deltaPercent)}%</em>`;
}

// Смуги нормуються на максимум ряду, а не на суму: ряд читають, щоб порівняти позиції між собою,
// і за часткою від суми найбільша смуга на трьох позиціях зайняла б третину доріжки й перестала б
// показувати різницю з другою.
function attackBars(rows, labelOf) {
  const peak = rows.reduce((max, row) => Math.max(max, row.messages), 0) || 1;
  return `<div class="bar-rows">${rows.map((row) => `<div class="bar-row">
    <span class="bar-label">${escapeHtml(labelOf(row))}</span>
    <span class="bar-track"><i style="width:${Math.max(1.5, (row.messages / peak) * 100)}%"></i></span>
    <b>${row.messages}</b>${attackDelta(row)}</div>`).join('')}</div>`;
}

function attackHourChart(hours) {
  const peak = hours.reduce((max, row) => Math.max(max, row.messages), 0) || 1;
  return `<div class="hour-chart" role="img" aria-label="Розподіл повідомлень за годинами доби">
    ${hours.map((row) => `<span class="hour-col${row.hour >= 22 || row.hour < 6 ? ' is-night' : ''}"
      title="${String(row.hour).padStart(2, '0')}:00 — ${row.messages} повідомл.">
      <i style="height:${row.messages ? Math.max(2, (row.messages / peak) * 100) : 0}%"></i>
      <small>${row.hour % 3 === 0 ? String(row.hour).padStart(2, '0') : ''}</small></span>`).join('')}
    </div><p class="chart-foot">Київський час. Затемнені колонки — нічні години 22:00–06:00.</p>`;
}

function attackWaveList(waves) {
  if (!waves.length) {
    return '<p class="chart-foot">За цей період повідомлення не згрупувалися в жодну хвилю: '
      + 'окремі поодинокі згадки хвилею не називаються.</p>';
  }
  const peak = waves.reduce((max, wave) => Math.max(max, wave.messages), 0) || 1;
  return `<div class="wave-list">${[...waves].reverse().map((wave) => `<article>
    <time>${new Date(wave.startedAt).toLocaleDateString('uk-UA', { day: '2-digit', month: 'short' })}
      · ${shortTime(wave.startedAt)}–${shortTime(wave.endedAt)}</time>
    <span class="bar-track"><i style="width:${Math.max(2, (wave.messages / peak) * 100)}%"></i></span>
    <b>${wave.messages}</b>
    <p>${wave.durationMinutes} хв · ${wave.eventsRaised} ${attackEventsWord(wave.eventsRaised)}${wave.threatTypes.length
      ? ` · ${wave.threatTypes.map((entry) => escapeHtml(entry.label)).join(' + ')}`
      : ''}</p></article>`).join('')}</div>`;
}

function attackSummary(data) {
  const topTarget = data.targets[0];
  const peak = data.hours.reduce((best, row) => (!best || row.messages > best.messages ? row : best), null);
  const night = data.hours.reduce((sum, row) => sum + (row.hour >= 22 || row.hour < 6 ? row.messages : 0), 0);
  const total = data.hours.reduce((sum, row) => sum + row.messages, 0);
  return `<div class="metric-grid">
    <div><span>Повідомлень про загрозу</span><strong>${data.totals.messages}</strong>
      <small>${data.totals.eventsRaised} ${attackPlural(data.totals.eventsRaised, 'окрема', 'окремі', 'окремих')} ${attackEventsWord(data.totals.eventsRaised)} · було ${data.totals.previousMessages}</small></div>
    <div><span>Найбільше згадок</span><strong class="metric-word">${escapeHtml(topTarget?.oblastName ?? '—')}</strong>
      <small>${topTarget ? `${topTarget.messages} ${attackMessagesWord(topTarget.messages)} · ${Math.round(topTarget.share * 100)}% усіх` : 'немає даних'}</small></div>
    <div><span>Пікова година</span><strong>${peak && peak.messages ? `${String(peak.hour).padStart(2, '0')}:00` : '—'}</strong>
      <small>${total ? `${peak.messages} ${attackMessagesWord(peak.messages)} · вночі ${Math.round((night / total) * 100)}%` : 'немає даних'}</small></div>
  </div>`;
}

function attackPatternsBlock(patterns) {
  return `<section class="pattern-block">
    <header><p>Висновок</p><h2>Патерни та ймовірна стратегія</h2></header>
    <p class="pattern-headline">${escapeHtml(patterns.headline)}</p>
    <ul class="pattern-list">${patterns.findings.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
    <div class="analytics-note"><strong>Як це читати</strong>
      <ul>${patterns.caveats.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul></div>
  </section>`;
}

async function renderAttacks() {
  const root = contentShell(
    'Відкриті джерела',
    'Аналіз атак',
    'Що повідомляли моніторингові канали за добу, тиждень і місяць: типи засобів, території, час доби та хвилі. Це опис минулого, а не прогноз.'
  );
  const requested = new URLSearchParams(location.search).get('period');
  let period = ['day', 'week', 'month'].includes(requested) ? requested : 'day';

  root.innerHTML = `<div class="period-switch" role="group" aria-label="Період аналізу">
      ${Object.entries(attackPeriodNames).map(([value, label]) =>
    `<button type="button" data-period="${value}"${value === period ? ' class="is-active" aria-pressed="true"' : ' aria-pressed="false"'}>${label}</button>`).join('')}
    </div><div id="attacks-body"><p>Завантаження…</p></div>`;

  const body = $('#attacks-body', root);
  const load = async () => {
    body.innerHTML = '<p>Завантаження…</p>';
    let data;
    try {
      const response = await fetch(`/api/v1/analytics/attacks?period=${period}`);
      if (!response.ok) throw new Error('attacks unavailable');
      data = await response.json();
    } catch {
      body.innerHTML = '<p class="chart-foot">Не вдалося отримати аналітику. Спробуйте оновити сторінку.</p>';
      return;
    }
    const means = data.means.filter((row) => row.messages > 0);
    const targets = data.targets.filter((row) => row.messages > 0).slice(0, 12);
    body.innerHTML = `${attackSummary(data)}
      <section class="chart-block"><header><p>Засоби</p><h2>Типи засобів у повідомленнях</h2></header>
        ${means.length ? attackBars(means, (row) => row.label) : '<p class="chart-foot">Немає повідомлень за цей період.</p>'}
        <p class="chart-foot">Одне повідомлення про комбінований удар потрапляє в кілька рядків — воно згадує кілька типів.</p></section>
      <section class="chart-block"><header><p>Час</p><h2>Розподіл за годинами доби</h2></header>
        ${attackHourChart(data.hours)}</section>
      <!-- «Території», а не «Області»: повідомлення про загрозу для всієї країни підіймається до
           рядка «Україна», і назвати його областю було б неправдою просто в заголовку. -->
      <section class="chart-block"><header><p>Території</p><h2>Території, які згадують найчастіше</h2></header>
        ${targets.length ? attackBars(targets, (row) => row.oblastName) : '<p class="chart-foot">Жодна територія не названа.</p>'}
        <p class="chart-foot">Згадка області ≠ влучання по ній: це територія, названа в повідомленні про загрозу.</p></section>
      <section class="chart-block"><header><p>Групування</p><h2>Хвилі атак</h2></header>
        ${attackWaveList(data.waves)}
        ${data.combinations.length ? `<p class="chart-foot">Повторювані поєднання в одній хвилі: ${data.combinations
    .map((pair) => `${escapeHtml(pair.labels[0])} + ${escapeHtml(pair.labels[1])} (${pair.waves} ${attackPlural(pair.waves, 'хвиля', 'хвилі', 'хвиль')})`).join('; ')}.</p>` : ''}</section>
      ${data.directions.length ? `<section class="chart-block"><header><p>Напрямки</p><h2>Формулювання напрямку, які повторюються</h2></header>
        <div class="bar-rows">${data.directions.map((row) => `<div class="bar-row">
          <span class="bar-label bar-label-wide">«${escapeHtml(row.direction)}»</span>
          <b>${row.messages}</b></div>`).join('')}</div>
        <p class="chart-foot">Дослівні цитати з повідомлень. Система не будує з них маршрут і не екстраполює траєкторію.</p></section>` : ''}
      ${attackPatternsBlock(data.patterns)}`;
  };

  root.querySelectorAll('[data-period]').forEach((button) => button.addEventListener('click', () => {
    period = button.dataset.period;
    root.querySelectorAll('[data-period]').forEach((other) => {
      other.classList.toggle('is-active', other === button);
      other.setAttribute('aria-pressed', String(other === button));
    });
    // Період живе в адресі: посилання на «місяць» має відкриватися місяцем, а не добою.
    history.replaceState({}, '', `/attacks?period=${period}`);
    void load();
  }));
  await load();
}

async function renderSources() {
  const root = contentShell('Прозорість', 'Джерела та стан', 'Кожне повідомлення має provenance; перепублікації одного першоджерела не рахуються як незалежні докази.');
  const statuses = { current: 'актуальне', stale: 'дані застаріли', error: 'помилка', unknown: 'очікуємо дані', unconfigured: 'потребує токена', disabled: 'вимкнено' };
  const channels = await fetch('/api/v1/channels').then((response) => response.json());
  root.innerHTML = `<div class="source-grid">${snapshot.sourceHealth.map((source) => `<article><span class="source-tier">TIER ${source.tier}</span><h2>${escapeHtml(source.name)}</h2><p>${source.official ? 'Офіційне джерело' : 'Допоміжне джерело'}${source.last_success_at ? ` · останній успіх ${timeAgo(source.last_success_at)}` : ''}</p><div class="source-status ${source.status}">${statuses[source.status] ?? source.status}</div>${source.status === 'error' && source.last_error ? `<small>${escapeHtml(source.last_error)}</small>` : ''}</article>`).join('')}</div>
    <section class="channel-section"><header><p>Підписки</p><h2>Рекомендовані Telegram-канали</h2><span>Каталог формує адміністратор. Позначка ✓ означає ручну перевірку запису.</span></header>
    <div class="channel-grid">${channels.items.map((channel) => `<a href="${escapeHtml(channel.url)}" target="_blank" rel="noreferrer"><span>${channel.verified ? '✓ перевірено' : escapeHtml(channel.category)}</span><h3>${escapeHtml(channel.title)}</h3><p>${escapeHtml(channel.description)}</p><footer>@${escapeHtml(channel.username)}${channel.location_name ? ` · ${escapeHtml(channel.location_name)}` : ''}</footer></a>`).join('') || '<p>Каталог поки порожній.</p>'}</div></section>`;
}

async function renderAbout() {
  const root = contentShell('Методологія', 'Що карта знає — і чого не знає', 'Система пояснює публічні сигнали, але не вгадує цілі та не замінює офіційні команди.');
  const methodology = await fetch('/api/v1/methodology').then((response) => response.json());
  root.innerHTML = `<div class="method-grid"><article><span>01</span><h2>Тривога</h2><p>Лише агрегований стан офіційних API. AI не може оголосити або завершити тривогу.</p></article><article><span>02</span><h2>Загроза</h2><p>Нормалізована подія з першоджерелом, часом, строком дії та рівнем доказовості.</p></article><article><span>03</span><h2>Оцінка v${escapeHtml(methodology.version)}</h2><p>Відносний індекс для офіційного попередження на ${methodology.horizonHours} годин. Старі сигнали втрачають половину ваги кожні ${methodology.guardrails.signalHalfLifeHours} години.</p></article><article><span>04</span><h2>Захисні межі</h2><p>Лише Tier C: максимум ${methodology.guardrails.onlyTierCMaximum}/10. Без Tier A: максимум ${methodology.guardrails.withoutTierAMaximum}/10. Висока впевненість потребує офіційного джерела.</p></article><article><span>05</span><h2>Напрямок</h2><p>Лише дослівно повідомлений напрямок із часом. Жодної екстраполяції маршруту або цілі.</p></article></div><div class="safety-note"><strong>У разі офіційної тривоги</strong><p>Прямуйте до визначеного укриття та дотримуйтеся вказівок ДСНС і місцевої влади. Низький індекс не означає безпеку.</p></div>`;
}

// ------------------------------------------------------------------------------------------------
// Закритий контур: екстраполяція вектора
// ------------------------------------------------------------------------------------------------
//
// Усе нижче рендериться ЛИШЕ всередині renderOps(), тобто після успішної Basic-автентифікації, і
// звертається лише до /ops/*. На карту, у знімок, у потік подій і в бота ці дані не потрапляють —
// не тому, що клієнт цього не робить, а тому, що публічні ендпоінти їх не віддають.
function opsProjectionHtml(projection) {
  if (!projection) return '';
  const candidates = (projection.candidates ?? []).map((candidate) =>
    `<li>${escapeHtml(candidate.name)} — ${candidate.distanceKm} км, відхилення ${candidate.angularDeviationDegrees}°, ~${candidate.minutesToReach} хв${candidate.withinUncertainty ? '' : ' (поза сектором)'}${candidate.coordinatePrecision === 'approximate' ? ' · координата наближена' : ''}</li>`).join('');
  const reasons = (projection.uncertainty?.reasons ?? []).map((reason) => `<li>${escapeHtml(reason)}</li>`).join('');
  return `<div class="safety-note"><strong>${escapeHtml(String(projection.dataNature ?? 'calculated')).toUpperCase()} — розрахунок, не спостереження</strong>
      <p>${escapeHtml(projection.narrative ?? '')}</p></div>
    <dl><div><dt>Основа</dt><dd>${escapeHtml(projection.basis?.fromName ?? '')} → ${escapeHtml(projection.basis?.toName ?? '')} (${escapeHtml(vectorBasisLabels[projection.basis?.segmentBasis] ?? '')})</dd></div>
      <div><dt>Курс і швидкість</dt><dd>${projection.bearingDegrees}° · ${projection.groundSpeedKmh} км/год</dd></div>
      <div><dt>Горизонт</dt><dd>${projection.horizonMinutes} хв · ${projection.horizonDistanceKm} км</dd></div>
      <div><dt>Невизначеність</dt><dd>сектор ±${projection.uncertainty?.lateralHalfAngleDegrees}° · радіус ${projection.uncertainty?.radiusKmAtHorizon} км · впевненість ${escapeHtml(projection.uncertainty?.confidence ?? '')}</dd></div>
      <div><dt>Формулювання</dt><dd>${projection.narrativeOrigin === 'model' ? `модель ${escapeHtml(projection.modelVersion ?? '')}` : 'детерміноване (модель не застосовано або відхилено)'}</dd></div></dl>
    ${reasons ? `<h3>Чому оцінка невпевнена</h3><ul>${reasons}</ul>` : ''}
    ${candidates ? `<h3>Локації в секторі — розрахунок</h3><ul>${candidates}</ul>` : '<p class="legend-note">У секторі немає жодної локації з каталогу.</p>'}`;
}

function opsVectorSection(payload) {
  if (!payload) return '';
  const events = (payload.events ?? []).map((event) => `<article>
      <div><span>${escapeHtml(event.threat_type)} · ${escapeHtml(event.evidence_level)} · ${event.classifications} повідомл.</span>
        <h3>${escapeHtml(event.title)}</h3><p>остання згадка ${timeAgo(event.last_observed_at)}</p></div>
      <div class="ops-channel-actions"><button data-project-vector="${escapeHtml(event.id)}">Порахувати екстраполяцію</button></div>
      <div id="projection-${escapeHtml(event.id)}" class="ops-projection"></div>
    </article>`).join('') || '<p>Немає активних подій із ланцюгом повідомлень.</p>';
  return `<section class="ops-section" id="vector-section"><header class="ops-section-head"><div><p>Тільки для оператора</p><h2>Вектори загроз: екстраполяція</h2></div></header>
    <details class="safety-note ops-fold"><summary><strong>Не для публікації</strong></summary><p>${escapeHtml(payload.notice ?? '')}</p></details>
    <div class="ops-channel-list">${events}</div></section>`;
}

// ------------------------------------------------------------------------------------------------
// Журнал моделі: що саме її просили і що вона відповіла
// ------------------------------------------------------------------------------------------------
//
// ai_runs — єдине місце, де записано дослівний запит і дослівну відповідь. Три різні шари пишуть
// сюди, і саме prompt_version, а не model, каже, який це був шар: модель може бути та сама.
const promptVersionNames = {
  'v2': 'Оцінка ризику',
  'analytics-narrative-v1': 'Наратив аналітики',
  'nightly-digest-v1': 'Нічний дайджест',
  'vector-narrative-v1': 'Формулювання екстраполяції',
  'shadow-classifier-v1': 'Тіньова класифікація',
  'retrospective-gate-v1': 'Ретроспективний гейт'
};

function bytesLabel(value) {
  const bytes = Number(value ?? 0);
  if (!bytes) return '—';
  return bytes < 1024 ? `${bytes} Б` : `${(bytes / 1024).toFixed(1)} КБ`;
}

// Порожній журнал — не помилка й не «ще не встигло». Це стан «жодна модель ніколи не викликалася»,
// і його треба назвати вголос, інакше порожня таблиця читається як поломка панелі.
function aiRunsEmptyState(codex, settings) {
  const off = [];
  if (settings && Object.values(settings.features).every((enabled) => !enabled)) {
    off.push('усі перемикачі Codex вимкнено');
  }
  if (codex && !codex.narrativeEnabled) off.push('<code>ANALYTICS_NARRATIVE_ENABLED=false</code>');
  if (codex && !codex.baseUrlConfigured) off.push('<code>CODEX_BASE_URL</code> порожній');
  if (settings && !settings.effectiveModel) off.push('модель не обрано');
  return `<div class="empty-state">
    <strong>Жодного звернення до моделі</strong>
    <p>Таблиця <code>ai_runs</code> порожня: за всю історію цієї бази модель не викликали жодного разу.
    Оцінки ризику рахує детермінований набір правил і підписує їх як <code>rule-fallback</code>,
    класифікація повідомлень моделі не використовує взагалі.
    ${off.length ? `Вимкнено: ${off.join(', ')}.` : ''}</p>
  </div>`;
}

// Що саме витратило виклик. `prompt_version` — це транспортний рівень, який кодував функцію лише
// за домовленістю й уже розійшовся з нею; `surface` називає її прямо, тому він і став заголовком,
// а версія промпту переїхала в технічний рядок.
const aiRunSurfaceNames = {
  narrative: 'Наратив аналітики',
  digest: 'Нічний дайджест',
  attacks: 'Аналіз атак',
  shadow: 'Тіньова класифікація',
  risk: 'Оцінка ризику',
  retrospective_gate: 'Ретроспективний гейт'
};
const aiRunValidationNames = { passed: 'звірку пройдено', rejected: 'звірку не пройдено', skipped: 'звірка не застосовна' };

function aiRunsUrl() {
  return `/ops/ai-runs?limit=50${aiRunsSurface ? `&surface=${encodeURIComponent(aiRunsSurface)}` : ''}`;
}

function aiRunRow(run) {
  const failed = run.status === 'failed';
  const technical = [
    new Date(run.created_at).toLocaleString('uk-UA'),
    promptVersionNames[run.prompt_version] ?? run.prompt_version,
    run.classifier_version ? `класифікатор ${run.classifier_version}` : null,
    run.validation_status ? aiRunValidationNames[run.validation_status] ?? run.validation_status : null,
    `запит ${bytesLabel(run.input_bytes)}`,
    `відповідь ${bytesLabel(run.output_bytes)}`,
    run.duration_ms != null ? `${run.duration_ms} мс` : null
  ].filter(Boolean).map((part) => escapeHtml(String(part))).join(' · ');
  return `<article data-ai-run="${escapeHtml(run.id)}">
    <div>
      <span>${escapeHtml(aiRunSurfaceNames[run.surface] ?? run.surface ?? 'поверхню не вказано')}</span>
      <h3>${escapeHtml(run.model)}</h3>
      <p>${technical}</p>
      ${run.fallback_reason ? `<p class="ai-run-error">Детермінований текст: ${escapeHtml(run.fallback_reason)}</p>` : ''}
      ${failed && run.error ? `<p class="ai-run-error">${escapeHtml(run.error)}</p>` : ''}
    </div>
    <div class="ops-channel-actions">
      <span class="evidence ${failed ? 'unverified' : 'confirmed'}">${failed ? 'помилка' : 'успіх'}</span>
      <button data-ai-run-open="${escapeHtml(run.id)}">Запит і відповідь</button>
    </div>
    <div class="ai-run-detail" id="ai-run-${escapeHtml(run.id)}"></div>
  </article>`;
}

function opsAiRunsSection(data, codex, settings) {
  if (!data) return `<section class="ops-section"><header class="ops-section-head"><div><p>Аудит моделі</p><h2>Журнал звернень</h2></div></header><p class="legend-note">Журнал недоступний.</p></section>`;
  const totals = data.totals ?? {};
  const facts = Number(totals.total)
    ? `<dl class="codex-facts">
        <div><dt>Усього звернень</dt><dd>${totals.total}</dd></div>
        <div><dt>З них невдалих</dt><dd>${totals.failed}</dd></div>
        <div><dt>Перше</dt><dd>${totals.first_at ? new Date(totals.first_at).toLocaleString('uk-UA') : '—'}</dd></div>
        <div><dt>Останнє</dt><dd>${totals.last_at ? new Date(totals.last_at).toLocaleString('uk-UA') : '—'}</dd></div>
      </dl>`
    : '';
  const surfaceOptions = [
    `<option value=""${aiRunsSurface ? '' : ' selected'}>Усі поверхні</option>`,
    ...Object.entries(aiRunSurfaceNames).map(([value, label]) =>
      `<option value="${escapeHtml(value)}"${aiRunsSurface === value ? ' selected' : ''}>${escapeHtml(label)}</option>`)
  ].join('');
  return `<section class="ops-section" id="ai-runs-section">
    <header class="ops-section-head">
      <div><p>Аудит моделі</p><h2>Журнал звернень</h2></div>
      <div class="ops-channel-actions">
        <select data-ai-runs-surface aria-label="Поверхня">${surfaceOptions}</select>
        <button data-ai-runs-refresh>Оновити</button>
      </div>
    </header>
    ${facts}
    <div class="ops-channel-list ai-run-list">
      ${data.items?.length ? data.items.map(aiRunRow).join('') : aiRunsEmptyState(codex, settings)}
    </div>
    ${data.items?.length === data.limit ? `<p class="legend-note">Показано останні ${data.limit} — журнал довший.</p>` : ''}
  </section>`;
}

function wireAiRunsSection(root, codex, settings) {
  const rerender = async () => {
    const data = await opsFetch(aiRunsUrl()).then((r) => r.ok ? r.json() : null).catch(() => null);
    const section = $('#ai-runs-section', root);
    if (!section) return;
    section.outerHTML = opsAiRunsSection(data, codex, settings);
    wireAiRunsSection(root, codex, settings);
  };

  $('[data-ai-runs-refresh]', root)?.addEventListener('click', () => void rerender());
  $('[data-ai-runs-surface]', root)?.addEventListener('change', (event) => {
    aiRunsSurface = event.currentTarget.value;
    void rerender();
  });

  root.querySelectorAll('[data-ai-run-open]').forEach((button) => button.addEventListener('click', async () => {
    const id = button.dataset.aiRunOpen;
    const output = $(`#ai-run-${id}`, root);
    // Друге натискання згортає: розгорнутий запит оцінки ризику — це кількасот рядків,
    // і залишати їх на екрані назавжди означає зробити список нечитабельним.
    if (output.innerHTML) { output.innerHTML = ''; button.textContent = 'Запит і відповідь'; return; }
    output.textContent = 'Завантажуємо…';
    const run = await opsFetch(`/ops/ai-runs/${encodeURIComponent(id)}`).then((r) => r.ok ? r.json() : null).catch(() => null);
    if (!run) { output.innerHTML = '<p class="legend-note">Не вдалося завантажити запис.</p>'; return; }
    button.textContent = 'Згорнути';
    output.innerHTML = `
      <h3>Запит до моделі</h3>
      <pre class="ops-json">${escapeHtml(JSON.stringify(run.input, null, 2))}</pre>
      <h3>Відповідь моделі</h3>
      ${run.output == null
        ? `<p class="legend-note">Відповіді немає — звернення завершилося помилкою.</p>`
        : `<pre class="ops-json">${escapeHtml(JSON.stringify(run.output, null, 2))}</pre>`}
      ${run.error ? `<h3>Помилка</h3><p class="legend-warning">${escapeHtml(run.error)}</p>` : ''}`;
  }));
}

// ------------------------------------------------------------------------------------------------
// Codex: вхід через ChatGPT
// ------------------------------------------------------------------------------------------------
//
// Кнопка живе тут, а не на публічній сторінці, бо вона розпоряджається обліковим записом установки,
// а не користувача. Токен ніколи не приходить у браузер: /ops/codex віддає лише те, що оператор
// мусить знати, аби вирішити, чи тиснути кнопку, — чий акаунт, доки дійсний і чого бракує.

function codexFact(term, value) {
  return `<div><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

// Умови, за яких збережена сесія нічого не змінить. Їх показуємо ЗАВЖДИ, а не лише коли підключення
// вже є: «підключено, але тиша» — найгірший стан, і він має бути пояснений до, а не після входу.
// `settings` — те, що оператор обрав нижче в цій же групі. Без нього підказки читалися б як брехня:
// відколи модель і три перемикачі живуть у /ops, порожній `CODEX_MODEL` більше не означає «моделі
// немає», а `ANALYTICS_NARRATIVE_ENABLED=false` більше не означає «наративу не буде».
// ------------------------------------------------------------------------------------------------
// Довіра до джерел
// ------------------------------------------------------------------------------------------------
//
// Тут — із розкладкою, бо оператор має мати змогу посперечатися з числом. Оцінка без компонентів —
// це оракул, а з оракулом не сперечаються. На публічній карті лишається саме слово.

function trustPercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `${Math.round(Number(value) * 100)}%`;
}

// Числа з `components` приходять із jsonb, тобто з бази, а не з константи в коді. Розкладка нікому
// не допоможе, якщо в неї можна щось вписати, тож жодне значення звідти не потрапляє в розмітку
// сирим: або число, або нуль.
function trustCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function trustLagLabel(seconds) {
  if (seconds == null) return 'нікого не наздоганяв';
  const value = Number(seconds);
  if (!Number.isFinite(value)) return 'не виміряно';
  return value >= 60 ? `${Math.round(value / 60)} хв` : `${Math.round(value)} с`;
}

// Те саме число для колонки завширшки в чотири символи. Довге «нікого не наздоганяв» лишається
// в підказці й у розгорнутій картці — саме тому колонку взагалі можна скоротити.
function trustLagShort(seconds) {
  if (seconds == null) return '—';
  const value = Number(seconds);
  if (!Number.isFinite(value)) return '—';
  return value >= 60 ? `${Math.round(value / 60)} хв` : `${Math.round(value)} с`;
}

// Тон — не прикраса, як і в решті ops-консолі: звичайне й нейтральне джерело лишається беззвучним,
// бо жодної дії не вимагає, і саме тому знижена довіра помітна. Якби «звичайна» світилася
// застережним тоном, то світився б увесь каталог — а список, у якому все жовте, не вирізняє нічого.
function trustState(source) {
  if (source.trust == null) return { label: 'не виміряно', tone: 'off' };
  if (source.neutral) return { label: 'нейтрально', tone: 'off' };
  if (source.label === 'висока') return { label: 'висока', tone: 'ok' };
  if (source.label === 'знижена') return { label: 'знижена', tone: 'bad' };
  return { label: 'звичайна', tone: 'off' };
}

// Джерело без вимірювання або з вибіркою, меншою за поріг, не має чого порівнювати. Тримати його
// в одній таблиці з поміряними означає розбавляти порівняння рядками, які в ньому не беруть
// участі, — тому вони йдуть у власний згорнутий кластер, але не зникають.
const trustUnscored = (source) => source.trust == null || source.neutral === true;

/**
 * Колонки таблиці, оголошені один раз.
 *
 * Заголовок, скорочення, повна назва, значення для показу й значення для сортування живуть в
 * одному місці — інакше `data-label` мобільної картки, `title` заголовка й вміст комірки
 * розʼїжджаються при першій же правці. Скорочення тут навмисні: сім повних назв у рядку
 * перетворюють таблицю на те, чим вона й була, — на стос карток.
 */
const TRUST_COLUMNS = [
  { key: 'modifier', short: 'Внесок', full: 'Модифікатор внеску сигналу в індекс ризику',
    text: (source) => (source.trust == null ? '—' : `×${Number(source.modifier).toFixed(2)}`),
    sort: (source) => (source.trust == null ? null : Number(source.modifier)) },
  { key: 'withdrawn', short: 'Відкл.', full: 'Відкликано тверджень',
    text: (source) => trustPercent(source.components?.withdrawnShare),
    sort: (source) => Number(source.components?.withdrawnShare ?? NaN) },
  { key: 'corroborated', short: 'Підтв.', full: 'Підтверджено іншими джерелами',
    text: (source) => trustPercent(source.components?.corroboratedShare),
    sort: (source) => Number(source.components?.corroboratedShare ?? NaN) },
  { key: 'first', short: 'Перш.', full: 'Першим повідомив, подій',
    text: (source) => String(trustCount(source.components?.firstReports)),
    sort: (source) => trustCount(source.components?.firstReports) },
  { key: 'lag', short: 'Лаг', full: 'Медіанний лаг за лідером',
    text: (source) => trustLagShort(source.components?.lagMedianSeconds),
    title: (source) => trustLagLabel(source.components?.lagMedianSeconds),
    sort: (source) => Number(source.components?.lagMedianSeconds ?? NaN) },
  { key: 'unreadable', short: 'Нечит.', full: 'Не вдалося прочитати повідомлень',
    text: (source) => trustPercent(source.components?.unreadableShare),
    sort: (source) => Number(source.components?.unreadableShare ?? NaN) },
  { key: 'sample', short: 'N', full: 'Обсяг вибірки — подій у вікні',
    text: (source) => String(trustCount(source.components?.sampleSize)),
    sort: (source) => trustCount(source.components?.sampleSize) }
];

// Порядок за замовчуванням відповідає питанню, з яким сюди приходять: «що псує індекс». Найгірша
// довіра — угорі. Каталог, відсортований за назвою, відповідав би на питання «як це називається».
const TRUST_SORTS = [
  ['trust-asc', 'Довіра ↑ — проблемні спочатку'],
  ['trust-desc', 'Довіра ↓ — найкращі спочатку'],
  ['withdrawn-desc', 'Відкликано ↓'],
  ['lag-desc', 'Медіанний лаг ↓'],
  ['sample-desc', 'Обсяг вибірки ↓'],
  ['name-asc', 'Назва А→Я']
];

function trustBar(source) {
  const tone = trustState(source).tone;
  const value = Number(source.trust);
  const percent = Number.isFinite(value) ? Math.round(Math.min(1, Math.max(0, value)) * 100) : 0;
  // aria-hidden: смуга — це друге кодування того самого числа, яке стоїть поруч цифрами. Читач
  // екрана має почути число один раз, а не число і його ж довжину.
  return `<span class="trust-bar is-${tone}" aria-hidden="true"><i style="width:${percent}%"></i></span>`;
}

function sourceTrustRow(source, methodology) {
  const state = trustState(source);
  const id = escapeHtml(source.sourceId);
  const detailId = `trust-detail-${id}`;
  const trustText = source.trust == null ? '—' : Number(source.trust).toFixed(2);
  const cells = TRUST_COLUMNS.map((column) => {
    const title = column.title ? ` title="${escapeHtml(column.title(source))}"` : '';
    return `<td class="td-num" data-label="${escapeHtml(column.full)}"${title}>${escapeHtml(column.text(source))}</td>`;
  }).join('');
  const sortKeys = TRUST_COLUMNS
    .map((column) => ` data-sort-${column.key}="${escapeHtml(String(column.sort(source) ?? ''))}"`).join('');
  return `<tr class="trust-row" data-trust-row data-source="${id}"
      data-name="${escapeHtml(`${source.name} ${source.sourceId}`.toLowerCase())}"
      data-sort-trust="${source.trust == null ? '' : Number(source.trust)}"${sortKeys}>
      <td class="td-name">
        <button type="button" class="trust-name" data-trust-expand="${id}" aria-expanded="false" aria-controls="${detailId}">
          <span class="trust-caret" aria-hidden="true">▸</span>
          <span class="trust-title">${escapeHtml(source.name)}</span>
          <span class="trust-chips">
            <i class="trust-chip" title="Рівень джерела">${escapeHtml(source.tier)}</i>
            ${source.official ? '<i class="trust-chip is-official" title="Офіційне джерело">офіц.</i>' : ''}
            <i class="trust-chip is-muted" title="Група незалежності">${escapeHtml(source.independenceGroup)}</i>
            ${source.enabled ? '' : '<i class="trust-chip is-muted" title="Джерело вимкнено">вимк.</i>'}
          </span>
        </button>
      </td>
      <td class="td-num td-trust" data-label="Довіра">
        ${trustBar(source)}<b class="is-${state.tone}">${escapeHtml(trustText)}</b>
        <span class="trust-word">${escapeHtml(state.label)}</span>
      </td>
      ${cells}
    </tr>
    <tr class="trust-detail" id="${detailId}" hidden>
      <td colspan="${TRUST_COLUMNS.length + 2}">${sourceTrustDetail(source, methodology)}</td>
    </tr>`;
}

// Розгорнутий рядок — це та сама картка, що була раніше, і саме тут живуть ПОВНІ назви метрик.
// Скорочення в таблиці чесні рівно тому, що розшифровка лежить за одним натисканням, а не в
// документації десь.
function sourceTrustDetail(source, methodology) {
  const components = source.components ?? {};
  const measured = source.trust != null;
  const window = source.windowDays ?? methodology?.windowDays ?? null;
  const reason = !measured
    ? 'Нічного розрахунку для цього джерела ще не було: воно або щойно додане, або жодного разу не потрапило в прохід.'
    : source.neutral
      ? `Замало спостережень для власної оцінки: ${trustCount(components.sampleSize)} подій за ${trustCount(window)} днів `
        + `проти порога ${trustCount(methodology?.minSampleSize)}. Довіра лишається нейтральною, внесок — незміненим.`
      : '';
  return `<div class="trust-detail-body">
    ${reason ? `<p class="legend-note">${escapeHtml(reason)}</p>` : ''}
    <dl class="codex-facts">
      <div><dt>Відкликано тверджень</dt><dd>${trustPercent(components.withdrawnShare)}</dd></div>
      <div><dt>Підтверджено іншими</dt><dd>${trustPercent(components.corroboratedShare)}</dd></div>
      <div><dt>Першим повідомив</dt><dd>${trustCount(components.firstReports)} подій</dd></div>
      <div><dt>Медіанний лаг</dt><dd>${escapeHtml(trustLagLabel(components.lagMedianSeconds))}</dd></div>
      <div><dt>Не вдалося прочитати</dt><dd>${trustPercent(components.unreadableShare)}</dd></div>
      <div><dt>Обсяг вибірки</dt><dd>${trustCount(components.sampleSize)} подій</dd></div>
      <div><dt>Ідентифікатор</dt><dd>${escapeHtml(source.sourceId)}</dd></div>
      <div><dt>Методологія</dt><dd>${escapeHtml(source.methodologyVersion ?? '—')}</dd></div>
      <div><dt>Розраховано</dt><dd>${source.computedAt ? escapeHtml(new Date(source.computedAt).toLocaleString('uk-UA')) : 'ще не було'}</dd></div>
    </dl>
    <div class="trust-history" data-trust-history></div>
  </div>`;
}

// Ряд, що стоїть за поточним числом. Список віддає лише поточне значення, тож історія вантажиться
// на розгортання й рівно один раз на рядок: 70 запитів на відкриття сторінки — це не «історія
// присутня», це відмова в обслуговуванні власному серверу.
function sourceTrustHistoryHtml(history) {
  if (!Array.isArray(history) || !history.length) {
    return '<p class="legend-note">Історії ще немає: це перший розрахунок для джерела.</p>';
  }
  const rows = history.map((run) => {
    const percent = Math.round(Math.min(1, Math.max(0, Number(run.trust))) * 100);
    return `<li>
      <time>${escapeHtml(new Date(run.computedAt).toLocaleDateString('uk-UA'))}</time>
      <span class="trust-bar is-off" aria-hidden="true"><i style="width:${percent}%"></i></span>
      <b>${escapeHtml(Number(run.trust).toFixed(2))}</b>
      <small>${trustCount(run.components?.sampleSize)} подій · вікно ${trustCount(run.windowDays)} днів</small>
    </li>`;
  }).join('');
  return `<h4>Історія розрахунків</h4><ul class="trust-history-list">${rows}</ul>`;
}

function trustTableHtml(sources, methodology, bodyAttribute) {
  const head = TRUST_COLUMNS
    .map((column) => `<th scope="col" class="th-num"><abbr title="${escapeHtml(column.full)}">${escapeHtml(column.short)}</abbr></th>`)
    .join('');
  return `<div class="trust-table-wrap">
    <table class="trust-table">
      <thead><tr>
        <th scope="col" class="th-name">Джерело</th>
        <th scope="col" class="th-num th-trust">Довіра</th>
        ${head}
      </tr></thead>
      <tbody ${bodyAttribute}>${sources.map((source) => sourceTrustRow(source, methodology)).join('')}</tbody>
    </table>
  </div>`;
}

function opsSourceTrustSection(data) {
  if (!data) return '<section class="ops-section" id="source-trust-section"><header class="ops-section-head"><div><p>Джерела</p><h2>Довіра до джерел</h2></div></header><p class="legend-note">Розрахунок довіри недоступний.</p></section>';
  const methodology = data.methodology ?? {};
  const all = data.sources ?? [];
  // Порядок за замовчуванням той самий, який одразу застосує applyTrustView(): вона є єдиним
  // розпорядником порядку, а це — стан до першого кадру. Розійтися їм не можна, інакше рядки
  // переставилися б на очах у того, хто нічого не чіпав.
  const byTrustAsc = (a, b) => (a.trust == null ? Infinity : Number(a.trust))
    - (b.trust == null ? Infinity : Number(b.trust));
  const scored = all.filter((source) => !trustUnscored(source)).sort(byTrustAsc);
  const unscored = all.filter(trustUnscored).sort(byTrustAsc);
  const sortOptions = TRUST_SORTS
    .map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join('');
  return `<section class="ops-section" id="source-trust-section">
    <header class="ops-section-head">
      <div><p>Джерела · вікно ${trustCount(methodology.windowDays)} днів</p><h2>Довіра до джерел</h2></div>
      <button data-source-trust-recalculate>Перерахувати</button>
    </header>
    <dl class="codex-facts">
      <div><dt>Методологія</dt><dd>${escapeHtml(methodology.version ?? '—')}</dd></div>
      <div><dt>Останній розрахунок</dt><dd>${data.measuredAt ? escapeHtml(new Date(data.measuredAt).toLocaleString('uk-UA')) : 'ще не було'}</dd></div>
      <div><dt>Період напіврозпаду</dt><dd>${trustCount(methodology.halfLifeDays)} днів</dd></div>
      <div><dt>Нейтральний старт до</dt><dd>${trustCount(methodology.minSampleSize)} подій</dd></div>
    </dl>
    <details class="safety-note ops-fold"><summary><strong>Довіра не змінює рівень джерела</strong></summary><p>${escapeHtml(methodology.notice ?? '')}</p></details>
    <div class="trust-controls">
      <label class="trust-filter">Фільтр за назвою
        <input type="search" data-trust-filter placeholder="назва або ідентифікатор" autocomplete="off" spellcheck="false">
      </label>
      <label class="trust-order">Порядок
        <select data-trust-sort>${sortOptions}</select>
      </label>
      <output class="trust-count" data-trust-count>${scored.length} ${pluralUk(scored.length, 'джерело', 'джерела', 'джерел')} з вимірюванням</output>
    </div>
    ${scored.length
      ? trustTableHtml(scored, methodology, 'data-trust-body')
      : '<p class="legend-note">Жодного джерела з достатньою вибіркою. Усі — у кластері нижче.</p>'}
    ${unscored.length
      ? `<details class="trust-neutral">
          <summary><span>Нейтральні (недостатньо даних)</span><b>${unscored.length}</b><span class="legend-caret" aria-hidden="true">▾</span></summary>
          <p class="legend-note">Менше ніж ${trustCount(methodology.minSampleSize)} подій у вікні або розрахунку ще не було. Довіра таких джерел нейтральна, а внесок — незмінений: порівнювати їх поки нема з чим.</p>
          ${trustTableHtml(unscored, methodology, 'data-trust-neutral-body')}
        </details>`
      : ''}
  </section>`;
}

/**
 * Фільтр і порядок працюють по DOM, а не перемальовуванням секції.
 *
 * Перемальовування згорнуло б кожен розгорнутий рядок, скинуло б фокус із поля пошуку на кожну
 * літеру й викинуло б уже завантажену історію. Тут же рядок або ховається, або переставляється —
 * пара «рядок + його деталь» переставляється разом, інакше деталь опинилася б під чужим рядком.
 */
function trustRowPairs(body) {
  return [...body.querySelectorAll('[data-trust-row]')]
    .map((row) => ({ row, detail: row.nextElementSibling }));
}

function applyTrustView(section) {
  const query = ($('[data-trust-filter]', section)?.value ?? '').trim().toLowerCase();
  const sort = $('[data-trust-sort]', section)?.value ?? 'trust-asc';
  const [key, direction] = sort.split('-');
  // `withdrawn-desc` → dataset.sortWithdrawn. Одне перетворення на всі колонки: атрибути пише
  // TRUST_COLUMNS із того самого ключа, тож новий стовпчик стає сортовним без правки тут.
  const attribute = `sort${key[0].toUpperCase()}${key.slice(1)}`;
  let shown = 0;
  let total = 0;
  for (const body of section.querySelectorAll('[data-trust-body], [data-trust-neutral-body]')) {
    const pairs = trustRowPairs(body);
    const numeric = key !== 'name';
    const value = ({ row }) => {
      if (!numeric) return row.dataset.name ?? '';
      const raw = Number(row.dataset[attribute]);
      // Порожнє значення завжди в кінці, у який би бік не сортували: «немає числа» — це не
      // «нуль», і джерело без метрики не має права очолити рейтинг найгірших.
      return Number.isFinite(raw) ? raw : (direction === 'asc' ? Infinity : -Infinity);
    };
    pairs.sort((a, b) => {
      if (!numeric) return String(value(a)).localeCompare(String(value(b)), 'uk');
      return direction === 'desc' ? value(b) - value(a) : value(a) - value(b);
    });
    for (const pair of pairs) {
      total += 1;
      const match = !query || (pair.row.dataset.name ?? '').includes(query);
      pair.row.hidden = !match;
      if (pair.detail) pair.detail.hidden = !match || pair.row.querySelector('[data-trust-expand]')?.getAttribute('aria-expanded') !== 'true';
      if (match) shown += 1;
      body.append(pair.row);
      if (pair.detail) body.append(pair.detail);
    }
  }
  const count = $('[data-trust-count]', section);
  if (count) {
    count.textContent = query
      ? `Показано ${shown} із ${total} ${pluralUk(total, 'джерела', 'джерел', 'джерел')}`
      : `${total} ${pluralUk(total, 'джерело', 'джерела', 'джерел')} у каталозі`;
  }
}

function wireSourceTrustSection(root) {
  const section = $('#source-trust-section', root);
  if (!section) return;
  applyTrustView(section);

  $('[data-trust-filter]', section)?.addEventListener('input', () => applyTrustView(section));
  $('[data-trust-sort]', section)?.addEventListener('change', () => applyTrustView(section));

  section.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-trust-expand]');
    if (!button || !section.contains(button)) return;
    const row = button.closest('[data-trust-row]');
    const detail = row?.nextElementSibling;
    if (!detail) return;
    const open = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!open));
    row.classList.toggle('is-open', !open);
    detail.hidden = open;
    if (open || row.dataset.historyLoaded) return;
    row.dataset.historyLoaded = '1';
    const target = detail.querySelector('[data-trust-history]');
    if (!target) return;
    target.innerHTML = '<p class="legend-note">Завантажуємо історію…</p>';
    const payload = await opsFetch(`/ops/api/source-trust/${encodeURIComponent(row.dataset.source)}?limit=30`)
      .then((result) => result.ok ? result.json() : null).catch(() => null);
    target.innerHTML = payload
      ? sourceTrustHistoryHtml(payload.history)
      : '<p class="legend-note">Історію завантажити не вдалося.</p>';
  });

  $('[data-source-trust-recalculate]', section)?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true; button.textContent = 'Рахуємо…';
    await opsFetch('/ops/api/source-trust/recalculate', { method: 'POST' }).catch(() => null);
    const data = await opsFetch('/ops/api/source-trust').then((r) => r.ok ? r.json() : null).catch(() => null);
    const current = $('#source-trust-section', root);
    if (!current) return;
    current.outerHTML = opsSourceTrustSection(data);
    wireSourceTrustSection(root);
  });
}

function codexPreconditions(status, settings) {
  const rows = [];
  const featureOn = settings ? Object.values(settings.features).some(Boolean) : false;
  if (!status.narrativeEnabled && !featureOn) rows.push('<code>ANALYTICS_NARRATIVE_ENABLED=false</code>, і жоден перемикач нижче не ввімкнено — токен збережеться, але модель не запитуватимуть. Аналітика лишається повною й без неї.');
  if (!status.baseUrlConfigured) rows.push('<code>CODEX_BASE_URL</code> не задано — вхід дає токен, але не адресу, куди його слати.');
  if (settings ? !settings.effectiveModel : !status.modelConfigured) rows.push('Модель не обрано: ні в списку нижче, ні в <code>CODEX_MODEL</code>.');
  if (status.envTokenConfigured) rows.push('У <code>.env</code> лишається <code>CODEX_API_KEY</code>. Збережена сесія має пріоритет — змінна тепер лише запасний варіант.');
  return rows.length ? `<ul class="codex-preconditions">${rows.map((row) => `<li>${row}</li>`).join('')}</ul>` : '';
}

function opsCodexSection(status, settings) {
  if (!status) return '<section class="ops-section"><header class="ops-section-head"><div><p>Модель для наративів</p><h2>Codex / ChatGPT</h2></div></header><p class="legend-note">Стан входу недоступний.</p></section>';
  const state = !status.connected ? { label: 'не підключено', tone: 'off' }
    : status.expired && !status.canRefresh ? { label: 'сесія завершилася', tone: 'bad' }
      : status.expired ? { label: 'потребує оновлення', tone: 'warn' }
        : { label: 'підключено', tone: 'ok' };
  const facts = [
    codexFact('Акаунт ChatGPT', status.accountId ?? 'не повідомлено'),
    codexFact('Токен дійсний до', status.expiresAt ? new Date(status.expiresAt).toLocaleString('uk-UA') : 'невідомо'),
    codexFact('Автооновлення', status.canRefresh ? 'є refresh-токен' : 'немає — знадобиться повторний вхід'),
    codexFact('Адреса повернення', status.redirectUri)
  ].join('');
  return `<section class="ops-section" id="codex-section">
    <header class="ops-section-head">
      <div><p>Модель для аналітичних наративів</p><h2>Codex / ChatGPT</h2></div>
      <span class="codex-state is-${state.tone}">${escapeHtml(state.label)}</span>
    </header>
    <dl class="codex-facts">${facts}</dl>
    ${codexPreconditions(status, settings)}
    ${status.lastError ? `<p class="legend-warning">Остання помилка: ${escapeHtml(status.lastError)}</p>` : ''}
    ${status.pendingLogin ? `<p class="legend-warning">Вхід триває. Сеанс дійсний до ${escapeHtml(new Date(status.pendingLogin.expiresAt).toLocaleTimeString('uk-UA'))}.</p>` : ''}
    <div class="ops-channel-actions codex-actions">
      <button data-codex-login>${status.connected ? 'Увійти заново' : 'Увійти через ChatGPT'}</button>
      ${status.connected ? '<button data-codex-disconnect>Відключити</button>' : ''}
      <button data-codex-refresh>Оновити стан</button>
    </div>
    <div id="codex-login-hint"></div>
    <details class="safety-note ops-fold">
      <summary><strong>Повернення можливе лише на localhost</strong></summary>
      <p>Клієнт Codex приймає єдину адресу повернення — <code>${escapeHtml(status.redirectUri)}</code>. Вхід завершиться тільки тоді, коли браузер і застосунок бачать один і той самий <code>localhost</code>: на вашій машині так, на віддаленому сервері за Caddy — ні. Крім того, вхід Codex призначено для клієнта Codex, а не для стороннього сервера, який працює цілодобово; ризик санкцій до облікового запису лишається на вас.</p>
    </details>
  </section>`;
}

// ------------------------------------------------------------------------------------------------
// Codex: що саме модель робить у системі
// ------------------------------------------------------------------------------------------------
//
// Три перемикачі, а не один. «Увімкнути ШІ» — це не рішення, яке оператор може ухвалити один раз:
// наратив аналітики бачить лише він сам, дайджест іде тисячам людей у Telegram, а формулювання
// екстраполяції взагалі не публікується. Ціна помилки в цих трьох місцях різна, тож і вимикач у
// кожного свій. Під кожним підписано, куди саме потрапить текст, — бо це і є те, що визначає,
// наскільки страшно його вмикати.

const codexFeatureLabels = {
  narrative: {
    title: 'Наратив аналітики',
    note: 'Модель переказує людською мовою вже пораховані агрегати на сторінці аналітики. Кожне число з її тексту звіряється з розрахунком; одне невідоме — і текст відкидається цілком.'
  },
  digest: {
    title: 'Нічний дайджест',
    note: 'Один підсумковий рядок під переліком оцінок у Telegram. Іде людям, підписаним на аналітику, з явною позначкою, що його написала модель. Самі оцінки модель не змінює.'
  },
  attacks: {
    title: 'Аналіз атак',
    note: 'Формулювання операторської екстраполяції вектора. Не публікується ніде за межами цієї консолі. Числа так само звіряються з розрахунком.'
  },
  // Четвертий перемикач стоїть окремо за суттю, а не лише за порядком: перші три додають текст до
  // того, на що людина вже дивиться, а цей витрачає виклик на КОЖНЕ прийняте повідомлення й не
  // зʼявляється ніде, крім таблиці звірки нижче. Підпис мусить сказати обидві речі: що це тіньовий
  // режим і що на бойовий шлях він не впливає ніколи.
  shadow: {
    title: 'Тіньова класифікація',
    note: 'Модель читає ті самі повідомлення після того, як правила вже ухвалили рішення, і її вердикт лягає поруч для звірки. На оповіщення, події й карту це не впливає ніколи. Єдиний перемикач, який витрачає виклик на кожне повідомлення, — тому він і найдорожчий.'
  },
  // Пʼятий перемикач — єдиний, чий вердикт може щось змінити на бойовому шляху, і зміна ця строго
  // одностороння: «опублікувати» → «лише архів» для повідомлень, які правила вже позначили як
  // підозру на ретроспективу. Створити, розширити чи повернути подію модель не може структурно;
  // мовчання, таймаут або вимкнена сесія означають публікацію за детермінованим вердиктом.
  retrospective_gate: {
    title: 'Ретроспективний гейт',
    note: 'Для повідомлень, які правила позначили як схожі на переказ минулої ночі, модель відповідає на одне питання: це загроза зараз чи оповідь про минуле? «Оповідь» ховає повідомлення в архів. Будь-яка невпевненість, помилка чи таймаут — публікація як без моделі.'
  }
};

function codexFeatureField(key, enabled) {
  const label = codexFeatureLabels[key];
  return `<label class="codex-feature">
    <input type="checkbox" data-codex-feature="${escapeHtml(key)}"${enabled ? ' checked' : ''}>
    <span><strong>${escapeHtml(label.title)}</strong>${escapeHtml(label.note)}</span>
  </label>`;
}

function opsCodexSettingsSection(payload) {
  if (!payload) {
    return '<section class="ops-section" id="codex-settings-section"><header class="ops-section-head"><div><p>Керування</p><h2>Модель і функції</h2></div></header><p class="legend-note">Налаштування недоступні.</p></section>';
  }
  const settings = payload.settings;
  const models = payload.availableModels ?? [];
  // Порожній варіант — це справжній вибір, а не «нічого не вибрано»: він означає «беріть те, що
  // задано в CODEX_MODEL», і саме так поводиться свіжовстановлена система.
  const options = [
    `<option value=""${settings.model ? '' : ' selected'}>За замовчуванням${payload.status?.modelConfigured ? ' — CODEX_MODEL' : ' (CODEX_MODEL порожній)'}</option>`,
    ...models.map((model) => `<option value="${escapeHtml(model)}"${settings.model === model ? ' selected' : ''}>${escapeHtml(model)}</option>`)
  ].join('');
  const source = payload.modelsSource === 'api'
    ? 'Перелік отримано від Codex.'
    : `Перелік запасний${payload.modelsError ? `: ${escapeHtml(payload.modelsError)}` : ''}.`;
  const effective = settings.effectiveModel
    ? `Зараз викликається <code>${escapeHtml(settings.effectiveModel)}</code> (${settings.modelSource === 'stored' ? 'вибір оператора' : 'із CODEX_MODEL'}).`
    : 'Модель не обрано ніде — жоден виклик не відбудеться.';

  return `<section class="ops-section" id="codex-settings-section">
    <header class="ops-section-head"><div><p>Керування</p><h2>Модель і функції</h2></div></header>
    <div class="codex-settings">
      <label class="codex-model">Модель<select data-codex-model>${options}</select></label>
      <p class="legend-note">${source} ${effective}</p>
      <div class="codex-features">
        ${Object.keys(codexFeatureLabels).map((key) => codexFeatureField(key, settings.features[key])).join('')}
      </div>
      <div class="ops-channel-actions codex-actions">
        <button data-codex-settings-save>Зберегти</button>
        <output id="codex-settings-status"></output>
      </div>
      <p class="legend-note">Вимкнене — це не помилка й не деградація: аналітика, дайджест і екстраполяція повні без моделі. Перемикач лише додає текст поверх готових чисел.</p>
    </div>
  </section>`;
}

function wireCodexSettingsSection(root, onSaved) {
  const status = $('#codex-settings-status', root);

  $('[data-codex-settings-save]', root)?.addEventListener('click', async () => {
    const features = {};
    root.querySelectorAll('[data-codex-feature]').forEach((input) => {
      features[input.dataset.codexFeature] = input.checked;
    });
    status.textContent = 'Зберігаємо…';
    const result = await opsFetch('/ops/codex/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: $('[data-codex-model]', root)?.value || null, features })
    }).catch(() => null);
    if (!result?.ok) { status.textContent = 'Не вдалося зберегти.'; return; }
    status.textContent = 'Збережено.';
    // Перемальовуємо всю групу: збережений перемикач змінює й підказки в журналі звернень
    // («усі три вимкнено»), тож показувати новий стан лише в одному місці означало б показати
    // два різні стани поруч.
    await onSaved();
  });
}

// ------------------------------------------------------------------------------------------------
// Тіньова класифікація: де правила й модель розійшлися
// ------------------------------------------------------------------------------------------------
//
// Це не панель якості моделі, а список для читання. Кожна розбіжність — повідомлення, яке варто
// переглянути людині: або правила пропустили нову лексику, або модель помилилася. Дію з цього
// робить людина — пише патерн і тест; сама сторінка нічого не змінює й нічого не запускає.

const shadowFieldNames = {
  significance: 'значущість',
  threat_type: 'клас загрози',
  locations: 'локації'
};

function shadowFieldName(field) {
  return shadowFieldNames[field] ?? field;
}

function shadowVerdictLine(label, verdict) {
  const places = verdict.locations?.length ? verdict.locations.join(', ') : 'без локацій';
  const significance = verdict.significant ? 'значуще' : 'проігноровано';
  const confidence = verdict.confidence == null ? '' : ` · впевненість ${verdict.confidence.toFixed(2)}`;
  return `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(verdict.threatType)} · ${escapeHtml(places)} · ${significance}${confidence}</p>`;
}

// Порожньо буває з двох різних причин, і назвати треба саме ту, що трапилася: вимкнений перемикач —
// це рішення оператора, а мовчазна модель при ввімкненому — привід відкрити журнал звернень.
function shadowEmptyState(data, settings) {
  const off = settings && settings.features && settings.features.shadow === false;
  return `<div class="empty-state">
    <strong>Жодного порівняння за ${data.windowHours} год</strong>
    <p>${off
      ? 'Перемикач «Тіньова класифікація» вимкнено — модель не викликають узагалі. Це стан за замовчуванням.'
      : 'Перемикач увімкнено, але порівнянь немає: або модель не обрано й не виконано вхід, або всі виклики впали. Причина буде в журналі звернень нижче.'}</p>
  </div>`;
}

function opsShadowSection(data, settings) {
  if (!data) {
    return '<section class="ops-section" id="shadow-section"><header class="ops-section-head"><div><p>Звірка класифікатора</p><h2>Тіньова класифікація</h2></div></header><p class="legend-note">Дані недоступні.</p></section>';
  }
  // Нуль порівнянь і нуль відсотків згоди — протилежні стани, і плутати їх не можна: перше означає
  // «модель мовчить», друге — «модель не погоджується з правилами взагалі».
  const body = data.total === 0
    ? shadowEmptyState(data, settings)
    : `<dl class="codex-facts">
        <div><dt>Порівнянь</dt><dd>${data.total}</dd></div>
        <div><dt>Згода</dt><dd>${data.agreementPercent}%</dd></div>
        <div><dt>Розбіжностей</dt><dd>${data.disagreed}</dd></div>
        <div><dt>Вікно</dt><dd>${data.windowHours} год</dd></div>
      </dl>
      ${data.byField?.length ? `<p class="legend-note">За осями: ${data.byField.map((row) => `${escapeHtml(shadowFieldName(row.field))} — ${row.count}`).join(', ')}.</p>` : ''}
      <div class="ops-channel-list">${data.recentDisagreements.map((row) => `<article>
        <div>
          <span>${escapeHtml(row.fields.map(shadowFieldName).join(', '))}</span>
          <h3>${escapeHtml(new Date(row.publishedAt).toLocaleString('uk-UA'))}</h3>
          <p>${escapeHtml(row.text)}</p>
          ${shadowVerdictLine('Правила', row.deterministic)}
          ${shadowVerdictLine('Модель', row.model)}
        </div>
      </article>`).join('')}</div>`;
  return `<section class="ops-section" id="shadow-section">
    <header class="ops-section-head">
      <div><p>Звірка класифікатора</p><h2>Тіньова класифікація</h2></div>
      <button data-shadow-refresh>Оновити</button>
    </header>
    <p class="legend-note">Модель читає ті самі повідомлення після того, як рішення вже ухвалено правилами. На карту, оповіщення й бота це не впливає ніколи. Розбіжність — не помилка моделі й не помилка правил, а привід прочитати повідомлення.</p>
    ${body}
  </section>`;
}

function wireShadowSection(root, settings) {
  $('[data-shadow-refresh]', root)?.addEventListener('click', async () => {
    const data = await opsFetch('/ops/shadow-classifier?hours=24').then((r) => r.ok ? r.json() : null).catch(() => null);
    const section = $('#shadow-section', root);
    if (!section) return;
    section.outerHTML = opsShadowSection(data, settings);
    wireShadowSection(root, settings);
  });
}

function wireCodexSection(root, settings) {
  const rerender = async () => {
    const status = await opsFetch('/ops/codex').then((r) => r.ok ? r.json() : null).catch(() => null);
    const section = $('#codex-section', root);
    if (!section) return null;
    section.outerHTML = opsCodexSection(status, settings);
    wireCodexSection(root, settings);
    return status;
  };

  $('[data-codex-refresh]', root)?.addEventListener('click', () => void rerender());

  $('[data-codex-login]', root)?.addEventListener('click', async (event) => {
    // Вкладку відкриваємо СИНХРОННО, всередині обробника кліку: якби ми чекали на відповідь
    // сервера, браузер уже не вважав би відкриття наслідком дії користувача й заблокував би його.
    const tab = window.open('', '_blank');
    const hint = $('#codex-login-hint', root);
    hint.textContent = 'Готуємо сеанс входу…';
    const result = await opsFetch('/ops/codex/login', { method: 'POST' });
    const payload = await result.json().catch(() => null);
    if (!result.ok) {
      tab?.close();
      hint.innerHTML = `<p class="legend-warning">Не вдалося почати вхід: ${escapeHtml(payload?.reason ?? 'невідома причина')}</p>`;
      return;
    }
    const url = safeUrl(payload.authorizeUrl);
    if (!url) { tab?.close(); hint.innerHTML = '<p class="legend-warning">Сервер повернув некоректну адресу входу.</p>'; return; }
    if (tab) tab.location = url;
    // Посилання лишаємо в будь-якому разі: спливні вікна можуть бути заблоковані, а ще оператор
    // може захотіти відкрити вхід в іншому профілі браузера.
    hint.innerHTML = `<p class="legend-note">Завершіть вхід у вкладці ChatGPT. Після повернення стан оновиться сам.</p>
      <a class="territory-all" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Відкрити сторінку входу ChatGPT ↗</a>`;
    // Опитуємо стан, поки сеанс входу живий: інакше оператор мусив би здогадатися натиснути «оновити».
    clearInterval(codexPollTimer);
    const stopAt = Date.parse(payload.expiresAt);
    codexPollTimer = setInterval(async () => {
      const status = await rerender();
      if (!status || status.connected || !status.pendingLogin || Date.now() > stopAt) clearInterval(codexPollTimer);
    }, 4000);
    event.preventDefault();
  });

  $('[data-codex-disconnect]', root)?.addEventListener('click', async () => {
    await opsFetch('/ops/codex', { method: 'DELETE' });
    clearInterval(codexPollTimer);
    void rerender();
  });
}

// ------------------------------------------------------------------------------------------------
// Режим показу і подієвий перерахунок
// ------------------------------------------------------------------------------------------------
//
// Найвпливовіший орган керування на сторінці, тому він стоїть одразу під метриками. Моделі й
// перемикачів аналітичних функцій тут НЕМАЄ навмисно: вони вже живуть у картці «Codex-аналітика»,
// а два перемикачі на одне рішення — найзаплутаніший стан, у якому може бути операційна сторінка.

// Імена полів у журналі змін. Ключі — snake_case, як їх пише аудит на сервері.
const RUNTIME_FIELD_NAMES = {
  publication_mode: 'режим показу',
  analytics_event_driven: 'подієве оновлення аналітики',
  analytics_debounce_ms: 'пауза перед перерахунком',
  analytics_max_delay_ms: 'гранична затримка перерахунку',
  analytics_min_pass_interval_ms: 'мінімальний інтервал між проходами',
  codex_cooldown_ms: 'інтервал між зверненнями до Codex'
};

// Підписи числових полів форми. Ключі — camelCase, як їх називають `bounds` у GET /ops/api/runtime
// і `issues` у 400 на PUT.
//
// Це САМЕ підписи, а не перелік полів: список будує runtimeBoundedFields() з того, що прислав
// сервер. Нове обмеження в міграції зʼявляється у формі без правки цього файлу, а поле, підпису
// для якого тут немає, малюється зі своїм ключем — незграбний підпис кращий за невидиме
// налаштування, яке оператор не може ні побачити, ні змінити.
const RUNTIME_FIELD_LABELS = {
  analyticsDebounceMs: 'Пауза перед перерахунком',
  analyticsMaxDelayMs: 'Гранична затримка перерахунку',
  analyticsMinPassIntervalMs: 'Мінімальний інтервал між проходами',
  codexCooldownMs: 'Мінімальний інтервал між зверненнями до Codex'
};
const RUNTIME_FIELD_NOTES = {
  analyticsDebounceMs: 'Скільки чекати після останньої події, перш ніж рахувати.',
  analyticsMaxDelayMs: 'Максимум, на скільки безперервний потік подій може відкласти перерахунок.',
  analyticsMinPassIntervalMs: 'Скільки щонайменше має минути між двома проходами аналітики.',
  codexCooldownMs: '0 — без обмеження.'
};
// Порядок показу знайомих полів. Незнайоме йде в кінець у тому порядку, у якому його прислав сервер.
const RUNTIME_FIELD_ORDER = [
  'analyticsDebounceMs', 'analyticsMaxDelayMs', 'analyticsMinPassIntervalMs', 'codexCooldownMs'
];
// Одиниця виміру читається із суфікса ключа, а не зі списку полів: поле, названого за тією самою
// угодою, форма підпише правильно й без правки.
//
// Дві угоди в одній таблиці, бо форму числового поля ділять два екрани. Рантайм називає поля
// camelCase (`analyticsDebounceMs`), реєстр налаштувань — UPPER_SNAKE (`AI_TIMEOUT_MS`), і жодне
// імʼя однієї угоди не може випадково закінчитися суфіксом іншої: регістр їх розводить.
// `_PER_MINUTE` стоїть перед коротшими суфіксами, бо find() бере ПЕРШИЙ збіг.
const RUNTIME_UNIT_SUFFIXES = [
  ['Ms', 'мс'], ['Seconds', 'с'], ['Minutes', 'хв'], ['Days', 'днів'],
  ['_PER_MINUTE', 'за хвилину'], ['_MS', 'мс'], ['_SECONDS', 'с'], ['_PAGE_SIZE', 'повідомлень']
];
const runtimeUnit = (field) => RUNTIME_UNIT_SUFFIXES.find(([suffix]) => field.endsWith(suffix))?.[1] ?? '';
// Підпис шукається у двох таблицях, бо runtimeNumberField() малює поля обох екранів. Ключ, якого
// немає в жодній, малюється сам собою — незграбний підпис кращий за невидиме налаштування.
const runtimeFieldLabel = (field) => RUNTIME_FIELD_LABELS[field] ?? APP_SETTING_LABELS[field] ?? field;
// 600000 читається як «600 000» — вузьким нерозривним пробілом, як велить uk-UA. Шістка нулів
// поспіль у підказці про межі — це підказка, яку доводиться рахувати пальцем.
const ukNumberFormat = new Intl.NumberFormat('uk-UA');
const ukNumber = (value) => (Number.isFinite(Number(value)) ? ukNumberFormat.format(Number(value)) : String(value));

// Тривалість hold конфігурована на сервері (bounds.publicationDelaySeconds), тож підписи режиму
// будуються функцією, а не константою з переписаною цифрою.
const runtimeModeNames = (delaySeconds) => ({ live: 'Наживо', delayed_15s: `Із затримкою ${delaySeconds} с` });

// Числове поле форми — це рівно те, для чого сервер надіслав діапазон. `publicationDelaySeconds`
// приходить у тому ж обʼєкті голим числом (це константа розгортання, а не налаштування), і саме
// форма діапазону, а не список імен, відрізняє одне від одного.
function runtimeBoundedFields(bounds) {
  const ranged = Object.keys(bounds ?? {}).filter((key) => {
    const bound = bounds[key];
    return bound != null && typeof bound === 'object'
      && Number.isFinite(Number(bound.min)) && Number.isFinite(Number(bound.max));
  });
  const known = RUNTIME_FIELD_ORDER.filter((key) => ranged.includes(key));
  return [...known, ...ranged.filter((key) => !known.includes(key))];
}

// min/max приходять із меж, які надіслав сервер, а не переписані тут константою: обмеження
// живуть у CHECK міграції, і форма мусить дізнаватися їх звідти, а не з чужої копії.
//
// Межі не просто написані під полем — вони натискні. Підказка «від 0 до 600 000 мс» і кнопка
// «підставити мінімум» — це та сама пара чисел, і робити з них два різні органи керування
// означало б показати межу двічі, а виконати її жодного разу.
function runtimeNumberField(field, bound, value) {
  const min = Number(bound.min);
  const max = Number(bound.max);
  const unit = runtimeUnit(field);
  const suffix = unit ? ` ${unit}` : '';
  const title = runtimeFieldLabel(field);
  const note = RUNTIME_FIELD_NOTES[field] ?? APP_SETTING_NOTES[field] ?? '';
  const id = escapeHtml(field);
  const current = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : min;
  const pick = (kind, edge, word) => `<button type="button" class="bound-pick" data-runtime-bound="${kind}"`
    + ` data-runtime-for="${id}" aria-label="Підставити ${word}: ${escapeHtml(ukNumber(edge))}${escapeHtml(suffix)}"`
    + `>${escapeHtml(ukNumber(edge))}</button>`;
  return `<div class="codex-feature runtime-field" data-runtime-row="${id}">
    <label class="codex-feature-title" for="runtime-in-${id}">${escapeHtml(title)}${escapeHtml(unit ? `, ${unit}` : '')}</label>
    <input id="runtime-in-${id}" type="number" data-runtime-field="${id}" min="${min}" max="${max}" step="1"
      inputmode="numeric" value="${escapeHtml(String(current))}"
      aria-describedby="runtime-hint-${id} runtime-error-${id}">
    <p class="runtime-bounds" id="runtime-hint-${id}">від ${pick('min', min, 'мінімум')} до ${pick('max', max, 'максимум')}${escapeHtml(suffix)}</p>
    ${note ? `<p class="codex-feature-note">${escapeHtml(note)}</p>` : ''}
    <p class="runtime-field-error" id="runtime-error-${id}" data-runtime-error hidden></p>
  </div>`;
}

// Перевірка ДО запиту. Раніше «поставив усі затримки на 0» їхало на сервер і поверталося рядком
// «Не вдалося зберегти.» — повідомленням, яке не називає ні поля, ні межі, ні того, що саме в
// ньому не так. Тут кожна проблема називає поле, значення й діапазон, і жодна з них не коштує
// звернення до мережі.
function validateRuntimeForm(section) {
  const problems = [];
  const values = {};
  section.querySelectorAll('input[type="number"][data-runtime-field]').forEach((input) => {
    const field = input.dataset.runtimeField;
    const name = runtimeFieldLabel(field);
    const unit = runtimeUnit(field);
    const suffix = unit ? ` ${unit}` : '';
    const min = Number(input.min);
    const max = Number(input.max);
    const range = `від ${ukNumber(min)} до ${ukNumber(max)}${suffix}`;
    const raw = input.value.trim();
    const value = Number(raw);
    if (raw === '' || !Number.isFinite(value) || !Number.isInteger(value)) {
      problems.push({ field, message: `${name}: потрібне ціле число, ${range}.` });
      return;
    }
    values[field] = value;
    if (value < min || value > max) {
      problems.push({ field, message: `${name}: ${ukNumber(value)}${suffix} поза межами — ${range}.` });
    }
  });
  // Перехресне правило runtime_settings_delay_order із міграції 022. Сервер називає в `issues`
  // саме максимум, тому й тут воно висить на максимумі: пауза 0 законна поруч із будь-яким
  // законним максимумом, тож порушити пару можна лише згори.
  const { analyticsDebounceMs: debounce, analyticsMaxDelayMs: maxDelay } = values;
  if (Number.isFinite(debounce) && Number.isFinite(maxDelay) && maxDelay < debounce) {
    problems.push({
      field: 'analyticsMaxDelayMs',
      message: `${runtimeFieldLabel('analyticsMaxDelayMs')}: ${ukNumber(maxDelay)} мс менше за паузу `
        + `${ukNumber(debounce)} мс. Гранична затримка не може бути меншою за паузу.`
    });
  }
  return problems;
}

/**
 * Малює проблеми біля полів і повертає ті, для яких поля у формі немає.
 *
 * Порожній список — це скидання: клас, повідомлення й aria-invalid знімаються з УСІХ рядків, тож
 * виправлене поле перестає світитися, щойно оператор натиснув «Зберегти» вдруге.
 */
function showRuntimeFieldErrors(section, problems) {
  section.querySelectorAll('[data-runtime-row]').forEach((row) => {
    row.classList.remove('is-invalid');
    row.querySelector('input')?.removeAttribute('aria-invalid');
    const output = row.querySelector('[data-runtime-error]');
    if (output) { output.textContent = ''; output.hidden = true; }
  });
  const orphans = [];
  for (const problem of problems) {
    const row = section.querySelector(`[data-runtime-row="${problem.field}"]`);
    if (!row) { orphans.push(problem); continue; }
    row.classList.add('is-invalid');
    row.querySelector('input')?.setAttribute('aria-invalid', 'true');
    const output = row.querySelector('[data-runtime-error]');
    if (output) { output.textContent = problem.message; output.hidden = false; }
  }
  section.querySelector('.is-invalid input')?.focus();
  return orphans;
}

// Що сказати про поле, яке відхилив сервер. Межі беремо з самого поля — вони вже прийшли від
// сервера в `bounds` і лежать в атрибутах, тож повідомлення не вигадує діапазон від себе.
function runtimeIssueMessage(section, field) {
  const name = RUNTIME_FIELD_LABELS[field] ?? RUNTIME_FIELD_NAMES[field] ?? field;
  const input = section.querySelector(`[data-runtime-field="${field}"]`);
  if (!input || input.type !== 'number') return `${name}: сервер відхилив це значення.`;
  const unit = runtimeUnit(field);
  const suffix = unit ? ` ${unit}` : '';
  return `${name}: сервер відхилив це значення. Дозволено від ${ukNumber(input.min)} до ${ukNumber(input.max)}${suffix}.`;
}

function runtimeAuditRow(row) {
  return `<article>
    <div>
      <span>${escapeHtml(new Date(row.changedAt).toLocaleString('uk-UA'))} · ${escapeHtml(row.changedBy)} · ${escapeHtml(row.source)}</span>
      <h3>${escapeHtml(RUNTIME_FIELD_NAMES[row.field] ?? row.field)}</h3>
      <p>${escapeHtml(row.previousValue ?? '—')} → ${escapeHtml(row.newValue)}</p>
    </div>
  </article>`;
}

function opsRuntimeSection(data) {
  if (!data) {
    return '<section class="ops-section" id="runtime-section"><header class="ops-section-head"><div><p>Публікація та аналітика</p><h2>Режим показу і подієвий перерахунок</h2></div></header><p class="legend-note">Налаштування середовища недоступні.</p></section>';
  }
  const settings = data.settings ?? {};
  const bounds = data.bounds ?? {};
  const effective = data.effective ?? null;
  const delayed = settings.publicationMode === 'delayed_15s';
  const delaySeconds = effective?.delaySeconds || bounds.publicationDelaySeconds || 15;
  // Тон — не прикраса: звичайний режим лишається беззвучним, колір зʼявляється лише тоді, коли
  // оператор мусить памʼятати, що показ затримано.
  const pill = `<span class="codex-state${delayed ? ' is-warn' : ''}">${delayed ? `Затримка ${delaySeconds} с` : 'Наживо'}</span>`;
  const options = Object.entries(runtimeModeNames(delaySeconds))
    .map(([value, label]) => `<option value="${value}"${settings.publicationMode === value ? ' selected' : ''}>${escapeHtml(label)}</option>`)
    .join('');
  const effectiveFacts = effective
    ? `<dl class="codex-facts">
        <div><dt>Затримка</dt><dd>${escapeHtml(String(effective.delaySeconds ?? 0))} с</dd></div>
        <div><dt>Зріз</dt><dd>${effective.cutoffAt ? escapeHtml(new Date(effective.cutoffAt).toLocaleString('uk-UA')) : '—'}</dd></div>
        <div><dt>Версія зрізу</dt><dd>${escapeHtml(String(effective.cutoffVersion ?? '—'))}</dd></div>
        <div><dt>Остання опублікована подія</dt><dd>${effective.lastPublishedEventAt ? escapeHtml(new Date(effective.lastPublishedEventAt).toLocaleString('uk-UA')) : 'подій ще не було'}</dd></div>
        <div><dt>Утримано подій</dt><dd>${escapeHtml(String(effective.backlogEvents ?? 0))}</dd></div>
        <div><dt>Відставання</dt><dd>${escapeHtml(String(effective.behindSeconds ?? 0))} с</dd></div>
      </dl>`
    : '';
  return `<section class="ops-section" id="runtime-section">
    <header class="ops-section-head">
      <div><p>Публікація та аналітика</p><h2>Режим показу і подієвий перерахунок</h2></div>
      <div class="ops-channel-actions">${pill}<button type="button" data-analytics-recalculate>Оновити зараз</button></div>
    </header>
    <label class="codex-model">Режим показу<select data-runtime-mode>${options}</select></label>
    ${delayed ? `<p class="legend-note">Публікація затримана на ${delaySeconds} с. Затримка не стосується Telegram-сповіщень.</p>` : ''}
    <div class="codex-features">
      <label class="codex-feature">
        <input type="checkbox" data-runtime-field="analyticsEventDriven"${settings.analyticsEventDriven ? ' checked' : ''}>
        <span><strong>Подієве оновлення аналітики</strong>Перерахунок після кожної релевантної події, а не лише за таймером.</span>
      </label>
      ${runtimeBoundedFields(bounds).map((field) => runtimeNumberField(field, bounds[field], settings[field])).join('')}
    </div>
    ${effectiveFacts}
    <div class="ops-channel-actions runtime-actions">
      <button type="button" data-runtime-save>Зберегти</button>
      <button type="button" data-runtime-minimums>Мінімальні затримки</button>
      <output id="runtime-status"></output>
    </div>
    <output id="analytics-recalculate-status"></output>
    <p class="legend-note">Модель і доступні аналітичні функції — у картці «Codex-аналітика» нижче.</p>
    <div class="ops-channel-list">${(data.audit ?? []).map(runtimeAuditRow).join('')}</div>
    <details class="safety-note ops-fold">
      <summary><strong>Затримка не стосується Telegram-сповіщень.</strong></summary>
      <p>${escapeHtml(data.notice ?? '')}</p>
    </details>
  </section>`;
}

const RECOMPUTE_SKIP_TEXT = {
  overlap: 'Перерахунок уже виконується.',
  disabled: 'Подієве оновлення вимкнено.',
  cooldown: 'Попередній перерахунок був щойно. Спробуйте за хвилину.'
};
const RECOMPUTE_CODEX_TEXT = {
  used: 'модель оновила текст',
  cooldown: 'інтервал ще не минув',
  disabled: 'вимкнено',
  failed: 'модель недоступна, текст детермінований'
};

function wireRuntimeSection(root, onSaved) {
  const section = $('#runtime-section', root);
  if (!section) return;
  // Секція має стабільний id саме заради цього: перемалювати можна тільки її, і тоді обробники
  // треба навісити наново — рекурсивно, тим самим викликом.
  const rerender = async () => {
    const data = await opsFetch('/ops/api/runtime').then((result) => result.ok ? result.json() : null).catch(() => null);
    const current = $('#runtime-section', root);
    if (!current) return;
    current.outerHTML = opsRuntimeSection(data);
    wireRuntimeSection(root, onSaved);
  };
  const refresh = onSaved ?? rerender;

  // Натискна межа. Одна делегація на секцію, а не по слухачу на кнопку: поля будуються з того,
  // що прислав сервер, і їхня кількість тут наперед невідома.
  section.addEventListener('click', (event) => {
    const button = event.target.closest('[data-runtime-bound]');
    if (!button || !section.contains(button)) return;
    const input = $(`[data-runtime-field="${button.dataset.runtimeFor}"]`, section);
    if (!input) return;
    input.value = button.dataset.runtimeBound === 'max' ? input.max : input.min;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  });

  // Помилка гасне на першому ж дотику до поля: підсвічений рядок, який лишається підсвіченим
  // після виправлення, вчить не довіряти підсвічуванню взагалі.
  section.addEventListener('input', (event) => {
    const row = event.target.closest?.('[data-runtime-row]');
    if (!row) return;
    row.classList.remove('is-invalid');
    row.querySelector('input')?.removeAttribute('aria-invalid');
    const output = row.querySelector('[data-runtime-error]');
    if (output) { output.textContent = ''; output.hidden = true; }
  });

  // «Усі затримки на мінімум» — той самий намір, з якого почалася скарга, тільки виконуваний
  // одним натисканням і завжди в межах: мінімум кожного поля береться з його ж діапазону, а
  // перехресне правило «максимум ≥ пауза» на мінімумах виконується завжди.
  $('[data-runtime-minimums]', section)?.addEventListener('click', () => {
    const status = $('#runtime-status', section);
    const fields = [...section.querySelectorAll('input[type="number"][data-runtime-field]')];
    fields.forEach((input) => { input.value = input.min; });
    showRuntimeFieldErrors(section, []);
    status.textContent = fields.length
      ? `Підставлено мінімальні межі для ${fields.length} ${pluralUk(fields.length, 'поля', 'полів', 'полів')}. Натисніть «Зберегти».`
      : 'Числових полів у формі немає.';
  });

  $('[data-runtime-save]', section)?.addEventListener('click', async () => {
    const status = $('#runtime-status', section);
    const local = validateRuntimeForm(section);
    if (local.length) {
      showRuntimeFieldErrors(section, local);
      status.textContent = `Не надіслано: ${local.length} ${pluralUk(local.length, 'поле', 'поля', 'полів')} поза межами. Виправте позначене.`;
      return;
    }
    showRuntimeFieldErrors(section, []);
    const body = { publicationMode: $('[data-runtime-mode]', section)?.value };
    section.querySelectorAll('[data-runtime-field]').forEach((input) => {
      body[input.dataset.runtimeField] = input.type === 'checkbox' ? input.checked : Number(input.value);
    });
    status.textContent = 'Зберігаємо…';
    const result = await opsFetch('/ops/api/runtime', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).catch(() => null);
    if (!result) { status.textContent = 'Сервер недоступний. Нічого не збережено.'; return; }
    if (!result.ok) {
      // 400 несе `issues: ['analyticsMaxDelayMs']` — імена полів, а не текст. Малюємо їх біля
      // самих полів: узагальнене «Не вдалося зберегти.» лишається рівно на той випадок, коли
      // сервер справді не назвав нічого, і навіть тоді воно каже код відповіді.
      const payload = await result.json().catch(() => null);
      const issues = Array.isArray(payload?.issues) ? payload.issues : [];
      const orphans = showRuntimeFieldErrors(section, issues.map((field) => ({
        field, message: runtimeIssueMessage(section, field)
      })));
      status.textContent = issues.length
        ? `Сервер відхилив ${issues.length} ${pluralUk(issues.length, 'поле', 'поля', 'полів')}.`
          + (orphans.length ? ` Поза формою: ${orphans.map((problem) => problem.field).join(', ')}.` : ' Виправте позначене.')
        : `Не вдалося зберегти (HTTP ${result.status}). Сервер не назвав жодного поля.`;
      return;
    }
    status.textContent = 'Збережено.';
    // Повний перемалюнок: режим змінює підказки й в інших картках, тож показувати новий стан лише
    // в одному місці означало б показати два різні стани поруч.
    await refresh();
  });

  $('[data-analytics-recalculate]', section)?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const output = $('#analytics-recalculate-status', section);
    button.disabled = true; button.textContent = 'Рахуємо…';
    try {
      const result = await opsFetch('/ops/api/analytics/recalculate', { method: 'POST' });
      const payload = result.ok ? await result.json().catch(() => null) : null;
      if (!payload) { output.textContent = 'Не вдалося оновити.'; return; }
      output.textContent = payload.skipped
        ? (RECOMPUTE_SKIP_TEXT[payload.skipped] ?? 'Не вдалося оновити.')
        : `Оновлено о ${shortTime(payload.recomputedAt)} · Codex: ${RECOMPUTE_CODEX_TEXT[payload.codex] ?? payload.codex}`;
    } catch {
      output.textContent = 'Не вдалося оновити.';
    } finally {
      button.disabled = false; button.textContent = 'Оновити зараз';
    }
  });
}

// ------------------------------------------------------------------------------------------------
// Кероване оновлення з /ops
// ------------------------------------------------------------------------------------------------
//
// Картка мусить лишатися чесною в момент, коли вона сама зникає: оновлення перезбирає й перезапускає
// той самий контейнер, який її віддає. Тому все, що вона показує, приходить із журналу в базі —
// PostgreSQL сценарій оновлення свідомо не перезапускає, — а зірваний опит поруч із активним запуском
// читається як «застосунок перезапускається», а не як «щось зламалося».
//
// Підтвердження — у два кроки й без діалогу. Модальне вікно ставить питання «ви впевнені?», на яке
// чесна відповідь завжди «так», і тому воно нічого не перевіряє. Друге натискання на кнопку, яка
// відкрито називає СЕМИЗНАЧНИЙ commit, перевіряє рівно те, що треба: що оператор бачив, що саме
// поїде на сервер.

const DEPLOY_STAGES = ['queued', 'checking', 'building', 'migrating', 'starting', 'waiting_ready'];
const DEPLOY_STAGE_NAMES = {
  queued: 'у черзі', checking: 'перевірка', building: 'збірка',
  migrating: 'міграції', starting: 'запуск', waiting_ready: 'готовність'
};
const DEPLOY_ERROR_TEXT = {
  remote_mismatch: 'origin робочого дерева не збігається з налаштованим репозиторієм',
  working_tree_dirty: 'у робочому дереві на хості є незбережені зміни',
  fetch_failed: 'не вдалося прочитати origin/main',
  commit_moved: 'origin/main зрушив між показом і підтвердженням',
  checkout_failed: 'не вдалося перемкнути робоче дерево на цільовий commit',
  build_failed: 'збірка образу завершилася помилкою',
  migration_failed: 'міграції з цільового образу не застосувалися — старий застосунок працює далі',
  start_failed: 'docker compose up завершився помилкою',
  ready_timeout: 'новий застосунок не відповів на /health/ready за відведений час',
  ready_commit_mismatch: '/health/ready відповідає з іншого commit — контейнер не перестворився',
  runner_lost: 'процес оновлення зник; запуск закрито як невдалий',
  journal_unavailable: 'журнал оновлень недоступний',
  internal_error: 'внутрішня помилка процесу оновлення'
};
const DEPLOY_STATUS_NAMES = { succeeded: 'успішно', failed: 'невдало' };

function shortCommit(value) {
  return value ? String(value).slice(0, 7) : '—';
}

function deployMoment(value) {
  return value ? new Date(value).toLocaleString('uk-UA') : '—';
}

// Тривалість словами, без секунд там, де вони нічого не додають: збірка міряється хвилинами.
function deployDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '—';
  const seconds = Math.max(0, Math.round(Number(ms) / 1000));
  if (seconds < 90) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} хв ${seconds - minutes * 60} с`;
}

// Тон — не прикраса, як і в решті ops-консолі: синхронізований стан лишається беззвучним, бо жодної
// дії не вимагає, і саме тому доступне оновлення чи розбіжність помітні.
function deployPill(data) {
  if (!data.enabled) return { label: 'вимкнено', tone: 'off' };
  if (!data.runner?.reachable) return { label: 'Runner недоступний', tone: 'warn' };
  if (data.current) return { label: 'оновлення триває', tone: 'warn' };
  if (data.commitState === 'in_sync') return { label: 'Синхронізовано', tone: 'ok' };
  if (data.commitState === 'behind') return { label: 'Доступне оновлення', tone: 'warn' };
  if (data.commitState === 'drifted') return { label: 'Розбіжність', tone: 'warn' };
  return { label: 'стан невідомий', tone: 'off' };
}

function deployStageStrip(run) {
  const current = DEPLOY_STAGES.indexOf(run.currentStage ?? run.status);
  const cells = DEPLOY_STAGES.map((stage, index) => {
    const state = index < current ? ' is-done' : index === current ? ' is-current' : '';
    return `<li class="deploy-stage${state}">${escapeHtml(DEPLOY_STAGE_NAMES[stage])}</li>`;
  }).join('');
  const started = Date.parse(run.startedAt ?? run.requestedAt);
  const elapsed = Number.isFinite(started) ? deployDuration(Date.now() - started) : '—';
  return `<ol class="deploy-stages">${cells}</ol>
    <p class="legend-note">Триває ${escapeHtml(elapsed)} · ${escapeHtml(shortCommit(run.fromCommit))} → ${escapeHtml(shortCommit(run.toCommit ?? run.expectedCommit))} · запустив ${escapeHtml(run.requestedBy ?? '—')}</p>
    <p class="legend-warning" id="deploy-restart-note" hidden>Застосунок перезапускається — оновлення триває. Журнал зберігається в базі і зʼявиться після відновлення.</p>`;
}

function deployRunRow(run) {
  const failed = run.status === 'failed';
  const tone = failed ? 'bad' : run.status === 'succeeded' ? 'ok' : 'warn';
  const label = DEPLOY_STATUS_NAMES[run.status] ?? run.status;
  const migrations = (run.migrationsApplied ?? []).length;
  return `<article>
    <div>
      <span>${escapeHtml(deployMoment(run.requestedAt))} · ${escapeHtml(run.requestedBy ?? '—')} · ${escapeHtml(shortCommit(run.fromCommit))} → ${escapeHtml(shortCommit(run.toCommit ?? run.expectedCommit))}</span>
      <h3>${escapeHtml(label)}${failed ? ` — ${escapeHtml(run.currentStage ?? 'невідомий етап')}` : ''}</h3>
      <p>${escapeHtml(deployDuration(run.durationMs))} · міграцій застосовано: ${migrations}${migrations ? ` (${escapeHtml((run.migrationsApplied ?? []).join(', '))})` : ''}</p>
      ${failed ? `<p class="legend-warning">${escapeHtml(run.errorCode ?? 'помилка')}: ${escapeHtml(DEPLOY_ERROR_TEXT[run.errorCode] ?? run.errorSummary ?? 'причину не записано')}</p>` : ''}
      ${failed && run.logTail ? `<details><summary>Журнал команди</summary><pre class="ops-json">${escapeHtml(run.logTail)}</pre></details>` : ''}
    </div>
    <div class="ops-channel-actions"><span class="codex-state is-${tone}">${escapeHtml(label)}</span></div>
  </article>`;
}

function opsDeploySection(data) {
  if (!data) {
    return '<section class="ops-section" id="deploy-section"><header class="ops-section-head"><div><p>Розгортання</p><h2>Оновлення з main</h2></div></header><p class="legend-note">Стан оновлення недоступний.</p></section>';
  }
  const repo = data.repo ?? {};
  const pill = deployPill(data);
  const target = repo.remoteCommit;
  // Кнопку вимкнено рівно тоді, коли натискання не мало б сенсу або не мало б адресата: нема чого
  // оновлювати, нема куди слати, або запуск уже триває.
  const canDeploy = Boolean(data.enabled && data.runner?.reachable && target && !data.current
    && data.commitState !== 'in_sync' && !repo.workingTreeDirty);
  const facts = `<dl class="codex-facts">
      <div><dt>Образ</dt><dd>${escapeHtml(shortCommit(data.app?.commit))}${data.app?.builtAt ? ` · ${escapeHtml(deployMoment(data.app.builtAt))}` : ''}</dd></div>
      <div><dt>Робоче дерево</dt><dd>${escapeHtml(shortCommit(repo.workingTreeCommit))}${repo.workingTreeDirty ? ' · є незбережені зміни' : ''}</dd></div>
      <div><dt>origin/main</dt><dd>${escapeHtml(shortCommit(target))}</dd></div>
      <div><dt>Перевірено</dt><dd>${escapeHtml(deployMoment(repo.lastCheckedAt))}</dd></div>
      <div><dt>Останнє оновлення</dt><dd>${data.history?.length ? `${escapeHtml(DEPLOY_STATUS_NAMES[data.history[0].status] ?? data.history[0].status)} · ${escapeHtml(deployMoment(data.history[0].requestedAt))}` : 'ще не було'}</dd></div>
      <div><dt>Схема</dt><dd>${escapeHtml(String(data.app?.migrations?.newest ?? '—'))}</dd></div>
    </dl>`;
  const notes = [];
  if (!data.enabled) notes.push('Оновлення з панелі вимкнено: <code>DEPLOY_ENABLED=false</code>. Контейнер <code>deployer</code> не потрібен і не запускається.');
  else if (!data.runner?.reachable) notes.push('Процес оновлення не відповідає. Він запускається на хості один раз: <code>docker compose up -d deployer</code>.');
  if (repo.workingTreeDirty) notes.push('У робочому дереві на хості є незбережені зміни. Оновлення їх не чіпає і не почнеться, доки вони там.');
  if (repo.lastCheckOk === false && repo.lastCheckError) notes.push(`Остання перевірка не вдалася: ${escapeHtml(repo.lastCheckError)}`);
  const pending = data.history?.[0]?.pendingManualServices ?? [];
  if (pending.length) {
    notes.push(`Конфігурація цих сервісів змінилася, але оновлення їх свідомо не перезапускає: ${escapeHtml(pending.join(', '))}. На хості: <code>docker compose -p threatlens up -d ${escapeHtml(pending.join(' '))}</code>`);
  }
  return `<section class="ops-section" id="deploy-section">
    <header class="ops-section-head">
      <div><p>Розгортання · гілка ${escapeHtml(data.limits?.ref ?? 'refs/heads/main')}</p><h2>Оновлення з main</h2></div>
      <div class="ops-channel-actions">
        <span class="codex-state is-${pill.tone}">${escapeHtml(pill.label)}</span>
        <button type="button" data-deploy-check${data.enabled ? '' : ' disabled'}>Перевірити</button>
        <button type="button" data-deploy-run data-commit="${escapeHtml(target ?? '')}"${canDeploy ? '' : ' disabled'}>Оновити до ${escapeHtml(shortCommit(target))}</button>
      </div>
    </header>
    ${facts}
    ${notes.map((note) => `<p class="legend-note">${note}</p>`).join('')}
    <output id="deploy-status"></output>
    ${data.current ? deployStageStrip(data.current) : ''}
    <div class="ops-channel-list">${(data.history ?? []).map(deployRunRow).join('')}</div>
    <details class="safety-note ops-fold">
      <summary><strong>Оновлення незворотне</strong></summary>
      <p>Міграції не відкочуються: код їде вперед, схема — лише вперед. Повернення коду — ручна дія на хості (<code>git checkout &lt;commit&gt;</code> і повторна збірка), і вона не скасовує вже застосованих міграцій. Перезапускаються тільки <code>${escapeHtml((data.limits?.services ?? ['app', 'caddy']).join('</code>, <code>'))}</code>; <code>${escapeHtml((data.limits?.manualServices ?? ['postgres', 'backup', 'deployer']).join('</code>, <code>'))}</code> лишаються на місці й оновлюються руками.</p>
    </details>
  </section>`;
}

function wireDeploySection(root) {
  clearInterval(deployPollTimer);
  const section = $('#deploy-section', root);
  if (!section) return;
  const status = $('#deploy-status', section);

  const repaint = (data) => {
    lastDeployData = data;
    const current = $('#deploy-section', root);
    if (!current) return;
    current.outerHTML = opsDeploySection(data);
    wireDeploySection(root);
  };

  const load = () => opsFetch('/ops/api/deploy')
    .then((result) => result.ok ? result.json() : null)
    .catch(() => null);

  $('[data-deploy-check]', section)?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true; button.textContent = 'Перевіряємо…';
    const result = await opsFetch('/ops/api/deploy/check', { method: 'POST' }).catch(() => null);
    if (!result?.ok) {
      const payload = await result?.json().catch(() => null);
      status.textContent = payload?.error === 'runner_unreachable'
        ? 'Процес оновлення не відповідає.'
        : 'Не вдалося перевірити origin/main.';
      button.disabled = false; button.textContent = 'Перевірити';
      return;
    }
    repaint(await load());
  });

  // Два кроки на одній кнопці. Перше натискання лише перейменовує її, називаючи commit; друге —
  // надсилає. Через десять секунд кнопка сама повертається до першого стану, щоб «озброєна» кнопка
  // не чекала випадкового кліку хвилинами.
  $('[data-deploy-run]', section)?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const commit = button.dataset.commit;
    if (!commit) return;
    if (button.dataset.armed !== 'true') {
      button.dataset.armed = 'true';
      button.textContent = `Підтвердити оновлення до ${shortCommit(commit)}`;
      setTimeout(() => {
        if (!button.isConnected || button.dataset.armed !== 'true') return;
        button.dataset.armed = 'false';
        button.textContent = `Оновити до ${shortCommit(commit)}`;
      }, 10_000);
      return;
    }
    button.dataset.armed = 'false';
    button.disabled = true; button.textContent = 'Запускаємо…';
    const result = await opsFetch('/ops/api/deploy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, expectedRemoteCommit: commit })
    }).catch(() => null);
    const payload = await result?.json().catch(() => null);
    if (result?.status === 202) status.textContent = `Оновлення запущено (запуск №${payload?.runId ?? '?'}).`;
    else if (result?.status === 409) status.textContent = 'Оновлення вже триває.';
    else if (result?.status === 429) status.textContent = `Занадто часто. Спробуйте за ${payload?.retryAfterSeconds ?? 60} с.`;
    else if (result?.status === 502) status.textContent = 'Процес оновлення не відповідає.';
    else status.textContent = 'Не вдалося запустити оновлення.';
    repaint(await load());
  });

  deployPollTimer = setInterval(async () => {
    const armed = $('[data-deploy-run]', root)?.dataset.armed === 'true';
    const data = await load();
    if (!data) {
      // Опит зірвався. Якщо востаннє ми бачили активний запуск — це не збій, це і є оновлення:
      // сервер, який відповідав на цей запит, зараз перестворюється.
      const note = $('#deploy-restart-note', root);
      if (note && lastDeployData?.current) note.hidden = false;
      return;
    }
    if (armed) { lastDeployData = data; return; }
    // Перемальовуємо лише тоді, коли щось справді змінилося: картка з розгорнутим журналом не має
    // згортатися кожні три секунди.
    const signature = JSON.stringify([
      data.commitState, data.enabled, data.runner?.reachable, data.repo?.remoteCommit,
      data.repo?.lastCheckedAt, data.current?.id, data.current?.status, data.history?.[0]?.id,
      data.history?.[0]?.status
    ]);
    const previous = JSON.stringify([
      lastDeployData?.commitState, lastDeployData?.enabled, lastDeployData?.runner?.reachable,
      lastDeployData?.repo?.remoteCommit, lastDeployData?.repo?.lastCheckedAt,
      lastDeployData?.current?.id, lastDeployData?.current?.status,
      lastDeployData?.history?.[0]?.id, lastDeployData?.history?.[0]?.status
    ]);
    if (signature === previous) { lastDeployData = data; return; }
    repaint(data);
  }, 3000);
}

// ------------------------------------------------------------------------------------------------
// Дозбір повідомлень після простою
// ------------------------------------------------------------------------------------------------
//
// Тільки читання: ручного запуску тут немає навмисно. Дозбір, викликаний натисканням, — це сплеск
// історичних запитів у той момент, коли оператор найбільше нервує, а Telegram найменше схильний
// пробачати; сканування саме перевіряє розрив кожні кілька хвилин.
//
// «Обмежено» — не помилка. Вікно має межі за віком, кількістю і сторінками, і джерело, яке в них
// уперлося, дозбиралося успішно рівно настільки, наскільки йому дозволено.

const BACKFILL_STATUS = {
  ok: { label: 'дозбір виконано', tone: 'ok' },
  truncated: { label: 'дозбір обмежено', tone: 'warn' },
  skipped_small_gap: { label: 'розрив малий', tone: 'off' },
  skipped_recent: { label: 'перевірено нещодавно', tone: 'off' },
  skipped_disabled: { label: 'вимкнено', tone: 'off' },
  no_cursor: { label: 'архів порожній', tone: 'off' },
  failed: { label: 'помилка', tone: 'bad' }
};
const BACKFILL_TRUNCATED = { age: 'віком', count: 'кількістю', pages: 'сторінками' };

function backfillGap(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return '—';
  const value = Math.max(0, Math.round(Number(seconds)));
  if (value < 90) return `${value} с`;
  if (value < 5400) return `${Math.round(value / 60)} хв`;
  return `${(value / 3600).toFixed(1)} год`;
}

function backfillRow(source) {
  const state = BACKFILL_STATUS[source.lastRunStatus] ?? { label: 'ще не перевірялося', tone: 'off' };
  const truncated = source.lastRunStatus === 'truncated' && source.truncatedReason
    ? ` ${escapeHtml(BACKFILL_TRUNCATED[source.truncatedReason] ?? source.truncatedReason)}`
    : '';
  return `<article>
    <div>
      <span>${escapeHtml(source.sourceId ?? '')} · розрив ${escapeHtml(backfillGap(source.gapSeconds))}</span>
      <h3>${escapeHtml(source.name ?? source.sourceId ?? '—')}</h3>
      <p>курсор ${escapeHtml(deployMoment(source.cursorPublishedAt))} · перевірено ${escapeHtml(deployMoment(source.lastCheckedAt))}</p>
      <p>прочитано ${escapeHtml(String(source.messagesRead ?? 0))} · застосовано ${escapeHtml(String(source.messagesReplayed ?? 0))} · застарілих ${escapeHtml(String(source.messagesStale ?? 0))} · сторінок ${escapeHtml(String(source.pagesRead ?? 0))}</p>
      ${source.lastError ? `<p class="legend-warning">${escapeHtml(source.lastError)}</p>` : ''}
    </div>
    <div class="ops-channel-actions"><span class="codex-state is-${state.tone}">${escapeHtml(state.label)}${truncated}</span></div>
  </article>`;
}

function opsBackfillSection(data) {
  if (!data) {
    return '<section class="ops-section" id="backfill-section"><header class="ops-section-head"><div><p>Збір</p><h2>Дозбір після простою</h2></div></header><p class="legend-note">Стан дозбору недоступний.</p></section>';
  }
  const thresholds = data.thresholds ?? {};
  const sources = [...(data.sources ?? [])]
    .sort((left, right) => Number(right.gapSeconds ?? 0) - Number(left.gapSeconds ?? 0));
  const failing = sources.filter((source) => source.lastRunStatus === 'failed').length;
  const pill = failing
    ? { label: `помилок: ${failing}`, tone: 'bad' }
    : data.sweep?.running ? { label: 'сканування триває', tone: 'warn' } : { label: 'у нормі', tone: 'off' };
  return `<section class="ops-section" id="backfill-section">
    <header class="ops-section-head">
      <div><p>Збір · класифікаційні Telegram-джерела</p><h2>Дозбір після простою</h2></div>
      <span class="codex-state is-${pill.tone}">${escapeHtml(pill.label)}</span>
    </header>
    <dl class="codex-facts">
      <div><dt>Поріг розриву</dt><dd>${escapeHtml(backfillGap(thresholds.minGapSeconds ?? 3600))}</dd></div>
      <div><dt>Вікно</dt><dd>${escapeHtml(backfillGap(thresholds.maxAgeSeconds ?? 21600))}</dd></div>
      <div><dt>Ліміт повідомлень</dt><dd>${escapeHtml(String(thresholds.maxMessages ?? 300))}</dd></div>
      <div><dt>Ліміт сторінок</dt><dd>${escapeHtml(String(thresholds.maxPages ?? 5))}</dd></div>
      <div><dt>Останнє сканування</dt><dd>${escapeHtml(deployMoment(data.sweep?.lastAt))}</dd></div>
      <div><dt>Джерел у списку</dt><dd>${sources.length}</dd></div>
    </dl>
    <p class="legend-note">${escapeHtml(data.notice ?? 'Офіційні alert-канали дозбираються окремим контуром і сюди не входять.')}</p>
    <div class="ops-channel-list">${sources.map(backfillRow).join('')}</div>
  </section>`;
}

// ------------------------------------------------------------------------------------------------
// Покриття по областях
// ------------------------------------------------------------------------------------------------
//
// Відомість, яка відповідає на питання «з яких областей до нас узагалі щось надходить». Двадцять
// сім рядків — стільки ж, скільки областей; жоден не зникає через те, що в ньому нуль, бо саме
// нуль і є знахідкою.
//
// Головне, що мусить бути видно з самої картки: покриття тут ВИВЕДЕНЕ зі спостереженої поведінки,
// а не оголошене в схемі — таблиці «джерело обслуговує область» не існує (див. коментар у
// src/api/ops-coverage-routes.ts). Тому текст застереження приходить із сервера разом із числами,
// а не лежить у документації: число, походження якого невидиме, — це число, якому довіряють не з
// тієї причини.
//
// Колір у цій таблиці підпорядковується тій самій домовленості, що й карта: червоне означає
// офіційну тривогу, помаранчеве — загрозу, жовте — прогалину, яка вимагає дії («жодного активного
// каналу»). Потік повідомлень кольору не має взагалі — його кодує довжина смуги, бо обсяг трафіку
// не є небезпекою.

const COVERAGE_COLUMNS = [
  ['sources', 'Канали', 'Активних джерел, які за вікно спостереження поставили в область повідомлення або тримають у ній стан тривоги. Через дріб — вимкнені.'],
  ['messages', 'Повідомлень / год', 'Класифікованих повідомлень за останню годину. Повідомлення, яке назвало кілька міст однієї області, рахується один раз.'],
  ['alerts', 'Тривога', 'Активних періодів офіційної тривоги в області просто зараз.'],
  ['threats', 'Загрози', 'Живих подій загроз, привʼязаних до області (останні 12 годин).']
];
const COVERAGE_WINDOWS = [1, 3, 7, 14, 30];

function coverageRow(row, peak) {
  const uncovered = row.sourcesEnabled === 0;
  const national = row.kind === 'country';
  // Смуга росте від правого краю, під самим числом: колонка вирівняна праворуч, і смуга, що
  // росла б ліворуч, відірвалася б від величини, яку кодує.
  const heat = peak > 0 ? Math.round((row.messagesLastHour / peak) * 100) : 0;
  const seen = row.lastMessageAt
    ? `остання згадка ${timeAgo(row.lastMessageAt)} · за вікно ${row.messagesWindow}`
    : 'за вікно спостереження жодного повідомлення';
  return `<tr class="coverage-row${uncovered ? ' is-uncovered' : ''}${national ? ' is-national' : ''}"
      data-coverage-row data-name="${escapeHtml(row.name.toLowerCase())}"
      data-sort-name="${escapeHtml(row.name)}"
      data-sort-sources="${row.sourcesEnabled}" data-sort-messages="${row.messagesLastHour}"
      data-sort-alerts="${row.activeAlerts}" data-sort-threats="${row.activeThreats}">
    <th scope="row" class="coverage-name">
      <span class="coverage-oblast">${escapeHtml(row.name)}</span>
      <span class="coverage-id">${escapeHtml(row.locationId)}</span>
    </th>
    <td class="td-num coverage-sources" data-label="Канали">
      <b>${row.sourcesEnabled}</b><span class="coverage-off" title="вимкнених джерел із покриттям">/${row.sourcesDisabled}</span>
    </td>
    <td class="td-num coverage-flow" data-label="Повідомлень / год" style="--heat:${heat}%" title="${escapeHtml(seen)}">${row.messagesLastHour}</td>
    <td class="td-num coverage-alerts" data-label="Тривога">${row.activeAlerts ? `<b>${row.activeAlerts}</b>` : '<span class="coverage-nil">—</span>'}</td>
    <td class="td-num coverage-threats" data-label="Загрози">${row.activeThreats ? `<b>${row.activeThreats}</b>` : '<span class="coverage-nil">—</span>'}</td>
  </tr>`;
}

function opsCoverageSection(data) {
  if (!data) {
    return '<section class="ops-section" id="coverage-section"><header class="ops-section-head"><div><p>Області</p><h2>Покриття по областях</h2></div></header><p class="legend-note">Зведення по областях недоступне.</p></section>';
  }
  const rows = data.rows ?? [];
  const totals = data.totals ?? {};
  // Шкала смуги міряється лише областями. «Загальнодержавні» — не область, а решта scope, і його
  // трафік регулярно найбільший: узяти його за сто відсотків означало б розчавити всі двадцять сім
  // смуг заради рядка, який із ними не змагається. Смуги в нього немає й на рівні CSS.
  const peak = rows.reduce((max, row) => row.kind === 'country'
    ? max : Math.max(max, Number(row.messagesLastHour ?? 0)), 0);
  const [sortKey, sortDirection] = coverageSort.split('-');
  const head = COVERAGE_COLUMNS.map(([key, label, hint]) => `<th scope="col" class="th-num"
      ${sortKey === key ? `aria-sort="${sortDirection === 'desc' ? 'descending' : 'ascending'}"` : 'aria-sort="none"'}>
      <button type="button" data-coverage-sort="${key}" title="${escapeHtml(hint)}">${escapeHtml(label)}</button>
    </th>`).join('');
  const windowOptions = COVERAGE_WINDOWS
    .map((days) => `<option value="${days}"${Number(data.windowDays) === days ? ' selected' : ''}>вікно ${days} дн.</option>`)
    .join('');
  return `<section class="ops-section" id="coverage-section">
    <header class="ops-section-head">
      <div><p>Області · ${escapeHtml(String(totals.regions ?? rows.length))} рядків</p><h2>Покриття по областях</h2></div>
      <div class="ops-channel-actions">
        <span class="codex-state${totals.uncovered ? ' is-warn' : ''}">${totals.uncovered ? `${totals.uncovered} без каналів` : 'усі області покрито'}</span>
        <select data-coverage-window aria-label="Вікно спостереження">${windowOptions}</select>
        <button type="button" data-coverage-refresh>Оновити</button>
      </div>
    </header>
    <details class="safety-note ops-fold">
      <summary><strong>Покриття виведене, а не оголошене</strong></summary>
      <p>${escapeHtml(data.notice ?? '')}</p>
    </details>
    <div class="coverage-table-wrap">
      <table class="coverage-table">
        <thead><tr>
          <th scope="col" class="th-name">
            <button type="button" data-coverage-sort="name" title="За назвою області">Область</button>
          </th>
          ${head}
        </tr></thead>
        <tbody data-coverage-body>${rows.map((row) => coverageRow(row, peak)).join('')}</tbody>
      </table>
    </div>
    <p class="legend-note">${escapeHtml(String(totals.messagesLastHour ?? 0))} ${pluralUk(Number(totals.messagesLastHour ?? 0), 'повідомлення', 'повідомлення', 'повідомлень')} за годину · ${escapeHtml(String(totals.activeAlerts ?? 0))} ${pluralUk(Number(totals.activeAlerts ?? 0), 'область під тривогою', 'області під тривогою', 'областей під тривогою')} · ${escapeHtml(String(totals.activeThreats ?? 0))} ${pluralUk(Number(totals.activeThreats ?? 0), 'жива загроза', 'живі загрози', 'живих загроз')} · зріз ${escapeHtml(deployMoment(data.generatedAt))}</p>
  </section>`;
}

/**
 * Порядок — по DOM, як у відомості довіри.
 *
 * Перемальовувати секцію заради сортування означало б заново тягнути запит, який рахує чотири
 * агрегати по всій базі, щоб переставити двадцять сім рядків, які вже тут лежать.
 */
function applyCoverageView(section) {
  const [key, direction] = coverageSort.split('-');
  const body = $('[data-coverage-body]', section);
  if (!body) return;
  const attribute = `sort${key[0].toUpperCase()}${key.slice(1)}`;
  const rows = [...body.querySelectorAll('[data-coverage-row]')];
  rows.sort((left, right) => {
    if (key === 'name') {
      const compared = String(left.dataset.sortName ?? '').localeCompare(String(right.dataset.sortName ?? ''), 'uk');
      return direction === 'desc' ? -compared : compared;
    }
    const a = Number(left.dataset[attribute] ?? 0);
    const b = Number(right.dataset[attribute] ?? 0);
    // Рівні числа не мають права переставлятися випадково: за однакового трафіку рядки лишаються
    // в алфавітному порядку, інакше кожне сортування давало б іншу таблицю з тих самих даних.
    if (a === b) return String(left.dataset.sortName ?? '').localeCompare(String(right.dataset.sortName ?? ''), 'uk');
    return direction === 'desc' ? b - a : a - b;
  });
  rows.forEach((row) => body.append(row));
  section.querySelectorAll('[data-coverage-sort]').forEach((button) => {
    const active = button.dataset.coverageSort === key;
    button.closest('th')?.setAttribute('aria-sort', active ? (direction === 'desc' ? 'descending' : 'ascending') : 'none');
    button.classList.toggle('is-sorted', active);
  });
}

function wireCoverageSection(root) {
  const section = $('#coverage-section', root);
  if (!section) return;
  applyCoverageView(section);

  const rerender = async () => {
    const data = await opsFetch(`/ops/api/coverage?windowDays=${coverageWindowDays}`)
      .then((result) => result.ok ? result.json() : null).catch(() => null);
    const current = $('#coverage-section', root);
    if (!current) return;
    current.outerHTML = opsCoverageSection(data);
    wireCoverageSection(root);
  };

  // Одна делегація на секцію: заголовків стільки, скільки колонок, і кожен із них — кнопка.
  section.addEventListener('click', (event) => {
    const button = event.target.closest('[data-coverage-sort]');
    if (!button || !section.contains(button)) return;
    const key = button.dataset.coverageSort;
    const [currentKey, currentDirection] = coverageSort.split('-');
    // Назва починається за зростанням, числа — за спаданням: «найбільше зверху» — це те, заради
    // чого числову колонку взагалі натискають.
    const next = key === currentKey
      ? (currentDirection === 'desc' ? 'asc' : 'desc')
      : (key === 'name' ? 'asc' : 'desc');
    coverageSort = `${key}-${next}`;
    applyCoverageView(section);
  });

  $('[data-coverage-window]', section)?.addEventListener('change', (event) => {
    coverageWindowDays = Number(event.currentTarget.value) || 7;
    void rerender();
  });
  $('[data-coverage-refresh]', section)?.addEventListener('click', () => void rerender());
}

// Смуга показників. Шість фішок в один рядок замість чотирьох карток заввишки в сто пікселів:
// консоль починається з відповіді на «чи все живе», а не з чотирьох цифр кеглем 32.
function opsKpiChip(label, value, tone = '', hint = '') {
  return `<article class="ops-kpi${tone ? ` is-${tone}` : ''}"${hint ? ` title="${escapeHtml(hint)}"` : ''}>
    <span>${escapeHtml(label)}</span><strong>${value}</strong>
  </article>`;
}

function opsKpiStrip(data, runtime, deploy) {
  const queued = data.outbox.reduce((sum, item) => sum + Number(item.count), 0);
  const mode = runtime?.settings?.publicationMode;
  const delaySeconds = runtime?.effective?.delaySeconds ?? 0;
  const pill = deploy ? deployPill(deploy) : { label: 'невідомо', tone: 'off' };
  const behind = Number(runtime?.effective?.behindSeconds ?? 0);
  // Скільки секунд минуло від часу, який назвало джерело, до нашого запису — на останній тривозі.
  // Значення живе в памʼяті процесу і зʼявляється лише тоді, коли тривога справді почалася, тож
  // поруч завжди стоїть вік вимірювання: число без нього виглядало б як «зараз», хоча може бути
  // з минулої ночі. Порожньо — це чесно, а не помилка.
  const propagation = runtime?.propagation ?? null;
  const propagationAge = propagation ? Math.max(0, Math.round((Date.now() - Date.parse(propagation.at)) / 60000)) : 0;
  return `<div class="ops-kpis">
    ${opsKpiChip('Джерела', data.sources.length, '', 'Джерел у каталозі')}
    ${opsKpiChip('Черга', queued, queued ? 'warn' : '', 'Повідомлень в outbox')}
    ${opsKpiChip('Канали', data.channels.filter((item) => item.active).length, '', 'Активних у каталозі рекомендованих')}
    ${opsKpiChip('PostgreSQL', escapeHtml(data.database.size), '', 'Розмір бази')}
    ${opsKpiChip('Розгортання', escapeHtml(pill.label), pill.tone === 'ok' ? '' : pill.tone, 'Стан оновлення з main')}
    ${opsKpiChip('Показ', mode === 'delayed_15s' ? `+${delaySeconds} с` : 'наживо', mode === 'delayed_15s' ? 'warn' : '', behind ? `Відставання ${behind} с` : 'Режим публікації')}
    ${opsKpiChip(
    'Затримка тривоги',
    propagation ? `${escapeHtml(propagation.seconds.toFixed(1))} с` : '—',
    propagation && propagation.seconds >= 20 ? 'warn' : '',
    propagation
      ? `Остання тривога: ${propagation.seconds.toFixed(1)} с від часу джерела до нашого запису · ${escapeHtml(propagation.source)} · ${propagationAge} хв тому`
      : 'Від часу, який назвало джерело, до нашого запису. Порожньо, доки не почалася жодна тривога після запуску'
  )}
  </div>`;
}

/**
 * Форма входу оператора, спільна для обох маршрутів консолі.
 *
 * Перевірка йде на `probe` — той самий маршрут, який щойно відповів 401, а не завжди `/ops/api`:
 * інакше сторінка налаштувань підтверджувала б пароль запитом до сусіднього ендпоінта й малювала
 * власний 401 одразу після успішного входу.
 */
function opsLoginForm(root, probe, retry) {
  opsAuthorization = '';
  root.innerHTML = `<form class="ops-login"><span>AUTH / BASIC</span><h2>Вхід оператора</h2><p>Облікові дані залишаються лише в памʼяті цієї вкладки.</p><label>Користувач<input required name="username" autocomplete="username" value="operator"></label><label>Пароль<input required name="password" type="password" autocomplete="current-password"></label><button>Увійти</button><output></output></form>`;
  $('.ops-login', root).addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    opsAuthorization = basicAuthorization(values.get('username'), values.get('password'));
    const check = await opsFetch(probe).catch(() => null);
    if (check?.ok) return void retry();
    opsAuthorization = ''; $('output', form).textContent = 'Неправильний логін або пароль.';
  });
}

async function renderOps() {
  clearInterval(codexPollTimer);
  clearInterval(deployPollTimer);
  const root = contentShell('Закритий контур', 'Операційна консоль', 'Стан системи та керування каталогом рекомендованих Telegram-каналів.');
  const response = await opsFetch('/ops/api');
  if (response.status === 401) {
    opsLoginForm(root, '/ops/api', () => void renderOps());
    return;
  }
  if (!response.ok) { root.innerHTML = '<p>Операційна консоль тимчасово недоступна.</p>'; return; }
  const data = await response.json();
  // Екстраполяція живе тільки тут. Запит іде на окремий ендпоінт за тим самим Basic-логіном; жоден
  // публічний маршрут її не віддає, і жоден інший екран цієї функції не викликає.
  // Стан входу приходить у складі налаштувань, а не окремим запитом: перемикач «увімкнено» поруч
  // із мертвою сесією — найзаплутаніший стан цієї функції, і показати їх із двох різних моментів
  // означало б зробити його ще заплутанішим.
  const [vectorOps, codexSettings, aiRuns, shadow, sourceTrust, runtime, deploy, backfill, coverage] = await Promise.all([
    opsFetch('/ops/vectors').then((result) => result.ok ? result.json() : null).catch(() => null),
    opsFetch('/ops/codex/settings').then((result) => result.ok ? result.json() : null).catch(() => null),
    opsFetch(aiRunsUrl()).then((result) => result.ok ? result.json() : null).catch(() => null),
    opsFetch('/ops/shadow-classifier?hours=24').then((result) => result.ok ? result.json() : null).catch(() => null),
    opsFetch('/ops/api/source-trust').then((result) => result.ok ? result.json() : null).catch(() => null),
    opsFetch('/ops/api/runtime').then((result) => result.ok ? result.json() : null).catch(() => null),
    opsFetch('/ops/api/deploy').then((result) => result.ok ? result.json() : null).catch(() => null),
    opsFetch('/ops/api/backfill').then((result) => result.ok ? result.json() : null).catch(() => null),
    opsFetch(`/ops/api/coverage?windowDays=${coverageWindowDays}`).then((result) => result.ok ? result.json() : null).catch(() => null)
  ]);
  lastDeployData = deploy;
  const codex = codexSettings?.status ?? null;
  // Консоль — єдина сторінка, яка НЕ підпорядковується мірі рядка: тут не читають, тут звіряють,
  // і колонка завширшки 1240 px на моніторі 2560 px лишає мертвий правий берег. Клас несе і
  // повну ширину, і всю щільність: за його межами жодне з правил нижче не діє.
  root.classList.add('ops-console');
  root.parentElement?.classList.add('ops-shell');
  // Дві смуги змісту, а не дві колонки сітки: картки цієї консолі мають різну висоту, і рядкова
  // сітка лишала б під кожною коротшою карткою дірку заввишки в її сусідку. Кожна смуга — власний
  // потік, який пакується щільно. Ліворуч сигнал, праворуч обслуговування; на вузькому екрані
  // `display: contents` розпускає обидві в один стовпчик, і жодне правило не дублюється.
  // Другий екран консолі — окремий маршрут, а не ще одна картка тут. Реєстр налаштувань — це
  // вісімдесят полів, і жодне з них не є станом: вони не оновлюються самі, їх не звіряють поглядом,
  // і поруч із живими картками вони отримали б таймер перемалювання, який зносив би форму під
  // пальцем. Посилання стоїть під смугою показників, бо це навігація, а не дія над системою.
  root.innerHTML = `${opsKpiStrip(data, runtime, deploy)}
    <nav class="ops-quicklinks" aria-label="Розділи консолі">
      <a href="/ops/settings" data-route="/ops/settings">Налаштування →</a>
      <span>Реєстр змінних середовища: значення, походження, журнал змін.</span>
    </nav>
    <div class="ops-grid">
    <div class="ops-col ops-col--signal">
    ${opsRuntimeSection(runtime)}
    ${opsCoverageSection(coverage)}
    ${opsSourceTrustSection(sourceTrust)}
    </div>
    <div class="ops-col ops-col--service">
    ${opsDeploySection(deploy)}
    ${opsBackfillSection(backfill)}
    <section class="ops-section" id="channels-section"><header class="ops-section-head"><div><p>Каталог для користувачів</p><h2>Додати Telegram-канал</h2></div><button id="ops-logout">Вийти</button></header>
      <form id="channel-form" class="channel-form">
        <label>Назва<input required name="title" maxlength="120" placeholder="Повітряні Сили ЗС України"></label>
        <label>Username<input required name="username" maxlength="40" placeholder="@channel_name"></label>
        <label>Категорія<select name="category"><option value="official">Офіційний</option><option value="regional">Регіональний</option><option value="monitoring">Моніторинговий</option><option value="analytics">Аналітичний</option></select></label>
        <label>Територія<select name="locationId"><option value="">Уся Україна</option>${locations.filter((item) => item.type !== 'country').map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name_uk)}</option>`).join('')}</select></label>
        <label class="channel-description">Опис<textarea name="description" maxlength="500" placeholder="Чому цей канал рекомендовано"></textarea></label>
        <label>Порядок<input name="sortOrder" type="number" min="0" max="10000" value="100"></label>
        <label class="check-field"><input name="verified" type="checkbox"> Перевірено адміністратором</label>
        <button type="submit">Додати до каталогу</button><output id="channel-form-status"></output>
      </form>
      <div class="ops-channel-list">${data.channels.map((channel) => `<article class="${channel.active ? '' : 'is-disabled'}"><div><span>${channel.verified ? '✓ перевірено' : escapeHtml(channel.category)}</span><h3>${escapeHtml(channel.title)}</h3><p>@${escapeHtml(channel.username)}${channel.location_name ? ` · ${escapeHtml(channel.location_name)}` : ''}</p></div><div class="ops-channel-actions"><a href="${escapeHtml(channel.url)}" target="_blank" rel="noreferrer">Відкрити ↗</a><button data-channel-toggle="verified" data-id="${channel.id}" data-value="${channel.verified}">${channel.verified ? 'Зняти перевірку' : 'Перевірити'}</button><button data-channel-toggle="active" data-id="${channel.id}" data-value="${channel.active}">${channel.active ? 'Приховати' : 'Активувати'}</button></div></article>`).join('')}</div>
    </section>
    </div>
    <div class="ops-col ops-col--full">
    <div class="ops-group" id="codex-group">
      <header class="ops-group-head"><p>Модель в аналітиці</p><h2>Codex-аналітика</h2>
        <p>Вхід, вибір моделі, чотири перемикачі, звірка з правилами й журнал усіх звернень — усе, що визначає, коли систему пише машина, і що саме вона написала.</p></header>
      ${opsCodexSection(codex, codexSettings?.settings ?? null)}
      ${opsCodexSettingsSection(codexSettings)}
      ${opsShadowSection(shadow, codexSettings?.settings ?? null)}
      ${opsAiRunsSection(aiRuns, codex, codexSettings?.settings ?? null)}
    </div>
    ${opsVectorSection(vectorOps)}
    <details class="ops-raw"><summary>Технічний стан і журнали</summary><pre class="ops-json">${escapeHtml(JSON.stringify({ sources: data.sources, outbox: data.outbox, aiRuns: data.aiRuns, database: data.database }, null, 2))}</pre></details>
    </div>
    </div>`;
  wireRuntimeSection(root, () => renderOps());
  // Картка оновлення перемальовує ЛИШЕ себе і має власний таймер: повний renderOps() кожні три
  // секунди скидав би напівзаповнену форму каналу й напівнабраний пароль сусідніх карток.
  wireDeploySection(root);
  wireCodexSection(root, codexSettings?.settings ?? null);
  wireCodexSettingsSection(root, () => renderOps());
  wireShadowSection(root, codexSettings?.settings ?? null);
  wireAiRunsSection(root, codex, codexSettings?.settings ?? null);
  wireSourceTrustSection(root);
  wireCoverageSection(root);
  root.querySelectorAll('[data-project-vector]').forEach((button) => button.addEventListener('click', async () => {
    const output = $(`#projection-${button.dataset.projectVector}`, root);
    output.textContent = 'Рахуємо…';
    const result = await opsFetch(`/ops/threats/${encodeURIComponent(button.dataset.projectVector)}/vector-projection?horizonMinutes=15`, { method: 'POST' });
    const payload = await result.json().catch(() => null);
    if (!result.ok) {
      output.innerHTML = `<p class="legend-note">Розрахунок неможливий: ${escapeHtml(payload?.reason ?? 'невідома причина')}. Це нормальний стан — ланцюг може не мати жодного відрізка з двома координатами й виміряним часом.</p>`;
      return;
    }
    output.innerHTML = opsProjectionHtml(payload);
  }));
  $('#channel-form', root).addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget; const values = Object.fromEntries(new FormData(form));
    const result = await opsFetch('/ops/channels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      title: values.title, username: values.username, description: values.description, category: values.category,
      locationId: values.locationId || null, verified: form.elements.verified.checked, active: true,
      sortOrder: Number(values.sortOrder || 100)
    }) });
    if (result.ok) return void renderOps();
    const error = await result.json().catch(() => ({ error: 'request_failed' }));
    $('#channel-form-status', root).textContent = error.error === 'channel_exists' ? 'Такий канал уже існує.' : 'Не вдалося додати канал.';
  });
  root.querySelectorAll('[data-channel-toggle]').forEach((button) => button.addEventListener('click', async () => {
    const field = button.dataset.channelToggle;
    const result = await opsFetch(`/ops/channels/${button.dataset.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: button.dataset.value !== 'true' }) });
    if (result.ok) void renderOps();
  }));
  $('#ops-logout', root).addEventListener('click', () => { opsAuthorization = ''; void renderOps(); });
}

// ------------------------------------------------------------------------------------------------
// Налаштування застосунку
// ------------------------------------------------------------------------------------------------
//
// Реєстр змінних середовища, який тепер має два джерела: рядок у `app_settings` і сам процес.
// Сторінка існує заради одного питання, на яке досі відповідала лише вправа з `docker compose exec`:
// «яке значення діє ЗАРАЗ і звідки воно взялося». Тому походження тут — не примітка під полем, а
// бейдж поруч зі значенням, і він має рівно три стани: БД, .env, за замовчуванням.
//
// Кольору на сторінці рівно стільки, скільки небезпеки: бурштин на «потребує перезапуску» (діюче
// значення розійшлося зі збереженим) і червоний на відхиленому. Усе інше — графіт і кістка, як
// велить решта системи: налаштування, яке просто збережене, нічого не стверджує про світ.
//
// Секрет ніколи не приходить із сервера — ні в `value`, ні в `envValue`, ні в `defaultValue`. Тому
// поле секрету не «показує приховане», а чесно каже дві речі, які сервер справді надіслав:
// встановлено чи ні, і звідки. Замінити його можна, побачити — ні.

// Куди веде «як отримати →».
//
// РІШЕННЯ, і воно не косметичне: `docs/` НЕ віддається застосунком. `fastifyStatic` змонтовано на
// `public/`, а `/docs/TOKENS.md` не потрапив би навіть у 404 — його зʼїв би setNotFoundHandler і
// віддав index.html, тобто карту замість інструкції. Тому основний шлях — інструкція просто тут,
// у розгортайці біля самого поля: вона працює без мережі, без GitHub і на приватному репозиторії.
// Посилання на blob лишається другим кроком для повного тексту, з датою перевірки.
const TOKENS_DOC_URL = 'https://github.com/IvanSnezhok/threatlens-ua/blob/main/docs/TOKENS.md';

// Порядок і назви груп. Сервер надсилає `groups` — саме він розпорядник складу; ця таблиця лише
// підписує ідентифікатор словом і задає порядок, у якому групи стоять на сторінці.
const APP_SETTING_GROUPS = [
  ['telegram', 'Telegram', 'Колектор, бот і канали, з яких надходить усе живе.'],
  ['official', 'Офіційні джерела', 'Три незалежні постачальники стану тривог і витримки навколо них.'],
  ['publication', 'Публікація', 'Що і коли бачить читач.'],
  ['analytics', 'Аналітика й моделі', 'Детерміновані числа не залежать від жодного з цих ключів — лише проза над ними.'],
  ['map', 'Карта й довідники', 'Підкладка, кодифікатор і довідковий шар окупації.'],
  ['system', 'Система', 'Доступ, розгортання й тотожність образу.']
];
const APP_SETTING_GROUP_NAMES = Object.fromEntries(APP_SETTING_GROUPS.map(([id, name]) => [id, name]));
const APP_SETTING_GROUP_NOTES = Object.fromEntries(APP_SETTING_GROUPS.map(([id, , note]) => [id, note]));

// Підписи ключів. Це САМЕ підписи: склад сторінки будує сервер, а ключ, підпису для якого тут
// немає, малюється власним іменем — незграбно, але видимо. Той самий закон, що й у
// RUNTIME_FIELD_LABELS, і з тієї самої причини: новий ключ у реєстрі мусить зʼявитися на сторінці
// без правки цього файлу.
const APP_SETTING_LABELS = {
  // Telegram
  TELEGRAM_BOT_TOKEN: 'Токен бота',
  TELEGRAM_BOT_USERNAME: 'Username бота',
  TELEGRAM_MODE: 'Режим бота',
  TELEGRAM_ADMIN_CHAT_ID: 'Chat ID адміністратора',
  TELEGRAM_API_ID: 'MTProto api_id',
  TELEGRAM_API_HASH: 'MTProto api_hash',
  TELEGRAM_SESSION: 'Рядок сесії MTProto',
  ALERT_CHANNEL_ENABLED: 'Офіційні alert-канали',
  ALERT_CHANNEL_USERNAME: 'Запасний alert-канал',
  ALERT_CHANNEL_MAX_ALERT_SECONDS: 'Стеля тривалості тривоги з каналу',
  ALERT_CHANNEL_BACKFILL_MESSAGES: 'Дочитування каналу: повідомлень',
  ALERT_CHANNEL_BACKFILL_SECONDS: 'Дочитування каналу: вікно',
  OSINT_MONITOR_ENABLED: 'Моніторингові OSINT-канали',
  OSINT_MONITOR_COALESCE_SECONDS: 'Склеювання повторів моніторингу',
  CLASSIFIER_BACKFILL_ENABLED: 'Дозбір після простою',
  CLASSIFIER_BACKFILL_MIN_GAP_SECONDS: 'Поріг розриву для дозбору',
  CLASSIFIER_BACKFILL_MAX_AGE_SECONDS: 'Глибина дозбору',
  CLASSIFIER_BACKFILL_MAX_MESSAGES: 'Ліміт повідомлень на джерело',
  CLASSIFIER_BACKFILL_MAX_PAGES: 'Ліміт сторінок на джерело',
  CLASSIFIER_BACKFILL_PAGE_SIZE: 'Розмір сторінки історії',
  CLASSIFIER_BACKFILL_MAX_SOURCES_PER_SWEEP: 'Джерел за одне сканування',
  CLASSIFIER_BACKFILL_SOURCE_DELAY_MS: 'Пауза між джерелами',
  CLASSIFIER_BACKFILL_MIN_RERUN_SECONDS: 'Мінімум між повторами джерела',
  CLASSIFIER_BACKFILL_CHECK_INTERVAL_SECONDS: 'Період сканування розривів',
  // Офіційні джерела
  UKRAINE_ALARM_API_TOKEN: 'Токен Ukraine Alarm',
  UKRAINE_ALARM_API_URL: 'Адреса API Ukraine Alarm',
  ALERTS_IN_UA_TOKEN: 'Токен Alerts.in.ua',
  ALERTS_IN_UA_URL: 'Адреса API Alerts.in.ua',
  AERIAL_MIRROR_ENABLED: 'Громадське дзеркало тривог',
  AERIAL_MIRROR_URL: 'Адреса дзеркала',
  AERIAL_MIRROR_STALE_SECONDS: 'Гранична давність кеша дзеркала',
  AERIAL_MIRROR_RAW_SOURCE: 'Наскрізне джерело дзеркала',
  AERIAL_MIRROR_REQUEST_GAP_MS: 'Пауза між запитами до дзеркала',
  ALERT_END_DEBOUNCE_SECONDS: 'Витримка перед відбоєм',
  DEMO_SOURCE_ENABLED: 'Демо-джерело',
  // Публікація
  PUBLICATION_DELAY_SECONDS: 'Тривалість затримки показу',
  NIGHTLY_DIGEST_TIME: 'Час нічного дайджесту',
  APP_TIMEZONE: 'Часовий пояс застосунку',
  // Аналітика й моделі
  AI_BASE_URL: 'Адреса моделі',
  AI_API_KEY: 'Ключ моделі',
  AI_MODEL: 'Назва моделі',
  AI_TIMEOUT_MS: 'Тайм-аут звернення до моделі',
  ANALYTICS_EVENT_DRIVEN_ENABLED: 'Подієвий перерахунок аналітики',
  ANALYTICS_NARRATIVE_ENABLED: 'Наратив аналітики',
  CODEX_BASE_URL: 'Адреса Codex',
  CODEX_API_KEY: 'Токен Codex',
  CODEX_MODEL: 'Модель Codex',
  CODEX_ACCOUNT_ID: 'Обліковий запис Codex',
  CODEX_API_STYLE: 'Транспорт Codex',
  SHADOW_CLASSIFIER_MAX_PER_MINUTE: 'Бюджет тіньової класифікації',
  RETROSPECTIVE_GATE_TIMEOUT_MS: 'Тайм-аут підтвердження ретроспективи',
  RETROSPECTIVE_GATE_MAX_PER_MINUTE: 'Бюджет підтвердження ретроспективи',
  CODEX_OAUTH_ISSUER: 'Видавець OAuth Codex',
  CODEX_OAUTH_CLIENT_ID: 'Client ID OAuth Codex',
  CODEX_OAUTH_SCOPE: 'Обсяг доступу OAuth Codex',
  CODEX_OAUTH_REDIRECT_PORT: 'Порт зворотного виклику',
  CODEX_OAUTH_REDIRECT_HOST: 'Хост зворотного виклику',
  CODEX_OAUTH_BIND_ADDRESS: 'Адреса прослуховування зворотного виклику',
  CODEX_OAUTH_LOGIN_TIMEOUT_SECONDS: 'Час життя початого входу',
  // Карта й довідники
  MAP_STYLE_URL: 'Стиль підкладки карти',
  KATOTTG_SYNC_ENABLED: 'Синхронізація КАТОТТГ',
  KATOTTG_URL: 'Адреса кодифікатора КАТОТТГ',
  KATOTTG_VERSION: 'Версія кодифікатора',
  OCCUPATION_SOURCE_ENABLED: 'Шар окупованих територій',
  DEEPSTATE_API_URL: 'Адреса DeepStateMap',
  OCCUPATION_SYNC_INTERVAL_SECONDS: 'Період оновлення шару окупації',
  OCCUPATION_STALE_AFTER_SECONDS: 'Термін придатності ревізії окупації',
  // Система
  NODE_ENV: 'Середовище',
  PORT: 'Порт застосунку',
  PUBLIC_URL: 'Публічна адреса',
  DATABASE_URL: 'Підключення до PostgreSQL',
  OPS_USER: 'Користувач консолі',
  OPS_PASSWORD: 'Пароль консолі',
  METRICS_TOKEN: 'Токен /metrics',
  APP_COMMIT: 'Commit образу',
  APP_BUILT_AT: 'Час збірки образу',
  DEPLOY_ENABLED: 'Оновлення з консолі',
  DEPLOY_RUNNER_URL: 'Адреса процесу оновлення',
  DEPLOY_RUNNER_TOKEN: 'Токен процесу оновлення',
  DEPLOY_RUNNER_TIMEOUT_MS: 'Бюджет запиту до процесу оновлення'
};

// Примітки. Не в кожного ключа — лише там, де значення без пояснення читається неправильно: межа,
// яка є запобіжником, а не регулятором; вимикач, який не забирає вже показане; порожній рядок, що
// має власне значення.
const APP_SETTING_NOTES = {
  TELEGRAM_ADMIN_CHAT_ID: 'Технічні сповіщення оператору: деградація MTProto-колектора й старт на .env замість збережених налаштувань. Порожнє значення вимикає їх; не список — один chat id.',
  TELEGRAM_SESSION: 'Рівноцінно входу в акаунт. Відкликається в Telegram → Пристрої.',
  ALERT_CHANNEL_USERNAME: 'Запасний варіант: читається лише тоді, коли не вдався запит до таблиці джерел.',
  ALERT_CHANNEL_MAX_ALERT_SECONDS: 'Запобіжник проти загубленого відбою, а не типова тривалість. Зниження до правдоподібної тривалості робить із нього генератор фальшивого «Офіційний відбій».',
  OSINT_MONITOR_COALESCE_SECONDS: '0 — без склеювання. Придушується повторне сповіщення, а не саме повідомлення.',
  CLASSIFIER_BACKFILL_CHECK_INTERVAL_SECONDS: '0 — лише один раз, на старті колектора.',
  AERIAL_MIRROR_STALE_SECONDS: 'Запобіжник: за цією межею відповідь дзеркала стає помилкою джерела й нічого не пишеться. Підняти — розширити вікно, у якому вірять мертвому дзеркалу.',
  AERIAL_MIRROR_RAW_SOURCE: 'Порожній рядок вимикає наскрізний режим і повертає поведінку «лише області» — це відступ до відомого стану, а не деградація.',
  AERIAL_MIRROR_REQUEST_GAP_MS: 'Ендпоінт дозволяє два запити на секунду; сплеск отримує обрізане тіло.',
  ALERT_END_DEBOUNCE_SECONDS: 'Скільки джерело може мовчати про тривогу, перш ніж її дозволено завершити. Опитування — раз на 15 с.',
  DEMO_SOURCE_ENABLED: 'У production увімкнене демо-джерело — відмова старту.',
  PUBLICATION_DELAY_SECONDS: 'Лише ДОВЖИНА утримання. Сам режим (наживо / із затримкою) вмикає оператор на головній сторінці консолі.',
  APP_TIMEZONE: 'Пояс, у якому бот називає час. Форматувальники перечитують його на місці.',
  ANALYTICS_NARRATIVE_ENABLED: 'Жодне число від цього не змінюється — лише проза над уже порахованим.',
  CODEX_API_STYLE: '`auto` вибирає транспорт за адресою; явні значення — для проксі на оманливому URL.',
  SHADOW_CLASSIFIER_MAX_PER_MINUTE: 'Стеля витрат, а не пропускна здатність. Понадбюджетні повідомлення відкидаються, а не стають у чергу.',
  RETROSPECTIVE_GATE_TIMEOUT_MS: 'Виклик усередині конвеєра: повідомлення, яке чекає на модель, — це повідомлення, якого ще немає на карті.',
  RETROSPECTIVE_GATE_MAX_PER_MINUTE: 'Понад бюджет ворота публікують. Вичерпана квота може коштувати придушення, ніколи — попередження.',
  OCCUPATION_SYNC_INTERVAL_SECONDS: 'Постачальник публікує приблизно раз на добу; частіше за годину відхиляється.',
  DEEPSTATE_API_URL: 'Дані не під відкритою ліцензією. Атрибуція обовʼязкова.',
  MAP_STYLE_URL: 'Читає браузер відвідувача. Для production — власна підкладка.',
  OPS_PASSWORD: 'У production — щонайменше 16 символів, інакше застосунок не стартує.',
  METRICS_TOKEN: 'У production — щонайменше 16 символів.',
  DEPLOY_RUNNER_TOKEN: 'Спільний секрет із контейнером `deployer`. У production при увімкненому оновленні — від 32 символів.',
  APP_COMMIT: 'Запікається в образ під час збірки. `unknown` означає образ, зібраний поза compose.'
};

// Якір у docs/TOKENS.md. Не в кожного ключа — лише в того, який десь ЗДОБУВАЮТЬ: реєструють,
// подають заявку, генерують або натискають кнопку.
const APP_SETTING_DOC_ANCHORS = {
  TELEGRAM_API_ID: 'telegram-mtproto', TELEGRAM_API_HASH: 'telegram-mtproto',
  TELEGRAM_SESSION: 'telegram-mtproto',
  TELEGRAM_BOT_TOKEN: 'telegram-bot', TELEGRAM_BOT_USERNAME: 'telegram-bot',
  TELEGRAM_ADMIN_CHAT_ID: 'telegram-bot',
  UKRAINE_ALARM_API_TOKEN: 'ukrainealarm', UKRAINE_ALARM_API_URL: 'ukrainealarm',
  ALERTS_IN_UA_TOKEN: 'alerts-in-ua', ALERTS_IN_UA_URL: 'alerts-in-ua',
  AERIAL_MIRROR_ENABLED: 'aerial-mirror', AERIAL_MIRROR_URL: 'aerial-mirror',
  AERIAL_MIRROR_RAW_SOURCE: 'aerial-mirror',
  AI_BASE_URL: 'ai-platform', AI_API_KEY: 'ai-platform', AI_MODEL: 'ai-platform',
  CODEX_BASE_URL: 'codex', CODEX_API_KEY: 'codex', CODEX_MODEL: 'codex',
  CODEX_ACCOUNT_ID: 'codex', CODEX_API_STYLE: 'codex',
  CODEX_OAUTH_ISSUER: 'codex', CODEX_OAUTH_CLIENT_ID: 'codex', CODEX_OAUTH_SCOPE: 'codex',
  CODEX_OAUTH_REDIRECT_PORT: 'codex', CODEX_OAUTH_REDIRECT_HOST: 'codex',
  CODEX_OAUTH_BIND_ADDRESS: 'codex', CODEX_OAUTH_LOGIN_TIMEOUT_SECONDS: 'codex',
  OPS_USER: 'self-generated', OPS_PASSWORD: 'self-generated', METRICS_TOKEN: 'self-generated',
  DEPLOY_RUNNER_TOKEN: 'self-generated', DATABASE_URL: 'self-generated',
  KATOTTG_SYNC_ENABLED: 'katottg', KATOTTG_URL: 'katottg', KATOTTG_VERSION: 'katottg',
  OCCUPATION_SOURCE_ENABLED: 'deepstate', DEEPSTATE_API_URL: 'deepstate',
  MAP_STYLE_URL: 'basemap', PUBLIC_URL: 'domain'
};

// Здобуття, вкладене в саму сторінку. Три-пʼять кроків — не переказ TOKENS.md, а те, що потрібно
// біля поля, у яке зараз вставляють значення. Повний текст із датами перевірки — за посиланням.
const APP_SETTING_HOWTO = {
  'telegram-mtproto': [
    'my.telegram.org → увійти телефоном ТОГО акаунта, який читатиме канали.',
    'API development tools → заповнити форму (назва будь-яка, платформа Other, URL можна лишити порожнім).',
    'Сторінка покаже App api_id (число) і App api_hash (32 hex-символи).',
    'node scripts/telegram-session.mjs — запитає ці два значення, телефон, код і пароль двоетапної перевірки, після чого надрукує рядок TELEGRAM_SESSION=…'
  ],
  'telegram-bot': [
    '@BotFather у Telegram → /newbot.',
    'Назва, потім username, що закінчується на bot.',
    'BotFather віддасть токен виду 123456789:AAF… Відкликати — /revoke там само.',
    'Chat ID адміністратора: написати @userinfobot.'
  ],
  ukrainealarm: [
    'api.ukrainealarm.com — заявка через форму в браузері.',
    'Автоматичне звернення по токен відповідає 403: форму заповнює людина.',
    'Погодження триває стільки, скільки триває. Джерело не обовʼязкове — офіційні тривоги вже працюють через Telegram-колектор.'
  ],
  'alerts-in-ua': [
    'alerts.in.ua, розділ для розробників — письмова заявка.',
    'Ліміт запитів указано у відповіді видавця; опитування частіше за нього повертає 429.',
    'Перед довірою перевірити на стенді: ідентифікатори регіонів мусять лягти на місцевий каталог.'
  ],
  'aerial-mirror': [
    'Нічого здобувати не треба: джерело без токена й без заявки.',
    'Єдиний «вимкнено» цього джерела — цей перемикач.'
  ],
  'ai-platform': [
    'platform.openai.com → API keys → створити ключ.',
    'На акаунті платформи має бути налаштована оплата: підписка ChatGPT доступу до API не дає.',
    'Підходить будь-який OpenAI-сумісний ендпоінт — локальний сервер, проксі, інший постачальник.'
  ],
  codex: [
    'Кнопка «Увійти через ChatGPT» на головній сторінці консолі — сесія збережеться в PostgreSQL і оновлюватиметься сама.',
    'Зворотний виклик іде на http://localhost:1455/auth/callback і іншого редиректу той клієнт не приймає.',
    'На віддаленому хості за Caddy кнопка не завершиться, доки порт не протунельовано: ssh -L 1455:localhost:1455 …',
    'Ручний шлях: codex login, потім токен і account id із ~/.codex/auth.json. Він не оновлюється сам.'
  ],
  'self-generated': [
    'Ніхто їх не видає: openssl rand -base64 24 (для токена процесу оновлення — openssl rand -hex 32).',
    'Пароль консолі й токен /metrics у production — від 16 символів, інакше застосунок не стартує.'
  ],
  katottg: ['Публікація міністерства, без реєстрації. Змінюється лише коли виходить новий кодифікатор.'],
  deepstate: [
    'Публічний ендпоінт, токена немає.',
    'Дані НЕ під відкритою ліцензією: атрибуція обовʼязкова, а перед публічним поширенням потрібен дозвіл — або вимкнути шар.'
  ],
  basemap: ['Публічний тайл-сервер. Для production — власний стиль PMTiles, див. data/map/README.md.'],
  domain: ['Домен, A/AAAA-запис на хост, відкриті 80 і 443. Сертифікат Caddy отримує сам.']
};

const SETTING_SOURCE_NAMES = { db: 'БД', env: '.env', default: 'за замовчуванням' };
const SETTING_SOURCE_HINTS = {
  db: 'Значення збережено в цій консолі й переважає над .env.',
  env: 'Значення прийшло зі змінних середовища контейнера.',
  default: 'Значення ніде не задано — діє типове зі схеми.'
};
// Підпис озброєної кнопки називає НАСЛІДОК, а не дію. «Ви впевнені?» перевіряє рішучість;
// «колектор перепідключиться» перевіряє те єдине, що варто перевірити, — чи оператор знає, що
// зараз станеться.
const SETTING_IMPACT_ARMED = {
  collector: 'Підтвердити: колектор перепідключиться',
  alerts: 'Підтвердити: торкнеться офіційних тривог',
  publication: 'Підтвердити: торкнеться публічного показу'
};
const SETTING_IMPACT_NOTES = {
  collector: 'Зміна перезапускає підписки MTProto. Поки триває перепідключення, канали не читаються.',
  alerts: 'Зміна впливає на те, коли тривога починається і коли їй дозволено завершитися.',
  publication: 'Зміна впливає на те, що бачить читач публічної сторінки.'
};
const SETTINGS_PUT_ERRORS = {
  unknown_setting: 'Сервер не знає такого ключа або він доступний лише з .env.',
  confirmation_required: 'Ключ потребує підтвердження. Натисніть кнопку збереження ще раз.',
  publication_delayed: 'Показ зараз затримано. Довжину затримки не можна змінювати, доки діє режим «із затримкою»: перемкніть показ на «наживо» на головній сторінці консолі.'
};
// Стан колектора одним словом — той самий словник, що й у решті консолі.
const COLLECTOR_STATE_NAMES = {
  disabled: 'вимкнено', starting: 'запускається', ready: 'читає',
  degraded: 'частково', flood_wait: 'flood wait', failed: 'збій'
};
const COLLECTOR_STATE_TONES = {
  disabled: 'off', starting: 'warn', ready: 'ok', degraded: 'warn', flood_wait: 'bad', failed: 'bad'
};

const settingLabel = (key) => APP_SETTING_LABELS[key] ?? key;

/** Живий стан колектора поруч із ключем, який його перезапустить. */
function settingCollectorPill(collector) {
  if (!collector?.state) return '';
  const tone = COLLECTOR_STATE_TONES[collector.state] ?? 'off';
  const name = COLLECTOR_STATE_NAMES[collector.state] ?? collector.state;
  const bound = Number.isFinite(Number(collector.resolved)) && Number.isFinite(Number(collector.channels))
    ? ` ${collector.resolved}/${collector.channels}`
    : '';
  return `<span class="codex-state is-${tone}" title="Стан колектора на момент читання сторінки">колектор: ${escapeHtml(name)}${escapeHtml(bound)}</span>`;
}

/**
 * Значення для показу і для пошуку.
 *
 * Секрет не має тут жодного значення взагалі — сервер його не надсилає, і вигадувати заглушку, яка
 * виглядає як значення, було б гірше за порожнечу.
 */
const settingIsSecret = (setting) => setting.isSecret === true || setting.ui?.kind === 'secret';

function settingDisplayValue(setting) {
  if (settingIsSecret(setting)) return setting.isSet ? '•••••••' : 'не встановлено';
  const applied = setting.applied ?? setting.stored ?? setting.envValue ?? setting.defaultValue;
  if (applied === null || applied === undefined || applied === '') return '';
  return String(applied);
}

/** Рядок, який шукає пошук: ключ, підпис і значення разом. */
function settingSearchIndex(setting) {
  return [setting.key, settingLabel(setting.key), settingIsSecret(setting) ? '' : settingDisplayValue(setting)]
    .join(' ').toLowerCase();
}

function settingBadges(setting) {
  const source = setting.source ?? 'default';
  const badges = [`<span class="settings-badge is-${escapeHtml(source)}" title="${escapeHtml(SETTING_SOURCE_HINTS[source] ?? '')}">${escapeHtml(SETTING_SOURCE_NAMES[source] ?? source)}</span>`];
  if (setting.pendingRestart) {
    badges.push('<span class="settings-badge is-pending" title="Збережене значення відрізняється від того, з яким процес стартував">потребує перезапуску</span>');
  } else if (setting.apply === 'restart') {
    badges.push('<span class="settings-badge is-restart" title="Зміна цього ключа набуде чинності лише після перезапуску контейнера">лише після перезапуску</span>');
  }
  if (setting.scope === 'env') badges.push('<span class="settings-badge is-locked" title="Ключ доступний лише зі змінних середовища">тільки .env</span>');
  if (settingIsSecret(setting)) badges.push('<span class="settings-badge is-secret">секрет</span>');
  return badges.join('');
}

/** «Як отримати →»: кроки просто тут, повний текст — за посиланням. Див. TOKENS_DOC_URL. */
function settingHowTo(key) {
  const anchor = APP_SETTING_DOC_ANCHORS[key];
  const steps = anchor ? APP_SETTING_HOWTO[anchor] : null;
  if (!anchor || !steps) return '';
  return `<details class="setting-howto">
    <summary>як отримати →</summary>
    <ol>${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
    <p class="legend-note"><a href="${escapeHtml(`${TOKENS_DOC_URL}#${anchor}`)}" target="_blank" rel="noreferrer">docs/TOKENS.md#${escapeHtml(anchor)} ↗</a> — повний текст із датами перевірки й порядком заміни.</p>
  </details>`;
}

/** Керувальний орган поля. Числове бере готову форму рантайму разом із її натискними межами. */
function settingControl(setting) {
  const key = setting.key;
  const id = escapeHtml(key);
  const ui = setting.ui ?? {};
  const kind = (setting.isSecret || ui.kind === 'secret') ? 'secret' : (ui.kind ?? 'text');
  // `env` — не «поле, яке не можна змінити», а поле, змінювати яке звідси означало б зачинити двері
  // зсередини або порушити те, чим сама сторінка тримається. Показуємо його разом із причиною й без
  // жодного органа керування, який щось обіцяв би.
  const locked = setting.scope === 'env';
  const note = APP_SETTING_NOTES[key] ?? '';
  const noteHtml = note ? `<p class="codex-feature-note">${escapeHtml(note)}</p>` : '';
  const applyNote = setting.applyNote ? `<p class="codex-feature-note">${escapeHtml(setting.applyNote)}</p>` : '';
  const envReason = locked && setting.envReason
    ? `<p class="codex-feature-note setting-envreason">${escapeHtml(setting.envReason)}</p>` : '';
  const error = `<p class="runtime-field-error" id="runtime-error-${id}" data-runtime-error hidden></p>`;
  const title = `${settingLabel(key)}`;

  if (kind === 'number') {
    const min = ui.min ?? ui.bound?.min;
    const max = ui.max ?? ui.bound?.max;
    // Межі є — віддаємо полю рантайму цілком: підпис, одиниця, натискні мінімум і максимум,
    // місце під помилку. Немає меж — це просто число без діапазону, і вигадувати діапазон не можна.
    if (!locked && Number.isFinite(Number(min)) && Number.isFinite(Number(max))) {
      return runtimeNumberField(key, { min, max }, settingDisplayValue(setting));
    }
    return `<div class="codex-feature runtime-field" data-runtime-row="${id}">
      <label class="codex-feature-title" for="set-${id}">${escapeHtml(title)}${escapeHtml(runtimeUnit(key) ? `, ${runtimeUnit(key)}` : '')}</label>
      <input id="set-${id}" type="number" step="1" inputmode="numeric" data-setting-input="${id}"
        value="${escapeHtml(settingDisplayValue(setting))}"${locked ? ' disabled' : ''}>
      ${noteHtml}${applyNote}${envReason}${error}
    </div>`;
  }

  if (kind === 'boolean') {
    const on = String(settingDisplayValue(setting)) === 'true';
    return `<div class="codex-feature runtime-field setting-boolean" data-runtime-row="${id}">
      <label class="codex-feature-title" for="set-${id}">${escapeHtml(title)}</label>
      <label class="setting-switch"><input id="set-${id}" type="checkbox" data-setting-input="${id}"${on ? ' checked' : ''}${locked ? ' disabled' : ''}>
        <span data-setting-switch-text>${on ? 'увімкнено' : 'вимкнено'}</span></label>
      ${noteHtml}${applyNote}${envReason}${error}
    </div>`;
  }

  if (kind === 'select' || kind === 'enum') {
    const options = ui.options ?? ui.values ?? ui.choices ?? [];
    const current = settingDisplayValue(setting);
    const list = options.map((option) => {
      const value = typeof option === 'string' ? option : option.value;
      const name = typeof option === 'string' ? option : (option.label ?? option.value);
      return `<option value="${escapeHtml(String(value))}"${String(value) === current ? ' selected' : ''}>${escapeHtml(String(name))}</option>`;
    }).join('');
    return `<div class="codex-feature runtime-field" data-runtime-row="${id}">
      <label class="codex-feature-title" for="set-${id}">${escapeHtml(title)}</label>
      <select id="set-${id}" data-setting-input="${id}"${locked ? ' disabled' : ''}>${list}</select>
      ${noteHtml}${applyNote}${error}
    </div>`;
  }

  if (kind === 'secret') {
    // Маска — не «приховане значення», а рівно те, що сервер надіслав: встановлено чи ні, і звідки.
    // Поля для введення тут спершу немає взагалі: воно зʼявляється на «Замінити», бо порожній
    // password-інпут поруч зі встановленим секретом читається як «секрет стерли».
    return `<div class="codex-feature runtime-field setting-secret" data-runtime-row="${id}">
      <span class="codex-feature-title">${escapeHtml(title)}</span>
      <p class="setting-mask" data-setting-mask>${setting.isSet ? '•••••••' : '<i>не встановлено</i>'}</p>
      ${locked ? '' : `<div class="setting-secret-input" data-setting-secret-input hidden>
        <label class="visually-hidden" for="set-${id}">Нове значення: ${escapeHtml(title)}</label>
        <input id="set-${id}" type="password" autocomplete="new-password" spellcheck="false"
          data-setting-input="${id}" placeholder="вставити нове значення">
      </div>`}
      ${noteHtml}${applyNote}${envReason}${error}
    </div>`;
  }

  const value = settingDisplayValue(setting);
  const multiline = value.length > 120;
  const placeholder = ui.placeholder ? ` placeholder="${escapeHtml(String(ui.placeholder))}"` : '';
  const control = multiline
    ? `<textarea id="set-${id}" rows="2" spellcheck="false" data-setting-input="${id}"${locked ? ' disabled' : ''}>${escapeHtml(value)}</textarea>`
    : `<input id="set-${id}" type="${kind === 'url' ? 'url' : 'text'}" spellcheck="false" autocomplete="off"
        data-setting-input="${id}" value="${escapeHtml(value)}"${placeholder}${locked ? ' disabled' : ''}>`;
  return `<div class="codex-feature runtime-field" data-runtime-row="${id}">
    <label class="codex-feature-title" for="set-${id}">${escapeHtml(title)}</label>
    ${control}
    ${noteHtml}${applyNote}${envReason}${error}
  </div>`;
}

/**
 * Один рядок реєстру.
 *
 * `data-initial` — те, що сервер вважає діючим ЗАРАЗ. Уся брудність сторінки міряється від нього,
 * а не від значення, з яким поле намалювали: це те саме, доки ніхто не друкував.
 */
function opsSettingRow(setting, collector) {
  const key = setting.key;
  const id = escapeHtml(key);
  const confirm = setting.confirm === true;
  const impact = setting.impact ?? '';
  const impactNote = impact && SETTING_IMPACT_NOTES[impact]
    ? `<p class="setting-impact">${escapeHtml(SETTING_IMPACT_NOTES[impact])}</p>` : '';
  const locked = setting.scope === 'env';
  const secret = setting.isSecret || setting.ui?.kind === 'secret';
  const actions = locked
    ? '<span class="legend-note">Змінюється лише у <code>.env</code> і перезапуском.</span>'
    : secret
      ? `<button type="button" data-setting-replace="${id}">Замінити</button>
         <button type="button" data-setting-save="${id}" hidden disabled>Зберегти</button>
         <button type="button" data-setting-cancel="${id}" hidden>Скасувати</button>
         ${setting.source === 'db' ? `<button type="button" class="setting-danger" data-setting-clear="${id}">Очистити</button>` : ''}`
      : `<button type="button" data-setting-save="${id}" disabled>Зберегти</button>
         ${setting.source === 'db' ? `<button type="button" class="setting-danger" data-setting-clear="${id}">Скинути</button>` : ''}`;
  return `<article class="setting-row${locked ? ' is-locked' : ''}" data-setting-row="${id}" data-setting-key="${id}"
      data-search="${escapeHtml(settingSearchIndex(setting))}"
      data-initial="${escapeHtml(secret ? '' : settingDisplayValue(setting))}"
      data-secret="${secret ? 'true' : 'false'}" data-locked="${locked ? 'true' : 'false'}"
      data-confirm="${confirm ? 'true' : 'false'}" data-impact="${escapeHtml(impact)}">
    <div class="setting-field">
      ${settingControl(setting)}
      ${impactNote}
      <p class="setting-key"><code>${id}</code>${setting.updatedAt ? ` · змінено ${escapeHtml(new Date(setting.updatedAt).toLocaleString('uk-UA'))}${setting.updatedBy ? ` · ${escapeHtml(setting.updatedBy)}` : ''}` : ''}</p>
      ${settingHowTo(key)}
      <details class="setting-audit" data-setting-audit="${id}">
        <summary>Журнал змін ключа</summary>
        <div data-setting-audit-body><p class="legend-note">Читаємо…</p></div>
      </details>
    </div>
    <div class="setting-side">
      <div class="settings-badges">${settingBadges(setting)}${confirm && impact === 'collector' ? settingCollectorPill(collector) : ''}</div>
      <div class="ops-channel-actions setting-actions">${actions}</div>
      <output class="setting-status" data-setting-status="${id}"></output>
    </div>
  </article>`;
}

/** Група — розгортайка, бо шість груп на вісімдесят полів інакше стають одним нескінченним списком. */
function opsSettingsGroup(group, settings, collector) {
  const id = typeof group === 'string' ? group : (group.id ?? group.key ?? group.group);
  const name = (typeof group === 'object' && (group.label ?? group.name ?? group.title))
    || APP_SETTING_GROUP_NAMES[id] || id;
  const note = (typeof group === 'object' && group.note) || APP_SETTING_GROUP_NOTES[id] || '';
  const rows = settings.filter((setting) => setting.group === id);
  if (!rows.length) return '';
  const pending = rows.filter((setting) => setting.pendingRestart).length;
  return `<details class="settings-group" data-settings-group="${escapeHtml(id)}" open>
    <summary>
      <span class="settings-group-name">${escapeHtml(name)}</span>
      <span class="settings-group-count" data-settings-group-count>${rows.length}</span>
      ${pending ? `<span class="settings-badge is-pending">${pending} чекає перезапуску</span>` : ''}
      <span class="legend-caret" aria-hidden="true">▾</span>
    </summary>
    ${note ? `<p class="legend-note settings-group-note">${escapeHtml(note)}</p>` : ''}
    <div class="settings-rows">${rows.map((setting) => opsSettingRow(setting, collector)).join('')}</div>
  </details>`;
}

function settingsAuditRow(row) {
  return `<article>
    <div>
      <span>${escapeHtml(new Date(row.changedAt).toLocaleString('uk-UA'))} · ${escapeHtml(row.changedBy ?? '—')} · ${escapeHtml(row.source ?? '—')}</span>
      <h3>${escapeHtml(settingLabel(row.field))}</h3>
      <p><code>${escapeHtml(row.field ?? '')}</code>: ${escapeHtml(row.previousValue ?? '—')} → ${escapeHtml(row.newValue ?? '—')}</p>
    </div>
  </article>`;
}

/**
 * Банер перезапуску називає обидва справжні шляхи, а не «перезапустіть застосунок».
 *
 * Кнопка на головній сторінці консолі підписана «Оновити до <commit>» і робить повне оновлення з
 * main; `docker compose restart app` перезапускає той самий образ. Це різні дії з різними
 * наслідками, і оператор мусить бачити обидві названими, а не вгадувати, яку мали на увазі.
 */
function settingsRestartBanner(restartPending) {
  const keys = restartPending?.keys ?? [];
  const count = Number(restartPending?.count ?? keys.length ?? 0);
  if (!count) return '';
  return `<div class="settings-restart" role="status">
    <p><strong>${count} ${pluralUk(count, 'ключ чекає', 'ключі чекають', 'ключів чекає')} перезапуску.</strong>
      Значення збережено, але процес досі працює з тим, з яким стартував.</p>
    ${keys.length ? `<p class="settings-restart-keys">${keys.map((key) => `<code>${escapeHtml(key)}</code>`).join(' ')}</p>` : ''}
    <p class="legend-note">Застосувати можна двома шляхами, і вони різні: кнопка «Оновити до …» в
      картці «Оновлення з main» на головній сторінці консолі збирає й розгортає новий commit, а на
      хості <code>docker compose restart app</code> перезапускає той самий образ із новими
      значеннями.</p>
  </div>`;
}

async function renderOpsSettings() {
  clearInterval(codexPollTimer);
  clearInterval(deployPollTimer);
  const root = contentShell('Закритий контур', 'Налаштування застосунку',
    'Реєстр змінних середовища: що діє зараз, звідки воно взялося і хто це змінив.');
  const response = await opsFetch('/ops/api/settings').catch(() => null);
  if (response?.status === 401) {
    opsLoginForm(root, '/ops/api/settings', () => void renderOpsSettings());
    return;
  }
  root.classList.add('ops-console');
  root.parentElement?.classList.add('ops-shell');
  if (!response?.ok) {
    // Легітимний проміжний стан, а не збій сторінки: маршрут може ще не існувати в цьому образі.
    root.innerHTML = `<nav class="ops-quicklinks"><a href="/ops" data-route="/ops">← Операційна консоль</a></nav>
      <section class="ops-section"><header class="ops-section-head"><div><p>Реєстр</p><h2>Налаштування недоступні</h2></div></header>
      <p class="legend-note">Сервер не віддав реєстр налаштувань${response ? ` (HTTP ${response.status})` : ''}. Значення далі читаються з <code>.env</code>, і жодне з них від цього не змінилося.</p></section>`;
    return;
  }
  const data = await response.json().catch(() => null);
  if (!data) { root.innerHTML = '<p class="legend-note">Реєстр налаштувань нечитний.</p>'; return; }

  const groups = data.groups?.length ? data.groups : APP_SETTING_GROUPS.map(([id]) => id);
  const envOnly = data.envOnly ?? [];
  const rejected = data.rejected ?? [];
  const orphans = data.orphans ?? [];
  const blocked = data.blocked ?? [];
  const audit = data.audit ?? [];
  // «Чому лише в .env» сервер надсилає один раз, списком, а не повторює в кожному рядку. Розкладаємо
  // його по ключах тут: причина потрібна БІЛЯ поля, бо саме там оператор питає «а чому воно сіре».
  const envReasons = new Map(envOnly.map((item) => [
    typeof item === 'string' ? item : item.key,
    typeof item === 'object' ? (item.reason ?? '') : ''
  ]));
  const settings = (data.settings ?? []).map((setting) => (
    envReasons.has(setting.key) ? { ...setting, envReason: envReasons.get(setting.key) } : setting
  ));

  root.innerHTML = `<nav class="ops-quicklinks" aria-label="Розділи консолі">
      <a href="/ops" data-route="/ops">← Операційна консоль</a>
      <span>${settings.length} ${pluralUk(settings.length, 'ключ', 'ключі', 'ключів')} у реєстрі · ${envOnly.length} лише з <code>.env</code></span>
    </nav>
    ${data.degraded ? `<div class="settings-rejected" role="alert">
      <p><strong>Реєстр не прочитався на старті.</strong> Усе, що показано нижче як діюче, зараз
        приходить зі змінних середовища: збережені значення не застосовано жодне.</p>
      <p class="legend-note">Це навмисна поведінка — читання реєстру відмовляє «відкрито», щоб збій
        бази не залишив застосунок без конфігурації взагалі. Але доки цей рядок тут, сторінка
        показує намір, а не дійсність. Перевірте журнал застосунку й
        <code>threatlens_app_settings_read_failures_total</code>.</p>
    </div>` : ''}
    ${settingsRestartBanner(data.restartPending)}
    ${rejected.length ? `<div class="settings-rejected" role="alert">
      <p><strong>Сервер відхилив ${rejected.length} ${pluralUk(rejected.length, 'збережене значення', 'збережені значення', 'збережених значень')}</strong> і читає їх з <code>.env</code>.</p>
      <p class="settings-restart-keys">${rejected.map((item) => `<code>${escapeHtml(typeof item === 'string' ? item : (item.key ?? ''))}</code>${typeof item === 'object' && item.reason ? ` — ${escapeHtml(item.reason)}` : ''}`).join(' · ')}</p>
    </div>` : ''}
    ${orphans.length ? `<p class="legend-note">У таблиці лишилися ключі, яких реєстр більше не знає: ${orphans.map((key) => `<code>${escapeHtml(typeof key === 'string' ? key : (key.key ?? ''))}</code>`).join(' ')}. Вони ні на що не впливають — це слід перейменування або відкату на старіший образ.</p>` : ''}
    ${blocked.length ? `<p class="legend-note">У таблиці є рядки для ключів, які читаються лише з <code>.env</code>: ${blocked.map((key) => `<code>${escapeHtml(typeof key === 'string' ? key : (key.key ?? ''))}</code>`).join(' ')}. Їх туди міг вписати лише хтось руками, і вони не діють.</p>` : ''}
    <section class="ops-section settings-console" id="settings-section">
      <header class="ops-section-head">
        <div><p>Реєстр · ${escapeHtml(String(settings.length))} ключів</p><h2>Значення й походження</h2></div>
        <div class="ops-channel-actions">
          <output id="settings-status"></output>
          <button type="button" data-settings-save-all disabled>Зберегти всі зміни</button>
        </div>
      </header>
      <div class="settings-toolbar">
        <label class="settings-search">Пошук
          <input type="search" data-settings-search placeholder="ключ, підпис або значення"
            autocomplete="off" spellcheck="false">
        </label>
        <output class="settings-count" data-settings-count></output>
      </div>
      <div class="settings-groups">
        ${groups.map((group) => opsSettingsGroup(group, settings, data.collector)).join('')}
      </div>
      ${data.notice ? `<details class="safety-note ops-fold"><summary><strong>Що ця сторінка не робить</strong></summary><p>${escapeHtml(data.notice)}</p></details>` : ''}
    </section>
    <details class="ops-fold settings-envonly">
      <summary><strong>Тільки в <code>.env</code> — ${envOnly.length} ${pluralUk(envOnly.length, 'ключ', 'ключі', 'ключів')}</strong></summary>
      <p class="legend-note">Ці ключі свідомо не можна змінити звідси. Кожен із них потрібен раніше
        за базу, читається compose, або є тим самим замком, крізь який відкрито цю сторінку.</p>
      <dl class="codex-facts settings-envonly-list">
        ${envOnly.map((item) => `<div><dt>${escapeHtml(typeof item === 'string' ? item : (item.key ?? ''))}</dt>
          <dd>${escapeHtml(typeof item === 'object' ? (item.reason ?? '') : '')}</dd></div>`).join('')}
      </dl>
    </details>
    <section class="ops-section" id="settings-audit-section">
      <header class="ops-section-head"><div><p>Журнал</p><h2>Останні зміни</h2></div></header>
      ${audit.length
        ? `<div class="ops-channel-list">${audit.map(settingsAuditRow).join('')}</div>`
        : '<p class="legend-note">Змін ще не було: усе діюче прийшло з <code>.env</code> або з типових значень.</p>'}
    </section>`;
  wireOpsSettings(root, data);
}

/**
 * Уся сторінка на одній делегації плюс кілька точкових слухачів.
 *
 * Перемальовування тут коштує дорожче, ніж деінде в консолі: вісімдесят полів, з яких половина може
 * бути напівнабрана, і розгорнутий журнал ключа, який щойно прочитали. Тому збереження оновлює
 * рядок на місці — бейдж, підпис і стан кнопки, — а повний перечит робиться лише тоді, коли
 * оператор попросив зберегти все.
 */
function wireOpsSettings(root, data) {
  const section = $('#settings-section', root);
  if (!section) return;
  const status = $('#settings-status', section);
  const saveAll = $('[data-settings-save-all]', section);
  const search = $('[data-settings-search]', section);
  const counter = $('[data-settings-count]', section);
  const settingsByKey = new Map((data.settings ?? []).map((setting) => [setting.key, setting]));

  // Числове поле рантайму не знає про реєстр і підписує інпут своїм атрибутом. Замість того щоб
  // дублювати розмітку, позначаємо його тут — одна петля замість другої форми того самого поля.
  section.querySelectorAll('input[type="number"][data-runtime-field]').forEach((input) => {
    input.dataset.settingInput = input.dataset.runtimeField;
  });

  const rows = () => [...section.querySelectorAll('[data-setting-row]')];
  const rowOf = (key) => section.querySelector(`[data-setting-row="${key}"]`);
  const inputOf = (row) => row?.querySelector('[data-setting-input]');

  const currentValue = (row) => {
    const input = inputOf(row);
    if (!input) return null;
    if (input.type === 'checkbox') return input.checked ? 'true' : 'false';
    return input.value;
  };

  // Брудність секрету — це не «значення відрізняється», бо порівнювати нема з чим. Це «оператор
  // відкрив поле заміни й щось у нього вписав».
  const isDirty = (row) => {
    if (row.dataset.locked === 'true') return false;
    const value = currentValue(row);
    if (value === null) return false;
    if (row.dataset.secret === 'true') return row.dataset.replacing === 'true' && value !== '';
    return value !== row.dataset.initial;
  };

  const dirtyRows = () => rows().filter(isDirty);

  const paintRow = (row) => {
    const dirty = isDirty(row);
    row.classList.toggle('is-dirty', dirty);
    const save = row.querySelector('[data-setting-save]');
    if (save) save.disabled = !dirty;
    if (!dirty) disarm(row.querySelector('[data-setting-save]'));
  };

  const refreshTotals = () => {
    const dirty = dirtyRows();
    saveAll.disabled = dirty.length === 0;
    saveAll.textContent = dirty.length
      ? `Зберегти всі зміни (${dirty.length})`
      : 'Зберегти всі зміни';
    disarm(saveAll);
  };

  // Два кроки на одній кнопці — той самий механізм, що й у кнопки оновлення: перше натискання лише
  // перейменовує кнопку наслідком, друге надсилає, і через десять секунд озброєння спадає само.
  const disarm = (button) => {
    if (!button || button.dataset.armed !== 'true') return;
    button.dataset.armed = 'false';
    if (button.dataset.restLabel) button.textContent = button.dataset.restLabel;
  };
  const arm = (button, armedLabel) => {
    button.dataset.restLabel = button.dataset.restLabel ?? button.textContent;
    button.dataset.armed = 'true';
    button.textContent = armedLabel;
    setTimeout(() => {
      if (!button.isConnected) return;
      disarm(button);
    }, 10_000);
  };

  const applyView = () => {
    const query = (search?.value ?? '').trim().toLowerCase();
    let shown = 0;
    let total = 0;
    for (const group of section.querySelectorAll('[data-settings-group]')) {
      let visible = 0;
      for (const row of group.querySelectorAll('[data-setting-row]')) {
        total += 1;
        const match = !query || (row.dataset.search ?? '').includes(query);
        row.hidden = !match;
        if (match) { visible += 1; shown += 1; }
      }
      group.hidden = visible === 0;
      const count = group.querySelector('[data-settings-group-count]');
      if (count) count.textContent = String(visible);
      // Пошук, який знайшов збіг у згорнутій групі й лишив її згорнутою, — це пошук, який збрехав.
      if (query && visible) group.open = true;
    }
    counter.textContent = query
      ? `Показано ${shown} із ${total} ${pluralUk(total, 'ключа', 'ключів', 'ключів')}`
      : `${total} ${pluralUk(total, 'ключ', 'ключі', 'ключів')} у реєстрі`;
  };

  /** Одна відповідь сервера — одне тлумачення, для всіх кнопок сторінки. */
  const explainFailure = async (result, keys) => {
    const payload = await result.json().catch(() => null);
    const issues = Array.isArray(payload?.issues) ? payload.issues : [];
    if (issues.length) {
      const orphaned = showRuntimeFieldErrors(section, issues.map((key) => ({
        field: key,
        message: `${settingLabel(key)}: сервер відхилив це значення.`
      })));
      return `Сервер відхилив ${issues.length} ${pluralUk(issues.length, 'ключ', 'ключі', 'ключів')}.`
        + (orphaned.length ? ` Поза формою: ${orphaned.map((problem) => problem.field).join(', ')}.` : ' Виправте позначене.');
    }
    const named = SETTINGS_PUT_ERRORS[payload?.error];
    // Сервер називає винні ключі в `keys` — і `unknown_setting`, і `confirmation_required`. Показати
    // текст без них означало б лишити оператора з правильним поясненням і без адреси.
    const blamed = Array.isArray(payload?.keys) && payload.keys.length ? ` (${payload.keys.join(', ')})` : '';
    if (named) return `${named}${blamed}`;
    return `Не вдалося зберегти (HTTP ${result.status})${blamed || (keys.length ? `: ${keys.join(', ')}` : '')}.`;
  };

  const put = async (values, confirmKeys) => {
    const body = { values, confirm: confirmKeys ?? [] };
    return opsFetch('/ops/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).catch(() => null);
  };

  /** Оновлює один рядок за свіжою відповіддю, не чіпаючи решти сторінки. */
  const repaintRow = (fresh, collector) => {
    const row = rowOf(fresh.key);
    if (!row) return;
    settingsByKey.set(fresh.key, fresh);
    row.dataset.initial = settingIsSecret(fresh) ? '' : settingDisplayValue(fresh);
    row.dataset.search = settingSearchIndex(fresh);
    row.dataset.replacing = 'false';
    const badges = row.querySelector('.settings-badges');
    if (badges) {
      badges.innerHTML = settingBadges(fresh)
        + (fresh.confirm === true && fresh.impact === 'collector' ? settingCollectorPill(collector) : '');
    }
    if (settingIsSecret(fresh)) {
      const mask = row.querySelector('[data-setting-mask]');
      if (mask) mask.innerHTML = fresh.isSet ? '•••••••' : '<i>не встановлено</i>';
      const holder = row.querySelector('[data-setting-secret-input]');
      if (holder) { holder.hidden = true; const input = inputOf(row); if (input) input.value = ''; }
      row.querySelector('[data-setting-replace]')?.removeAttribute('hidden');
      row.querySelector('[data-setting-save]')?.setAttribute('hidden', '');
      row.querySelector('[data-setting-cancel]')?.setAttribute('hidden', '');
    } else {
      const input = inputOf(row);
      if (input) {
        if (input.type === 'checkbox') {
          input.checked = settingDisplayValue(fresh) === 'true';
          const text = row.querySelector('[data-setting-switch-text]');
          if (text) text.textContent = input.checked ? 'увімкнено' : 'вимкнено';
        } else input.value = settingDisplayValue(fresh);
      }
    }
    paintRow(row);
  };

  const absorb = (payload) => {
    for (const fresh of payload.settings ?? []) repaintRow(fresh, payload.collector);
    const banner = $('.settings-restart', root);
    const markup = settingsRestartBanner(payload.restartPending);
    if (banner) banner.outerHTML = markup || '';
    else if (markup) $('.ops-quicklinks', root)?.insertAdjacentHTML('afterend', markup);
    refreshTotals();
    applyView();
  };

  const submit = async (keysWanted, valuesOverride) => {
    const keys = keysWanted;
    const values = valuesOverride ?? Object.fromEntries(keys.map((key) => [key, currentValue(rowOf(key))]));
    const confirmKeys = keys.filter((key) => rowOf(key)?.dataset.confirm === 'true');
    const problems = validateRuntimeForm(section).filter((problem) => keys.includes(problem.field));
    if (problems.length) {
      showRuntimeFieldErrors(section, problems);
      status.textContent = `Не надіслано: ${problems.length} ${pluralUk(problems.length, 'поле', 'поля', 'полів')} поза межами.`;
      return false;
    }
    showRuntimeFieldErrors(section, []);
    status.textContent = 'Зберігаємо…';
    const result = await put(values, confirmKeys);
    if (!result) { status.textContent = 'Сервер недоступний. Нічого не збережено.'; return false; }
    if (!result.ok) { status.textContent = await explainFailure(result, keys); return false; }
    const payload = await result.json().catch(() => null);
    if (payload) absorb(payload);
    status.textContent = `Збережено: ${keys.length} ${pluralUk(keys.length, 'ключ', 'ключі', 'ключів')}.`;
    return true;
  };

  section.addEventListener('input', (event) => {
    const row = event.target.closest?.('[data-setting-row]');
    if (!row) return;
    const text = row.querySelector('[data-setting-switch-text]');
    if (text && event.target.type === 'checkbox') text.textContent = event.target.checked ? 'увімкнено' : 'вимкнено';
    paintRow(row);
    refreshTotals();
  });
  section.addEventListener('change', (event) => {
    const row = event.target.closest?.('[data-setting-row]');
    if (!row) return;
    paintRow(row);
    refreshTotals();
  });
  search?.addEventListener('input', applyView);

  // Натискні межі числових полів: делегація, бо кількість полів наперед невідома. Той самий
  // механізм, що й у формі рантайму.
  section.addEventListener('click', (event) => {
    const bound = event.target.closest('[data-runtime-bound]');
    if (!bound || !section.contains(bound)) return;
    const input = section.querySelector(`[data-runtime-field="${bound.dataset.runtimeFor}"]`);
    if (!input) return;
    input.value = bound.dataset.runtimeBound === 'max' ? input.max : input.min;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  });

  section.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button || !section.contains(button)) return;
    const row = button.closest('[data-setting-row]');
    if (!row) return;
    const key = row.dataset.settingKey;
    const rowStatus = row.querySelector('[data-setting-status]');

    if (button.dataset.settingReplace !== undefined) {
      row.dataset.replacing = 'true';
      row.querySelector('[data-setting-secret-input]')?.removeAttribute('hidden');
      button.setAttribute('hidden', '');
      row.querySelector('[data-setting-save]')?.removeAttribute('hidden');
      row.querySelector('[data-setting-cancel]')?.removeAttribute('hidden');
      inputOf(row)?.focus();
      return;
    }
    if (button.dataset.settingCancel !== undefined) {
      row.dataset.replacing = 'false';
      const input = inputOf(row);
      if (input) input.value = '';
      row.querySelector('[data-setting-secret-input]')?.setAttribute('hidden', '');
      row.querySelector('[data-setting-replace]')?.removeAttribute('hidden');
      row.querySelector('[data-setting-save]')?.setAttribute('hidden', '');
      button.setAttribute('hidden', '');
      paintRow(row); refreshTotals();
      return;
    }
    if (button.dataset.settingSave !== undefined) {
      if (row.dataset.confirm === 'true' && button.dataset.armed !== 'true') {
        arm(button, SETTING_IMPACT_ARMED[row.dataset.impact] ?? 'Підтвердити зміну');
        return;
      }
      disarm(button);
      rowStatus.textContent = '';
      await submit([key]);
      return;
    }
    if (button.dataset.settingClear !== undefined) {
      // Скидання завжди у два кроки: воно ВИДАЛЯЄ збережений рядок, і повернути його можна лише
      // набравши значення заново — а для секрету значення набрати нема звідки.
      if (button.dataset.armed !== 'true') {
        arm(button, row.dataset.secret === 'true'
          ? 'Підтвердити: секрет буде знято'
          : 'Підтвердити: повернути до .env');
        return;
      }
      disarm(button);
      status.textContent = 'Скидаємо…';
      const result = await put({ [key]: null }, row.dataset.confirm === 'true' ? [key] : []);
      if (!result) { status.textContent = 'Сервер недоступний. Нічого не змінено.'; return; }
      if (!result.ok) { status.textContent = await explainFailure(result, [key]); return; }
      const payload = await result.json().catch(() => null);
      if (payload) absorb(payload);
      status.textContent = `Скинуто: ${key}.`;
    }
  });

  saveAll.addEventListener('click', async () => {
    const dirty = dirtyRows();
    if (!dirty.length) return;
    const needsConfirm = dirty.filter((row) => row.dataset.confirm === 'true');
    if (needsConfirm.length && saveAll.dataset.armed !== 'true') {
      arm(saveAll, `Підтвердити ${needsConfirm.length} ${pluralUk(needsConfirm.length, 'ключ', 'ключі', 'ключів')} з наслідками`);
      return;
    }
    disarm(saveAll);
    await submit(dirty.map((row) => row.dataset.settingKey));
  });

  // Журнал ключа читається на перше розгортання і більше не перечитується: він описує минуле, а
  // минуле не змінюється, доки цієї сторінки не чіпали.
  section.querySelectorAll('[data-setting-audit]').forEach((details) => {
    details.addEventListener('toggle', async () => {
      if (!details.open || details.dataset.loaded === 'true') return;
      details.dataset.loaded = 'true';
      const key = details.dataset.settingAudit;
      const body = details.querySelector('[data-setting-audit-body]');
      const result = await opsFetch(`/ops/api/settings/audit?key=${encodeURIComponent(key)}&limit=50`)
        .then((response) => response.ok ? response.json() : null).catch(() => null);
      const entries = result?.audit ?? result?.entries ?? (Array.isArray(result) ? result : []);
      body.innerHTML = entries.length
        ? `<div class="ops-channel-list">${entries.map(settingsAuditRow).join('')}</div>`
        : '<p class="legend-note">Цей ключ ще ніхто не змінював звідси.</p>';
    });
  });

  // Ретракційний люк, показаний ДО натискання. Сервер відповість 409, і відповість правильно, але
  // кнопка, яка виглядає доступною й гарантовано відмовить, — це кнопка, яка бреше. Режим показу
  // приходить у тому самому payload, тож умову видно наперед.
  if (data.publicationMode && data.publicationMode !== 'live') {
    const row = rowOf('PUBLICATION_DELAY_SECONDS');
    if (row) {
      // Замикаємо саме ПОЛЕ, а не кнопку. Замкнена кнопка над полем, яке приймає набране число,
      // лишає оператора з правкою, якої нікуди подіти; замкнене поле не може стати брудним, тож
      // ані «Зберегти», ані «Зберегти всі» не поїдуть по гарантовану 409.
      row.dataset.locked = 'true';
      row.classList.add('is-locked');
      const input = inputOf(row);
      if (input) input.disabled = true;
      const output = row.querySelector('[data-setting-status]');
      if (output) {
        output.textContent = 'Показ затримано — довжину затримки зараз змінити не можна. '
          + 'Перемкніть показ на «наживо» на головній сторінці консолі.';
      }
      row.querySelectorAll('[data-setting-save], [data-setting-clear]')
        .forEach((button) => { button.disabled = true; });
    }
  }

  rows().forEach(paintRow);
  refreshTotals();
  applyView();
}

// `fromSnapshot` ставить лише loadSnapshot(). Обробник посилань і popstate викликають функцію
// голяка — popstate ще й передає власний Event, у якого цього поля просто немає, тож перевірка
// свідомо шукає рівно true, а не істинність.
function renderCurrentRoute(options = {}) {
  if (!snapshot) return;
  const route = activePage();
  const fromSnapshot = options?.fromSnapshot === true;
  // Карту знімаємо лише коли справді йдемо з маршруту карти — на місці вона переживає оновлення знімка.
  if (map && route !== '/') { map.remove(); map = null; mapLayersReady = false; }
  // Опитування стану входу Codex і стану оновлення привʼязані до вузлів, яких поза консоллю вже
  // немає. Таймер оновлення особливо: він перемальовує #deploy-section, а на карті такого вузла
  // не існує, тож кожні три секунди він шукав би його марно.
  if (route !== '/ops') { clearInterval(codexPollTimer); clearInterval(deployPollTimer); }
  if (route === '/') renderMapPage();
  else if (route === '/history') void renderHistory();
  else if (route === '/attacks') void renderAttacks();
  else if (route === '/analytics') void renderAnalytics();
  else if (route === '/sources') void renderSources();
  // Консоль не читає знімок узагалі — вона тягне власні дані сімома запитами під Basic-авторизацією.
  // Перемальовувати її від кадру потоку або від хвилинного паска означало б зносити форму під
  // пальцем оператора: renderOps() починається з contentShell(), тобто з повної заміни #app, і
  // напівнабране число в «Пауза перед перерахунком» мовчки повертається до збереженого. Те саме
  // зʼїдало б пароль у формі входу. Свої дані консоль оновлює сама — через rerender()/onSaved().
  //
  // Виняток — перший рендер: прямий вхід на /ops проходить через boot() -> loadSnapshot(), тобто
  // саме зі знімка, і без цієї умови #app лишився б порожнім.
  else if (route === '/ops') { if (!fromSnapshot || renderedRoute !== '/ops') void renderOps(); }
  // Реєстр налаштувань підпорядковується тому самому правилу й з тієї самої причини: сторінка
  // будується з нуля через contentShell(), а на ній може стояти вісімдесят полів, половина з яких
  // напівнабрана, і розгорнутий пароль у полі заміни секрету. Кадр потоку, який перемалював би її,
  // мовчки повернув би все до збереженого.
  else if (route === '/ops/settings') { if (!fromSnapshot || renderedRoute !== '/ops/settings') void renderOpsSettings(); }
  else void renderAbout();
  renderedRoute = route;
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-route]');
  if (!link || event.metaKey || event.ctrlKey) return;
  event.preventDefault(); $('#detail-dialog')?.close(); history.pushState({}, '', link.href); renderCurrentRoute();
});
window.addEventListener('popstate', renderCurrentRoute);

async function boot() {
  const [loadedConfig, loadedLocations, loadedCountry, loadedAdmin] = await Promise.all([
    fetch('/api/v1/config').then((r) => r.json()),
    fetch('/api/v1/locations').then((r) => r.json()),
    fetch('/data/ukraine-adm0.geojson').then((r) => r.json()),
    fetch('/data/ukraine-adm1.geojson').then((r) => r.json())
  ]);
  config = loadedConfig; locations = loadedLocations;
  countryBoundary = loadedCountry; adminBoundaries = enrichBoundaries(loadedAdmin);
  indexRegionFeatures();
  $('#demo-label').hidden = !config.demoMode;
  if (location.pathname === '/tv') document.body.classList.add('tv-mode');
  window.Telegram?.WebApp?.ready(); window.Telegram?.WebApp?.expand();
  void loadRaionBoundaries(); // районна геометрія важка й не мусить затримувати першу картинку
  void loadOccupation(); // довідковий шар вантажиться окремо й не блокує старт карти
  await loadSnapshot(); connectStream();
  // Пасок на випадок тиші: у затриманому режимі «фактична свіжість» і смуга «ЗАТРИМКА 15 С» не
  // мають права застигнути в очікуванні кадру потоку, якого на спокійній системі просто не буде.
  setInterval(() => void loadSnapshot().catch(markOffline), 60000);
  setInterval(() => void loadOccupation(), 900000);
}
boot().catch(markOffline);
