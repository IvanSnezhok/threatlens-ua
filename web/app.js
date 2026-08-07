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
const occupationLayerIds = ['occupation-fill', 'occupation-hatch', 'occupation-line', 'occupation-contested-line'];
const occupationColor = ['case', ['==',['get','status'],'occupied'], '#ff7a4d', ['==',['get','status'],'liberated'], '#72d6ca', '#8f9b94'];

let snapshot = null;
let map = null;
let config = null;
let locations = [];
let adminBoundaries = { type: 'FeatureCollection', features: [] };
let countryBoundary = { type: 'FeatureCollection', features: [] };
let occupation = null;
let occupationVisible = true;
let occupationLayersReady = false;
let occupationLegendOpen = null;
let occupationFetchedAt = null;
let opsAuthorization = '';
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
}

function connectStream() {
  const source = new EventSource('/api/v1/stream');
  source.addEventListener('connected', () => { lastReceived = new Date(); updateFreshness(); });
  const schedule = () => {
    lastReceived = new Date();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => loadSnapshot().catch(markOffline), 250);
  };
  ['alert.started','alert.ended','threat.created','threat.updated','threat.corrected','assessment.updated','source.stale','source.recovered'].forEach((name) => source.addEventListener(name, schedule));
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
    <div class="risk-row"><strong>${item.risk_score}<small>/10</small></strong><span>${levelNames[item.risk_level] ?? item.risk_level}<br><small>${item.indicative_percent ?? Math.round(item.risk_score * 10)}% індикативно · ${item.assessment_confidence}</small></span></div>
    <div class="event-foot"><b>НЕ Є ТРИВОГОЮ</b><span>до ${shortTime(item.horizon_end)}</span></div></article>`;
  return `<article class="event-card ${item.evidenceLevel}" data-event="${item.id}">
    <div class="event-meta"><span>${escapeHtml(evidenceNames[item.evidenceLevel] ?? item.evidenceLevel)}</span><time>${shortTime(item.lastObservedAt)}</time></div>
    <h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.summary)}</p>
    <div class="location-tags">${item.locations.map((loc) => `<span>${escapeHtml(loc.name)}</span>`).join('')}</div>
    <div class="event-foot"><b>${escapeHtml(threatNames[item.threatType] ?? item.threatType)}</b><span>${timeAgo(item.lastObservedAt)}</span></div></article>`;
}

function markerCollection() {
  const features = [];
  for (const alert of snapshot.alerts) if (alert.longitude != null) features.push({ type: 'Feature', id: `a-${alert.id}`, geometry: { type: 'Point', coordinates: [alert.longitude, alert.latitude] }, properties: { kind: 'alert', title: alert.location_name } });
  for (const threat of snapshot.threats) for (const loc of threat.locations) if (loc.longitude != null) features.push({ type: 'Feature', id: `t-${threat.id}-${loc.id}`, geometry: { type: 'Point', coordinates: [loc.longitude, loc.latitude] }, properties: { kind: 'threat', entityId: threat.id, title: threat.title, evidence: threat.evidenceLevel } });
  for (const risk of snapshot.assessments) if (risk.longitude != null) features.push({ type: 'Feature', id: `r-${risk.id}`, geometry: { type: 'Point', coordinates: [risk.longitude, risk.latitude] }, properties: { kind: 'assessment', entityId: risk.id, title: risk.location_name, score: Number(risk.risk_score) } });
  return { type: 'FeatureCollection', features };
}

function directionCollection() {
  return { type: 'FeatureCollection', features: snapshot.threats.filter((threat) => threat.geometry?.type === 'LineString').map((threat) => ({ type: 'Feature', id: threat.id, geometry: threat.geometry, properties: { title: threat.title } })) };
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
  occupationLayersReady = false; // карту перестворюють на кожному оновленні знімка — шар доводиться додавати наново
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
    map.addSource('ukraine-cities', { type: 'geojson', data: cityCollection(), promoteId: 'locationId' });
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
      'line-color': '#b7ef56', 'line-width': ['interpolate',['linear'],['zoom'],4,1.8,8,3.4], 'line-opacity': .95
    } });
    addOccupationLayers();
    map.addLayer({ id: 'city-hit', type: 'circle', source: 'ukraine-cities', minzoom: 5.7, paint: {
      'circle-radius': ['interpolate',['linear'],['zoom'],5.7,3,9,6], 'circle-color': '#72d6ca',
      'circle-opacity': .82, 'circle-stroke-color': '#09100f', 'circle-stroke-width': 1.5
    } });
    map.addLayer({ id: 'city-labels', type: 'symbol', source: 'ukraine-cities', minzoom: 7.2, layout: {
      'text-field': ['get','nameUk'], 'text-size': 10, 'text-offset': [0,1.15], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular']
    }, paint: { 'text-color': '#d8e7df', 'text-halo-color': '#09100f', 'text-halo-width': 1.4 } });
    map.addLayer({ id: 'crimea-ukraine-label', type: 'symbol', source: 'sovereignty-labels', minzoom: 4.2, layout: {
      'text-field': ['get','label'], 'text-size': ['interpolate',['linear'],['zoom'],4.2,10,7,14],
      'text-letter-spacing': .12, 'text-font': ['Noto Sans Regular']
    }, paint: { 'text-color': '#f3efd9', 'text-halo-color': '#09100f', 'text-halo-width': 2 } });
    map.addSource('live-events', { type: 'geojson', data: markerCollection(), promoteId: 'id' });
    map.addLayer({ id: 'assessment-halo', type: 'circle', source: 'live-events', filter: ['==',['get','kind'],'assessment'], paint: { 'circle-radius': ['+', 12, ['*', ['coalesce',['get','score'],0], 2]], 'circle-color': '#e3b341', 'circle-opacity': .10, 'circle-stroke-width': 1, 'circle-stroke-color': '#e3b341', 'circle-stroke-opacity': .6 } });
    map.addLayer({ id: 'threat-pulse', type: 'circle', source: 'live-events', filter: ['==',['get','kind'],'threat'], paint: { 'circle-radius': 13, 'circle-color': '#ff7a4d', 'circle-opacity': .18, 'circle-stroke-width': 2, 'circle-stroke-color': '#ff7a4d' } });
    map.addLayer({ id: 'alert-pulse', type: 'circle', source: 'live-events', filter: ['==',['get','kind'],'alert'], paint: { 'circle-radius': 20, 'circle-color': '#ff3d3d', 'circle-opacity': .3, 'circle-stroke-width': 4, 'circle-stroke-color': '#ff3d3d' } });
    map.addLayer({ id: 'event-labels', type: 'symbol', source: 'live-events', layout: { 'text-field': ['get','title'], 'text-size': 11, 'text-offset': [0, 2.1], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': '#f4f0df', 'text-halo-color': '#09100f', 'text-halo-width': 1.5 } });
    map.addSource('reported-directions', { type: 'geojson', data: directionCollection() });
    map.addLayer({ id: 'direction-lines', type: 'line', source: 'reported-directions', paint: { 'line-color': '#ff7a4d', 'line-width': 3, 'line-dasharray': [2,2], 'line-opacity': .8 } });
    map.on('click', 'event-labels', (event) => {
      const feature = event.features?.[0]; if (!feature) return;
      const id = feature.properties.entityId;
      if (feature.properties.kind === 'threat' && id) void showThreatDetails(id);
      else if (feature.properties.kind === 'assessment' && id) void showAssessmentDetails(id);
      else new maplibregl.Popup({ closeButton: false }).setLngLat(event.lngLat).setHTML(`<strong>${escapeHtml(feature.properties.title)}</strong><p>Офіційна тривога активна.</p>`).addTo(map);
    });
    const openTerritory = (event) => {
      const feature = event.features?.[0];
      if (feature?.layer?.id === 'ukraine-region-fill'
        && map.queryRenderedFeatures(event.point, { layers: ['city-hit'] }).length) return;
      if (feature?.properties?.locationId) void showLocationHistory(feature.properties.locationId);
    };
    map.on('click', 'ukraine-region-fill', openTerritory);
    map.on('click', 'city-hit', openTerritory);
    for (const layer of ['ukraine-region-fill','city-hit']) {
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    }
  });
  $('#fit-ukraine').addEventListener('click', () => map.fitBounds([[21.5,43.2],[41.2,52.5]], { padding: 36, duration: 700 }));
}

function updateMap() {
  if (!map?.loaded()) return;
  map.getSource('live-events')?.setData(markerCollection());
  map.getSource('reported-directions')?.setData(directionCollection());
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

async function showThreatDetails(id) {
  const response = await fetch(`/api/v1/threats/${encodeURIComponent(id)}`);
  if (!response.ok) return openDetail('Подію не знайдено', 'Помилка', '<p>Дані могли бути архівовані або виправлені.</p>');
  const item = await response.json();
  const sources = item.evidence.map((source) => {
    const url = safeUrl(source.public_url);
    return `<article class="evidence-row"><div><span>TIER ${escapeHtml(source.tier)} · ${source.official ? 'офіційне' : 'допоміжне'}</span><strong>${escapeHtml(source.name)}</strong></div><time>${new Date(source.published_at).toLocaleString('uk-UA')}</time><p>${escapeHtml(source.raw_text)}</p>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Першоджерело ↗</a>` : ''}</article>`;
  }).join('') || '<p>Публічних доказів ще немає.</p>';
  const updates = item.updates.map((update) => `<li><time>${new Date(update.created_at).toLocaleString('uk-UA')}</time> ${escapeHtml(update.reason)}: ${escapeHtml(update.new_status)} / ${escapeHtml(update.new_evidence_level)}</li>`).join('');
  openDetail(item.title, evidenceNames[item.evidence_level] ?? item.evidence_level,
    `<p class="detail-summary">${escapeHtml(item.summary)}</p><dl><div><dt>Остання згадка</dt><dd>${new Date(item.last_observed_at).toLocaleString('uk-UA')}</dd></div><div><dt>Дійсна до</dt><dd>${item.valid_until ? new Date(item.valid_until).toLocaleString('uk-UA') : 'не визначено'}</dd></div><div><dt>Напрямок</dt><dd>${escapeHtml(item.direction_text || 'не повідомлявся')}</dd></div></dl><h3>Джерела</h3>${sources}${updates ? `<h3>Історія змін</h3><ol class="update-list">${updates}</ol>` : ''}<div class="safety-note"><strong>Геометрія не є прогнозом</strong><p>Система показує лише дослівно повідомлену територію або напрямок і не екстраполює маршрут.</p></div>`);
}

