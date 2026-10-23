// tgcloud/lib/router.js — ported from the Cloudflare Worker version of the bot.
import { DB, ORDER_KIND, answerCallbackQuery, deleteMessage, editMessageText, getConfig, getSession, getWallet, isAdmin, isChannelMember, memGet, resetSession, saveState, sendMessage } from './core.js';
import { escapeHtml } from './atlaspay.js';
import { adminReplyKeyboard, isLowVolumeAlertEnabled, joinChannelKeyboard, listUserSubscriptions, mainReplyKeyboard, paymentMethodKeyboard, plansKeyboard, productsKeyboard, purchasePaymentPrompt, subscriptionsKeyboard } from './keyboards.js';
import { syncSubscription } from './delivery.js';
import { handleAtlaspayButton, handleWalletAtlasPay } from './atlaspay2.js';
import { buildUserConfigsView, captureReferral, confirmReferralAndReward, handleAdminAction, handleAdminAddStart, handleAdminDelete, handleAdminPanel, handleAdminReplyKeyboardText, handleBtnStyleMenu, handleBtnStyleSet, handleCardAddStart, handleCardDelete, handleChannelAdDelete, handleChannelAdEditStart, handleChannelAdMenu, handleChannelAdNewStart, handleChannelAdOpen, handleCheckJoin, handleForceJoinToggle, handleGlassStyleMenu, handleGlassStyleSet, handleMainMenuText, handleOrderCancel, handleOrderStepMessage, handlePaymentMethodSelection, handlePlaceOrder, handlePlanAddStart, handlePlanDelete, handlePlanEditStart, handlePlanSelection, handlePlansBulkPriceStart, handleProductSelection, handleReferralAdminMenu, handleReferralCommissionPercentEditStart, handleRenewMenu, handleSettingEditStart, handleSettingsMenu, handleStart, handleTestConfigAddStart, handleTestConfigsClearUnused, handleTutorialAddStart, handleTutorialDelete, handleTutorialEditStart, handleTutorialsView, handleUserConfigsMenu, handleWalletAdjustStart, handleWalletAdminPendingList, handleWalletCardSelection, handleWalletMenu, handleWalletMinTopupEditStart, handleWalletRequestAction, handleWalletTopupStart, registerUser } from './handlers.js';
import { handleRenewSelection, handleSubscriptionStatusCallback } from './subs.js';
import { handlePgGroups, handlePgPing, handlePgSelfTest } from './pgadmin.js';
import { adminSubKeyboard, formatAdminSubscription, handleAdminAwaitingInput, handleAdminSubAction, handleAdminSubDelete, handleAdminSubDeleteAsk, handleAdminSubLookup } from './suba.js';

export async function processUpdate(update, config, env) {
  try {
    if (update.message) {
      await processMessage(update.message, config, env);
    } else if (update.callback_query) {
      await processCallbackQuery(update.callback_query, config, env);
    }
  } catch (err) {
    console.error('processUpdate error:', err);
    // ⚠️ قبلاً در صورت بروز خطای برنامه‌نویسی، ربات کاملاً بی‌صدا می‌ماند و نه
    // کاربر و نه ادمین متوجه نمی‌شدند مشکل کجاست. حالا هر دو مطلع می‌شوند.
    await notifyUpdateFailure(update, config, err).catch((e) =>
      console.error('notifyUpdateFailure failed:', e)
    );
  } finally {
    await saveState(env);
  }
}

