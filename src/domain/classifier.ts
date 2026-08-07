import type { ClassifiedMessage, RelationType, ThreatType } from '../types.js';

export interface LocationLexeme {
  id: string;
  name: string;
  aliases: string[];
}

const patterns: Array<[ThreatType, RegExp]> = [
  ['ballistic_missile', /(балістик[а-яіїєґ]*|іскандер[-– ]?м|kn[-– ]?(23|24))/iu],
  ['cruise_missile', /(крилат[а-яіїєґ]* ракет[а-яіїєґ]*|іскандер[-– ]?к|калібр[а-яіїєґ]*)/iu],
  ['guided_air_bomb', /(каб[а-яіїєґ]*|керован[а-яіїєґ]* авіаційн[а-яіїєґ]* бомб[а-яіїєґ]*)/iu],
  ['uav', /(бпла|ударн[а-яіїєґ]* дрон[а-яіїєґ]*|безпілотник[а-яіїєґ]*|шахед[а-яіїєґ]*)/iu],
  ['aviation', /(стратегічн[а-яіїєґ]* авіаці[а-яіїєґ]*|тактичн[а-яіїєґ]* авіаці[а-яіїєґ]*|активність авіаці[а-яіїєґ]*)/iu],
  ['mlrs', /(рсзв|реактивн[а-яіїєґ]* артилері[а-яіїєґ]*)/iu],
  ['artillery', /(артилерійськ[а-яіїєґ]* обстріл[а-яіїєґ]*|ствольн[а-яіїєґ]* артилері[а-яіїєґ]*)/iu],
  ['mortar', /(мінометн[а-яіїєґ]* обстріл[а-яіїєґ]*)/iu]
];

const strategicIndicators: Array<{ name: string; pattern: RegExp; threatTypes: ThreatType[] }> = [
  { name: 'зліт стратегічної авіації', pattern: /(зліт|підня(?:то|лися)|у повітрі).{0,45}(ту[-– ]?(95|160)|стратегічн[а-яіїєґ]* авіаці)/iu, threatTypes: ['cruise_missile'] },
  { name: 'активність МіГ-31К', pattern: /(міг[-– ]?31к|mig[-– ]?31k|носі[йя].{0,20}кинджал)/iu, threatTypes: ['ballistic_missile'] },
  { name: 'активність пускових установок', pattern: /(с[-– ]?300|с[-– ]?400|іскандер).{0,45}(активн|робот|переміщ|готовн|пуск)/iu, threatTypes: ['ballistic_missile'] },
  { name: 'активність ракетоносіїв у морі', pattern: /(ракетоносі[йї]|носі[йї].{0,25}калібр|корабл[а-яіїєґ]*.{0,25}калібр)/iu, threatTypes: ['cruise_missile'] },
  { name: 'ознаки підготовки БпЛА', pattern: /(пуск|запуск|старт|груп[а-яіїєґ]*).{0,35}(шахед|бпла|безпілотник)/iu, threatTypes: ['uav'] },
  { name: 'робота ворожої ППО', pattern: /(робот[а-яіїєґ]*|активн[а-яіїєґ]*).{0,25}(ворож[а-яіїєґ]* ппо|ппо рф)/iu, threatTypes: ['ballistic_missile','cruise_missile'] }
];

const labels: Record<ThreatType, string> = {
  uav: 'Загроза ударних БпЛА',
  ballistic_missile: 'Балістична загроза',
  cruise_missile: 'Загроза крилатих ракет',
  guided_air_bomb: 'Загроза керованих авіаційних бомб',
  aviation: 'Підвищена активність авіації',
  mlrs: 'Загроза реактивної артилерії',
  artillery: 'Загроза артилерійського обстрілу',
  mortar: 'Загроза мінометного обстрілу',
  combined: 'Комбінована загроза',
  unknown: 'Повідомлення про загрозу'
};

function relationFor(text: string, alias: string): RelationType {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(у напрямку|курс(?:ом)? на|руха(?:ється|ються) до)\\s+(?:.{0,24})${escaped}`, 'iu').test(text)) {
    return 'reported_direction';
  }
  if (new RegExp(`(загроза|небезпека|увага для)(?:.{0,45})${escaped}`, 'iu').test(text)) {
    return 'explicit_threat';
  }
  if (/наслідк|влучан|пошкоджен|вибух/iu.test(text)) return 'aftermath';
  return 'mentioned';
}

export function classifyMessage(text: string, locations: LocationLexeme[]): ClassifiedMessage {
  const matchedIndicators = strategicIndicators.filter(({ pattern }) => pattern.test(text));
  const matchedTypes = [...new Set([
    ...patterns.filter(([, pattern]) => pattern.test(text)).map(([type]) => type),
    ...matchedIndicators.flatMap(({ threatTypes }) => threatTypes)
  ])];
  const threatType: ThreatType = matchedTypes.length > 1 ? 'combined' : matchedTypes[0] ?? 'unknown';
  const normalized = text.toLocaleLowerCase('uk-UA');
  const seen = new Set<string>();
  const found: ClassifiedMessage['locations'] = [];

  for (const location of locations) {
    const aliases = [location.name, ...location.aliases].sort((a, b) => b.length - a.length);
    const alias = aliases.find((candidate) => {
      const lowered = candidate.toLocaleLowerCase('uk-UA');
      if (normalized.includes(lowered)) return true;
      const stem = lowered.replace(/(ою|ею|ами|ями|ові|еві|а|я|и|і|у|ю|е)$/u, '');
      return stem.length >= 5 && normalized.includes(stem);
    });
    if (!alias || seen.has(location.id)) continue;
    seen.add(location.id);
    found.push({ id: location.id, name: location.name, relationType: relationFor(text, alias) });
  }

  const direction = text.match(/(?:у напрямку|курс(?:ом)? на|руха(?:ється|ються) до)\s+([^.!\n]{2,80})/iu)?.[0];
  const summary = text.replace(/\s+/g, ' ').trim().slice(0, 500);
  return {
    threatType,
    signalThreatTypes: matchedTypes.length ? matchedTypes : ['unknown'],
    locations: found,
    nationalScope: found.length === 0 && matchedIndicators.length > 0,
    indicators: matchedIndicators.map(({ name }) => name),
    directionText: direction,
    title: labels[threatType],
    summary
  };
}

export function riskLevel(score: number): 'background' | 'elevated' | 'significant' | 'high' | 'very_high' {
  if (score < 2) return 'background';
  if (score < 4) return 'elevated';
  if (score < 6) return 'significant';
  if (score < 8) return 'high';
  return 'very_high';
}
