#!/usr/bin/env node
/**
 * Generates TELEGRAM_SESSION for the MTProto collector.
 *
 * The collector reads public channels as a *user*, not as a bot: the Bot API cannot subscribe to a
 * channel it does not administer, so official alert channels are unreachable that way. A user login
 * is interactive — phone, SMS/app code, and 2FA password if the account has one — which is why this
 * cannot be part of `docker compose up` and has to be run once by hand.
 *
 * The result is a long-lived credential equivalent to being logged in as that account. It is printed
 * once, never written to disk by this script, and belongs in .env (which is gitignored) or a secret
 * store. Revoke it from Telegram → Settings → Devices if it ever leaks.
 *
 *   node scripts/telegram-session.mjs
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const rl = createInterface({ input: stdin, output: stdout });
const ask = async (question) => (await rl.question(question)).trim();

const apiId = Number(process.env.TELEGRAM_API_ID || await ask('TELEGRAM_API_ID (my.telegram.org → API development tools): '));
const apiHash = process.env.TELEGRAM_API_HASH || await ask('TELEGRAM_API_HASH: ');

if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
  console.error('\nПотрібні дійсні TELEGRAM_API_ID (число) і TELEGRAM_API_HASH. Отримати: https://my.telegram.org');
  rl.close();
  process.exit(1);
}

const { TelegramClient } = await import('teleproto');
const { StringSession } = await import('teleproto/sessions/index.js');

const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

try {
  await client.start({
    phoneNumber: () => ask('Номер телефону у форматі +380…: '),
    phoneCode: () => ask('Код із Telegram: '),
    // Only asked when the account has two-step verification enabled.
    password: () => ask('Пароль двоетапної перевірки: '),
    onError: (error) => { console.error('Помилка входу:', error?.message ?? error); }
  });

  const me = await client.getMe();
  const session = client.session.save();

  console.log('\n' + '─'.repeat(72));
  console.log(`Увійшли як: ${me?.username ? '@' + me.username : ''} ${me?.firstName ?? ''}`.trim());
  console.log('─'.repeat(72));
  console.log('\nДодайте цей рядок у .env:\n');
  console.log(`TELEGRAM_SESSION=${session}\n`);
  console.log('Це облікові дані рівня повного доступу до акаунта. Не комітьте їх і не передавайте.');
  console.log('Відкликати: Telegram → Налаштування → Пристрої.\n');
} catch (error) {
  console.error('\nНе вдалося створити сесію:', error?.message ?? error);
  process.exitCode = 1;
} finally {
  await client.disconnect().catch(() => undefined);
  rl.close();
}
