// tgcloud/lib/pgadmin.js — ported from the Cloudflare Worker version of the bot.
import { DB, dbLog, ensurePlansLoaded, sendMessage } from './core.js';
import { PgError, buildUserCreatePayload, normalizeGroupIds, normalizePgUser, pgConfigured, pgCreateUser, pgCreateUserFromTemplate, pgDeleteUser, pgErrorHint, pgGetUser, pgListGroups, pgMissingConfig, pgPing } from './pasarguard.js';
import { escapeHtml } from './atlaspay.js';
import { formatBytes, formatDate } from './keyboards.js';

export async function handlePgPing(callbackQuery, config, env) {
  const chatId = callbackQuery.message.chat.id;
  if (!pgConfigured(config)) {
    return sendMessage(
      config.BOT_TOKEN,
      chatId,
      '❌ اتصال تنظیم نشده است. این مقدارها ست نشده‌اند:\n' +
        pgMissingConfig(config)
          .map((name) => `• <code>${escapeHtml(name)}</code>`)
          .join('\n')
    );
  }
  try {
    const result = await pgPing(env, config);
    const who = result.admin ? `\n👤 ادمین متصل: <code>${escapeHtml(result.admin)}</code>` : '';
    return sendMessage(
      config.BOT_TOKEN,
      chatId,
      `✅ اتصال به پنل برقرار است.\n🔗 مسیر بررسی: <code>${result.via}</code>${who}`
    );
  } catch (err) {
    const message = err instanceof PgError ? err.message : 'خطای نامشخص';
    await dbLog(env, 'error', 'pasarguard', `ping failed: ${message}`);
    return sendMessage(config.BOT_TOKEN, chatId, `❌ اتصال برقرار نشد.\n\n${escapeHtml(message)}`);
  }
}

export async function handlePgGroups(callbackQuery, config, env) {
  const chatId = callbackQuery.message.chat.id;
  try {
    const data = await pgListGroups(env, config);
    const groups = (data && data.groups) || [];
    if (groups.length === 0) {
      return sendMessage(
        config.BOT_TOKEN,
        chatId,
        'ℹ️ هیچ گروهی در پنل ساخته نشده است. ابتدا در پنل پاسارگارد یک Group با اینباندهای دلخواه بسازید.'
      );
    }
    let text = '📋 <b>گروه‌های پنل پاسارگارد</b>\n\nاین شناسه‌ها را در «📦 مدیریت بسته‌ها» وارد کنید:\n\n';
    for (const group of groups.slice(0, 50)) {
      text += `🔹 <code>${group.id}</code> — ${escapeHtml(String(group.name || ''))}\n`;
    }
    text += '\nمثال ورودی برای یک بسته: <code>1,3</code>';
    return sendMessage(config.BOT_TOKEN, chatId, text);
  } catch (err) {
    const message = err instanceof PgError ? err.message : 'خطای نامشخص';
    return sendMessage(config.BOT_TOKEN, chatId, `❌ دریافت گروه‌ها ناموفق بود.\n\n${escapeHtml(message)}`);
  }
}

/**
 * تست سرتاسری API: ساخت یک کاربر آزمایشی → خواندن آن → حذف آن.
 * چیزی در پنل باقی نمی‌ماند و روی اشتراک مشتری‌ها اثری ندارد.
 */
export async function handlePgSelfTest(callbackQuery, config, env) {
  const chatId = callbackQuery.message.chat.id;
  ensurePlansLoaded();
  const sample = DB.plans[0] || {};
  const username = `${config.PG_USERNAME_PREFIX}_selftest_${Math.random().toString(36).slice(2, 8)}`;
  const steps = [];

  // پنل کاربر بدون گروه (یا با گروه ناموجود) را قبول نمی‌کند، پس اول گروه‌های
  // واقعی پنل را می‌گیریم و شناسه‌های بسته را با آن‌ها تطبیق می‌دهیم.
  let groupIds = normalizeGroupIds(sample.groupIds);
  if (!sample.templateId) {
    try {
      const data = await pgListGroups(env, config);
      const groups = (data && data.groups) || [];
      const realIds = groups.map((group) => Number(group.id));

      if (!groups.length) {
        steps.push('⚠️ در پنل هیچ گروهی ساخته نشده — اول در پاسارگارد یک Group با اینباندهای دلخواه بسازید');
        groupIds = [];
      } else {
        const invalid = groupIds.filter((id) => !realIds.includes(id));
        const valid = groupIds.filter((id) => realIds.includes(id));

        if (invalid.length) {
          steps.push(
            `⚠️ این شناسه‌های گروه در پنل وجود ندارند: <b>${invalid.join('، ')}</b>\n` +
              `   گروه‌های موجود: ${groups.map((g) => `<code>${g.id}</code> (${escapeHtml(String(g.name))})`).join(' , ')}`
          );
        }

        groupIds = valid.length ? valid : [realIds[0]];
        if (!valid.length) {
          steps.push(
            `ℹ️ برای این تست از گروه «${escapeHtml(String(groups[0].name))}» (${groups[0].id}) استفاده شد`
          );
        }
      }
    } catch (err) {
      steps.push(`⚠️ دریافت گروه‌ها ناموفق بود: ${escapeHtml(err instanceof PgError ? err.message : 'خطای نامشخص')}`);
    }
  }

  const plan = {
    id: 'selftest',
    title: 'تست اتصال',
    gb: 1,
    days: 0, // کانفیگ‌ها بدون تاریخ انقضا ساخته می‌شوند
    price: 0,
    groupIds,
    templateId: sample.templateId || null,
    onHold: false,
  };

  let created = null;
  try {
    created = plan.templateId
      ? await pgCreateUserFromTemplate(env, config, plan.templateId, username, 'تست اتصال ربات')
      : await pgCreateUser(env, config, buildUserCreatePayload(plan, username, 'تست اتصال ربات'));
    const normalized = normalizePgUser(config, created);
    steps.push(`✅ ساخت کاربر: <code>${escapeHtml(normalized.pgUsername)}</code>`);
    steps.push(`✅ لینک اشتراک: <code>${escapeHtml(normalized.subscriptionUrl || '—')}</code>`);
    steps.push(`✅ حجم/انقضا: ${formatBytes(normalized.dataLimitBytes)} | ${formatDate(normalized.expireAt)}`);
  } catch (err) {
    steps.push(
      `❌ ساخت کاربر: ${escapeHtml(err instanceof PgError ? err.message : 'خطای نامشخص')}${pgErrorHint(err, plan)}`
    );
  }

  if (created) {
    try {
      await pgGetUser(env, config, username);
      steps.push('✅ خواندن وضعیت کاربر');
    } catch (err) {
      steps.push(`❌ خواندن وضعیت: ${escapeHtml(err instanceof PgError ? err.message : 'خطای نامشخص')}`);
    }
    try {
      await pgDeleteUser(env, config, username);
      steps.push('✅ حذف کاربر آزمایشی (چیزی در پنل باقی نماند)');
    } catch (err) {
      steps.push(
        `⚠️ حذف کاربر آزمایشی ناموفق بود، آن را دستی حذف کنید: <code>${escapeHtml(username)}</code>\n` +
          escapeHtml(err instanceof PgError ? err.message : 'خطای نامشخص')
      );
    }
  }

  await dbLog(env, 'info', 'pasarguard', 'self test executed', { username });
  return sendMessage(config.BOT_TOKEN, chatId, `🧪 <b>تست سرتاسری API</b>\n\n${steps.join('\n')}`);
}
