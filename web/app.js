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
const vectorLayerIds = ['threat-vector-sequence','threat-vector-direction','threat-vector-transit','threat-vector-nodes','threat-vector-order'];
const vectorColor = '#ff7a4d';
const vectorBasisLabels = {
  reported_transit: 'джерело повідомило сам рух',
  reported_direction: 'джерело повідомило напрямок',
  observation_sequence: 'послідовність окремих повідомлень'
};

// Хороплет тривог. Заливка регіону, а не точка: офіційний канал оголошує тривогу на цілу територію,
// а в районів у каталозі KATOTTG узагалі немає координат, тож точка для них неможлива в принципі.
const alertColor = '#ff4747';
const alertLayerIds = ['alert-oblast-fill','alert-raion-fill','alert-raion-line','alert-oblast-line','alert-oblast-label','alert-raion-label'];
// 136 районів на оглядовому масштабі зливаються в кашу й перебивають обласну картину, заради якої карту й відкривають.
// Тому районний шар починає проявлятися з RAION_ZOOM_MIN і набирає повну силу на RAION_ZOOM_FULL —
// там одна область займає майже весь кадр, а район читається як окрема пляма й лишається клікабельним і на телефоні.
const RAION_ZOOM_MIN = 6;
const RAION_ZOOM_FULL = 6.8;
// alert — тривогу оголошено дослівно на цю територію.
// unmapped — тривога в її частині, для якої контуру немає взагалі, тож детальнішої картинки не буде;
//            такий регіон не гасне на великому масштабі, інакше тривога просто зникла б із карти.
// partial — тривога в її частині, яка має власний контур; тут область поступається районові.
const alertFlag = ['boolean', ['feature-state', 'alert'], false];
const unmappedFlag = ['boolean', ['feature-state', 'unmapped'], false];
const partialFlag = ['boolean', ['feature-state', 'partial'], false];
const fadingLabel = ['==', ['get', 'tone'], 'partial'];
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
let opsAuthorization = '';
let codexPollTimer = null;
let lastReceived = null;
let refreshTimer = null;
let backendStatus = 'current';

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function opsFetch(url, options = {}) {
  const headers = new Headers(options.headers ?? {});
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

// Офіційний канал оголошує тривогу переважно на рівні району, подекуди — на рівні області чи громади.
// direct — територія, названа в повідомленні дослівно. covered — її батьківські території: без цього
// на оглядовому масштабі область виглядала б спокійною, поки в її районі триває тривога.
// unmapped — найближчий предок із контуром, коли в самої названої території контуру немає
// (громади, а поки що й кілька районів без геометрії). Він відповідає за тривогу на всіх масштабах,
// бо детальнішого шару, який його підмінить, просто не існує.
function alertCoverage() {
  const parents = new Map(locations.map((item) => [item.id, item.parent_id]));
  const direct = new Set(), covered = new Set(), unmapped = new Set();
  for (const alert of snapshot?.alerts ?? []) {
    if (!alert.location_id) continue;
    direct.add(alert.location_id);
    const seen = new Set([alert.location_id]);
    let anchored = regionFeatures.has(alert.location_id);
    let parent = parents.get(alert.location_id);
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      covered.add(parent);
      if (!anchored && regionFeatures.has(parent)) { anchored = true; unmapped.add(parent); }
      parent = parents.get(parent);
    }
  }
  return { direct, covered, unmapped };
}

function alertLabelCollection(direct, covered, unmapped) {
  const names = new Map(locations.map((item) => [item.id, item.name_uk]));
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
  for (const id of direct) add(id, 'direct');
  for (const id of covered) if (!direct.has(id)) add(id, unmapped.has(id) ? 'unmapped' : 'partial');
  return { type: 'FeatureCollection', features };
}

// Стан тривоги накладається через feature-state: геометрія областей і районів (понад мегабайт)
// лишається незмінною, на кожен тік потоку змінюються лише кілька десятків прапорців.
function applyAlertLayers() {
  if (!mapLayersReady || !map) return;
  const { direct, covered, unmapped } = alertCoverage();
  for (const [source, ids] of [['ukraine-admin', oblastIds], ['ukraine-raions', raionIds]]) {
    if (!map.getSource(source)) continue;
    map.removeFeatureState({ source });
    for (const id of covered) {
      if (!ids.has(id) || direct.has(id)) continue;
      map.setFeatureState({ source, id }, unmapped.has(id) ? { unmapped: true } : { partial: true });
    }
    for (const id of direct) if (ids.has(id)) map.setFeatureState({ source, id }, { alert: true });
  }
  map.getSource('alert-labels')?.setData(alertLabelCollection(direct, covered, unmapped));
}

