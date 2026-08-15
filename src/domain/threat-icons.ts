/**
 * The threat-class icon catalogue and the deterministic order that decides which three of them a
 * territory shows.
 *
 * Pure by contract: zero database access, zero `config` import, zero `Date.now()`. The caller passes
 * `now`, and that single fact is what makes the ranking reproducible between the server, the unit
 * tests and any replay of a recorded snapshot — «алгоритм має бути детермінованим» is not a wish
 * about the output, it is a constraint on the inputs.
 *
 * ## Precondition the ranking is written against
 *
 * `composeTerritoryStates` produces **at most one candidate per threat class per territory**: one
 * `TerritoryThreat` per class, and an `analytic` candidate only for a class that has no live threat
 * at all. Keys 5–7 of the order are therefore unreachable in production; they exist so the order
 * stays total if that invariant is ever relaxed, and they are unit-tested directly against
 * same-class pairs.
 *
 * ## Known limit of the danger ladder
 *
 * The classifier collapses every multi-class report into `combined`
 * (`matchedTypes.length > 1 ? 'combined' : …`, src/domain/classifier.ts), so a combined report that
 * contained ballistics ranks below a pure ballistic report. The ladder cannot recover the members.
 * It matters little because danger is only key #4 — state, evidence and freshness all dominate it —
 * and inventing a member list would be worse than ranking the class we actually recorded.
 */
import { THREAT_TYPES, type EvidenceLevel, type RelationType, type ThreatType } from '../types.js';

/**
 * The ten threat classes as filled 512×512 silhouettes.
 *
 * ## Where the glyphs come from, and what that obliges us to
 *
 * Every path below is a glyph from **game-icons.net**, used under **CC BY 3.0**. The per-class
 * comments name the exact author and icon, and the licence notice is shown to the reader in the map
 * legend (`web/app.js`, `renderVectorLegend`) — attribution that lives only in a source comment is
 * not attribution, because nobody who receives the work ever sees it.
 *
 * They replaced ten hand-drawn 24×24 silhouettes. Two reasons, and the second is the load-bearing
 * one. The hand-drawn set had gone stale in style; more seriously, `cruise_missile` and `aviation`
 * had converged on almost the same aeroplane, `artillery` had degenerated into a bare trapezium and
 * `combined` into a triangle — three classes the reader could not tell apart on the map, which is
 * the only thing an icon is for. The replacements were chosen against that test and checked by
 * rendering all ten at 20 px before any of this was written.
 *
 * The grid changed with them: 24 → 512, because that is what game-icons draws on. Rescaling the
 * paths by hand would gain nothing and lose fidelity — `web/app.js` already scales the glyph box by
 * `ICON_GLYPH_BOX / ICON_GLYPH_GRID`, so the grid is a number in one place, not a format.
 *
 * These are richer in detail than what they replaced, which is why the glyph now occupies 80% of the
 * chip rather than 60% while the chip itself shrank from 30 px to 24 px. At the old 60% the thin
 * elements — a launcher's rails, a drone's arms — disappeared entirely at overview zoom.
 *
 * Why path strings and not files: `npm run build:web` is a bare `esbuild --bundle` with no
 * asset-copy step, and production CSP is `default-src 'self'`. An icon that lives in a file is an
 * icon that has to be fetched, and a fetch that fails is an icon that MapLibre silently replaces
 * with a 1×1 transparent image (`map.on('styleimagemissing')`, web/app.js:679-681). A string in the
 * bundle cannot fail to arrive.
 *
 * ## Why no arrows — and why a missile with a nose is not one
 *
 * An arrow drawn on a territory asserts a predicted target. This system does not predict targets,
 * and says so in eight places.
 *
 * Several of these glyphs do have an inherent orientation, because the objects do: a rocket has a
 * nose, a falling bomb has a down. That is a depiction, not a bearing, and the distinction is
 * mechanical rather than a matter of reading — **the chip is never rotated**. `icon-rotate` is not
 * set on any of the four territory-icon layers, so the glyph sits at the same angle over Sumy as
 * over Odesa and cannot encode a direction even in principle. The one bitmap on this map that IS
 * rotated is the vector arrowhead, and it is not from this table.
 *
 * The map does draw one arrowhead, and it is not one of these and never will be: it belongs to a
 * threat-vector leg whose basis is `reported_transit` or `reported_direction` — a movement a source
 * stated in so many words, between two places that source named — and it lives in `web/app.js` as
 * its own bitmap. The difference is the whole rule: that arrow points from a reported place to
 * another reported place, while an arrow on a *territory glyph* would point at a target nobody
 * reported. A leg the sources did not assert (`observation_sequence`) gets no arrowhead either.
 *
 * Дзеркальна копія цієї мапи живе у web/app.js (`threatIconPaths`). Змінюєш тут — зміни й там.
 */