// وقتی پردازش یک پیام/دکمه با خطا مواجه شود، به‌جای سکوت کامل:
// ۱) به خود کاربر یک پیام کلی «خطا رخ داد» نشان می‌دهد (تا گیج نماند)
// ۲) متن دقیق خطا را برای ادمین ارسال می‌کند (تا بتوان مشکل را دیباگ کرد)
export async function notifyUpdateFailure(update, config, err) {
  const chatId =
    (update.message && update.message.chat && update.message.chat.id) ||
    (update.callback_query && update.callback_query.message && update.callback_query.message.chat.id) ||
    null;

  if (chatId) {
    await sendMessage(
      config.BOT_TOKEN,
      chatId,
      '⚠️ متاسفانه در پردازش درخواست شما خطایی رخ داد.\nلطفاً چند لحظه دیگر دوباره تلاش کنید یا با پشتیبانی در تماس باشید.'
    ).catch(() => {});
  }

  const errorText = err && err.stack ? err.stack : String(err);
  const adminTarget = config.ADMIN_GROUP_ID || config.ADMIN_CHAT_ID || null;
  if (adminTarget) {
    await sendMessage(
      config.BOT_TOKEN,
      adminTarget,
      `🐞 <b>خطای فنی ربات</b>\n\n👤 chatId: <code>${chatId || '-'}</code>\n\n<code>${escapeHtml(
        errorText.slice(0, 1500)
      )}</code>`
    ).catch(() => {});
  }
}

export async function processMessage(message, config, env) {
  const text = message.text || '';
  // Capture before the channel gate so the /start payload is not lost.
  captureReferral(message, config);

  // ---------- گیت عضویت اجباری در کانال ----------
  // اگر قابلیت فعال باشد، کاربر (به‌جز ادمین‌ها) باید ابتدا عضو کانال شود؛
  // این چک حتی جلوی دستور /start را هم می‌گیرد.
  if (!isAdmin(message.from.id, config) && DB.forceJoinEnabled && config.CHANNEL_ID) {
    const member = await isChannelMember(config, message.from.id);
    if (!member) {
      registerUser(message.from);
      return sendMessage(
        config.BOT_TOKEN,
        message.chat.id,
        `⚠️ برای استفاده از ربات، ابتدا باید عضو کانال ما شوید:\n${config.CHANNEL_ID}\n\nپس از عضویت، روی دکمه «✅ عضو شدم» بزنید.`,
        { reply_markup: joinChannelKeyboard(config) }
      );
    }
  }

  if (message.chat.type === 'private') await confirmReferralAndReward(message.from.id, config, env);

  if (/^\/start(?:@[a-zA-Z0-9_]+)?(?:\s|$)/i.test(text.trim())) {
    return handleStart(message, config, env);
  }
  if (text === '/admin') {
    return handleAdminPanel(message, config, env);
  }
  if (text === '/cancel') {
    resetSession(message.chat.id);
    if (isAdmin(message.from.id, config)) resetSession(`admin_${message.from.id}`);
    return sendMessage(config.BOT_TOKEN, message.chat.id, '❌ عملیات جاری لغو شد.', {
      reply_markup: mainReplyKeyboard(config),
    });
  }

  // دستور ادمین برای مدیریت یک اشتراک: /sub <نام کاربری پنل>
  if (/^\/sub(\s|@|$)/i.test(text.trim()) && isAdmin(message.from.id, config)) {
    return handleAdminSubLookup(message, config, env);
  }

  // ۱) آیا ادمین در مرحله‌ای از یک فرآیند تعاملی است؟ (ارسال اکانت / افزودن کارت /
  //    افزودن بسته / افزودن ادمین / افزودن مشتری ویژه / تنظیمات / کیف پول)
  if (await handleAdminAwaitingInput(message, config, env)) return;

  // ۲) دکمه‌های Reply Keyboard پنل ادمین
  if (await handleAdminReplyKeyboardText(message, config, env)) return;

  // ۳) اگر کاربر در یک عملیات جاری است — فقط مرحله جاری پردازش می‌شود
  const session = getSession(message.chat.id);
  // اگر session تایم‌اوت شده ، کاربر را مطلع کن
  if (session._timedOut) {
    delete session._timedOut;
    return sendMessage(config.BOT_TOKEN, message.chat.id,
      '⌛ عملیات قبلی به دلیل گذشت۱۰ دقیقه بی‌توجهی خودکار لغو شد.\n'
      + 'از منوی زیر می‌توانید دوباره شروع کنید.',
      { reply_markup: mainReplyKeyboard(config) }
    );
  }
  if (session.step !== 'idle') {
    const handled = await handleOrderStepMessage(message, config, env);
    if (handled !== null) return;
    // پیام به مرحله جاری مربوط نیست — بلوک کن
    return sendMessage(config.BOT_TOKEN, message.chat.id,
      '⚠️ یک عملیات در جریان دارید.\n' + 'لطفاً آن را تکمیل کنید یا با دستور /cancel لغو کنید.'
    );
  }

  // ۴) دکمه‌های منوی اصلی — فقط در حالت idle
  const mainMenuHandled = await handleMainMenuText(message, config, env);
  if (mainMenuHandled !== false) return;
}