// Районна геометрія вантажиться окремо й не блокує старт карти. Якщо файлу немає або він зіпсований,
// карта лишається повністю робочою на рівні областей: районну тривогу все одно видно як приглушену
// заливку батьківської області, бо стан підіймається вгору ієрархією каталогу.
async function loadRaionBoundaries() {
  try {
    const response = await fetch('/data/ukraine-adm2.geojson', { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('adm2 unavailable');
    const data = await response.json();
    if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features) || !data.features.length) throw new Error('adm2 malformed');
    raionBoundaries = data;
    indexRegionFeatures();
    map?.getSource('ukraine-raions')?.setData(raionCollection());
    applyAlertLayers();
  } catch { /* без районних контурів карта працює на рівні областей */ }
}

setInterval(() => { $('#clock strong').textContent = kyivTime(); updateFreshness(); }, 1000);

function updateFreshness() {
  if (!lastReceived) return;
  const age = (Date.now() - lastReceived.getTime()) / 1000;
  const strip = $('#system-strip');
  const backendProblem = backendStatus === 'degraded' || backendStatus === 'unconfigured';
  strip.dataset.state = age > 180 || backendProblem ? 'stale' : age > 60 ? 'delayed' : 'current';
  $('#system-state').textContent = age > 180 ? 'ДАНІ ЗАСТАРІЛИ'
    : backendStatus === 'degraded' ? 'ОФІЦІЙНІ ДЖЕРЕЛА НЕДОСТУПНІ'
      : backendStatus === 'unconfigured' ? 'ДЖЕРЕЛА НЕ НАЛАШТОВАНІ'
        : age > 60 ? 'МОЖЛИВА ЗАТРИМКА' : 'ДАНІ АКТУАЛЬНІ';
  $('#last-update').textContent = `оновлено ${Math.round(age)} с тому`;
}

async function loadSnapshot() {
  const response = await fetch('/api/v1/snapshot', { cache: 'no-store' });
  if (!response.ok) throw new Error('snapshot unavailable');
  snapshot = await response.json();
  backendStatus = snapshot.systemStatus;
  lastReceived = new Date();
  renderCurrentRoute();
  updateFreshness();
  // Ланцюги — окремий запит: він важчий за знімок і не має права затримати першу картинку.
  void loadVectors();
}

function connectStream() {
  const source = new EventSource('/api/v1/stream');
  source.addEventListener('connected', () => { lastReceived = new Date(); updateFreshness(); });
  const schedule = () => {
    lastReceived = new Date();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => loadSnapshot().catch(markOffline), 250);
  };
  // 'threat.withdrawn' and 'threat.expired' end a threat. Without them the map keeps drawing it
  // until some unrelated event happens to arrive, which is the one direction that must not lag.
  ['alert.started','alert.ended','threat.created','threat.updated','threat.corrected','threat.withdrawn','threat.expired','assessment.updated','source.stale','source.recovered'].forEach((name) => source.addEventListener(name, schedule));
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

// Офіційні тривоги тут більше не зʼявляються: їх малює хороплет.
// Точка в центроїді була доступна лише областям і вдавала локалізацію, якої в повідомленні немає,
// а район її не отримав би ніколи — координат у каталозі KATOTTG немає.
function markerCollection() {
  const features = [];
  for (const threat of snapshot.threats) for (const loc of threat.locations) if (loc.longitude != null) features.push({ type: 'Feature', id: `t-${threat.id}-${loc.id}`, geometry: { type: 'Point', coordinates: [loc.longitude, loc.latitude] }, properties: { kind: 'threat', entityId: threat.id, title: threat.title, evidence: threat.evidenceLevel } });
  for (const risk of snapshot.assessments) if (risk.longitude != null) features.push({ type: 'Feature', id: `r-${risk.id}`, geometry: { type: 'Point', coordinates: [risk.longitude, risk.latitude] }, properties: { kind: 'assessment', entityId: risk.id, title: risk.location_name, score: Number(risk.risk_score) } });
  return { type: 'FeatureCollection', features };
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
  }
  renderVectorLegend();
}