export const THREAT_ICON_PATHS: Record<ThreatType, string> = {
  // Балістична: тіло на висхідній гілці з розкиданим слідом.
  // Джерело: game-icons.net · lorc/rocket-flight · CC BY 3.0
  ballistic_missile:
    'M482.22 44.844l-50.533 46.25-21.937 57.22c-34.637 15.445-47.955 24.442-61.47 74.874l39.564-17.657-1.875 '
    + '32.095 37.342 14.344 21.75-24.5 17.625 39.56c24.52-42.467 25.663-63.24 '
    + '4.282-96.78l21.936-57.22-6.687-68.186zM389.093 263.22c-16.33 25.16-38.017 48.57-63.063 '
    + '68.217-.022.018-.038.045-.06.063-37.302 23.693-83.27 29.138-118.095 15.688 16.236 15.056 37.635 20.705 '
    + '59.156 19.156-49.41 14.874-102.32 9.118-139.624-14.28 14.142 19.334 34.493 31.22 56.97 36.592-58.93 '
    + '3.328-117.894-19.792-162.44-84l.002 168.03c65.91 28.65 135.148 19.62 196.218-11.56l-16.97 35.78 '
    + '88.126-85.03h-.093c2-1.796 3.973-3.6 5.936-5.438l-11.28 43.937 59.812-99.438c19.668-27.56 35.253-57.384 '
    + '45.406-87.718z',

  // КАБ: важке тіло носом донизу з оперенням і без двигуна — саме це відрізняє його від крилатої ракети.
  // Джерело: game-icons.net · delapouite/falling-bomb · CC BY 3.0
  guided_air_bomb:
    'M50.18 16.44L71.49 318.7 93.28 16.44h-43.1zm399.82 0l24.5 405.86 16.4-405.86H450zM256 28.46l-7.2 '
    + '21.62-15.5 108.62c.6.5 1.6 1.1 3.5 1.8 4.6 1.5 12 2.5 19.2 2.5 7.3 0 14.6-1 19.2-2.5 1.9-.7 2.9-1.3 '
    + '3.5-1.8L263.2 50.08 256 28.46zm-116.2 3.45l12.4 74.49 62.8 37.7V69.51l-75.2-37.6zm232.4.05L297 '
    + '69.56v74.54l62.8-37.7 12.4-74.44zm37 89.14L370 177.2 387 402l22.2-280.9zm-184.8 53.4L185 227v118.8c47.5 '
    + '17.7 94.4 17.7 142 0V227l-39.4-52.5c-2.1 1.3-4.4 2.2-6.8 3-7.4 2.5-16 3.5-24.8 '
    + '3.5s-17.4-1-24.8-3.5c-2.4-.8-4.7-1.7-6.8-3zm-112.5 25.9l18.6 290.9 13-255.6-31.6-35.3zm-59.51 '
    + '58.4l-30.2 22.3 22.27 165 7.93-187.3zm361.31 52.8l11.2 180.3 17.3-134.5-28.5-45.8zM185 364.9V400c0-.3.4 '
    + '2.4 1.6 5.6 1.2 3.2 3 7.4 5.4 12 4.8 9.3 11.6 20.5 19.3 31.1 7.7 10.6 16.4 20.7 24.6 27.7 8.2 7.1 15.9 '
    + '10.6 20.1 10.6 4.2 0 11.9-3.5 20.1-10.6 8.2-7 16.9-17.1 24.6-27.7 7.7-10.6 14.5-21.8 19.3-31.1 2.4-4.6 '
    + '4.2-8.8 5.4-12 1.2-3.2 1.6-5.8 1.6-5.6v-35.1c-47.2 16.1-94.9 16-142 0z',

  // Крилата: тіло, що входить полого, зі слідом позаду. Читається інакше, ніж літак — нинішній гліф плутався з авіацією.
  // Джерело: game-icons.net · lorc/incoming-rocket · CC BY 3.0
  cruise_missile:
    'M18.36 18.336V93.59l317.51 262.287-52.917.53 82.58 63.884-71.963.394 80.102 32.728-17.404 15.14c34.87 '
    + '16.374 70.587 22.075 135.648 22.718l.008-.002c-.314-44.892-11.583-91.282-28.666-126.69l-12.5 '
    + '25.762-43.65-104.975-8.303 72.656-53.752-70.182 5.8 55.584L85.86 18.336h-67.5zm148.736 0L336.303 271.23 '
    + '232.88 18.336h-65.784zm123.34 0l50.753 183.898 2.468-183.898h-53.22zM18.363 160.074v82.963l241.853 '
    + '99.272L18.36 160.073zm0 141.29v57.396l201.552-4.795-201.55-52.6zm357.154 77.212c41.388 7.493 81.473 '
    + '39.554 93.138 89.248-30.75-5.512-52.902-16.592-67.86-31.74-14.722-14.907-22.987-34.03-25.278-57.508z',

  // БпЛА: дельтоподібне крило. Форма збігається з силуетом ударного дрона типу Shahed, і саме тому вона тут, а не квадрокоптер.
  // Джерело: game-icons.net · delapouite/stealth-bomber · CC BY 3.0
  uav:
    'M256 32L20 400l60 64 52.1-75.9L176 432l50.5-50.5L256 448l29.5-66.5L336 432l43.9-43.9L432 464l60-64L256 '
    + '32zm-9 47v78l-39-13 39-65zm18 0l39 65-39 13V79z',

  // Авіація: винищувач у плані. Раніше цей клас і крилата ракета були двома майже однаковими літаками.
  // Джерело: game-icons.net · delapouite/jet-fighter · CC BY 3.0
  aviation:
    'M461.5 31.85c-5 1.2-10.4 3.4-16.4 6.4-12 6-26.7 15.3-42.1 26.1-26.7 18.7-55.5 41.75-75 59.95l39.8 19.9 '
    + '19.9 39.8c18.2-19.5 41.2-48.3 59.9-75 10.8-15.35 20.1-30.05 26.2-42.15 3-6 5.2-11.3 6.3-16.3 1.2-5 '
    + '1.9-10.9-2.9-15.7-4.8-4.56-10-4.25-15.7-3zm-14.8 33.4c4.9 4.71 5.6 12.1 3.8 18.7-1.8 6.6-6.1 13.3-12.9 '
    + '20.15l-42.2 42.2-29.6-29.7L408 74.45c6.8-6.8 13.5-11.06 20.1-12.9 6.1-1.71 14.3-.44 18.6 3.7zM183.2 '
    + '109.5l-21.3 21.2 45.6 5v-26.2zm129.9 25.2l-43.5 21.8-153 200.1 13.7 13.8 97.5-97.5 11.3 11.3c-32.5 '
    + '32.5-65 65.1-97.5 97.6l13.8 13.6 200.1-153 21.8-43.5-21.4-42.8zm-256.59.4l7.4 22.2 120.99 83.5 '
    + '64.5-84.3zm38.1 62.8l-13.1 13.2 24.39 24.3 17.6-17.5zm260.89 64.7l-84.3 64.5 83.5 121 22.2 7.3zm-190.9 '
    + '4.8l-110.99 9.1-22.6 22.6 82.39 35.4zm212.1 41.2l4.6 41.5 17.1-17.2v-24.3zm-132.1 38.8l-67 51.2 35.3 '
    + '82.4 22.6-22.6zm-138.7 21.2l-13.09 13.1 37.49 37.4 13.1-13zm188.2 19.9l-17.5 17.6 24.3 24.3 13.2-13.1z',

  // РСЗВ: пускова на станині під кутом.
  // Джерело: game-icons.net · delapouite/missile-launcher · CC BY 3.0
  mlrs:
    'M490.74 21.411c-8.947.782-20.72 3.22-33.566 7.781-16.386 5.82-34.345 14.758-50.969 25.893l26.783 '
    + '36.525c15.712-12.52 29.853-26.925 40.428-40.757 8.265-10.811 14.055-21.243 17.324-29.442zm-99.265 '
    + '44.026L57.609 310.24l8.28 11.291 83.062-60.906 10.643 14.516-83.063 60.906 8.28 11.29 '
    + '333.865-244.806zm-18.252 92.746L203.164 282.876l13.924 7.15L375.855 173.61zm-48.602 75.316l-35.775 '
    + '26.234c3.899 3.046 8.821 4.856 14.213 4.856 12.809 0 23-10.191 23-23 '
    + '0-2.855-.51-5.579-1.438-8.09zm-255.267 7.527L21.26 260.67l25.705 35.057 65.54-48.057zm226.705 '
    + '40.948v30.615h14v-30.615a40.734 40.734 0 0 1-7 .615c-2.386 0-4.723-.219-7-.615zm-135.065 31.822l-65.54 '
    + '48.058 25.706 35.06 33.194-39.964zm-117.9 7.09l-11.291 8.279 27.2 37.096 11.29-8.28zm236.965 '
    + '9.703v78h46v-78zm-18 54.336l-61.426 71.664h23.709l37.717-44.004zm82 0v27.66l37.716 44.004h23.71zm-192 '
    + '89.664v16h94v-16zm208 0v16h94v-16z',

  // Артилерія: снаряд. Ствол читався б як мінометна труба, а снаряд — ні з чим.
  // Джерело: game-icons.net · quoting/artillery-shell · CC BY 3.0
  artillery:
    'M372.386 52.97l-14.822 13.064 103.244 117.142 14.822-13.064zm-30.23 26.646l-36.649 32.303 15.549 '
    + '17.64zm16.865 16.346l-20.442 48.382-1.457 3.448 19.012 21.57 21.897-51.832zm-67.537 28.318L119.939 '
    + '275.485l.054.062-1.294 1.141c-19.625 17.298-36.277 35.67-49.407 53.91l92.854 105.356c19.745-10.734 '
    + '40.062-24.948 59.687-42.246l1.295-1.143.055.063 6.23-5.493 165.313-145.713zm102.615 11.482l-20.443 '
    + '48.385-1.456 3.445 20.838 23.641 21.897-51.83zm36.904 41.873l-20.441 48.385-.973 2.303 '
    + '37.194-32.783zM58.583 346.723c-4.228 6.959-7.93 13.848-11.015 20.592-6.73 14.712-10.7 28.778-11.157 '
    + '41.78-.457 13.001 2.827 25.259 10.93 34.452 8.103 9.194 19.85 13.989 32.805 15.168 12.955 1.18 '
    + '27.408-.992 42.847-5.822 7.078-2.214 14.377-5.02 21.811-8.342z',

  // Міномет: труба на двонозі.
  // Джерело: game-icons.net · delapouite/mortar · CC BY 3.0
  mortar:
    'M336.313 25.057l-42.536 73.45-1.718 28.036 45.754 26.498 23.463-15.446 42.535-73.448zm-50.3 '
    + '118.785l-31.07 53.654 30.307 17.55c.91-.06 1.825-.103 2.75-.103 3.218 0 6.35.39 9.36 '
    + '1.1l28.46-49.148zm-61.238 20.455l-4.63 7.72-33.665 56.106-11.09-7.19-7.55-4.9-9.795 15.102 7.55 4.896 '
    + '11.618 7.538-5.068 8.448-4.63 7.716 15.434 9.262 4.63-7.72 48-80 4.63-7.715zm14.22 44.766l-31.07 53.652 '
    + '53.655 31.072 2.623-4.53c-10.39-7.46-17.203-19.63-17.203-33.314 0-13.334 6.466-25.24 16.412-32.742zM288 '
    + '232.942c-12.81 0-23 10.19-23 23s10.19 23 23 23 23-10.19 23-23-10.19-23-23-23zM205.83 282.3l-78.078 '
    + '134.827c5.496 5.717 8.967 13.386 9.223 21.816h31.298l77.364-133.59zm109.432 4.184c-3.484 3.116-7.498 '
    + '5.644-11.885 7.436l89.393 161.023h16.01zM104 424.944c-8.39 0-15 6.608-15 15 0 8.39 6.61 15 15 '
    + '15s15-6.61 15-15c0-8.392-6.61-15-15-15zm-63 32v30h35.498c5.765-4.327 12.842-6.912 20.772-8.764 '
    + '9.43-2.204 20.05-3.237 30.675-3.237 10.626 0 21.22 1.03 30.608 3.24 7.86 1.847 14.873 4.418 20.568 '
    + '8.76H215v-30h-82.766c-5.803 9.562-16.317 16-28.234 16-11.917 0-22.43-6.438-28.234-16zm336 16v14h94v-14z',

  // Комбінована: рій. Множинність — це і є те, що каже клас.
  // Джерело: game-icons.net · lorc/missile-swarm · CC BY 3.0
  combined:
    'M17.34 17.38v34.08C37.24 85.91 61.4 120.5 95.03 151c6.97 24.6 23.57 43.7 46.27 '
    + '53.9-5.9-8.2-9.4-18.1-9.6-30.1 12 .1 21.9 3.7 30.1 '
    + '9.6-10.1-22.5-28.7-39-52.9-46-40.28-36.2-66.64-78.82-89.03-121.02zm26.96 0C98.65 32.32 173.5 71.74 '
    + '240.5 124.5l16.3-11.6C205.6 71.81 149.6 38.58 99.97 17.38zm110.1 0c28.4 8.14 52.8 19.57 75.3 32.83 13 '
    + '21.96 34.1 36.14 58.6 40.15-7.8-6.38-13.7-15.05-17-26.58 11.7-2.98 22.1-2.09 31.5 '
    + '1.46-15.5-19.08-37.8-30.23-63-30.76-10.3-6.07-21-11.82-32.3-17.1zm171.3 4.96L321 71.62c-6.1 10.46-12.1 '
    + '20.92-18.2 31.38-14.6 11.2-26.3 18.7-40.6 29l39.6 22.8h.1l38.3-13.9c37.3 28.7 84.7 43.6 133.5 '
    + '39.8-21.2-44.6-57.8-78.2-101.5-96.03l-7-39.5zM194.9 148.8l-17.2 46.4c-8.6 8.4-17.2 17.1-25.7 25.7-14.9 '
    + '5.8-31.2 11.8-46.6 17.5l32.3 32.3 40.6-3.5c28.6 37.3 70.5 64 118.6 '
    + '72.9-8.9-48.5-35.6-90.5-73.1-119l3.4-40zm123.3 20l-18.2 6.6c17.1 17.7 33.5 38.1 44.3 52.6 1.1 24.4 12.1 '
    + '46.1 30.6 61.3-3.5-9.5-4.3-19.9-1.4-31.6 11.6 3.3 20.2 9.3 26.6 '
    + '17.1-4.1-25.4-19-47-42.3-59.9-12-15.9-25.3-31.3-39.6-46.1zM17.34 247.2v49.7c14.05 24.6 33.51 44.5 56.99 '
    + '61 12.88 23.6 34.67 38.8 60.27 43-7.8-6.4-13.8-15.1-17.1-26.6 11.7-3 22.2-2.1 31.6 '
    + '1.5-15-18.5-36.3-29.5-60.47-30.7-35.62-23.9-60.18-54.2-71.29-97.9zM441.3 249l-28.7 40.4c-10.5 6-20.9 '
    + '12.1-31.4 18.1-16.1 1.9-33.2 3.3-49.6 4.8l22.9 39.6 40.1 7.1c17.9 43.5 51.5 80.1 95.7 101.2 '
    + '4-49.2-10.9-96.7-39.9-133.9l13.7-37.7zm-269.4 83.9l-4.6 49.3c-6.1 10.3-12.2 20.9-18.2 31.4-13 9.6-27 '
    + '19.4-40.5 28.9l39.6 22.9 38.3-13.9c37.3 28.7 84.6 43.6 133.4 '
    + '39.8-21.1-44.7-57.7-78.3-101.4-96.1l-7-39.5z',

  // Невизначена: знак питання. Відсутність класифікації, а не її різновид.
  // Джерело: game-icons.net · lorc/uncertainty · CC BY 3.0
  unknown:
    'M257.78 19.438c-127.92.016-231.75 103.855-231.75 231.78 0 55.734 19.71 106.776 52.532 146.72L57.75 '
    + '434.094h132.406l-66.312-114.72-22.375 39c-20.9-30.478-33.064-67.442-33.064-107.155 0-104.523 '
    + '84.854-189.376 189.375-189.376 104.523 0 189.408 84.853 189.408 189.375 0 39.108-11.68 75.664-32 '
    + '105.874l-21.875-37.72L327 434.095h132.406l-21.594-37.47c32.225-39.78 51.75-90.253 51.75-145.405 '
    + '0-127.927-103.827-231.766-231.75-231.782h-.03zm-.655 75.468c-49.528-.047-110.474 29.232-128.406 '
    + '104.938l60.75 14.312c26.965-76.242 90.87-70.824 113.31-28.625 26.775 50.346-89.687 107.283-84.124 '
    + '190.407h77.688c6.49-98.144 118.973-123.49 59.562-229.53C337.963 114.38 301 96.572 261.876 '
    + '95.03V95c-1.573-.062-3.153-.092-4.75-.094zM258.5 395.97c-26.95 0-48.594 21.644-48.594 48.592 0 26.95 '
    + '21.645 48.594 48.594 48.594 26.95 0 48.594-21.645 48.594-48.594 0-26.948-21.645-48.593-48.594-48.593z'
};

