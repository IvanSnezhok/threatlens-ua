/**
 * Приблизна кількість токенів у тексті — без токенізатора.
 *
 * Точний підрахунок потребує словника моделі (o200k для поточних моделей Codex) і мегабайта рангів у
 * памʼяті процесу, а питання, на яке тут відповідають, — «чи переріс контекст стелю, за якою його пора
 * стискати» — не потребує точності до токена. Оцінка свідомо КОНСЕРВАТИВНА: кирилиця рахується по
 * ~2,8 символа на токен (реальна щільність o200k на українському тексті — близько 3–3,5), латиниця й
 * цифри — по 4, решта символів і пробіли — по 1,5. Помилка в бік «більше токенів» означає раннє
 * стиснення, а не переповнений промт.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cyrillic = 0; let latin = 0; let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if ((code >= 0x0400 && code <= 0x04ff) || (code >= 0x0500 && code <= 0x052f)) cyrillic += 1;
    else if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin += 1;
    else other += 1;
  }
  return Math.ceil(cyrillic / 2.8 + latin / 4 + other / 1.5);
}

/**
 * Відрізає НАЙСТАРІШУ частину тексту так, щоб лишитися в межах бюджету токенів. Текст контексту
 * хронологічний — новіше внизу, — тож зберігається кінець. Ріже по межі рядка, щоб не лишати
 * половини запису.
 */
export function trimToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const lines = text.split('\n');
  let kept: string[] = [];
  let tokens = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const cost = estimateTokens(line) + 1;
    if (tokens + cost > maxTokens) break;
    kept.unshift(line);
    tokens += cost;
  }
  if (!kept.length && lines.length) {
    // Один рядок довший за весь бюджет: лишаємо його хвіст посимвольно.
    const last = lines[lines.length - 1]!;
    kept = [last.slice(Math.max(0, last.length - maxTokens * 2))];
  }
  return kept.join('\n');
}
