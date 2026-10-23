// tgcloud/lib/subs.js — ported from the Cloudflare Worker version of the bot.
import { DB, ORDER_KIND, answerCallbackQuery, editMessageText, getSession, memGet, sendMessage, setSession } from './core.js';
import { escapeHtml } from './atlaspay.js';
import { plansKeyboard, subscriptionActionsKeyboard } from './keyboards.js';
import { formatSubscriptionStatus, syncSubscription } from './delivery.js';

// وضعیت یک اشتراک را از پنل می‌گیرد و نمایش می‌دهد
export async function sendSubscriptionStatus(chatId, sub, config, env) {
  const result = await syncSubscription(env, config, sub);
  if (!result.ok) {
    return sendMessage(
      config.BOT_TOKEN,
      chatId,
      `⚠️ در حال حاضر امکان دریافت وضعیت لحظه‌ای از پنل نبود.\n(${escapeHtml(result.error)})\n\n` +
        `آخرین اطلاعات ثبت‌شده:\n\n${formatSubscriptionStatus(result.sub)}`,
      { reply_markup: subscriptionActionsKeyboard(sub) }
    );
  }
  return sendMessage(config.BOT_TOKEN, chatId, formatSubscriptionStatus(result.sub), {
    reply_markup: subscriptionActionsKeyboard(result.sub),
  });
}

export async function handleSubscriptionStatusCallback(callbackQuery, subId, config, env) {
  const sub = memGet(DB.subscriptions, subId);
  if (!sub || String(sub.userId) !== String(callbackQuery.from.id)) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ این اشتراک پیدا نشد.', true);
  }
  return sendSubscriptionStatus(callbackQuery.message.chat.id, sub, config, env);
}

// کاربر اشتراک مورد نظر برای تمدید را انتخاب کرد → انتخاب بسته
export async function handleRenewSelection(callbackQuery, subId, config) {
  const chatId = callbackQuery.message.chat.id;
  const sub = memGet(DB.subscriptions, subId);
  if (!sub || String(sub.userId) !== String(callbackQuery.from.id)) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ این اشتراک پیدا نشد.', true);
  }

  const user = memGet(DB.users, String(callbackQuery.from.id)) || {};
  const session = getSession(chatId);
  session.step = 'idle';
  session.data = {
    kind: ORDER_KIND.RENEW,
    renewOf: sub.id,
    customerName:
      user.lastOrderName || `${callbackQuery.from.first_name || ''} ${callbackQuery.from.last_name || ''}`.trim(),
  };
  setSession(chatId, session);

  return editMessageText(
    config.BOT_TOKEN,
    chatId,
    callbackQuery.message.message_id,
    `🔄 تمدید «${escapeHtml(sub.planTitle || '-')}»\n\nبسته مورد نظر برای تمدید را انتخاب کنید:`,
    { reply_markup: plansKeyboard(config, 'navback:subs:renew') }
  );
}