/**
 * The short name a designer uses for the glyph. Three differ from the class name.
 *
 * Documentation and legend copy only. **Nothing addressable is keyed on it** — image ids, layer ids
 * and the wire format all use `ThreatType`, so there is exactly one identifier a bug can be traced
 * through.
 */
export const THREAT_ICON_KEYS: Record<ThreatType, string> = {
  ballistic_missile: 'ballistic', guided_air_bomb: 'kab', cruise_missile: 'cruise',
  combined: 'combined', mlrs: 'mlrs', uav: 'uav', artillery: 'artillery',
  mortar: 'mortar', aviation: 'aviation', unknown: 'unknown'
};

export type IconTone = 'consequence' | 'confirmed' | 'reported' | 'analytic';
export const ICON_TONES = ['consequence', 'confirmed', 'reported', 'analytic'] as const;

// Дзеркальна копія цієї мапи живе у web/app.js (`threatIconLabels`). Змінюєш тут — зміни й там.
// Це рівно ті самі рядки, що вже показує карта у `threatNames`; іконка не має права називати
// той самий клас інакше, ніж картка події поруч.
export const THREAT_ICON_LABELS_UK: Record<ThreatType, string> = {
  uav: 'Ударні БпЛА',
  ballistic_missile: 'Балістична загроза',
  cruise_missile: 'Крилаті ракети',
  guided_air_bomb: 'Керовані авіабомби',
  aviation: 'Активність авіації',
  mlrs: 'РСЗВ',
  artillery: 'Артилерія',
  mortar: 'Мінометний обстріл',
  combined: 'Комбінована загроза',
  unknown: 'Невизначена загроза'
};

