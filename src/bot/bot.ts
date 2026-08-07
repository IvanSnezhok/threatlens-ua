import { Bot, InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { LOCATION_HIERARCHY_MAX_DEPTH } from '../repositories/events.js';
import { listRecommendedChannels } from '../services/recommended-channels.js';

const threatLabels: Record<string, string> = {
  uav: 'ударні БпЛА', ballistic_missile: 'балістичні ракети', cruise_missile: 'крилаті ракети',
  guided_air_bomb: 'КАБ', aviation: 'активність авіації', mlrs: 'РСЗВ', artillery: 'артилерія',
  mortar: 'мінометний обстріл', combined: 'комбінована загроза', unknown: 'невизначена загроза'
};
const levelLabels: Record<string, string> = {
  background: 'фоновий', elevated: 'підвищений', significant: 'значний', high: 'високий', very_high: 'дуже високий'
};
const evidenceLabels: Record<string, string> = {
  official: 'лише офіційні', confirmed: 'підтверджені+', monitoring: 'моніторинг+', unverified: 'усі згадки'
};

function html(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!);
}

async function ensureUser(chatId: number, username?: string) {
  await pool.query(
    `INSERT INTO telegram_users(chat_id,username) VALUES ($1,$2)
     ON CONFLICT (chat_id) DO UPDATE SET username=$2,enabled=true,last_seen_at=now()`,
    [chatId, username ?? null]
  );
}

async function locationKeyboard() {
  const locations = await pool.query(
    `SELECT id,name_uk FROM locations WHERE type=ANY($1::text[]) ORDER BY name_uk`,
    [['oblast','special_city']]
  );
  const keyboard = new InlineKeyboard();
  locations.rows.forEach((location, index) => {
    keyboard.text(location.name_uk, `sub:${location.id}`);
    if (index % 2 === 1) keyboard.row();
  });
  keyboard.row().text('🔎 Як знайти будь-яке місто', 'city-search-help');
  return keyboard;
}

async function settingsKeyboard(chatId: number) {
  const subscriptions = await pool.query(
    `SELECT s.id,l.name_uk,s.minimum_evidence_level,s.notify_threats,s.notify_analytics
     FROM subscriptions s JOIN locations l ON l.id=s.location_id
     WHERE s.chat_id=$1 AND s.enabled=true ORDER BY l.name_uk LIMIT 30`, [chatId]
  );
  const keyboard = new InlineKeyboard();
  for (const row of subscriptions.rows) {
    keyboard.text(`🗑 ${row.name_uk}`, `unsub:${row.id}`).row();
    keyboard.text(`${row.notify_threats ? '✅' : '❌'} загрози`, `toggle-threat:${row.id}`)
      .text(`${row.notify_analytics ? '✅' : '❌'} аналітика`, `toggle-analytics:${row.id}`).row();
    keyboard.text(`Доказовість: ${evidenceLabels[row.minimum_evidence_level]}`, `cycle-evidence:${row.id}`).row();
  }
  keyboard.text('＋ Додати територію', 'choose_city');
  return keyboard;
}

async function settingsText(chatId: number) {
  const count = await pool.query<{ count: number }>(
    `SELECT count(*)::integer count FROM subscriptions WHERE chat_id=$1 AND enabled=true`, [chatId]
  );
  return count.rows[0]!.count
    ? '<b>Налаштування підписок</b>\n\nДля кожної території можна вимкнути аналітику, повідомлення про загрози або змінити мінімальну доказовість.'
    : 'Активних територій немає. Додайте першу підписку.';
}

async function recommendedChannelsText(chatId: number) {
  const subscriptions = await pool.query<{ location_id: string }>(
    `SELECT location_id FROM subscriptions WHERE chat_id=$1 AND enabled=true ORDER BY created_at LIMIT 12`, [chatId]
  );
  const lists = await Promise.all([
    listRecommendedChannels(null),
    ...subscriptions.rows.map((row) => listRecommendedChannels(row.location_id))
  ]);
  const channels = [...new Map(lists.flat().map((channel) => [channel.id, channel])).values()].slice(0, 12);
  if (!channels.length) return '<b>Рекомендованих каналів поки немає.</b>\n\nАдміністратор ще формує перевірений каталог.';
  const category: Record<string, string> = {
    official: 'офіційний', regional: 'регіональний', monitoring: 'моніторинговий', analytics: 'аналітичний'
  };
  return `<b>Рекомендовані Telegram-канали</b>\n\n${channels.map((channel) =>
    `${channel.verified ? '✅' : '•'} <a href="${html(channel.url)}"><b>${html(channel.title)}</b></a>\n${html(category[channel.category] ?? channel.category)}${channel.location_name ? ` · ${html(channel.location_name)}` : ''}${channel.description ? `\n${html(channel.description)}` : ''}`
  ).join('\n\n')}\n\nКаталог формує адміністратор. Перевіряйте опис каналу перед підпискою.`;
}