export async function processCallbackQuery(callbackQuery, config, env) {
  const data = callbackQuery.data || '';
  if (!callbackQuery.message) return;
  if (callbackQuery.message.chat.type === 'private') registerUser(callbackQuery.from);

  // دکمه «عضو شدم، بررسی مجدد» همیشه (حتی وقتی هنوز عضو نیستند) باید کار کند
  if (data === 'checkjoin') {
    return handleCheckJoin(callbackQuery, config, env);
  }

  // ---------- گیت عضویت اجباری در کانال برای بقیه دکمه‌ها ----------
  if (!isAdmin(callbackQuery.from.id, config) && DB.forceJoinEnabled && config.CHANNEL_ID) {
    const member = await isChannelMember(config, callbackQuery.from.id);
    if (!member) {
      await answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '⚠️ ابتدا باید عضو کانال شوید.', true);
      return sendMessage(
        config.BOT_TOKEN,
        callbackQuery.message.chat.id,
        `⚠️ برای استفاده از ربات، ابتدا باید عضو کانال ما شوید:\n${config.CHANNEL_ID}\n\nپس از عضویت، روی دکمه «✅ عضو شدم» بزنید.`,
        { reply_markup: joinChannelKeyboard(config) }
      );
    }
  }

  if (callbackQuery.message.chat.type === 'private') await confirmReferralAndReward(callbackQuery.from.id, config, env);
  await answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id);

  if (data === 'noop') return;

  // ---------- خرید / بسته‌ها ----------
  if (data.startsWith('product:')) {
    return handleProductSelection(callbackQuery, config);
  }
  if (data === 'back:products') {
    await deleteMessage(config.BOT_TOKEN, callbackQuery.message.chat.id, callbackQuery.message.message_id).catch(() => {});
    return sendMessage(config.BOT_TOKEN, callbackQuery.message.chat.id, config.PRODUCT_SELECT_TEXT, {
      reply_markup: productsKeyboard(config),
    });
  }
  if (data === 'back:plans') {
    const planSession = getSession(callbackQuery.message.chat.id);
    const isRenewFlow = Boolean(planSession && planSession.data && planSession.data.kind === ORDER_KIND.RENEW);
    return editMessageText(
      config.BOT_TOKEN,
      callbackQuery.message.chat.id,
      callbackQuery.message.message_id,
      '💎 یکی از سرویس‌های ما را انتخاب کنید:',
      { reply_markup: plansKeyboard(config, isRenewFlow ? 'navback:subs:renew' : 'back:products') }
    );
  }
  if (data.startsWith('plan:')) {
    const planId = data.split(':')[1];
    return handlePlanSelection(callbackQuery, planId, config);
  }
  if (data.startsWith('paymethod:')) {
    const method = data.split(':')[1];
    return handlePaymentMethodSelection(callbackQuery, method, config, env);
  }
  if (data.startsWith('paycard:')) {
    // خرید مستقیم کارت‌به‌کارت حذف شده؛ فقط پرداخت از کیف پول مجاز است
    const oldSession = getSession(callbackQuery.message.chat.id);
    const oldPrice = Number(oldSession.data && oldSession.data.price) || 0;
    const oldBalance = getWallet(callbackQuery.from.id);
    return editMessageText(
      config.BOT_TOKEN,
      callbackQuery.message.chat.id,
      callbackQuery.message.message_id,
      purchasePaymentPrompt(oldBalance, oldPrice),
      { reply_markup: paymentMethodKeyboard(oldBalance, config, oldPrice) }
    );
  }
  if (data === 'order:confirm') {
    return handlePlaceOrder(callbackQuery, config, env);
  }
  if (data === 'order:cancel') {
    return handleOrderCancel(callbackQuery, config);
  }

  // ---------- اشتراک‌ها (وضعیت و تمدید) ----------
  if (data.startsWith('substatus:')) {
    const subId = data.slice('substatus:'.length);
    return handleSubscriptionStatusCallback(callbackQuery, subId, config, env);
  }
  if (data.startsWith('renew:')) {
    const subId = data.slice('renew:'.length);
    return handleRenewSelection(callbackQuery, subId, config);
  }

  // دکمه شیشه‌ای «🎓 آموزش‌ها» زیر پیام تحویل سرویس — برای همه کاربران
  if (data === 'tutorials:view') {
    return handleTutorialsView(callbackQuery, config);
  }

  if (data.startsWith('admin:')) {
    const [, action, orderId] = data.split(':');
    return handleAdminAction(callbackQuery, action, orderId, config, env);
  }

  // ---- کیف پول (مشتری) ----
  if (data === 'wallet:menu') {
    await deleteMessage(config.BOT_TOKEN, callbackQuery.message.chat.id, callbackQuery.message.message_id).catch(() => {});
    return handleWalletMenu(callbackQuery.message.chat.id, callbackQuery.from.id, config);
  }
  if (data === 'wallet:topup') {
    return handleWalletTopupStart(callbackQuery, config);
  }
  if (data.startsWith('walletcard:')) {
    const cardId = Number(data.split(':')[1]);
    return handleWalletCardSelection(callbackQuery, cardId, config);
  }
  if (data === 'walletatlas:pay') {
    return handleWalletAtlasPay(callbackQuery, config, env);
  }
  if (data.startsWith('atlas:')) {
    return handleAtlaspayButton(callbackQuery, data, config, env);
  }
  if (data.startsWith('walletreq:')) {
    const [, action, reqId] = data.split(':');
    return handleWalletRequestAction(callbackQuery, action, reqId, config, env);
  }

  // ---------- از این پس فقط ادمین‌ها ----------
  // نگهبان یکجا تا هیچ دکمه مدیریتی بدون بررسی دسترسی نماند
  const adminOnly =
    data.startsWith('card_') ||
    data.startsWith('plan_') ||
    data.startsWith('tut_') ||
    data.startsWith('testcfg_') ||
    data.startsWith('adminmgmt_') ||
    data.startsWith('setting_edit:') ||
    data.startsWith('btnstyle_') ||
    data.startsWith('referraladmin:') ||
    data.startsWith('ad_') ||
    data.startsWith('walletadmin:') ||
    data.startsWith('pg:') ||
    data.startsWith('ucfg:') ||
    data.startsWith('sadm:') ||
    data === 'forcejoin_toggle' ||
    data === 'lowvol_toggle';

  if (adminOnly && !isAdmin(callbackQuery.from.id, config)) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '⛔ دسترسی ندارید.', true);
  }

  if (data === 'referraladmin:toggle' || data === 'referraladmin:menu') {
    if (data === 'referraladmin:toggle') {
      DB.settings.REFERRAL_ENABLED = !config.REFERRAL_ENABLED;
    }
    return handleReferralAdminMenu(callbackQuery.message.chat.id, getConfig(env));
  }
  if (data === 'referraladmin:toggle_commission') {
    DB.settings.REFERRAL_COMMISSION_ENABLED = !config.REFERRAL_COMMISSION_ENABLED;
    return handleReferralAdminMenu(callbackQuery.message.chat.id, getConfig(env));
  }
  if (data === 'referraladmin:edit_commission_percent') {
    return handleReferralCommissionPercentEditStart(callbackQuery, config);
  }

  // ---- تبلیغ در کانال ----
  if (data === 'ad_menu') {
    return handleChannelAdMenu(callbackQuery.message.chat.id, config);
  }
  if (data === 'ad_new') {
    return handleChannelAdNewStart(callbackQuery, config);
  }
  if (data.startsWith('ad_open:')) {
    return handleChannelAdOpen(callbackQuery, data.slice('ad_open:'.length), config);
  }
  if (data.startsWith('ad_edit:')) {
    const [, subaction, adId] = data.split(':');
    return handleChannelAdEditStart(callbackQuery, subaction, adId, config);
  }
  if (data.startsWith('ad_delete:')) {
    return handleChannelAdDelete(callbackQuery, data.slice('ad_delete:'.length), config);
  }

  // ---- مدیریت کانفیگ کاربران — انتخاب از لیست ----
  if (data.startsWith('ucfg:')) {
    const ucParts = data.split(':');
    if (ucParts[1] === 'page') {
      const view = buildUserConfigsView(Number(ucParts[2]) || 0);
      if (!view) return;
      return editMessageText(
        config.BOT_TOKEN,
        callbackQuery.message.chat.id,
        callbackQuery.message.message_id,
        view.text,
        { reply_markup: view.reply_markup }
      );
    }
    if (ucParts[1] === 'sel') {
      const sub = memGet(DB.subscriptions, ucParts[2]);
      if (!sub) return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ اشتراک یافت نشد.', true);
      await syncSubscription(env, config, sub);
      return sendMessage(
        config.BOT_TOKEN,
        callbackQuery.message.chat.id,
        formatAdminSubscription(sub),
        { reply_markup: adminSubKeyboard(sub) }
      );
    }
    return;
  }

  // ---- مدیریت اشتراک توسط ادمین ----
  if (data.startsWith('sadm:')) {
    const [, action, subId] = data.split(':');
    if (action === 'del') return handleAdminSubDeleteAsk(callbackQuery, subId, config);
    if (action === 'delok') return handleAdminSubDelete(callbackQuery, subId, config, env);
    return handleAdminSubAction(callbackQuery, action, subId, config, env);
  }

  // ---- کارت‌ها ----
  if (data === 'card_add') {
    return handleCardAddStart(callbackQuery, config);
  }
  if (data.startsWith('card_del:')) {
    return handleCardDelete(callbackQuery, data.split(':')[1], config);
  }

  // ---- بسته‌های اینترنت ----
  if (data === 'plan_add') {
    return handlePlanAddStart(callbackQuery, config);
  }
  if (data === 'plan_bulk_price') {
    return handlePlansBulkPriceStart(callbackQuery, config);
  }
  if (data.startsWith('plan_edit:')) {
    return handlePlanEditStart(callbackQuery, data.split(':')[1], config);
  }
  if (data.startsWith('plan_del:')) {
    return handlePlanDelete(callbackQuery, data.split(':')[1], config, env);
  }

  // ---- آموزش‌ها ----
  if (data === 'tut_add') {
    return handleTutorialAddStart(callbackQuery, config);
  }
  if (data.startsWith('tut_edit:')) {
    return handleTutorialEditStart(callbackQuery, data.split(':')[1], config);
  }
  if (data.startsWith('tut_del:')) {
    return handleTutorialDelete(callbackQuery, data.split(':')[1], config);
  }

  // ---- تست کانفیگ ----
  if (data === 'testcfg_add') {
    return handleTestConfigAddStart(callbackQuery, config);
  }
  if (data === 'testcfg_clear_unused') {
    return handleTestConfigsClearUnused(callbackQuery, config);
  }

  // ---- ادمین‌ها ----
  if (data === 'adminmgmt_add') {
    return handleAdminAddStart(callbackQuery, config);
  }
  if (data.startsWith('adminmgmt_del:')) {
    return handleAdminDelete(callbackQuery, data.split(':')[1], config);
  }

  // ---- تنظیمات فروشگاه ----
  if (data.startsWith('setting_edit:')) {
    return handleSettingEditStart(callbackQuery, data.split(':')[1], config);
  }
  if (data === 'btnstyle_menu') {
    return handleBtnStyleMenu(callbackQuery.message.chat.id, config);
  }
  if (data.startsWith('btnstyle_set:')) {
    const [, key, style] = data.split(':');
    return handleBtnStyleSet(callbackQuery, key, style || '', config, env);
  }
  if (data === 'glassstyle_menu') {
    return handleGlassStyleMenu(callbackQuery.message.chat.id, config);
  }
  if (data.startsWith('glassstyle_set:')) {
    const [, key, style] = data.split(':');
    return handleGlassStyleSet(callbackQuery, key, style || '', config, env);
  }

  // ---- بازگشت به منوی قبلی (استاندارد در همه بخش‌ها) ----
  if (data.startsWith('navback:')) {
    // مقصد می‌تواند چندبخشی باشد (مثل subs:renew)، پس همه بعد از «navback:» خوانده می‌شود
    const target = data.slice('navback:'.length);
    const backChatId = callbackQuery.message.chat.id;
    const backUserId = callbackQuery.from.id;
    // پیام قبلی (همان پیامی که دکمه بازگشت رویش بود) حذف شود
    await deleteMessage(config.BOT_TOKEN, backChatId, callbackQuery.message.message_id).catch(() => {});

    // ---- بازگشت به «مرحله قبل» (نه منوی اصلی) ----
    if (target === 'settings' && isAdmin(backUserId, config)) {
      return handleSettingsMenu(backChatId, getConfig(env));
    }
    if ((target === 'ucfg' || target.startsWith('ucfg:')) && isAdmin(backUserId, config)) {
      return handleUserConfigsMenu(backChatId, config, Number(target.split(':')[1]) || 0);
    }
    if (target === 'subs:renew') {
      return handleRenewMenu(backChatId, backUserId, config);
    }
    if (target === 'subs:substatus') {
      const backSubs = listUserSubscriptions(backUserId);
      if (backSubs.length > 0) {
        return sendMessage(config.BOT_TOKEN, backChatId, '📊 وضعیت کدام اشتراک را می‌خواهید؟', {
          reply_markup: subscriptionsKeyboard(backSubs, 'substatus'),
        });
      }
    }
    if (target === 'admin' && isAdmin(callbackQuery.from.id, config)) {
      return sendMessage(config.BOT_TOKEN, backChatId, '🛠 منوی مدیریت:', {
        reply_markup: adminReplyKeyboard(),
      });
    }
    return sendMessage(config.BOT_TOKEN, backChatId, '🏠 منوی اصلی:', {
      reply_markup: mainReplyKeyboard(config),
    });
  }

  // ---- مدیریت کیف پول (ادمین) ----
  if (data === 'walletadmin:pending') {
    return handleWalletAdminPendingList(callbackQuery.message.chat.id, config);
  }
  if (data === 'walletadmin:adjust') {
    return handleWalletAdjustStart(callbackQuery, config);
  }
  if (data === 'walletadmin:min_topup') {
    return handleWalletMinTopupEditStart(callbackQuery, config);
  }

  // ---- هشدار کم‌شدن حجم (ادمین) ----
  if (data === 'lowvol_toggle') {
    DB.settings.LOW_VOLUME_ALERT_ENABLED = !isLowVolumeAlertEnabled();
    await answerCallbackQuery(
      config.BOT_TOKEN,
      callbackQuery.id,
      DB.settings.LOW_VOLUME_ALERT_ENABLED ? '🔔 هشدار کم‌شدن حجم روشن شد.' : '🔕 هشدار کم‌شدن حجم خاموش شد.'
    );
    return handleSettingsMenu(callbackQuery.message.chat.id, getConfig(env));
  }

  // ---- عضویت اجباری (ادمین) ----
  if (data === 'forcejoin_toggle') {
    return handleForceJoinToggle(callbackQuery, config);
  }

  // ---- پاسارگارد (ادمین) ----
  if (data === 'pg:ping') {
    return handlePgPing(callbackQuery, config, env);
  }
  if (data === 'pg:groups') {
    return handlePgGroups(callbackQuery, config, env);
  }
  if (data === 'pg:selftest') {
    return handlePgSelfTest(callbackQuery, config, env);
  }
}