// Дзеркальна копія цієї мапи живе у web/app.js (`threatIconAria`). Змінюєш тут — зміни й там.
export const ICON_TONE_ARIA_UK: Record<IconTone, string> = {
  consequence: 'повідомлено наслідки',
  confirmed: 'підтверджене джерело',
  reported: 'повідомлення моніторингу',
  analytic: 'аналітична оцінка, не тривога'
};

/** `ti-uav-confirmed`. 10 classes × 4 tones = 40 ids, all unique, all lower-case ASCII + `-`/`_`. */
export function iconImageId(threatType: ThreatType, tone: IconTone): string {
  return `ti-${threatType}-${tone}`;
}

/** «Ударні БпЛА — підтверджене джерело» */
export function iconAriaLabel(threatType: ThreatType, tone: IconTone): string {
  return `${THREAT_ICON_LABELS_UK[threatType]} — ${ICON_TONE_ARIA_UK[tone]}`;
}

export const MAX_ICON_SLOTS = 3;

/**
 * How little warning the class gives and how lethal one event is to the population under it.
 * Ballistic gives the least warning of anything in the list; a КАБ in the frontline belt has
 * effectively no interception window; cruise missiles give minutes; `combined` outranks every
 * single conventional class because by definition it is more than one; MLRS / artillery / mortar
 * are ordered by range and therefore by warning; `aviation` is a posture indicator rather than an
 * inbound weapon; `unknown` is last because it is the *absence* of a classification, not a class.
 *
 * The ten values are DISTINCT on purpose: that is what makes key #4 decisive for any two different
 * classes, and it is why keys #5–#7 only ever run for two candidates of the SAME class.
 */
