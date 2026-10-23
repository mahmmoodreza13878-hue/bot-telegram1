// tgcloud/lib/suba.js — ported from the Cloudflare Worker version of the bot.
import { DB, DEFAULT_PLAN_GROUP_IDS, MAX_TEST_CONFIGS, ORDER_STATUS, PG_STATUS_LABEL, SETTINGS_FIELDS, SHARED, SUB_STATUS, answerCallbackQuery, backNavRow, dbLog, dbSaveSubscription, dbSyncPlan, dbSyncUserWallet, editMessageCaption, editMessageMedia, editMessageReplyMarkup, editMessageText, ensurePlansLoaded, getConfig, getSession, getWallet, isAdmin, memGet, memSet, newId, normalizeChannelIdInput, resetSession, sendMessage, setSession } from './core.js';
import { PgError, normalizeGroupIds, normalizePgUser, pgDeleteUser, pgModifyUser, pgResetUserUsage, pgRevokeUserSub, pgSetUserDisabled } from './pasarguard.js';
import { escapeHtml } from './atlaspay.js';
import { adminReplyKeyboard, formatBytes, formatDate } from './keyboards.js';
import { sendLowVolumePreview, syncSubscription } from './delivery.js';
import { AD_BUTTON_TEXT_MAX, AD_TEXT_MAX, adBuildKeyboard, channelAdDetailKeyboard, describeAdDefaultButtonUrl, finalizeNewChannelAd, formatAdPreview, handleAdminsManagementMenu, handleCardsManagementMenu, handleChannelAdMenu, handlePlansManagementMenu, handleReferralAdminMenu, handleTestConfigsManagementMenu, handleTutorialsManagementMenu, handleWalletAdminMenu, isValidButtonUrl, resolveAdButtonUrl, userConfigsPageOf } from './handlers.js';

export const ADMIN_EXTEND_DAYS = 30;

// جستجوی اشتراک با شناسه اشتراک یا نام کاربری پنل
export function findSubscription(needle) {
  const key = String(needle || '').trim();
  if (!key) return null;
  const direct = memGet(DB.subscriptions, key);
  if (direct) return direct;
  for (const sub of DB.subscriptions.values()) {
    if (sub.pgUsername === key) return sub;
  }
  return null;
}

export function adminSubKeyboard(sub) {
  const disabled = sub.status === 'disabled';
  const rows = [
    [
      { text: disabled ? '✅ فعال‌سازی' : '🚫 غیرفعال‌سازی', callback_data: `sadm:toggle:${sub.id}`, style: disabled ? 'success' : 'danger' },
      { text: '🔁 ریست حجم مصرفی', callback_data: `sadm:reset:${sub.id}`, style: 'primary' },
    ],
    [
      { text: '♻️ لینک تازه (revoke)', callback_data: `sadm:revoke:${sub.id}`, style: 'primary' },
      { text: '🔄 بروزرسانی اطلاعات', callback_data: `sadm:sync:${sub.id}`, style: 'success' },
    ],
  ];

  // دکمه تمدید تاریخ فقط برای اشتراک‌هایی معنا دارد که تاریخ انقضا دارند
  // (کانفیگ‌های این فروشگاه بدون انقضا ساخته می‌شوند)
  if (sub.expireAt) {
    rows.push([{ text: `📅 +${ADMIN_EXTEND_DAYS} روز اعتبار`, callback_data: `sadm:extend:${sub.id}`, style: 'success' }]);
  }

  rows.push([{ text: '🗑 حذف کامل از پنل', callback_data: `sadm:del:${sub.id}`, style: 'danger' }]);
  rows.push(backNavRow(`ucfg:${userConfigsPageOf(sub.id)}`));
  return { inline_keyboard: rows };
}

export function formatAdminSubscription(sub) {
  const expireLine = sub.expireAt ? `\n📅 انقضا: ${formatDate(sub.expireAt)}` : '';
  return (
    `🛰 <b>اشتراک ${escapeHtml(sub.pgUsername)}</b>\n\n` +
    `👤 مشتری: <code>${escapeHtml(String(sub.userId))}</code>\n` +
    `📦 بسته: ${escapeHtml(sub.planTitle || '-')}\n` +
    `📌 وضعیت: ${PG_STATUS_LABEL[sub.status] || escapeHtml(sub.status)}\n` +
    `📶 حجم: ${formatBytes(sub.dataLimitBytes)} | مصرف: ${formatBytes(sub.usedTrafficBytes)}` +
    expireLine +
    `\n🆔 شناسه: <code>${escapeHtml(sub.id)}</code>\n` +
    `🔗 <code>${escapeHtml(sub.subscriptionUrl || '—')}</code>`
  );
}