async function showAssessmentDetails(id) {
  const response = await fetch(`/api/v1/assessments/${encodeURIComponent(id)}`);
  if (!response.ok) return openDetail('Оцінку не знайдено', 'Помилка', '<p>Оцінка могла втратити актуальність.</p>');
  const item = await response.json(); const explanation = item.explanation ?? {};
  const factors = (explanation.raisingFactors ?? []).map((factor) => `<li>${escapeHtml(factor)}</li>`).join('');
  const limits = (explanation.limitingFactors ?? []).map((factor) => `<li>${escapeHtml(factor)}</li>`).join('');
  const signals = item.signals.map((signal) => `<article class="signal-row"><strong>${escapeHtml(signal.signal_type)}</strong><span>TIER ${escapeHtml(signal.source_tier)} · внесок ${Number(signal.contribution).toFixed(2)}</span><small>${escapeHtml(signal.source_name || 'джерело не вказано')} · ${new Date(signal.observed_at).toLocaleString('uk-UA')}</small></article>`).join('');
  openDetail(`${item.location_name}: ${threatNames[item.threat_type] ?? item.threat_type}`, 'Аналітична оцінка, не тривога',
    `<div class="detail-score"><strong>${item.risk_score}<small>/10</small></strong><span>${escapeHtml(levelNames[item.risk_level])}<br>${item.indicative_percent ?? Math.round(item.risk_score * 10)}% індикативно · впевненість ${escapeHtml(item.assessment_confidence)}</span></div><p class="detail-summary">${escapeHtml(explanation.summary || '')}</p><dl><div><dt>Горизонт</dt><dd>${new Date(item.horizon_start).toLocaleString('uk-UA')} — ${new Date(item.horizon_end).toLocaleString('uk-UA')}</dd></div><div><dt>Методологія</dt><dd>${escapeHtml(item.methodology_version)} · ${escapeHtml(item.model_version)}</dd></div></dl>${factors ? `<h3>Що підвищує індекс</h3><ul>${factors}</ul>` : ''}${limits ? `<h3>Що обмежує оцінку</h3><ul>${limits}</ul>` : ''}<h3>Сигнали</h3>${signals}<div class="safety-note"><strong>Не статистична ймовірність</strong><p>${escapeHtml(explanation.caveat || 'Це відносний індекс публічних сигналів. Низький рівень не означає безпеку.')}</p></div>`);
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

function renderMapPage() {
  $('#app').replaceChildren($('#map-page').content.cloneNode(true));
  const telegramLink = document.querySelector('.telegram-cta');
  if (config.telegramBotUsername) {
    telegramLink.href = `https://t.me/${config.telegramBotUsername.replace(/^@/, '')}`;
  } else telegramLink.hidden = true;
  const items = [
    ...snapshot.alerts.map((item) => ({ type: 'alert', item })),
    ...snapshot.threats.map((item) => ({ type: 'threat', item })),
    ...snapshot.assessments.slice(0, 8).map((item) => ({ type: 'assessment', item }))
  ];
  $('#event-count').textContent = items.length;
  $('#event-list').innerHTML = items.length ? items.map(({ item, type }) => eventCard(item, type)).join('') : `<div class="empty-state"><strong>Немає активних офіційних повідомлень</strong><p>Це не означає відсутність загрози. Стежте за офіційними каналами.</p></div>`;
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
  const layerGroups = { alerts: ['alert-pulse'], threats: ['threat-pulse','direction-lines'], assessments: ['assessment-halo'] };
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
    $('#analytics-results', root).innerHTML = `<div class="metric-grid"><div><span>Тривоги</span><strong>${data.alerts.reduce((s, x) => s + x.alerts_count, 0)}</strong><small>завершених інтервалів</small></div><div><span>Загрози</span><strong>${data.threats.reduce((s, x) => s + x.threat_events, 0)}</strong><small>зафіксованих подій</small></div><div><span>Оцінки</span><strong>${risk.length}</strong><small>актуальних горизонтів</small></div></div><div class="analytics-note">Підрахунок загроз означає кількість нормалізованих інформаційних подій, а не атак, пусків або влучань.</div><div class="assessment-table">${risk.map((item) => `<article data-assessment="${item.id}"><div><span>${escapeHtml(item.location_name)}</span><strong>${threatNames[item.threat_type] ?? item.threat_type}</strong></div><b>${item.risk_score}<small>/10</small></b><p>${levelNames[item.risk_level]} · ${item.indicative_percent ?? Math.round(item.risk_score * 10)}% індикативно · ${item.assessment_confidence}</p><button class="text-button">Пояснення →</button></article>`).join('') || '<p>Актуальних оцінок немає.</p>'}</div>`;
    document.querySelectorAll('.assessment-table [data-assessment]').forEach((card) => card.addEventListener('click', () => void showAssessmentDetails(card.dataset.assessment)));
  };
  $('.filter-bar', root).addEventListener('submit', (event) => { event.preventDefault(); void load(); }); await load();
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

async function renderOps() {
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
    <details class="ops-raw"><summary>Технічний стан і журнали</summary><pre class="ops-json">${escapeHtml(JSON.stringify({ sources: data.sources, outbox: data.outbox, aiRuns: data.aiRuns, database: data.database }, null, 2))}</pre></details>`;
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
  if (map) { map.remove(); map = null; }
  if (route === '/') renderMapPage();
  else if (route === '/history') void renderHistory();
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
  $('#demo-label').hidden = !config.demoMode;
  if (location.pathname === '/tv') document.body.classList.add('tv-mode');
  window.Telegram?.WebApp?.ready(); window.Telegram?.WebApp?.expand();
  void loadOccupation(); // довідковий шар вантажиться окремо й не блокує старт карти
  await loadSnapshot(); connectStream();
  setInterval(() => void loadOccupation(), 900000);
}
boot().catch(markOffline);