export const DANGER_RANK: Record<ThreatType, number> = {
  ballistic_missile: 9, guided_air_bomb: 8, cruise_missile: 7, combined: 6,
  mlrs: 5, uav: 4, artillery: 3, mortar: 2, aviation: 1, unknown: 0
};

export const TONE_RANK: Record<IconTone, number> =
  { consequence: 3, confirmed: 2, reported: 1, analytic: 0 };

/** Mirrors `evidenceRank` in src/repositories/events.ts. An analytic-only candidate scores -1. */
export const EVIDENCE_RANK = { official: 3, confirmed: 2, monitoring: 1, unverified: 0 } as const;

/**
 * Mirrors the geographic-relevance weights in src/repositories/events.ts:487-491.
 * `official_alert` is in the enum and in two SQL CHECKs but no code path has ever written it;
 * it is ranked alongside `mentioned` rather than left undefined so a future writer cannot produce
 * an `undefined` comparison key.
 */
export const RELATION_RANK: Record<RelationType, number> =
  { explicit_threat: 3, reported_direction: 2, aftermath: 1, mentioned: 0, official_alert: 0 };

export interface IconCandidate {
  threatType: ThreatType;
  tone: IconTone;
  evidenceLevel: EvidenceLevel | null;   // null for an analytic-only candidate
  relationType: RelationType | null;
  lastConfirmedAt: string;               // ISO — lastObservedAt, or generatedAt for analytic
  eventCount: number;
  riskScore: number | null;
}