function addVectorLayers() {
  // Якір: alert-oblast-label. Геометрія ланцюга лягає НАД заливками й контурами тривог, але ПІД усіма
  // підписами — обласними, районними, підписом суверенітету Криму й підписами міст. Жоден наявний шар
  // при цьому не зміщується: вставка «перед» існуючим шаром не переставляє нічого іншого.
  // Маркери подій (threat-pulse, event-labels) додано без beforeId, тож вони лишаються зверху — лінія
  // не перекриває крапку, на яку клікають.
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
  const chains = vectors.filter((vector) => (vector.segments ?? []).some((segment) => segment.drawable)).length;
  const hidden = vectors.reduce((sum, vector) => sum + (vector.segments ?? []).filter((segment) => !segment.drawable).length, 0);
  legend.hidden = !drawn;
  if (!drawn) return;
  legend.open = vectorLegendOpen ?? window.matchMedia('(min-width: 981px)').matches;
  const swatch = (style) => `<i class="legend-swatch" style="height:0;border:0;border-top:2px solid ${vectorColor};${style}"></i>`;
  legend.innerHTML = `<summary><i class="swatch threat"></i><span class="legend-title">Ланцюги повідомлень</span><span class="legend-caret" aria-hidden="true">▾</span></summary>
    <div class="legend-body">
      <p class="legend-meta"><span>${chains} ланцюг${chains === 1 ? '' : 'ів'} · ${drawn} відрізк${drawn === 1 ? '' : 'ів'}</span></p>
      <p class="legend-warning">Це послідовність <b>повідомлень</b> із часом і джерелом, а не траєкторія польоту. Лінія показує, що і коли повідомили, а не куди прямує ціль. Система не прогнозує ціль, влучання або маршрут.</p>
      <ul class="legend-rows">
        <li>${swatch('opacity:.95')}<span>Суцільна — одне повідомлення ствердило сам рух («повз А на Б»).</span></li>
        <li>${swatch('border-top-style:dashed;opacity:.75')}<span>Штрихова — джерело повідомило напрямок, але не прибуття.</span></li>
        <li>${swatch('border-top-style:dotted;opacity:.5')}<span>Крапкова — різні повідомлення в різний час. Порядок наш; рух не стверджувало жодне джерело.</span></li>
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
    return `<li><time>${shortTime(segment.reportedAt)}</time> <b>${escapeHtml(from?.name ?? '?')} → ${escapeHtml(to?.name ?? '?')}</b>
      <span class="evidence ${escapeHtml(segment.evidenceLevel)}">${escapeHtml(evidenceNames[segment.evidenceLevel] ?? segment.evidenceLevel)}</span>
      <br><small>${escapeHtml(vectorBasisLabels[segment.basis] ?? segment.basis)} · ${escapeHtml(segment.source?.name ?? 'джерело не вказано')} · ${escapeHtml(gap)}${corroboration}</small>
      ${segment.statement ? `<br><small>«${escapeHtml(segment.statement)}»</small>` : ''}${approximate}${undrawn}</li>`;
  }).join('');
  const span = vector.span ?? {};
  return `<h3>Ланцюг повідомлень</h3>
    <p class="detail-summary">${span.sourceCount ?? 0} джерел${span.sourceCount === 1 ? 'о' : ''} за ${Math.max(1, Math.round((span.elapsedSeconds ?? 0) / 60))} хв · ${vector.nodes.length} точ${vector.nodes.length === 1 ? 'ка' : 'ок'} · ${vector.segments.length} перехід${vector.segments.length === 1 ? '' : 'ів'}</p>
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

function hatchPattern(color, alpha) {
  const size = 24, canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let offset = -size; offset < size * 2; offset += size / 2) { ctx.moveTo(offset, 0); ctx.lineTo(offset + size, size); }
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
  // Позначку «застаріло» дублюємо в summary: на вузьких екранах легенда згорнута,
  // і застарілий шар не має жодного шансу виглядати актуальним.
  legend.innerHTML = `<summary><i class="swatch occupation"></i><span class="legend-title">Тимчасово окуповані території</span>${stale ? '<b class="legend-stale">застаріло</b>' : ''}<span class="legend-caret" aria-hidden="true">▾</span></summary>
    <div class="legend-body">
      <p class="legend-meta"><span>${occupation.capturedLabel ? `Станом на ${escapeHtml(occupation.capturedLabel)}` : 'Час зрізу не вказано'}</span></p>
      ${stale ? '<p class="legend-warning">Шар не оновлювався надто довго. Лінія контролю могла змінитися — не покладайтеся на ці контури як на поточні.</p>' : ''}
      ${rows}
      <p class="legend-note">Окупація — тимчасовий фактичний стан на території України, а не зміна кордону. Державний кордон України залишається незмінним; АР Крим і Севастополь — територія України.</p>
      <p class="legend-source">Джерело шару: <a href="${escapeHtml(attributionUrl)}" target="_blank" rel="noreferrer">${escapeHtml(attributionName)} ↗</a></p>
    </div>`;
}