export function createBot() {
  if (!config.TELEGRAM_BOT_TOKEN || config.TELEGRAM_MODE === 'disabled') return null;
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  bot.command('start', async (ctx) => {
    await ensureUser(ctx.chat.id, ctx.from?.username);
    const keyboard = new InlineKeyboard().text('Обрати територію', 'choose_city').text('Канали', 'recommended-channels');
    if (config.PUBLIC_URL) keyboard.webApp('Відкрити карту', config.PUBLIC_URL);
    await ctx.reply(
      '<b>ThreatLens UA</b>\n\nОфіційні тривоги, перевірені повідомлення про загрози й пояснювана аналітика. Бот не замінює сирени, ДСНС або офіційний застосунок.\n\nПочніть з вибору території.',
      { parse_mode: 'HTML', reply_markup: keyboard }
    );
  });

  bot.command('city', async (ctx) => {
    await ensureUser(ctx.chat.id, ctx.from?.username);
    const search = String(ctx.match ?? '').trim();
    if (search) {
      const matches = await pool.query(
        `SELECT id,name_uk FROM locations WHERE type<>'country' AND
          (name_uk ILIKE '%'||$1||'%' OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE a ILIKE '%'||$1||'%'))
         ORDER BY CASE WHEN lower(name_uk)=lower($1) THEN 0 ELSE 1 END,name_uk LIMIT 12`, [search]
      );
      if (!matches.rowCount) return ctx.reply('Територію не знайдено. Спробуйте, наприклад: <code>/city Павлоград</code>', { parse_mode: 'HTML' });
      const keyboard = new InlineKeyboard();
      matches.rows.forEach((location) => keyboard.text(location.name_uk, `sub:${location.id}`).row());
      return ctx.reply('Знайдені території:', { reply_markup: keyboard });
    }
    return ctx.reply('Оберіть область або окреме місто. Також можна написати <code>/city назва</code>.', {
      parse_mode: 'HTML', reply_markup: await locationKeyboard()
    });
  });

  bot.callbackQuery('choose_city', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('Оберіть область або скористайтеся пошуком міста:', { reply_markup: await locationKeyboard() });
  });
  bot.callbackQuery('city-search-help', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Надішліть команду: /city Назва. Наприклад: /city Павлоград', show_alert: true });
  });
  bot.callbackQuery(/^sub:(.+)$/, async (ctx) => {
    const locationId = ctx.match[1];
    const location = await pool.query(`SELECT name_uk FROM locations WHERE id=$1 AND type<>'country'`, [locationId]);
    if (!location.rowCount || !ctx.chat) return ctx.answerCallbackQuery({ text: 'Територію не знайдено', show_alert: true });
    await ensureUser(ctx.chat.id, ctx.from.username);
    await pool.query(
      `INSERT INTO subscriptions(chat_id,location_id,minimum_evidence_level) VALUES ($1,$2,'monitoring')
       ON CONFLICT (chat_id,location_id,threat_type) DO UPDATE SET enabled=true`, [ctx.chat.id, locationId]
    );
    await ctx.answerCallbackQuery({ text: 'Підписку додано' });
    await ctx.editMessageText(`Підписка активна: <b>${html(location.rows[0].name_uk)}</b>\n\nЗа замовчуванням: офіційні тривоги, загрози рівня «моніторинг+» та аналітика.`, {
      parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('Налаштувати', 'open-settings').text('Додати ще', 'choose_city')
    });
  });

  bot.command('status', async (ctx) => {
    const rows = await pool.query(
      `WITH RECURSIVE roots(root) AS (
         SELECT DISTINCT location_id FROM subscriptions WHERE chat_id=$1 AND enabled=true
       ), sub_ancestors(root,id,depth,path) AS (
           SELECT root,root,0,ARRAY[root] FROM roots
         UNION ALL
           SELECT a.root,parent.id,a.depth+1,a.path||parent.id
           FROM sub_ancestors a JOIN locations self ON self.id=a.id
           JOIN locations parent ON parent.id=self.parent_id
           WHERE a.depth<${LOCATION_HIERARCHY_MAX_DEPTH} AND NOT (parent.id=ANY(a.path))
       ), sub_descendants(root,id,depth,path) AS (
           SELECT root,root,0,ARRAY[root] FROM roots
         UNION ALL
           SELECT d.root,child.id,d.depth+1,d.path||child.id
           FROM sub_descendants d JOIN locations child ON child.parent_id=d.id
           WHERE d.depth<${LOCATION_HIERARCHY_MAX_DEPTH} AND NOT (child.id=ANY(d.path))
       ), sub_related(root,id) AS (
           SELECT root,id FROM sub_ancestors UNION SELECT root,id FROM sub_descendants
       )
       SELECT l.name_uk,
        EXISTS(SELECT 1 FROM alert_periods ap JOIN sub_related r ON r.id=ap.location_id
          WHERE r.root=s.location_id AND ap.status='active') alert_active,
        t.title threat_title,t.evidence_level,t.valid_until,
        a.threat_type assessment_type,a.risk_score,a.risk_level,a.indicative_percent,a.assessment_confidence
       FROM subscriptions s JOIN locations l ON l.id=s.location_id
       LEFT JOIN LATERAL (
         SELECT e.title,e.evidence_level,e.valid_until FROM threat_events e
         JOIN threat_event_locations el ON el.event_id=e.id
         WHERE EXISTS (SELECT 1 FROM sub_related r WHERE r.root=s.location_id AND r.id=el.location_id)
           AND e.status IN ('observed','confirmed','active')
         ORDER BY e.last_observed_at DESC LIMIT 1
       ) t ON true
       LEFT JOIN LATERAL (
         SELECT * FROM risk_assessments ra WHERE ra.location_id=s.location_id AND ra.published=true
           AND ra.expires_at>now() AND ra.superseded_by IS NULL ORDER BY ra.risk_score DESC LIMIT 1
       ) a ON true
       WHERE s.chat_id=$1 AND s.enabled=true ORDER BY l.name_uk LIMIT 30`, [ctx.chat.id]
    );
    if (!rows.rowCount) return ctx.reply('Немає активних підписок. Використайте /city.');
    const lines = rows.rows.map((row) => {
      const alert = row.alert_active ? '🔴 активна офіційна тривога' : '⚪ активної офіційної тривоги немає';
      const threat = row.threat_title ? `\n⚠️ ${html(row.threat_title)} · ${html(row.evidence_level)}` : '';
      const risk = row.risk_score != null ? `\n📊 ${html(threatLabels[row.assessment_type] ?? row.assessment_type)}: ${html(levelLabels[row.risk_level])}, ${html(row.risk_score)}/10` : '';
      return `<b>${html(row.name_uk)}</b> — ${alert}${threat}${risk}`;
    });
    await ctx.reply(`${lines.join('\n\n')}\n\nСтаном на ${new Date().toLocaleTimeString('uk-UA', { timeZone: config.APP_TIMEZONE })}. Відсутність повідомлення не означає відсутність небезпеки.`, { parse_mode: 'HTML' });
  });

  bot.command('analytics', async (ctx) => {
    const result = await pool.query(
      `SELECT DISTINCT l.name_uk,a.threat_type,a.risk_score,a.risk_level,a.indicative_percent,
              a.assessment_confidence,a.explanation,a.horizon_end
       FROM subscriptions s JOIN locations l ON l.id=s.location_id
       LEFT JOIN risk_assessments a ON a.location_id=s.location_id AND a.published=true
         AND a.expires_at>now() AND a.superseded_by IS NULL
       WHERE s.chat_id=$1 AND s.enabled=true ORDER BY a.risk_score DESC NULLS LAST LIMIT 20`, [ctx.chat.id]
    );
    if (!result.rowCount) return ctx.reply('Спочатку додайте територію через /city.');
    const lines = result.rows.map((row) => row.risk_score == null
      ? `<b>${html(row.name_uk)}</b> — актуальної оцінки немає`
      : `<b>${html(row.name_uk)}</b> — ${html(threatLabels[row.threat_type] ?? row.threat_type)}\n${html(levelLabels[row.risk_level])} · ${html(row.indicative_percent)}% індикативного рівня · ${html(row.risk_score)}/10\nВпевненість: ${html(row.assessment_confidence)}`);
    await ctx.reply(`🌙 <b>Аналітика станом на ${new Date().toLocaleTimeString('uk-UA', { timeZone: config.APP_TIMEZONE, hour: '2-digit', minute: '2-digit' })}</b>\n\n${lines.join('\n\n')}\n\nЦе індекс публічних сигналів, не статистична ймовірність і не офіційна тривога.`, { parse_mode: 'HTML' });
  });

  const showSettings = async (ctx: any, edit = false) => {
    const text = await settingsText(ctx.chat.id); const reply_markup = await settingsKeyboard(ctx.chat.id);
    if (edit) return ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup });
    return ctx.reply(text, { parse_mode: 'HTML', reply_markup });
  };
  bot.command('settings', async (ctx) => showSettings(ctx));
  bot.command('channels', async (ctx) => ctx.reply(await recommendedChannelsText(ctx.chat.id), {
    parse_mode: 'HTML', link_preview_options: { is_disabled: true }
  }));
  bot.callbackQuery('recommended-channels', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.chat) return;
    await ctx.reply(await recommendedChannelsText(ctx.chat.id), {
      parse_mode: 'HTML', link_preview_options: { is_disabled: true }
    });
  });
  bot.callbackQuery('open-settings', async (ctx) => { await ctx.answerCallbackQuery(); await showSettings(ctx, true); });
  bot.callbackQuery(/^unsub:([0-9a-f-]+)$/, async (ctx) => {
    await pool.query(`UPDATE subscriptions SET enabled=false WHERE id=$1 AND chat_id=$2`, [ctx.match[1], ctx.chat?.id]);
    await ctx.answerCallbackQuery({ text: 'Підписку вимкнено' }); await showSettings(ctx, true);
  });
  bot.callbackQuery(/^toggle-(threat|analytics):([0-9a-f-]+)$/, async (ctx) => {
    const column = ctx.match[1] === 'threat' ? 'notify_threats' : 'notify_analytics';
    await pool.query(`UPDATE subscriptions SET ${column}=NOT ${column} WHERE id=$1 AND chat_id=$2`, [ctx.match[2], ctx.chat?.id]);
    await ctx.answerCallbackQuery({ text: 'Налаштування змінено' }); await showSettings(ctx, true);
  });
  bot.callbackQuery(/^cycle-evidence:([0-9a-f-]+)$/, async (ctx) => {
    await pool.query(
      `UPDATE subscriptions SET minimum_evidence_level=CASE minimum_evidence_level
       WHEN 'official' THEN 'confirmed' WHEN 'confirmed' THEN 'monitoring'
       WHEN 'monitoring' THEN 'unverified' ELSE 'official' END WHERE id=$1 AND chat_id=$2`,
      [ctx.match[1], ctx.chat?.id]
    );
    await ctx.answerCallbackQuery({ text: 'Поріг доказовості змінено' }); await showSettings(ctx, true);
  });

  bot.command('stop', async (ctx) => {
    await pool.query(`UPDATE telegram_users SET enabled=false WHERE chat_id=$1`, [ctx.chat.id]);
    await ctx.reply('Усі повідомлення вимкнено. /start — відновити без втрати налаштувань.');
  });
  bot.command('delete_me', async (ctx) => {
    await pool.query(`DELETE FROM telegram_users WHERE chat_id=$1`, [ctx.chat.id]);
    await ctx.reply('Telegram-ідентифікатор, підписки, черга повідомлень і журнал нічних зведень видалені.');
  });
  bot.command('help', async (ctx) => ctx.reply(
    '/status — поточний стан\n/city — додати територію\n/city Назва — пошук міста\n/analytics — оцінка на 6 годин\n/channels — рекомендовані Telegram-канали\n/settings — фільтри й видалення підписок\n/stop — вимкнути повідомлення\n/delete_me — видалити дані\n\nУ разі офіційної тривоги прямуйте до визначеного укриття.'
  ));
  bot.catch((error) => console.error('Telegram bot error', error.error));
  return bot;
}