export interface RankedIcon extends IconCandidate {
  rank: number;          // 0-based slot
  iconId: string;        // iconImageId(threatType, tone)
  labelUk: string;       // THREAT_ICON_LABELS_UK[threatType]
  ariaLabelUk: string;   // iconAriaLabel(threatType, tone)
}

/**
 * CONTRACT.md §3.2 declares `TerritoryState.icons: TerritoryIcon[]` without defining
 * `TerritoryIcon`. It is `RankedIcon`: the panel needs `eventCount`, `lastConfirmedAt` and
 * `evidenceLevel` anyway, and a narrower wire type would have to be widened again on first use.
 */
export type TerritoryIcon = RankedIcon;

export interface IconStack { icons: RankedIcon[]; overflow: number; }

const MINUTE = 60_000;

/**
 * Freshness as a bucket, never a raw timestamp.
 *
 * Two reports 400 ms apart are equally fresh to anyone reading the map, but a raw comparison would
 * let them swap slots between two snapshots taken a second apart, and the icon stack would flicker
 * during exactly the wave it exists to describe. Buckets make the order stable under clock jitter
 * and identical between the server, the tests and any replay.
 *
 * A future timestamp is clock skew on the source side, not freshness from the future: it clamps to
 * "now" rather than winning by being ahead. An unparseable timestamp falls into the oldest bucket,
 * which is the safe direction — it can never jump a malformed candidate to the front.
 */