// دستور ادمین: /sub <شناسه اشتراک یا نام کاربری پنل>
export async function handleAdminSubLookup(message, config, env) {
  const chatId = message.chat.id;
  const needle = (message.text || '').replace(/^\/sub(@\S+)?\s*/i, '').trim();

  if (!needle) {
    const recent = [...DB.subscriptions.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    let text = '🛰 <b>مدیریت اشتراک</b>\n\nاستفاده: <code>/sub نام‌کاربری‌پنل</code>\n';
    if (recent.length) {
      text += '\nآخرین اشتراک‌ها:\n';
      for (const sub of recent.slice(0, 10)) {
        text += `🔹 <code>${escapeHtml(sub.pgUsername)}</code> — ${escapeHtml(sub.planTitle || '-')}\n`;
      }
    }
    return sendMessage(config.BOT_TOKEN, chatId, text);
  }

  const sub = findSubscription(needle);
  if (!sub) {
    return sendMessage(config.BOT_TOKEN, chatId, '❌ اشتراکی با این شناسه/نام کاربری در دیتابیس ربات پیدا نشد.');
  }

  await syncSubscription(env, config, sub);
  return sendMessage(config.BOT_TOKEN, chatId, formatAdminSubscription(sub), {
    reply_markup: adminSubKeyboard(sub),
  });
}

// اجرای عملیات ادمین روی اشتراک
export async function handleAdminSubAction(callbackQuery, action, subId, config, env) {
  const chatId = callbackQuery.message.chat.id;
  const sub = memGet(DB.subscriptions, subId);
  if (!sub) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ اشتراک یافت نشد.', true);
  }

  try {
    if (action === 'toggle') {
      const disable = sub.status !== 'disabled';
      const updated = normalizePgUser(config, await pgSetUserDisabled(env, config, sub.pgUsername, disable));
      sub.status = updated.status;
      await sendMessage(
        config.BOT_TOKEN,
        chatId,
        disable ? '🚫 اشتراک در پنل غیرفعال شد.' : '✅ اشتراک در پنل فعال شد.'
      );
    } else if (action === 'reset') {
      const updated = normalizePgUser(config, await pgResetUserUsage(env, config, sub.pgUsername));
      sub.usedTrafficBytes = updated.usedTrafficBytes;
      await sendMessage(config.BOT_TOKEN, chatId, '🔁 حجم مصرفی این اشتراک صفر شد.');
    } else if (action === 'revoke') {
      const updated = normalizePgUser(config, await pgRevokeUserSub(env, config, sub.pgUsername));
      if (updated.subscriptionUrl) sub.subscriptionUrl = updated.subscriptionUrl;
      await sendMessage(
        config.BOT_TOKEN,
        chatId,
        '♻️ لینک قبلی باطل شد. لینک تازه برای مشتری ارسال می‌شود.'
      );
      await sendMessage(
        config.BOT_TOKEN,
        sub.chatId || sub.userId,
        `♻️ لینک اشتراک شما بازنشانی شد. لینک تازه:\n<code>${escapeHtml(sub.subscriptionUrl)}</code>`
      );
    } else if (action === 'extend') {
      if (!sub.expireAt || sub.status === 'on_hold') {
        await answerCallbackQuery(
          config.BOT_TOKEN,
          callbackQuery.id,
          'ℹ️ این اشتراک تاریخ انقضا ندارد و فقط با حجم محدود می‌شود.',
          true
        );
        return;
      }
      const base = Math.max(Date.now(), Number(sub.expireAt) || Date.now());
      const newExpire = Math.floor(base / 1000) + ADMIN_EXTEND_DAYS * 86400;
      const updated = normalizePgUser(config, await pgModifyUser(env, config, sub.pgUsername, { expire: newExpire }));
      sub.expireAt = updated.expireAt;
      sub.status = updated.status;
      await sendMessage(
        config.BOT_TOKEN,
        chatId,
        `📅 اعتبار تا ${formatDate(sub.expireAt)} تمدید شد.`
      );
      await sendMessage(
        config.BOT_TOKEN,
        sub.chatId || sub.userId,
        `📅 اعتبار اشتراک شما تا <b>${formatDate(sub.expireAt)}</b> تمدید شد.`
      );
    }
  } catch (err) {
    const message = err instanceof PgError ? err.message : 'خطای نامشخص';
    await dbLog(env, 'error', 'pasarguard', `admin action ${action} failed: ${message}`, {}, {
      telegramId: sub.userId,
    });
    return sendMessage(config.BOT_TOKEN, chatId, `❌ عملیات انجام نشد.\n\n${escapeHtml(message)}`);
  }

  if (action === 'sync') await syncSubscription(env, config, sub);

  sub.lastSyncedAt = Date.now();
  memSet(DB.subscriptions, sub.id, sub);
  await dbSaveSubscription(env, sub);
  await dbLog(env, 'info', 'pasarguard', `admin action ${action}`, {}, { telegramId: sub.userId });

  return sendMessage(config.BOT_TOKEN, chatId, formatAdminSubscription(sub), {
    reply_markup: adminSubKeyboard(sub),
  });
}

// حذف اشتراک عملیاتی برگشت‌ناپذیر است، پس یک مرحله تایید دارد
export async function handleAdminSubDeleteAsk(callbackQuery, subId, config) {
  const sub = memGet(DB.subscriptions, subId);
  if (!sub) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ اشتراک یافت نشد.', true);
  }
  return sendMessage(
    config.BOT_TOKEN,
    callbackQuery.message.chat.id,
    `⚠️ <b>حذف کامل اشتراک</b>\n\n` +
      `کاربر <code>${escapeHtml(sub.pgUsername)}</code> از پنل پاسارگارد حذف می‌شود و ` +
      `لینک اشتراک مشتری از کار می‌افتد. این کار برگشت‌ناپذیر است.\n\nمطمئن هستید؟`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🗑 بله، حذف کن', callback_data: `sadm:delok:${sub.id}`, style: 'danger' },
            { text: '⚪ انصراف', callback_data: 'noop', style: 'primary' },
          ],
        ],
      },
    }
  );
}

export async function handleAdminSubDelete(callbackQuery, subId, config, env) {
  const chatId = callbackQuery.message.chat.id;
  const sub = memGet(DB.subscriptions, subId);
  if (!sub) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ اشتراک یافت نشد.', true);
  }

  try {
    await pgDeleteUser(env, config, sub.pgUsername);
  } catch (err) {
    const message = err instanceof PgError ? err.message : 'خطای نامشخص';
    if (!(err instanceof PgError) || err.status !== 404) {
      await dbLog(env, 'error', 'pasarguard', `delete failed: ${message}`, {}, { telegramId: sub.userId });
      return sendMessage(config.BOT_TOKEN, chatId, `❌ حذف انجام نشد.\n\n${escapeHtml(message)}`);
    }
  }

  sub.status = SUB_STATUS.REVOKED;
  sub.updatedAt = Date.now();
  memSet(DB.subscriptions, sub.id, sub);
  await dbSaveSubscription(env, sub);
  await dbLog(env, 'info', 'pasarguard', 'subscription deleted by admin', {}, { telegramId: sub.userId });

  return sendMessage(
    config.BOT_TOKEN,
    chatId,
    `🗑 اشتراک <code>${escapeHtml(sub.pgUsername)}</code> از پنل حذف و در دیتابیس ربات باطل شد.`
  );
}

