/**
 * Назва місця, однозначна для того, хто читає сповіщення.
 *
 * У каталозі вісім назв не унікальні: Калинівка трапляється тричі, а Миколаїв, Богуслав, Золочів,
 * Городок, Степанівка, Миколаївка й Південне — двічі. «Загроза на Миколаїв» не каже, чи це обласний
 * центр на півдні, чи однойменне місто на Львівщині, — а це шістсот кілометрів різниці й питання,
 * чи стосується повідомлення читача взагалі.
 *
 * ## Три щаблі, і жодного зайвого слова
 *
 * 1. Назва унікальна в каталозі — і залишається сама собою. «Київ, Київська область» у кожному
 *    повідомленні було б шумом заради восьми випадків.
 * 2. Назва повторюється, але область її розрізняє — додається область.
 * 3. Область не розрізняє — додається район.
 *
 * Третій щабель не теоретичний: Калинівка Броварського й Калинівка Фастівського районів лежать
 * ОБИДВІ в Київській області, тож зупинка на другому щаблі лишила б два різні міста з однаковим
 * підписом — тобто рівно ту проблему, яку цей модуль розвʼязує, лише тихішу.
 *
 * Район на третьому щаблі стоїть ЗАМІСТЬ області, а не разом із нею: «Калинівка, Броварський район»
 * коротше за «Калинівка, Броварський район, Київська область» і вже однозначне. Скарга, з якої це
 * почалося, — на обсяг тексту, і рядок, довший за потрібне, тут не менша хиба, ніж двозначний.
 *
 * ## Чому це чиста функція, а не вираз у SQL
 *
 * Перша редакція жила виразом `CASE`, вбудованим у запити сповіщень. На двох щаблях вона ще
 * читалася; на третьому — з підрахунком однойменних у межах області — перетворилася на вкладені
 * латеральні підзапити, які довелося б повторити в кожному з трьох місць, де складається
 * повідомлення. Каталог має 652 рядки й змінюється лише під час синхронізації KATOTTG, тож правило
 * дешевше застосувати один раз до всього каталогу, ніж носити його копію в кожному запиті.
 *
 * Тут немає ані звернень до бази, ані `Date.now()`: на вхід — рядки каталогу, на вихід — мапа
 * підписів. Саме тому те, що каталог поверне завтра, можна перевірити сьогодні.
 */

export interface LocationRow {
  id: string;
  name_uk: string;
  type: string;
  parent_id: string | null;
}

/** Найближчий предок заданого типу, включно з самим вузлом. */
function ancestorOfType(row: LocationRow, byId: Map<string, LocationRow>, type: string): LocationRow | null {
  let current: LocationRow | undefined = row;
  // Глибина каталогу — країна → область → район → місто, тобто щонайбільше чотири рівні. Лічильник
  // тут не про глибину, а про цикл у `parent_id`: одна зіпсована синхронізація не має вішати процес.
  for (let step = 0; current && step < 8; step += 1) {
    if (current.type === type) return current;
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return null;
}

/**
 * Підписи для всього каталогу — по одному на локацію.
 *
 * Повертається мапа `id → підпис`, а не функція над однією локацією: рішення про кожен щабель
 * залежить від УСЬОГО каталогу, і рахувати його наново для кожної назви означало б обходити 652
 * рядки на кожне сповіщення.
 */
export function buildLocationLabels(rows: readonly LocationRow[]): Map<string, string> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const byName = new Map<string, LocationRow[]>();
  for (const row of rows) {
    const bucket = byName.get(row.name_uk);
    if (bucket) bucket.push(row);
    else byName.set(row.name_uk, [row]);
  }

  const labels = new Map<string, string>();
  for (const row of rows) {
    const sameName = byName.get(row.name_uk) ?? [row];
    if (sameName.length === 1) { labels.set(row.id, row.name_uk); continue; }

    const oblast = ancestorOfType(row, byId, 'oblast');
    // Уточнення має сенс лише тоді, коли воно справді розрізняє. Область, яку носять двоє
    // однойменних, не додає читачеві нічого, крім довжини.
    const sameOblast = sameName.filter((other) =>
      ancestorOfType(other, byId, 'oblast')?.id === oblast?.id);
    if (oblast && oblast.id !== row.id && sameOblast.length === 1) {
      labels.set(row.id, `${row.name_uk}, ${oblast.name_uk}`);
      continue;
    }

    const raion = ancestorOfType(row, byId, 'raion');
    if (raion && raion.id !== row.id) { labels.set(row.id, `${row.name_uk}, ${raion.name_uk}`); continue; }

    // Ні область, ні район не розрізняють — лишається сама назва. Це чесніше за уточнення, яке
    // нічого не уточнює, і в поточному каталозі така гілка недосяжна.
    labels.set(row.id, oblast && oblast.id !== row.id ? `${row.name_uk}, ${oblast.name_uk}` : row.name_uk);
  }
  return labels;
}

/** Ланцюг предків від самого вузла вгору, включно з ним. */
function ancestorIds(id: string, byId: Map<string, LocationRow>): Set<string> {
  const chain = new Set<string>();
  let current = byId.get(id);
  for (let step = 0; current && step < 8; step += 1) {
    if (chain.has(current.id)) break;
    chain.add(current.id);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return chain;
}

/**
 * Ті місця загрози, які стосуються ЦІЄЇ підписки — і жодного зайвого.
 *
 * ## Що це лагодить
 *
 * Перелік міст рахувався ОДИН РАЗ на всю загрозу, до циклу по підписниках, і тому кожен отримував
 * усі її локації. Людина, підписана на Київ, читала «Українськ, Бровари, Вишневе та ще 11»: два
 * міста з чотирнадцяти стосувалися її, решта — ні, а «та ще 11» ховало навіть те, які саме. Скарга
 * на обсяг тексту й скарга на згадування чужих напрямків — це одна й та сама помилка, побачена з
 * двох боків.
 *
 * ## Правило спорідненості
 *
 * Місце загрози стосується підписки, якщо воно є самою підпискою, лежить під нею або є її предком.
 * Третій випадок не зайвий: підписка на Бровари має почути «загроза на Київську область», бо це
 * твердження накриває Бровари цілком. А підписка на Київську область не має чути про сусідню
 * Житомирську лише тому, що обидві згадані в одному повідомленні.
 *
 * ## Чому не порожньо
 *
 * Якщо перетин порожній — а це можливо лише при неузгодженому каталозі, — повертається ВЕСЬ перелік.
 * Сповіщення без жодної назви місця гірше за сповіщення з зайвою: перше не можна прочитати взагалі.
 */
export function scopeToSubscription(
  threatLocationIds: readonly string[],
  subscriptionIds: readonly string[],
  rows: readonly LocationRow[]
): string[] {
  if (!subscriptionIds.length) return [...threatLocationIds];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const subscribed = new Set(subscriptionIds);
  const subscriptionAncestors = new Set<string>();
  for (const id of subscriptionIds) for (const up of ancestorIds(id, byId)) subscriptionAncestors.add(up);

  const scoped = threatLocationIds.filter((id) => {
    // Місце під підпискою: підписка стоїть у його ланцюзі предків.
    for (const up of ancestorIds(id, byId)) if (subscribed.has(up)) return true;
    // Місце над підпискою: воно саме стоїть у ланцюзі предків підписки.
    return subscriptionAncestors.has(id);
  });
  return scoped.length ? scoped : [...threatLocationIds];
}