export function freshnessBucket(lastConfirmedAt: string, now: Date): 0 | 1 | 2 | 3 {
  const at = Date.parse(lastConfirmedAt);
  if (!Number.isFinite(at)) return 0;
  const age = Math.max(0, now.getTime() - at);
  if (age < 10 * MINUTE) return 3;
  if (age < 30 * MINUTE) return 2;
  if (age < 120 * MINUTE) return 1;
  return 0;
}

const evidenceScore = (c: IconCandidate): number =>
  c.evidenceLevel == null ? -1 : EVIDENCE_RANK[c.evidenceLevel] ?? -1;

const relationScore = (c: IconCandidate): number =>
  c.relationType == null ? -1 : RELATION_RANK[c.relationType] ?? -1;

/** Never NaN: a NaN key would make `Array#sort` produce an arbitrary order, not a stable one. */
const recencyMs = (c: IconCandidate): number => {
  const at = Date.parse(c.lastConfirmedAt);
  return Number.isFinite(at) ? at : 0;
};

/**
 * Strict total order over icon candidates. Negative = `a` outranks `b`.
 *
 * Never returns 0 for two candidates of different classes: `DANGER_RANK` is injective over the ten
 * classes, so key #4 always decides, and key #8 guarantees it even if that ever stopped being true.
 * Two candidates of the SAME class compare equal only when every field is equal — which is the
 * definition of "the same icon".
 */