export async function handleAdminAwaitingInput(message, config, env) {
  const fromId = message.from.id;
  if (!isAdmin(fromId, config)) return false;

  const session = getSession(`admin_${fromId}`);
  const text = (message.text || message.caption || '').trim();

  switch (session.step) {
    case 'awaiting_send_account': {
      const orderId = session.data.orderId;
      const order = memGet(DB.orders, orderId);
      if (!order) {
        resetSession(`admin_${fromId}`);
        await sendMessage(config.BOT_TOKEN, message.chat.id, '❌ سفارش یافت نشد.');
        return true;
      }
      if (!text) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ لطفاً اطلاعات اکانت را به‌صورت متن ارسال کنید.');
        return true;
      }
      await sendMessage(
        config.BOT_TOKEN,
        order.chatId,
        `📨 <b>اکانت شما آماده است!</b>\n\nسفارش: #${order.id} | ${escapeHtml(order.planTitle)}\n\n${escapeHtml(text)}`
      );
      order.status = ORDER_STATUS.SENT;
      order.updatedAt = Date.now();
      order.accountInfo = text;
      memSet(DB.orders, order.id, order);
      resetSession(`admin_${fromId}`);
      await sendMessage(config.BOT_TOKEN, message.chat.id, `✅ اکانت برای سفارش #${order.id} ارسال شد.`);
      return true;
    }

    case 'awaiting_card_bank': {
      if (!text) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ لطفاً نام بانک را ارسال کنید.');
        return true;
      }
      session.data.bankName = text;
      session.step = 'awaiting_card_number';
      setSession(`admin_${fromId}`, session);
      await sendMessage(config.BOT_TOKEN, message.chat.id, '💳 شماره کارت را ارسال کنید:');
      return true;
    }

    case 'awaiting_card_number': {
      if (!text) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ لطفاً شماره کارت را ارسال کنید.');
        return true;
      }
      session.data.number = text;
      session.step = 'awaiting_card_holder';
      setSession(`admin_${fromId}`, session);
      await sendMessage(config.BOT_TOKEN, message.chat.id, '👤 نام صاحب کارت را ارسال کنید:');
      return true;
    }

    case 'awaiting_card_holder': {
      if (!text) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ لطفاً نام صاحب کارت را ارسال کنید.');
        return true;
      }
      const card = { id: SHARED.cardSeq++, bankName: session.data.bankName, number: session.data.number, holder: text };
      memSet(DB.cards, card.id, card);
      resetSession(`admin_${fromId}`);
      await sendMessage(config.BOT_TOKEN, message.chat.id, '✅ کارت جدید ثبت شد و برای همیشه ذخیره شد.');
      await handleCardsManagementMenu(message.chat.id, config);
      return true;
    }

    case 'awaiting_tutorial_title': {
      if (!text) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ لطفاً عنوان آموزش را ارسال کنید.');
        return true;
      }
      session.data.title = text;
      session.step = 'awaiting_tutorial_url';
      setSession(`admin_${fromId}`, session);
      await sendMessage(
        config.BOT_TOKEN,
        message.chat.id,
        '🔗 لینک آموزش را ارسال کنید (باید با http:// یا https:// شروع شود):'
      );
      return true;
    }

    case 'awaiting_tutorial_url': {
      const url = text.trim();
      if (!/^https?:\/\/\S+$/i.test(url)) {
        await sendMessage(
          config.BOT_TOKEN,
          message.chat.id,
          '⚠️ لینک نامعتبر است. لطفاً لینکی که با http:// یا https:// شروع می‌شود ارسال کنید:'
        );
        return true;
      }
      if (session.data.mode === 'edit' && session.data.tutorialId != null) {
        const existing = memGet(DB.tutorials, session.data.tutorialId);
        if (!existing) {
          resetSession(`admin_${fromId}`);
          await sendMessage(config.BOT_TOKEN, message.chat.id, '❌ آموزش یافت نشد (شاید قبلاً حذف شده).');
          return true;
        }
        existing.title = session.data.title;
        existing.url = url;
        memSet(DB.tutorials, existing.id, existing);
        resetSession(`admin_${fromId}`);
        await sendMessage(config.BOT_TOKEN, message.chat.id, '✅ آموزش ویرایش شد و برای همیشه ذخیره شد.');
      } else {
        const tutorial = { id: SHARED.tutorialSeq++, title: session.data.title, url };
        memSet(DB.tutorials, tutorial.id, tutorial);
        resetSession(`admin_${fromId}`);
        await sendMessage(config.BOT_TOKEN, message.chat.id, '✅ آموزش جدید ثبت شد و برای همیشه ذخیره شد.');
      }
      await handleTutorialsManagementMenu(message.chat.id, config);
      return true;
    }

    case 'awaiting_plans_per_gb': {
      const digits = String(text || '')
        .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
        .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
        .replace(/[,٬\s]/g, '');
      let perGb = Number(digits);
      if (!digits || isNaN(perGb) || perGb <= 0) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ لطفاً یک عدد معتبر ارسال کنید (مثلاً 4000).');
        return true;
      }
      if (perGb < 1000) perGb *= 1000; // «4» یعنی ۴ هزار تومان
      perGb = Math.round(perGb);
      if (perGb > 100000000) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ عدد خیلی بزرگ است. قیمت هر گیگ را به تومان ارسال کنید.');
        return true;
      }

      ensurePlansLoaded();
      let priced = 0;
      for (const plan of DB.plans) {
        if (Number(plan.gb) > 0) {
          plan.price = Math.round(Number(plan.gb) * perGb);
          priced++;
        }
        plan.groupIds = [...DEFAULT_PLAN_GROUP_IDS];
        plan.templateId = null;
        // آینه‌سازی در D1 تا گزارش‌گیری هم قیمت‌های جدید را ببیند (بدون D1 بی‌صدا رد می‌شود)
        await dbSyncPlan(env, plan);
      }
      resetSession(`admin_${fromId}`);

      await sendMessage(
        config.BOT_TOKEN,
        message.chat.id,
        `✅ قیمت هر گیگ روی <b>${perGb.toLocaleString()} تومان</b> تنظیم شد.\n` +
          `📦 ${priced} بسته قیمت‌گذاری شد؛ گروه‌ها: ${DEFAULT_PLAN_GROUP_IDS.join('، ')} | بدون قالب.`
      );
      await handlePlansManagementMenu(message.chat.id, getConfig(env));
      return true;
    }

    case 'awaiting_plan_title': {
      if (!text) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ لطفاً یک عنوان معتبر ارسال کنید.');
        return true;
      }
      session.data.title = text;
      session.step = 'awaiting_plan_gb';
      setSession(`admin_${fromId}`, session);
      await sendMessage(config.BOT_TOKEN, message.chat.id, '📶 حجم بسته را به گیگابایت ارسال کنید (فقط عدد، ۰ = نامحدود):');
      return true;
    }

    case 'awaiting_plan_gb': {
      const gb = Number(text);
      if (!text || isNaN(gb) || gb < 0) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ لطفاً یک عدد معتبر (۰ یا بیشتر) برای حجم ارسال کنید.');
        return true;
      }
      session.data.gb = gb;
      // کانفیگ‌ها تاریخ انقضا ندارند، پس مرحله «مدت اعتبار» پرسیده نمی‌شود
      session.data.days = 0;
      session.step = 'awaiting_plan_price';
      setSession(`admin_${fromId}`, session);
      await sendMessage(config.BOT_TOKEN, message.chat.id, '💰 قیمت بسته را به تومان ارسال کنید (فقط عدد):');
      return true;
    }

    case 'awaiting_plan_price': {
      const price = Number(text);
      if (!text || isNaN(price) || price < 0) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ لطفاً یک عدد معتبر برای قیمت (تومان) ارسال کنید.');
        return true;
      }
      session.data.price = price;
      session.step = 'awaiting_plan_groups';
      setSession(`admin_${fromId}`, session);
      await sendMessage(
        config.BOT_TOKEN,
        message.chat.id,
        '🧩 شناسه گروه‌های پاسارگارد این بسته را با کاما ارسال کنید (مثلاً <code>1,3</code>).\n\n' +
          'برای دیدن شناسه‌ها: پنل ادمین ← «🛰 پاسارگارد» ← «📋 دریافت لیست گروه‌ها».\n' +
          '⚠️ اگر گروه ندهید و قالب هم تعیین نکنید، کاربر ساخته می‌شود ولی هیچ کانفیگی نخواهد داشت.\n' +
          'برای رد کردن این مرحله «-» بفرستید.'
      );
      return true;
    }

    case 'awaiting_plan_groups': {
      let groupIds = [];
      if (text && text !== '-') {
        groupIds = normalizeGroupIds(text.split(/[,\s;]+/));
        if (groupIds.length === 0) {
          await sendMessage(
            config.BOT_TOKEN,
            message.chat.id,
            '⚠️ فرمت نامعتبر است. نمونه صحیح: <code>1,3</code> — یا برای رد کردن «-» بفرستید.'
          );
          return true;
        }
      }
      session.data.groupIds = groupIds;
      session.step = 'awaiting_plan_template';
      setSession(`admin_${fromId}`, session);
      await sendMessage(
        config.BOT_TOKEN,
        message.chat.id,
        '🧾 اگر می‌خواهید این بسته از «قالب کاربری» پنل ساخته شود، شناسه عددی قالب ' +
          '(user_template_id) را ارسال کنید.\n\n' +
          'در این حالت حجم و مدت از خود قالب پنل خوانده می‌شود.\n' +
          'برای استفاده از حجم/مدتی که همین‌جا وارد کردید، «-» بفرستید.'
      );
      return true;
    }

    case 'awaiting_plan_template': {
      let templateId = null;
      if (text && text !== '-') {
        const parsed = Number(text);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          await sendMessage(
            config.BOT_TOKEN,
            message.chat.id,
            '⚠️ شناسه قالب باید یک عدد صحیح مثبت باشد — یا برای رد کردن «-» بفرستید.'
          );
          return true;
        }
        templateId = parsed;
      }

      ensurePlansLoaded();
      let savedPlan = null;

      if (session.data.mode === 'edit') {
        const plan = DB.plans.find((p) => p.id === session.data.planId);
        if (plan) {
          plan.title = session.data.title;
          plan.gb = session.data.gb;
          plan.days = 0;
          plan.price = session.data.price;
          plan.groupIds = session.data.groupIds;
          plan.templateId = templateId;
          savedPlan = plan;
        }
        resetSession(`admin_${fromId}`);
        await sendMessage(config.BOT_TOKEN, message.chat.id, '✅ بسته ویرایش شد و برای همیشه ذخیره شد.');
      } else {
        savedPlan = {
          id: `custom${SHARED.planSeq++}`,
          title: session.data.title,
          gb: session.data.gb,
          days: 0,
          price: session.data.price,
          groupIds: session.data.groupIds,
          templateId,
          onHold: false,
        };
        DB.plans.push(savedPlan);
        resetSession(`admin_${fromId}`);
        await sendMessage(config.BOT_TOKEN, message.chat.id, '✅ بسته جدید اضافه شد و برای همیشه ذخیره شد.');
      }

      if (savedPlan) await dbSyncPlan(env, savedPlan);
      await handlePlansManagementMenu(message.chat.id, config);
      return true;
    }

    case 'awaiting_broadcast_message': {
      if (!text) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ لطفاً متن پیام را ارسال کنید.');
        return true;
      }
      resetSession(`admin_${fromId}`);
      const broadcastUsers = [...DB.users.values()];
      let broadcastOk = 0;
      let broadcastFail = 0;
      await sendMessage(config.BOT_TOKEN, message.chat.id, `⏳ در حال ارسال پیام به <b>${broadcastUsers.length}</b> کاربر...`);
      for (const u of broadcastUsers) {
        try {
          const targetChatId = u.chatId || u.id;
          await sendMessage(
            config.BOT_TOKEN,
            targetChatId,
            `📢 <b>پیام مهم</b>\n\n${text}`
          );
          broadcastOk++;
        } catch (_e) {
          broadcastFail++;
        }
      }
      await sendMessage(
        config.BOT_TOKEN,
        message.chat.id,
        `✅ پیام همگانی ارسال شد.\n\n` +
          `✔️ موفق: <b>${broadcastOk}</b>\n` +
          `❌ ناموفق (بلاک یا خطا): <b>${broadcastFail}</b>`
      );
      return true;
    }

    case 'awaiting_test_configs_bulk': {
      if (!text) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ لطفاً حداقل یک کانفیگ به‌صورت متن ارسال کنید.');
        return true;
      }
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      if (lines.length === 0) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ هیچ خط معتبری پیدا نشد. لطفاً دوباره ارسال کنید.');
        return true;
      }

      const remaining = MAX_TEST_CONFIGS - DB.testConfigs.length;
      if (remaining <= 0) {
        resetSession(`admin_${fromId}`);
        await sendMessage(config.BOT_TOKEN, message.chat.id, `⛔ ظرفیت پر است (حداکثر ${MAX_TEST_CONFIGS} کانفیگ).`);
        await handleTestConfigsManagementMenu(message.chat.id, config);
        return true;
      }

      const toAdd = lines.slice(0, remaining);
      const dropped = lines.length - toAdd.length;

      for (const line of toAdd) {
        DB.testConfigs.push({ id: SHARED.testConfigSeq++, text: line, used: false, usedByUserId: null, usedAt: null });
      }

      resetSession(`admin_${fromId}`);

      let confirmText = `✅ ${toAdd.length} کانفیگ تست اضافه شد و برای همیشه ذخیره شد.`;
      if (dropped > 0) {
        confirmText += `\n⚠️ ${dropped} خط دیگر به‌دلیل پر شدن ظرفیت (سقف ${MAX_TEST_CONFIGS} عدد) اضافه نشد.`;
      }
      await sendMessage(config.BOT_TOKEN, message.chat.id, confirmText);
      await handleTestConfigsManagementMenu(message.chat.id, config);
      return true;
    }

    case 'awaiting_admin_id': {
      let newId = null;
      if (message.forward_from && message.forward_from.id) {
        newId = String(message.forward_from.id);
      } else if (/^\d+$/.test(text)) {
        newId = text;
      }
      if (!newId) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ پیام معتبر نبود. یک پیام از کاربر فوروارد کنید یا آیدی عددی او را ارسال کنید.');
        return true;
      }
      DB.admins.add(newId);
      resetSession(`admin_${fromId}`);
      await sendMessage(config.BOT_TOKEN, message.chat.id, `✅ کاربر <code>${newId}</code> به‌عنوان ادمین اضافه شد و برای همیشه ذخیره شد.`);
      await handleAdminsManagementMenu(message.chat.id, config);
      return true;
    }

    case 'awaiting_wallet_adjust_id': {
      let targetId = null;
      if (message.forward_from && message.forward_from.id) {
        targetId = String(message.forward_from.id);
      } else if (/^\d+$/.test(text)) {
        targetId = text;
      }
      if (!targetId) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ پیام معتبر نبود. یک پیام از کاربر فوروارد کنید یا آیدی عددی او را ارسال کنید.');
        return true;
      }
      session.data.targetId = targetId;
      session.step = 'awaiting_wallet_adjust_amount';
      setSession(`admin_${fromId}`, session);
      const currentBalance = getWallet(targetId);
      await sendMessage(
        config.BOT_TOKEN,
        message.chat.id,
        `👤 کاربر: <code>${targetId}</code>\n💰 موجودی فعلی: ${currentBalance.toLocaleString()} تومان\n\n` +
          'مبلغ تغییر را ارسال کنید. برای افزایش موجودی با + و برای کاهش با - شروع کنید، مثلاً:\n<code>+50000</code> یا <code>-20000</code>'
      );
      return true;
    }

    case 'awaiting_wallet_adjust_amount': {
      const match = /^([+-])\s*(\d+)$/.exec(text);
      if (!match) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ فرمت نامعتبر است. مثال صحیح: +50000 یا -20000');
        return true;
      }
      const sign = match[1] === '-' ? -1 : 1;
      const amount = Number(match[2]) * sign;
      const targetId = session.data.targetId;
      const user = memGet(DB.users, targetId) || { id: targetId, orders: [], walletBalance: 0 };
      const newBalance = (user.walletBalance || 0) + amount;
      if (newBalance < 0) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ موجودی نمی‌تواند منفی شود.');
        return true;
      }
      user.walletBalance = newBalance;
      memSet(DB.users, targetId, user);
      await dbSyncUserWallet(env, targetId, newBalance);
      resetSession(`admin_${fromId}`);
      await sendMessage(
        config.BOT_TOKEN,
        message.chat.id,
        `✅ موجودی کاربر <code>${targetId}</code> بروزرسانی شد.\nموجودی جدید: ${newBalance.toLocaleString()} تومان`
      );
      await sendMessage(
        config.BOT_TOKEN,
        targetId,
        `💰 موجودی کیف پول شما توسط ادمین بروزرسانی شد.\nموجودی جدید: <b>${newBalance.toLocaleString()} تومان</b>`
      );
      return true;
    }

    case 'awaiting_setting_value': {
      const field = session.data.field;
      if (!SETTINGS_FIELDS[field]) {
        resetSession(`admin_${fromId}`);
        return true;
      }

      // ---- مورد خاص: تنظیم آیدی کانال ----
      if (field === 'CHANNEL_ID') {
        // اگر ادمین یک پست از کانال را فوروارد کند، آیدی عددی صحیح (حتی برای
        // کانال خصوصی) از روی خود پیام استخراج می‌شود — این تنها راه مطمئن
        // برای گرفتن chat_id قابل استفاده در کانال‌های خصوصی است.
        const forwardedChat = message.forward_from_chat
          || (message.forward_origin && message.forward_origin.chat)
          || null;
        if (forwardedChat && forwardedChat.type === 'channel') {
          const channelId = String(forwardedChat.id);
          if (!DB.settings) DB.settings = {};
          DB.settings.CHANNEL_ID = channelId;
          resetSession(`admin_${fromId}`);
          await sendMessage(config.BOT_TOKEN, message.chat.id,
            `✅ آیدی کانال «${escapeHtml(forwardedChat.title || '')}» با موفقیت ثبت شد.\n` +
            `مقدار ذخیره‌شده: <code>${channelId}</code>\n\n` +
            '⚠️ یادتان باشد ربات باید در این کانال «ادمین» باشد تا بتواند پیام ارسال کند و عضویت را چک کند.');
          return true;
        }
        if (!text) {
          await sendMessage(config.BOT_TOKEN, message.chat.id,
            '⚠️ لطفاً @username کانال را بفرستید، یا یک پست از کانال را فوروارد کنید.');
          return true;
        }
        const normalized = normalizeChannelIdInput(text);
        if (normalized.invitelink) {
          await sendMessage(config.BOT_TOKEN, message.chat.id,
            '⚠️ لینک‌های دعوت خصوصی (t.me/+...) را نمی‌توان مستقیماً به‌عنوان آیدی کانال استفاده کرد ' +
            '(همان علت خطای «chat not found»).\n\n' +
            '👉 راه‌حل: یک پست از همین کانال را همین‌جا برای ربات <b>فوروارد</b> کنید تا آیدی عددی صحیح ' +
            'خودکار استخراج و ذخیره شود.\n\n' +
            'نکته: ربات باید از قبل در آن کانال «ادمین» باشد.');
          return true;
        }
        if (!DB.settings) DB.settings = {};
        DB.settings.CHANNEL_ID = normalized.value;
        resetSession(`admin_${fromId}`);
        await sendMessage(config.BOT_TOKEN, message.chat.id,
          `✅ «${SETTINGS_FIELDS[field]}» بروزرسانی شد و برای همیشه ذخیره شد.\nمقدار جدید: <code>${escapeHtml(normalized.value)}</code>\n\n` +
          '⚠️ یادتان باشد ربات باید در این کانال «ادمین» باشد.');
        return true;
      }

      if (!text) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ لطفاً یک مقدار معتبر ارسال کنید.');
        return true;
      }
      if (field === 'LOW_VOLUME_ALERT_TEXT') {
        if (/^(default|پیش‌فرض|پیشفرض)$/i.test(text.trim())) {
          if (DB.settings) delete DB.settings.LOW_VOLUME_ALERT_TEXT;
          resetSession(`admin_${fromId}`);
          await sendMessage(config.BOT_TOKEN, message.chat.id, '✅ متن هشدار کم‌شدن حجم به حالت پیش‌فرض برگشت.');
          await sendLowVolumePreview(message.chat.id, getConfig(env));
          return true;
        }
        if (text.length > 1000) {
          await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ متن هشدار حداکثر ۱۰۰۰ کاراکتر باشد.');
          return true;
        }
      }
      if ((field === 'INVITE_TEXT' && text.length > 1000) ||
          (field === 'BTN_INVITE_LABEL' && (text.length > 64 || /[\r\n]/.test(text)))) {
        await sendMessage(config.BOT_TOKEN, message.chat.id,
          '⚠️ متن دعوت حداکثر ۱۰۰۰ کاراکتر و نام دکمه حداکثر ۶۴ کاراکتر در یک خط باشد.');
        return true;
      }
      if (field === 'BTN_INVITE_LABEL' && (text.startsWith('/') ||
          Object.keys(SETTINGS_FIELDS).some(key => key.startsWith('BTN_') && key !== field && config[key] === text) ||
          adminReplyKeyboard().keyboard.flat().some(button => button.text === text))) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ نام دکمه باید با سایر دکمه‌ها و دستورات متفاوت باشد.');
        return true;
      }
      if (!DB.settings) DB.settings = {};
      DB.settings[field] = text;
      resetSession(`admin_${fromId}`);
      await sendMessage(
        config.BOT_TOKEN,
        message.chat.id,
        `✅ «${SETTINGS_FIELDS[field]}» بروزرسانی شد و برای همیشه ذخیره شد.\nمقدار جدید: <code>${escapeHtml(text)}</code>`
      );
      if (field === 'INVITE_TEXT' || field === 'BTN_INVITE_LABEL') {
        await handleReferralAdminMenu(message.chat.id, getConfig(env));
      }
      if (field === 'LOW_VOLUME_ALERT_TEXT') {
        await sendLowVolumePreview(message.chat.id, getConfig(env));
      }
      return true;
    }

    case 'awaiting_wallet_min_topup': {
      const minTopup = Math.round(Number(text));
      if (!text || isNaN(minTopup) || minTopup < 1000 || minTopup > 1000000000) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ لطفاً یک عدد معتبر (حداقل ۱٬۰۰۰ تومان) ارسال کنید.');
        return true;
      }
      if (!DB.settings) DB.settings = {};
      DB.settings.WALLET_MIN_TOPUP = minTopup;
      resetSession(`admin_${fromId}`);
      await sendMessage(
        config.BOT_TOKEN,
        message.chat.id,
        `✅ حداقل مبلغ شارژ کیف پول به ${minTopup.toLocaleString()} تومان تغییر کرد.`
      );
      await handleWalletAdminMenu(message.chat.id, getConfig(env));
      return true;
    }

    case 'awaiting_referral_commission_percent': {
      const percent = Number(text);
      if (!text || isNaN(percent) || percent <= 0 || percent > 100) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ لطفاً یک عدد معتبر بین ۱ تا ۱۰۰ ارسال کنید.');
        return true;
      }
      if (!DB.settings) DB.settings = {};
      DB.settings.REFERRAL_COMMISSION_PERCENT = percent;
      resetSession(`admin_${fromId}`);
      await sendMessage(config.BOT_TOKEN, message.chat.id, `✅ درصد پورسانت به ${percent}٪ بروزرسانی شد.`);
      await handleReferralAdminMenu(message.chat.id, getConfig(env));
      return true;
    }

    case 'awaiting_ad_channel_id': {
      // اگر ادمین یک پست از کانال را فوروارد کند، آیدی عددی صحیح (حتی برای
      // کانال خصوصی) از روی خود پیام استخراج می‌شود.
      const forwardedChat = message.forward_from_chat
        || (message.forward_origin && message.forward_origin.chat)
        || null;
      let channelId = null;
      let channelLabel = '';
      if (forwardedChat && forwardedChat.type === 'channel') {
        channelId = String(forwardedChat.id);
        channelLabel = forwardedChat.title || '';
      } else if (text && /^-?\d{3,20}$/.test(text.trim())) {
        channelId = text.trim();
      } else {
        await sendMessage(config.BOT_TOKEN, message.chat.id,
          '⚠️ این مقدار آیدی عددی معتبر یک کانال نیست.\n\n' +
          'یا فقط رقم‌های آیدی عددی کانال را بفرستید (مثل <code>-1001234567890</code>)، ' +
          'یا یک پست از همان کانال را همین‌جا برای ربات فوروارد کنید.');
        return true;
      }
      // توجه: این مقدار فقط برای همین آگهی در سشن نگه داشته می‌شود و هیچ‌وقت
      // در DB.settings.CHANNEL_ID (کانال پیش‌فرض) نوشته نمی‌شود.
      session.data.channelId = channelId;
      session.step = 'awaiting_ad_text';
      setSession(`admin_${fromId}`, session);
      await sendMessage(config.BOT_TOKEN, message.chat.id,
        `✅ کانال مقصد این آگهی ثبت شد: <code>${escapeHtml(channelId)}</code>${channelLabel ? ` (${escapeHtml(channelLabel)})` : ''}\n\n` +
        `📝 حالا متن آگهی را ارسال کنید (حداکثر ${AD_TEXT_MAX} کاراکتر، HTML پشتیبانی می‌شود):`);
      return true;
    }

    case 'awaiting_ad_text': {
      if (!text || text.length > AD_TEXT_MAX) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, `⚠️ لطفاً متنی بین ۱ تا ${AD_TEXT_MAX} کاراکتر ارسال کنید.`);
        return true;
      }
      session.data.text = text;
      session.step = 'awaiting_ad_photo';
      setSession(`admin_${fromId}`, session);
      await sendMessage(config.BOT_TOKEN, message.chat.id,
        '🖼 عکس آگهی را ارسال کنید (اختیاری).\nاگر عکس نمی‌خواهید، دستور /skip را بفرستید.');
      return true;
    }

    case 'awaiting_ad_photo': {
      if (text === '/skip') {
        session.data.photoFileId = null;
      } else if (message.photo && message.photo.length > 0) {
        session.data.photoFileId = message.photo[message.photo.length - 1].file_id;
      } else {
        await sendMessage(config.BOT_TOKEN, message.chat.id,
          '⚠️ لطفاً یک عکس ارسال کنید یا برای رد کردن /skip را بفرستید.');
        return true;
      }
      session.step = 'awaiting_ad_button_text';
      setSession(`admin_${fromId}`, session);
      await sendMessage(config.BOT_TOKEN, message.chat.id,
        `🔘 متن دکمه شیشه‌ای زیر آگهی را ارسال کنید (حداکثر ${AD_BUTTON_TEXT_MAX} کاراکتر؛ مثلاً «🛒 خرید اشتراک»).\n` +
        `برای استفاده از دکمه پیش‌فرض «${config.AD_DEFAULT_BUTTON_TEXT}» → ${describeAdDefaultButtonUrl(config)} دستور /default را بفرستید.\n` +
        'اگر دکمه نمی‌خواهید، دستور /skip را بفرستید.');
      return true;
    }

    case 'awaiting_ad_button_text': {
      if (text === '/skip') {
        session.data.buttonText = null;
        session.data.buttonUrl = null;
        const chatId = message.chat.id;
        const ad = await finalizeNewChannelAd(config, chatId, session);
        resetSession(`admin_${fromId}`);
        if (ad) {
          await sendMessage(config.BOT_TOKEN, chatId, '✅ آگهی با موفقیت در کانال ارسال شد.');
          await handleChannelAdMenu(chatId, config);
        }
        return true;
      }
      if (text === '/default') {
        const resolvedUrl = await resolveAdButtonUrl(config, config.AD_DEFAULT_BUTTON_URL);
        if (!resolvedUrl) {
          await sendMessage(config.BOT_TOKEN, message.chat.id,
            '⚠️ ساخت لینک پیش‌فرض «خرید اشتراک» ممکن نشد (دریافت اطلاعات ربات ناموفق بود). کمی بعد دوباره امتحان کنید یا یک لینک دستی وارد کنید.');
          return true;
        }
        session.data.buttonText = config.AD_DEFAULT_BUTTON_TEXT;
        session.data.buttonUrl = resolvedUrl;
        const chatId = message.chat.id;
        const ad = await finalizeNewChannelAd(config, chatId, session);
        resetSession(`admin_${fromId}`);
        if (ad) {
          await sendMessage(config.BOT_TOKEN, chatId, '✅ آگهی با دکمه پیش‌فرض «خرید اشتراک» در کانال ارسال شد.');
          await handleChannelAdMenu(chatId, config);
        }
        return true;
      }
      if (!text || text.length > AD_BUTTON_TEXT_MAX) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, `⚠️ متن دکمه باید بین ۱ تا ${AD_BUTTON_TEXT_MAX} کاراکتر باشد.`);
        return true;
      }
      session.data.buttonText = text;
      session.step = 'awaiting_ad_button_url';
      setSession(`admin_${fromId}`, session);
      await sendMessage(config.BOT_TOKEN, message.chat.id,
        '🔗 لینک دکمه را ارسال کنید (باید با http:// یا https:// یا tg:// شروع شود):');
      return true;
    }

    case 'awaiting_ad_button_url': {
      if (!isValidButtonUrl(text)) {
        await sendMessage(config.BOT_TOKEN, message.chat.id,
          '⚠️ لینک نامعتبر است. باید با http:// یا https:// یا tg:// شروع شود.');
        return true;
      }
      session.data.buttonUrl = text.trim();
      const chatId = message.chat.id;
      const ad = await finalizeNewChannelAd(config, chatId, session);
      resetSession(`admin_${fromId}`);
      if (ad) {
        await sendMessage(config.BOT_TOKEN, chatId, '✅ آگهی با موفقیت در کانال ارسال شد.');
        await handleChannelAdMenu(chatId, config);
      }
      return true;
    }

    case 'awaiting_ad_edit_text': {
      const ad = memGet(DB.channelAds, session.data.adId);
      if (!ad) {
        resetSession(`admin_${fromId}`);
        await sendMessage(config.BOT_TOKEN, message.chat.id, '❌ آگهی یافت نشد (شاید حذف شده).');
        return true;
      }
      if (!text || text.length > AD_TEXT_MAX) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, `⚠️ لطفاً متنی بین ۱ تا ${AD_TEXT_MAX} کاراکتر ارسال کنید.`);
        return true;
      }
      ad.text = text;
      ad.updatedAt = Date.now();
      memSet(DB.channelAds, ad.id, ad);
      const keyboard = adBuildKeyboard(ad);
      const result = ad.photoFileId
        ? await editMessageCaption(config.BOT_TOKEN, ad.chatId, ad.messageId, ad.text, { reply_markup: keyboard })
        : await editMessageText(config.BOT_TOKEN, ad.chatId, ad.messageId, ad.text, { reply_markup: keyboard });
      resetSession(`admin_${fromId}`);
      if (!result || !result.ok) {
        await sendMessage(config.BOT_TOKEN, message.chat.id,
          `⚠️ متن در دیتابیس بروزرسانی شد اما ویرایش پیام کانال ناموفق بود: ${(result && result.description) || 'خطای نامشخص'}`);
      } else {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '✅ متن آگهی بروزرسانی شد.');
      }
      await sendMessage(config.BOT_TOKEN, message.chat.id, `📣 <b>جزئیات آگهی</b>\n\n${formatAdPreview(ad)}`, {
        reply_markup: channelAdDetailKeyboard(ad),
      });
      return true;
    }

    case 'awaiting_ad_edit_photo': {
      const ad = memGet(DB.channelAds, session.data.adId);
      if (!ad) {
        resetSession(`admin_${fromId}`);
        await sendMessage(config.BOT_TOKEN, message.chat.id, '❌ آگهی یافت نشد (شاید حذف شده).');
        return true;
      }
      if (!message.photo || message.photo.length === 0) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '⚠️ لطفاً یک عکس ارسال کنید.');
        return true;
      }
      const newFileId = message.photo[message.photo.length - 1].file_id;
      const result = await editMessageMedia(config.BOT_TOKEN, ad.chatId, ad.messageId, {
        type: 'photo',
        media: newFileId,
        caption: ad.text,
        parse_mode: 'HTML',
      }, { reply_markup: adBuildKeyboard(ad) });
      resetSession(`admin_${fromId}`);
      if (!result || !result.ok) {
        await sendMessage(config.BOT_TOKEN, message.chat.id,
          `⚠️ تعویض عکس ناموفق بود: ${(result && result.description) || 'خطای نامشخص'}`);
        return true;
      }
      ad.photoFileId = newFileId;
      ad.updatedAt = Date.now();
      memSet(DB.channelAds, ad.id, ad);
      await sendMessage(config.BOT_TOKEN, message.chat.id, '✅ عکس آگهی بروزرسانی شد.');
      await sendMessage(config.BOT_TOKEN, message.chat.id, `📣 <b>جزئیات آگهی</b>\n\n${formatAdPreview(ad)}`, {
        reply_markup: channelAdDetailKeyboard(ad),
      });
      return true;
    }

    case 'awaiting_ad_edit_button_text': {
      const ad = memGet(DB.channelAds, session.data.adId);
      if (!ad) {
        resetSession(`admin_${fromId}`);
        await sendMessage(config.BOT_TOKEN, message.chat.id, '❌ آگهی یافت نشد (شاید حذف شده).');
        return true;
      }
      if (text === '/remove') {
        ad.buttonText = null;
        ad.buttonUrl = null;
        ad.updatedAt = Date.now();
        memSet(DB.channelAds, ad.id, ad);
        await editMessageReplyMarkup(config.BOT_TOKEN, ad.chatId, ad.messageId, { inline_keyboard: [] });
        resetSession(`admin_${fromId}`);
        await sendMessage(config.BOT_TOKEN, message.chat.id, '✅ دکمه حذف شد.');
        await sendMessage(config.BOT_TOKEN, message.chat.id, `📣 <b>جزئیات آگهی</b>\n\n${formatAdPreview(ad)}`, {
          reply_markup: channelAdDetailKeyboard(ad),
        });
        return true;
      }
      if (text === '/default') {
        const resolvedUrl = await resolveAdButtonUrl(config, config.AD_DEFAULT_BUTTON_URL);
        if (!resolvedUrl) {
          await sendMessage(config.BOT_TOKEN, message.chat.id,
            '⚠️ ساخت لینک پیش‌فرض «خرید اشتراک» ممکن نشد (دریافت اطلاعات ربات ناموفق بود). کمی بعد دوباره امتحان کنید یا یک لینک دستی وارد کنید.');
          return true;
        }
        ad.buttonText = config.AD_DEFAULT_BUTTON_TEXT;
        ad.buttonUrl = resolvedUrl;
        ad.updatedAt = Date.now();
        memSet(DB.channelAds, ad.id, ad);
        const result = await editMessageReplyMarkup(config.BOT_TOKEN, ad.chatId, ad.messageId, adBuildKeyboard(ad));
        resetSession(`admin_${fromId}`);
        if (!result || !result.ok) {
          await sendMessage(config.BOT_TOKEN, message.chat.id,
            `⚠️ دکمه در دیتابیس بروزرسانی شد اما ویرایش پیام کانال ناموفق بود: ${(result && result.description) || 'خطای نامشخص'}`);
        } else {
          await sendMessage(config.BOT_TOKEN, message.chat.id, '✅ دکمه پیش‌فرض «خرید اشتراک» تنظیم شد.');
        }
        await sendMessage(config.BOT_TOKEN, message.chat.id, `📣 <b>جزئیات آگهی</b>\n\n${formatAdPreview(ad)}`, {
          reply_markup: channelAdDetailKeyboard(ad),
        });
        return true;
      }
      if (!text || text.length > AD_BUTTON_TEXT_MAX) {
        await sendMessage(config.BOT_TOKEN, message.chat.id, `⚠️ متن دکمه باید بین ۱ تا ${AD_BUTTON_TEXT_MAX} کاراکتر باشد.`);
        return true;
      }
      session.data.buttonText = text;
      session.step = 'awaiting_ad_edit_button_url';
      setSession(`admin_${fromId}`, session);
      await sendMessage(config.BOT_TOKEN, message.chat.id,
        '🔗 لینک جدید دکمه را ارسال کنید (باید با http:// یا https:// یا tg:// شروع شود؛ برای حذف دکمه /remove را بفرستید):');
      return true;
    }

    case 'awaiting_ad_edit_button_url': {
      const ad = memGet(DB.channelAds, session.data.adId);
      if (!ad) {
        resetSession(`admin_${fromId}`);
        await sendMessage(config.BOT_TOKEN, message.chat.id, '❌ آگهی یافت نشد (شاید حذف شده).');
        return true;
      }
      if (text === '/remove') {
        ad.buttonText = null;
        ad.buttonUrl = null;
        ad.updatedAt = Date.now();
        memSet(DB.channelAds, ad.id, ad);
        await editMessageReplyMarkup(config.BOT_TOKEN, ad.chatId, ad.messageId, { inline_keyboard: [] });
        resetSession(`admin_${fromId}`);
        await sendMessage(config.BOT_TOKEN, message.chat.id, '✅ دکمه حذف شد.');
        await sendMessage(config.BOT_TOKEN, message.chat.id, `📣 <b>جزئیات آگهی</b>\n\n${formatAdPreview(ad)}`, {
          reply_markup: channelAdDetailKeyboard(ad),
        });
        return true;
      }
      if (!isValidButtonUrl(text)) {
        await sendMessage(config.BOT_TOKEN, message.chat.id,
          '⚠️ لینک نامعتبر است. باید با http:// یا https:// یا tg:// شروع شود.');
        return true;
      }
      ad.buttonText = session.data.buttonText;
      ad.buttonUrl = text.trim();
      ad.updatedAt = Date.now();
      memSet(DB.channelAds, ad.id, ad);
      const result = await editMessageReplyMarkup(config.BOT_TOKEN, ad.chatId, ad.messageId, adBuildKeyboard(ad));
      resetSession(`admin_${fromId}`);
      if (!result || !result.ok) {
        await sendMessage(config.BOT_TOKEN, message.chat.id,
          `⚠️ دکمه در دیتابیس بروزرسانی شد اما ویرایش پیام کانال ناموفق بود: ${(result && result.description) || 'خطای نامشخص'}`);
      } else {
        await sendMessage(config.BOT_TOKEN, message.chat.id, '✅ دکمه آگهی بروزرسانی شد.');
      }
      await sendMessage(config.BOT_TOKEN, message.chat.id, `📣 <b>جزئیات آگهی</b>\n\n${formatAdPreview(ad)}`, {
        reply_markup: channelAdDetailKeyboard(ad),
      });
      return true;
    }

    default:
      return false;
  }
}