function initMap() {
  occupationLayersReady = false; // карту створюють наново лише при поверненні на маршрут карти — шари доводиться додавати з нуля
  mapLayersReady = false;
  map = new maplibregl.Map({ container: 'map', style: config.mapStyleUrl, center: [31.2, 48.8], zoom: 5.1, attributionControl: false });
  map.on('styleimagemissing', (event) => {
    if (!map.hasImage(event.id)) map.addImage(event.id, { width: 1, height: 1, data: new Uint8Array([0,0,0,0]) });
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  // Саме 'style.load', а не 'load': 'load' чекає ще й на завантаження тайлів підкладки,
  // тож при повільному або недоступному tiles.openfreemap.org жоден наш шар не зʼявився б —
  // ні державний кордон, ні підпис Криму, ні окупація. Стиль розібрано — можна додавати шари.
  map.on('style.load', () => {
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
    // Заливки тривоги йдуть під ukraine-sovereignty-fill і додаються ПЕРЕД addOccupationLayers(),
    // тож окупаційні шари вставляються поверх них і лишаються читабельними, як і раніше.
    // Золоте підсвічування суверенітету (ukraine-region-fill) теж лишається зверху — воно важливіше за колір тривоги.
    // alert — тривога оголошена дослівно на цю територію; partial — тривога лише в її частині,
    // тому область гасне до ледь помітної, коли районна картина вже читається.
    map.addLayer({ id: 'alert-oblast-fill', type: 'fill', source: 'ukraine-admin', paint: {
      'fill-color': alertColor,
      'fill-opacity': ['interpolate',['linear'],['zoom'],
        RAION_ZOOM_MIN, ['case', alertFlag, .34, unmappedFlag, .24, partialFlag, .18, 0],
        RAION_ZOOM_FULL, ['case', alertFlag, .30, unmappedFlag, .24, partialFlag, .06, 0]]
    } }, 'ukraine-sovereignty-fill');
    map.addLayer({ id: 'alert-raion-fill', type: 'fill', source: 'ukraine-raions', minzoom: RAION_ZOOM_MIN, paint: {
      'fill-color': alertColor,
      'fill-opacity': ['interpolate',['linear'],['zoom'],
        RAION_ZOOM_MIN, 0,
        RAION_ZOOM_FULL, ['case', alertFlag, .40, unmappedFlag, .28, partialFlag, .26, 0]]
    } }, 'ukraine-sovereignty-fill');
    addOccupationLayers();
    // Обидва контури тривоги лежать ПІД ukraine-region-lines: інакше червона межа перекрила б
    // золоту лінію суверенітету навколо Криму й Севастополя. Колір тривоги програє суверенітету.
    map.addLayer({ id: 'alert-raion-line', type: 'line', source: 'ukraine-raions', minzoom: RAION_ZOOM_MIN, paint: {
      'line-color': ['case', alertFlag, alertColor, unmappedFlag, '#ff7a4d', partialFlag, '#ff7a4d', '#72d6ca'],
      'line-width': ['interpolate',['linear'],['zoom'], RAION_ZOOM_MIN, .45, 9, 1.3],
      'line-opacity': ['interpolate',['linear'],['zoom'],
        RAION_ZOOM_MIN, 0,
        RAION_ZOOM_FULL, ['case', alertFlag, .9, unmappedFlag, .66, partialFlag, .62, .22]]
    } }, 'ukraine-region-lines');
    // Навколо Криму й Севастополя червоний контур не малюємо взагалі: там межа має лишатися золотою,
    // бо це підсвічування суверенітету. Сама тривога там читається із заливки — так само, як усюди.
    map.addLayer({ id: 'alert-oblast-line', type: 'line', source: 'ukraine-admin', paint: {
      'line-color': alertColor,
      'line-width': ['interpolate',['linear'],['zoom'], 4, 1.3, 8, 2.6],
      'line-opacity': ['interpolate',['linear'],['zoom'],
        RAION_ZOOM_MIN, ['case', crimeaSovereignty, 0, alertFlag, .85, unmappedFlag, .58, partialFlag, .45, 0],
        RAION_ZOOM_FULL, ['case', crimeaSovereignty, 0, alertFlag, .85, unmappedFlag, .58, partialFlag, .16, 0]]
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
    map.addLayer({ id: 'alert-oblast-label', type: 'symbol', source: 'alert-labels', filter: ['==',['get','level'],'oblast'], layout: {
      'text-field': ['get','label'], 'text-size': ['interpolate',['linear'],['zoom'],4.5,11,8,14],
      'text-transform': 'uppercase', 'text-letter-spacing': .05, 'text-max-width': 7, 'text-padding': 6,
      'text-offset': [0,-1.4], 'text-font': ['Noto Sans Regular']
    }, paint: { 'text-color': '#ffe1d8', 'text-halo-color': '#06080c', 'text-halo-width': 1.9,
      'text-opacity': ['interpolate',['linear'],['zoom'],
        RAION_ZOOM_MIN, ['case', fadingLabel, .8, 1],
        RAION_ZOOM_FULL, ['case', fadingLabel, 0, 1]] } }, 'crimea-ukraine-label');
    map.addLayer({ id: 'alert-raion-label', type: 'symbol', source: 'alert-labels', filter: ['==',['get','level'],'raion'], minzoom: RAION_ZOOM_MIN, layout: {
      'text-field': ['get','label'], 'text-size': 11, 'text-max-width': 8, 'text-padding': 4, 'text-font': ['Noto Sans Regular']
    }, paint: { 'text-color': '#ffd2c6', 'text-halo-color': '#06080c', 'text-halo-width': 1.7,
      'text-opacity': ['interpolate',['linear'],['zoom'],
        RAION_ZOOM_MIN, 0,
        RAION_ZOOM_FULL, ['case', fadingLabel, .8, 1]] } }, 'crimea-ukraine-label');
    map.addSource('live-events', { type: 'geojson', data: markerCollection(), promoteId: 'id' });
    map.addLayer({ id: 'assessment-halo', type: 'circle', source: 'live-events', filter: ['==',['get','kind'],'assessment'], paint: { 'circle-radius': ['+', 12, ['*', ['coalesce',['get','score'],0], 2]], 'circle-color': '#e3b341', 'circle-opacity': .10, 'circle-stroke-width': 1, 'circle-stroke-color': '#e3b341', 'circle-stroke-opacity': .6 } });
    map.addLayer({ id: 'threat-pulse', type: 'circle', source: 'live-events', filter: ['==',['get','kind'],'threat'], paint: { 'circle-radius': 13, 'circle-color': '#ff7a4d', 'circle-opacity': .18, 'circle-stroke-width': 2, 'circle-stroke-color': '#ff7a4d' } });
    map.addLayer({ id: 'event-labels', type: 'symbol', source: 'live-events', layout: { 'text-field': ['get','title'], 'text-size': 11, 'text-offset': [0, 2.1], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': '#e9e7e0', 'text-halo-color': '#06080c', 'text-halo-width': 1.5 } });
    map.addSource('reported-directions', { type: 'geojson', data: directionCollection() });
    map.addLayer({ id: 'direction-lines', type: 'line', source: 'reported-directions', paint: { 'line-color': '#ff7a4d', 'line-width': 3, 'line-dasharray': [2,2], 'line-opacity': .8 } });
    addVectorLayers();
    map.on('click', 'event-labels', (event) => {
      const feature = event.features?.[0]; if (!feature) return;
      const id = feature.properties.entityId;
      if (feature.properties.kind === 'threat' && id) void showThreatDetails(id);
      else if (feature.properties.kind === 'assessment' && id) void showAssessmentDetails(id);
    });
    // Один клік має відкрити одну історію, тож територію вибираємо від найточнішої до найзагальнішої:
    // місто → район → область. Районний шар нижче RAION_ZOOM_MIN не малюється, тож там клік завжди обласний.
    const openTerritory = (event) => {
      const feature = event.features?.[0];
      const layerId = feature?.layer?.id;
      if (!feature?.properties?.locationId) return;
      if (layerId !== 'city-hit' && map.queryRenderedFeatures(event.point, { layers: ['city-hit'] }).length) return;
      if (layerId === 'ukraine-region-fill' && map.queryRenderedFeatures(event.point, { layers: ['alert-raion-fill'] }).length) return;
      void showLocationHistory(feature.properties.locationId);
    };
    for (const layer of ['ukraine-region-fill','alert-raion-fill','city-hit']) {
      map.on('click', layer, openTerritory);
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    }
    mapLayersReady = true;
    applyAlertLayers();
    applyVectors();
  });
  $('#fit-ukraine').addEventListener('click', () => map.fitBounds([[21.5,43.2],[41.2,52.5]], { padding: 36, duration: 700 }));
}

function updateMap() {
  if (!mapLayersReady) return;
  map.getSource('live-events')?.setData(markerCollection());
  map.getSource('reported-directions')?.setData(directionCollection());
  applyAlertLayers();
  applyVectors();
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
  dialog.innerHTML = `<div class="detail-head"><div><p>${escapeHtml(kicker)}</p><h2>${escapeHtml(title)}</h2></div><button aria-label="Закрити">×</button></div><div class="detail-body">${body}</div>`;
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
    `<p class="detail-summary">${escapeHtml(item.summary)}</p><dl><div><dt>Остання згадка</dt><dd>${escapeHtml(agoOrUnknown(new Date(item.last_observed_at).getTime()))}</dd></div><div><dt>Дійсна до</dt><dd>${item.valid_until ? escapeHtml(shortTime(item.valid_until)) : 'не визначено'}</dd></div><div><dt>Напрямок</dt><dd>${escapeHtml(item.direction_text || 'не повідомлявся')}</dd></div></dl>${vectorChainHtml(vector)}<h3>Джерела</h3>${sources}${updates ? `<h3>Історія змін</h3><ol class="update-list">${updates}</ol>` : ''}<div class="safety-note"><strong>Геометрія не є прогнозом</strong><p>Система показує лише дослівно повідомлену територію або напрямок і не екстраполює маршрут.</p></div>`);
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

async function showLocationHistory(id) {
  const response = await fetch(`/api/v1/locations/${encodeURIComponent(id)}/timeline?limit=100`);
  if (!response.ok) return openDetail('Територію не знайдено', 'Помилка', '<p>Не вдалося завантажити історію.</p>');
  const data = await response.json();
  const kindNames = { alert: 'офіційна тривога', threat: 'загроза', assessment: 'аналітика' };
  const items = data.items.map((item) => `<article class="territory-entry ${escapeHtml(item.kind)}" data-kind="${escapeHtml(item.kind)}" data-entry-id="${escapeHtml(item.id)}">
    <div><span>${escapeHtml(kindNames[item.kind] ?? item.kind)}</span><time>${new Date(item.happened_at).toLocaleString('uk-UA')}</time></div>
    <h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.summary)}</p>
    <footer><b>${escapeHtml(threatNames[item.threat_type] ?? item.threat_type)}</b>${item.risk_score != null ? `<strong>${escapeHtml(item.risk_score)}/10 · ${escapeHtml(levelNames[item.risk_level] ?? item.risk_level)}</strong>` : `<strong>${escapeHtml(item.evidence_level ?? item.status)}</strong>`}</footer>
  </article>`).join('') || '<div class="empty-state"><strong>Історія поки порожня</strong><p>Для цієї території ще немає збережених тривог, загроз або аналітичних попереджень.</p></div>';
  const dialog = openDetail(data.location.name_uk, 'Історія території',
    `<div class="territory-summary"><div><strong>${data.counts.alerts}</strong><span>тривоги</span></div><div><strong>${data.counts.threats}</strong><span>загрози</span></div><div><strong>${data.counts.assessments}</strong><span>оцінки</span></div></div>
     <div class="territory-filters"><button class="is-active" data-territory-filter="all">Усе</button><button data-territory-filter="alert">Тривоги</button><button data-territory-filter="threat">Загрози</button><button data-territory-filter="assessment">Аналітика</button></div>
     <div class="territory-timeline">${items}</div>
     <a class="territory-all" href="/history?location=${encodeURIComponent(id)}" data-route="/history">Відкрити повну хронологію →</a>`);
  dialog.querySelectorAll('[data-territory-filter]').forEach((button) => button.addEventListener('click', () => {
    dialog.querySelectorAll('[data-territory-filter]').forEach((item) => item.classList.toggle('is-active', item === button));
    dialog.querySelectorAll('.territory-entry').forEach((entry) => { entry.hidden = button.dataset.territoryFilter !== 'all' && entry.dataset.kind !== button.dataset.territoryFilter; });
  }));
  dialog.querySelectorAll('.territory-entry').forEach((entry) => entry.addEventListener('click', () => {
    if (entry.dataset.kind === 'threat') void showThreatDetails(entry.dataset.entryId);
    if (entry.dataset.kind === 'assessment') void showAssessmentDetails(entry.dataset.entryId);
  }));
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
  // Ланцюги йдуть у групу «Загрози»: вони пояснюють ті самі події й не заслуговують окремого
  // перемикача, який довелося б додавати в public/index.html — файл, який зараз правлять інші гілки.
  const layerGroups = { alerts: alertLayerIds, threats: ['threat-pulse','direction-lines',...vectorLayerIds], assessments: ['assessment-halo'] };
  document.querySelectorAll('.layer-toggle').forEach((button) => button.addEventListener('click', () => {
    button.classList.toggle('is-active');
    const active = button.classList.contains('is-active');
    if (button.dataset.layer === 'occupation') {
      occupationVisible = active;
      applyOccupationVisibility();
      $('#occupation-legend')?.classList.toggle('is-off', !occupationVisible);
      return;
    }
    (layerGroups[button.dataset.layer] ?? []).forEach((layer) => map.getLayer(layer) && map.setLayoutProperty(layer, 'visibility', active ? 'visible' : 'none'));
  }));
  const legend = $('#occupation-legend');
  // Вибір користувача переживає перемальовування сторінки після кожної події потоку.
  legend.open = occupationLegendOpen ?? window.matchMedia('(min-width: 981px)').matches;
  legend.addEventListener('toggle', () => { occupationLegendOpen = legend.open; });
  renderOccupationLegend();
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
  return `<section class="ops-section"><header class="ops-section-head"><div><p>Тільки для оператора</p><h2>Вектори загроз: екстраполяція</h2></div></header>
    <div class="safety-note"><strong>Не для публікації</strong><p>${escapeHtml(payload.notice ?? '')}</p></div>
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
  'shadow-classifier-v1': 'Тіньова класифікація'
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

function aiRunRow(run) {
  const failed = run.status === 'failed';
  return `<article data-ai-run="${escapeHtml(run.id)}">
    <div>
      <span>${escapeHtml(promptVersionNames[run.prompt_version] ?? run.prompt_version)}</span>
      <h3>${escapeHtml(run.model)}</h3>
      <p>${new Date(run.created_at).toLocaleString('uk-UA')} · запит ${bytesLabel(run.input_bytes)} · відповідь ${bytesLabel(run.output_bytes)}${run.duration_ms != null ? ` · ${run.duration_ms} мс` : ''}</p>
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
  return `<section class="ops-section" id="ai-runs-section">
    <header class="ops-section-head">
      <div><p>Аудит моделі</p><h2>Журнал звернень</h2></div>
      <button data-ai-runs-refresh>Оновити</button>
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
    const data = await opsFetch('/ops/ai-runs?limit=50').then((r) => r.ok ? r.json() : null).catch(() => null);
    const section = $('#ai-runs-section', root);
    if (!section) return;
    section.outerHTML = opsAiRunsSection(data, codex, settings);
    wireAiRunsSection(root, codex, settings);
  };

  $('[data-ai-runs-refresh]', root)?.addEventListener('click', () => void rerender());

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

function sourceTrustRow(source) {
  const components = source.components ?? {};
  // Тон — не прикраса, як і в решті ops-консолі: звичайне й нейтральне джерело лишається беззвучним,
  // бо жодної дії не вимагає, і саме тому знижена довіра помітна. Якби «звичайна» світилася
  // застережним тоном, то світився б увесь каталог — а список, у якому все жовте, не вирізняє нічого.
  const state = source.trust == null ? { label: 'не виміряно', tone: 'off' }
    : source.neutral ? { label: 'нейтрально', tone: 'off' }
      : source.label === 'висока' ? { label: 'висока', tone: 'ok' }
        : source.label === 'знижена' ? { label: 'знижена', tone: 'bad' }
          : { label: 'звичайна', tone: 'off' };
  return `<article>
    <div>
      <span>TIER ${escapeHtml(source.tier)}${source.official ? ' · офіційне' : ''} · група ${escapeHtml(source.independenceGroup)}</span>
      <h3>${escapeHtml(source.name)}</h3>
      <p>${source.trust == null ? 'Нічного розрахунку для цього джерела ще не було.' : `довіра ${Number(source.trust).toFixed(2)} · модифікатор внеску ×${Number(source.modifier).toFixed(2)}`}</p>
      <dl class="codex-facts">
        <div><dt>Відкликано тверджень</dt><dd>${trustPercent(components.withdrawnShare)}</dd></div>
        <div><dt>Підтверджено іншими</dt><dd>${trustPercent(components.corroboratedShare)}</dd></div>
        <div><dt>Першим повідомив</dt><dd>${trustCount(components.firstReports)} подій</dd></div>
        <div><dt>Медіанний лаг</dt><dd>${escapeHtml(trustLagLabel(components.lagMedianSeconds))}</dd></div>
        <div><dt>Не вдалося прочитати</dt><dd>${trustPercent(components.unreadableShare)}</dd></div>
        <div><dt>Обсяг вибірки</dt><dd>${trustCount(components.sampleSize)} подій</dd></div>
      </dl>
    </div>
    <div class="ops-channel-actions"><span class="codex-state is-${state.tone}">${escapeHtml(state.label)}</span></div>
  </article>`;
}

function opsSourceTrustSection(data) {
  if (!data) return '<section class="ops-section" id="source-trust-section"><header class="ops-section-head"><div><p>Джерела</p><h2>Довіра до джерел</h2></div></header><p class="legend-note">Розрахунок довіри недоступний.</p></section>';
  const methodology = data.methodology ?? {};
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
    <div class="safety-note"><strong>Довіра не змінює рівень джерела</strong><p>${escapeHtml(methodology.notice ?? '')}</p></div>
    <div class="ops-channel-list">${(data.sources ?? []).map(sourceTrustRow).join('')}</div>
  </section>`;
}

function wireSourceTrustSection(root) {
  $('[data-source-trust-recalculate]', root)?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true; button.textContent = 'Рахуємо…';
    await opsFetch('/ops/api/source-trust/recalculate', { method: 'POST' }).catch(() => null);
    const data = await opsFetch('/ops/api/source-trust').then((r) => r.ok ? r.json() : null).catch(() => null);
    const section = $('#source-trust-section', root);
    if (!section) return;
    section.outerHTML = opsSourceTrustSection(data);
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
    <div class="safety-note">
      <strong>Повернення можливе лише на localhost</strong>
      <p>Клієнт Codex приймає єдину адресу повернення — <code>${escapeHtml(status.redirectUri)}</code>. Вхід завершиться тільки тоді, коли браузер і застосунок бачать один і той самий <code>localhost</code>: на вашій машині так, на віддаленому сервері за Caddy — ні. Крім того, вхід Codex призначено для клієнта Codex, а не для стороннього сервера, який працює цілодобово; ризик санкцій до облікового запису лишається на вас.</p>
    </div>
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
  // з'являється ніде, крім таблиці звірки нижче. Підпис мусить сказати обидві речі: що це тіньовий
  // режим і що на бойовий шлях він не впливає ніколи.
  shadow: {
    title: 'Тіньова класифікація',
    note: 'Модель читає ті самі повідомлення після того, як правила вже ухвалили рішення, і її вердикт лягає поруч для звірки. На оповіщення, події й карту це не впливає ніколи. Єдиний перемикач, який витрачає виклик на кожне повідомлення, — тому він і найдорожчий.'
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

async function renderOps() {
  clearInterval(codexPollTimer);
  const root = contentShell('Закритий контур', 'Операційна консоль', 'Стан системи та керування каталогом рекомендованих Telegram-каналів.');
  const response = await opsFetch('/ops/api');
  if (response.status === 401) {
    opsAuthorization = '';
    root.innerHTML = `<form class="ops-login"><span>AUTH / BASIC</span><h2>Вхід оператора</h2><p>Облікові дані залишаються лише в памʼяті цієї вкладки.</p><label>Користувач<input required name="username" autocomplete="username" value="operator"></label><label>Пароль<input required name="password" type="password" autocomplete="current-password"></label><button>Увійти</button><output></output></form>`;
    $('.ops-login', root).addEventListener('submit', async (event) => {
      event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
      opsAuthorization = basicAuthorization(values.get('username'), values.get('password'));
      const check = await opsFetch('/ops/api');
      if (check.ok) return void renderOps();
      opsAuthorization = ''; $('output', form).textContent = 'Неправильний логін або пароль.';
    });
    return;
  }
  if (!response.ok) { root.innerHTML = '<p>Операційна консоль тимчасово недоступна.</p>'; return; }
  const data = await response.json();
  // Екстраполяція живе тільки тут. Запит іде на окремий ендпоінт за тим самим Basic-логіном; жоден
  // публічний маршрут її не віддає, і жоден інший екран цієї функції не викликає.
  // Стан входу приходить у складі налаштувань, а не окремим запитом: перемикач «увімкнено» поруч
  // із мертвою сесією — найзаплутаніший стан цієї функції, і показати їх із двох різних моментів
  // означало б зробити його ще заплутанішим.
  const [vectorOps, codexSettings, aiRuns, shadow, sourceTrust] = await Promise.all([
    opsFetch('/ops/vectors').then((result) => result.ok ? result.json() : null).catch(() => null),
    opsFetch('/ops/codex/settings').then((result) => result.ok ? result.json() : null).catch(() => null),
    opsFetch('/ops/ai-runs?limit=50').then((result) => result.ok ? result.json() : null).catch(() => null),
    opsFetch('/ops/shadow-classifier?hours=24').then((result) => result.ok ? result.json() : null).catch(() => null),
    opsFetch('/ops/api/source-trust').then((result) => result.ok ? result.json() : null).catch(() => null)
  ]);
  const codex = codexSettings?.status ?? null;
  const queued = data.outbox.reduce((sum, item) => sum + Number(item.count), 0);
  root.innerHTML = `<div class="ops-metrics"><article><span>Джерела</span><strong>${data.sources.length}</strong></article><article><span>Черга</span><strong>${queued}</strong></article><article><span>Канали</span><strong>${data.channels.filter((item) => item.active).length}</strong></article><article><span>PostgreSQL</span><strong>${escapeHtml(data.database.size)}</strong></article></div>
    <section class="ops-section"><header class="ops-section-head"><div><p>Каталог для користувачів</p><h2>Додати Telegram-канал</h2></div><button id="ops-logout">Вийти</button></header>
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
    ${opsSourceTrustSection(sourceTrust)}
    <div class="ops-group" id="codex-group">
      <header class="ops-group-head"><p>Модель в аналітиці</p><h2>Codex-аналітика</h2>
        <p>Вхід, вибір моделі, чотири перемикачі, звірка з правилами й журнал усіх звернень — усе, що визначає, коли систему пише машина, і що саме вона написала.</p></header>
      ${opsCodexSection(codex, codexSettings?.settings ?? null)}
      ${opsCodexSettingsSection(codexSettings)}
      ${opsShadowSection(shadow, codexSettings?.settings ?? null)}
      ${opsAiRunsSection(aiRuns, codex, codexSettings?.settings ?? null)}
    </div>
    ${opsVectorSection(vectorOps)}
    <details class="ops-raw"><summary>Технічний стан і журнали</summary><pre class="ops-json">${escapeHtml(JSON.stringify({ sources: data.sources, outbox: data.outbox, aiRuns: data.aiRuns, database: data.database }, null, 2))}</pre></details>`;
  wireCodexSection(root, codexSettings?.settings ?? null);
  wireCodexSettingsSection(root, () => renderOps());
  wireShadowSection(root, codexSettings?.settings ?? null);
  wireAiRunsSection(root, codex, codexSettings?.settings ?? null);
  wireSourceTrustSection(root);
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

function renderCurrentRoute() {
  if (!snapshot) return;
  const route = activePage();
  // Карту знімаємо лише коли справді йдемо з маршруту карти — на місці вона переживає оновлення знімка.
  if (map && route !== '/') { map.remove(); map = null; mapLayersReady = false; }
  // Опитування стану входу Codex прив'язане до вузла, якого поза консоллю вже немає.
  if (route !== '/ops') clearInterval(codexPollTimer);
  if (route === '/') renderMapPage();
  else if (route === '/history') void renderHistory();
  else if (route === '/attacks') void renderAttacks();
  else if (route === '/analytics') void renderAnalytics();
  else if (route === '/sources') void renderSources();
  else if (route === '/ops') void renderOps();
  else void renderAbout();
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
  setInterval(() => void loadOccupation(), 900000);
}
boot().catch(markOffline);
