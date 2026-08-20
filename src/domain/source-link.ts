/**
 * Посилання на конкретний пост джерела — одне визначення на всі поверхні.
 *
 * Telegram-джерела тримають хендл каналу в `sources.telegram_username`, а номер поста — в
 * `source_messages.external_id`; разом вони адресують саме той пост, з якого зроблено класифікацію,
 * і саме це посилання варто показувати. Коли `external_id` не є номером (опитувані API тривог
 * вигадують власні ідентифікатори) — чесною лишається головна сторінка каналу, а джерело без
 * публічної адреси взагалі не дає посилання, замість того щоб вести в нікуди.
 *
 * Функція чиста й не знає ні про бота, ні про модель. Читачів у неї троє, і кожен ставить те саме
 * питання по-своєму: сповіщення показує «Першоджерело», перелік повідомлень простою дає моделі
 * «посилання на повідомлення», а сторінка аналізу — цитату. Три копії цих чотирьох рядків означали б
 * три різні відповіді на питання «а де це написано» для того самого поста.
 */
export interface SourceLinkFields {
  telegramUsername?: string | null;
  externalId?: string | null;
  publicUrl?: string | null;
}

export function sourceMessageUrl(fields: SourceLinkFields): string | null {
  const username = String(fields.telegramUsername ?? '').trim().replace(/^@/, '');
  const externalId = String(fields.externalId ?? '').trim();
  if (username && /^\d+$/.test(externalId)) return `https://t.me/${username}/${externalId}`;
  if (username) return `https://t.me/${username}`;
  const publicUrl = String(fields.publicUrl ?? '').trim();
  return /^https?:\/\//i.test(publicUrl) ? publicUrl : null;
}