export function compareThreatIcons(a: IconCandidate, b: IconCandidate, now: Date): number {
  return (
    (TONE_RANK[b.tone] - TONE_RANK[a.tone]) ||                                   // 1. state
    (evidenceScore(b) - evidenceScore(a)) ||                                     // 2. evidence
    (freshnessBucket(b.lastConfirmedAt, now) - freshnessBucket(a.lastConfirmedAt, now)) || // 3.
    (DANGER_RANK[b.threatType] - DANGER_RANK[a.threatType]) ||                   // 4. danger
    (relationScore(b) - relationScore(a)) ||                                     // 5. relation
    (b.eventCount - a.eventCount) ||                                             // 6. event count
    (recencyMs(b) - recencyMs(a)) ||                                             // 7. exact recency
    (THREAT_TYPES.indexOf(a.threatType) - THREAT_TYPES.indexOf(b.threatType))    // 8. stable key
  );
}

/**
 * Sorts, slots the first MAX_ICON_SLOTS and reports the remainder as `overflow`.
 * Does not mutate `candidates` — the caller keeps the full per-class list for the panel.
 */
export function rankThreatIcons(candidates: IconCandidate[], now: Date): IconStack {
  const sorted = [...candidates].sort((a, b) => compareThreatIcons(a, b, now));
  const icons = sorted.slice(0, MAX_ICON_SLOTS).map((candidate, rank) => ({
    ...candidate,
    rank,
    iconId: iconImageId(candidate.threatType, candidate.tone),
    labelUk: THREAT_ICON_LABELS_UK[candidate.threatType],
    ariaLabelUk: iconAriaLabel(candidate.threatType, candidate.tone)
  }));
  return { icons, overflow: Math.max(0, sorted.length - MAX_ICON_SLOTS) };
}
