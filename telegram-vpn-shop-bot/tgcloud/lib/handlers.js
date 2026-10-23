// tgcloud/lib/handlers.js — ported from the Cloudflare Worker version of the bot.
import { BTN_STYLE_CHOICES, BTN_STYLE_TARGETS, DB, DEFAULTS, DEFAULT_PLAN_GROUP_IDS, GLASS_BTN_STYLE_CHOICES, GLASS_STYLE_TARGETS, MAX_TEST_CONFIGS, ORDER_KIND, ORDER_STATUS, PG_STATUS_LABEL, SETTINGS_FIELDS, SHARED, WALLET_REQUEST_STATUS, addWalletBalance, answerCallbackQuery, backNavRow, callTelegram, d1All, d1Run, dbDeactivatePlan, dbLog, dbSaveOrder, dbStats, dbSyncUserWallet, dbUpsertUser, deleteMessage, editMessageReplyMarkup, editMessageText, ensurePlansLoaded, getConfig, getMe, getSession, getWallet, getWalletMinTopup, hasD1, isAdmin, isChannelMember, isPersistenceEnabled, memDelete, memGet, memSet, newId, notifyAdmins, nowSec, resetSession, saveState, sendMessage, sendPhoto, setSession } from './core.js';
import { pgConfigWarnings, pgConfigured, pgGetGroups, pgMissingConfig, pgProvision } from './pasarguard.js';
import { gatewayProvider, manualCardProvider, paymentResult, walletProvider } from './payments.js';
import { atlaspayConfigured, atlaspayProvider, escapeHtml, getPaymentProvider } from './atlaspay.js';
import { formatAdminOrderMessage, formatOrderStatus, formatOrderSummary, formatWalletRequestMessage } from './format.js';
import { adminOrderKeyboard, adminReplyKeyboard, adminsAdminInlineKeyboard, cardsAdminInlineKeyboard, forceJoinAdminKeyboard, formatBytes, formatDate, isAtlaspayAwaiting, listUserSubscriptions, mainReplyKeyboard, orderConfirmKeyboard, pasarguardAdminKeyboard, paymentMethodKeyboard, plansAdminInlineKeyboard, plansKeyboard, productsKeyboard, purchasePaymentPrompt, settingsInlineKeyboard, subscriptionsKeyboard, testConfigsAdminInlineKeyboard, tutorialsAdminInlineKeyboard, tutorialsViewKeyboard, walletAdminInlineKeyboard, walletMenuKeyboard, walletRequestAdminKeyboard, walletTopupCardsKeyboard } from './keyboards.js';
import { formatUserIdentityLine, provisionOrder } from './delivery.js';
import { recordPayment } from './atlaspay2.js';

export async function handleStart(message, config, env) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  registerUser(message.from);
  await dbUpsertUser(env, message.from);
  resetSession(chatId);

  let welcome =
    `👋 سلام <b>${escapeHtml(message.from.first_name || '')}</b>!\n\n` +
    `به <b>${escapeHtml(config.SHOP_NAME)}</b> خوش آمدید.`;

  if (config.WELCOME_EXTRA_TEXT) {
    welcome += `\n\n${escapeHtml(config.WELCOME_EXTRA_TEXT)}`;
  }

  welcome += `\n\nاز منوی زیر یکی از گزینه‌ها را انتخاب کنید:`;

  await sendMessage(config.BOT_TOKEN, chatId, welcome, { reply_markup: mainReplyKeyboard(config) });

  if (isAdmin(userId, config)) {
    let adminNote = '🛠 شما ادمین هستید. برای ورود به پنل مدیریت از دستور /admin استفاده کنید.';
    if (!isPersistenceEnabled(env)) {
      adminNote += '\n\n⚠️ توجه: حافظه دائمی (KV) وصل نیست — تغییرات پنل ادمین با ری‌استارت Worker از بین می‌روند.';
    }
    await sendMessage(config.BOT_TOKEN, chatId, adminNote);
  }

  // اگر کاربر از طریق لینک عمیق «start=shop» وارد شده (مثلاً با زدن دکمه
  // پیش‌فرض تبلیغ کانال)، منوی «خرید اشتراک» بلافاصله بعد از خوش‌آمدگویی باز می‌شود.
  const startPayloadMatch = (message.text || '').trim().match(/^\/start(?:@[a-zA-Z0-9_]+)?\s+(shop|buy)$/i);
  if (startPayloadMatch) {
    await handleBuyStart(chatId, config);
  }
}

export function registerUser(from) {
  const id = String(from.id);
  const existing = memGet(DB.users, id) || { id, orders: [], walletBalance: 0 };
  memSet(DB.users, id, {
    ...existing,
    username: from.username || null,
    firstName: from.first_name || '',
    lastName: from.last_name || '',
  });
}

// ---------- دعوت دوستان ----------
// Attribution is accepted only on first private contact. The referral stays
// pending until the existing membership gate allows access. No wallet rewards.
// Fields live inside DB.users and use the existing KV snapshot persistence.
export function captureReferral(message, config) {
  if (!message.from || message.from.is_bot || message.chat.type !== 'private') return;
  const id = String(message.from.id);
  const isNew = !DB.users.has(id);
  registerUser(message.from);
  if (!isNew || !config.REFERRAL_ENABLED) return;
  const match = (message.text || '').trim().match(/^\/start(?:@[a-zA-Z0-9_]+)?\s+ref_([1-9]\d{0,19})$/i);
  if (!match || match[1] === id || !DB.users.has(match[1])) return;
  const user = DB.users.get(id);
  user.pendingReferrerId = match[1];
  user.referralStartedAt = Date.now();
}

export function confirmReferral(userId, config) {
  if (!config.REFERRAL_ENABLED) return null;
  const id = String(userId);
  const user = DB.users.get(id);
  if (!user || user.referredBy || !user.pendingReferrerId) return null;
  const referrerId = String(user.pendingReferrerId);
  if (referrerId === id || !DB.users.has(referrerId)) return null;
  user.referredBy = referrerId;
  user.referredAt = Date.now();
  delete user.pendingReferrerId;
  return referrerId;
}

// تایید دعوت را ثبت می‌کند (بدون جایزه فوری). از این پس، به‌ازای هر خریدی
// که این کاربر انجام دهد، پورسانتی خودکار به دعوت‌کننده تعلق می‌گیرد
// (به تابع creditReferralCommission در زمان تحویل سفارش نگاه کنید).
export async function confirmReferralAndReward(userId, config, env) {
  confirmReferral(userId, config);
}

// ---------- پورسانت خرید دعوت دوست ----------
export function listReferralRewards(referrerId) {
  const result = [];
  for (const reward of DB.referralRewards.values()) {
    if (String(reward.referrerId) === String(referrerId)) result.push(reward);
  }
  result.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return result;
}

export function listReferredUsers(referrerId) {
  const result = [];
  for (const user of DB.users.values()) {
    if (String(user.referredBy || '') === String(referrerId)) result.push(user);
  }
  result.sort((a, b) => (a.referredAt || 0) - (b.referredAt || 0));
  return result;
}

// خروجی: متن کامل لیست همه دعوت‌ها گروه‌بندی‌شده بر اساس دعوت‌کننده (برای ادمین)
export function buildAllReferralsText() {
  const byReferrer = new Map();
  for (const user of DB.users.values()) {
    if (!user.referredBy) continue;
    const key = String(user.referredBy);
    if (!byReferrer.has(key)) byReferrer.set(key, []);
    byReferrer.get(key).push(user);
  }
  if (byReferrer.size === 0) return '';
  const lines = ['📋 <b>لیست کامل دعوت‌شدگان</b>\n'];
  for (const [referrerId, invitees] of byReferrer.entries()) {
    const referrer = DB.users.get(referrerId);
    const referrerLabel = referrer ? formatUserIdentityLine(referrer) : `<code>${referrerId}</code>`;
    lines.push(`👤 دعوت‌کننده: ${referrerLabel} — <b>${invitees.length}</b> نفر`);
    invitees
      .sort((a, b) => (a.referredAt || 0) - (b.referredAt || 0))
      .forEach((u, i) => lines.push(`   ${i + 1}. ${formatUserIdentityLine(u)}`));
    lines.push('');
  }
  return lines.join('\n').trim();
}

// شکستن متن بلند به چند پیام برای رعایت محدودیت طول پیام تلگرام
export function chunkText(text, maxLen = 3500) {
  const lines = text.split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLen && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function formatInviteText(config, link) {
  const template = String(config.INVITE_TEXT || DEFAULTS.INVITE_TEXT);
  const text = template.replace(/\{(shop|link)\}/g, (_, key) => key === 'shop' ? config.SHOP_NAME : link);
  return template.includes('{link}') ? text : `${text}\n\n${link}`;
}

export async function handleInviteMenu(message, config) {
  const chatId = message.chat.id;
  if (message.chat.type !== 'private') {
    return sendMessage(config.BOT_TOKEN, chatId, '👥 برای دریافت لینک دعوت، در گفت‌وگوی خصوصی ربات /invite را بفرستید.');
  }
  if (!config.REFERRAL_ENABLED) {
    return sendMessage(config.BOT_TOKEN, chatId, '⏸ دعوت دوستان در حال حاضر غیرفعال است.');
  }
  registerUser(message.from);
  // Read the actual username: no hardcoded bot name or extra deployment setting.
  let me;
  try { me = await getMe(config.BOT_TOKEN); } catch (_) { me = null; }
  const username = me && me.ok && me.result && me.result.username;
  if (!username || !/^[a-zA-Z0-9_]+$/.test(username)) {
    return sendMessage(config.BOT_TOKEN, chatId, '⚠️ دریافت لینک دعوت ممکن نشد. کمی بعد دوباره امتحان کنید.');
  }
  const link = `https://t.me/${username}?start=ref_${message.from.id}`;
  const invitation = formatInviteText(config, link);
  const shareText = invitation.split(link).join('').trim();

  const invitees = listReferredUsers(message.from.id);
  const MAX_SHOWN = 30;
  let inviteesBlock = '';
  if (invitees.length > 0) {
    const shown = invitees.slice(0, MAX_SHOWN)
      .map((u, i) => `${i + 1}. ${formatUserIdentityLine(u)}`)
      .join('\n');
    const more = invitees.length > MAX_SHOWN
      ? `\n… و ${invitees.length - MAX_SHOWN} نفر دیگر`
      : '';
    inviteesBlock = `\n\n👤 <b>لیست دوستان دعوت‌شده:</b>\n${shown}${more}\n`;
  }

  let rewardBlock = '';
  if (config.REFERRAL_COMMISSION_ENABLED) {
    const commissions = listReferralRewards(message.from.id);
    const totalEarned = commissions.reduce((sum, c) => sum + (c.amount || 0), 0);
    rewardBlock =
      `\n💰 به‌ازای هر خرید دوستان دعوت‌شده: <b>${config.REFERRAL_COMMISSION_PERCENT}٪</b> پورسانت مستقیم به کیف پول شما\n` +
      `💵 مجموع پورسانت دریافتی: <b>${totalEarned.toLocaleString()} تومان</b>${
        commissions.length ? ` (از ${commissions.length} خرید)` : ''
      }\n`;
  }

  return sendMessage(config.BOT_TOKEN, chatId,
    '👥 <b>دعوت دوستان</b>\n\n' +
    `✅ تعداد دوستان دعوت‌شده: <b>${invitees.length}</b>\n` +
    `${rewardBlock}` +
    `${inviteesBlock}\n` +
    `${escapeHtml(invitation)}\n\n` +
    'ℹ️ فقط کاربران جدیدی که با لینک شما ربات را شروع کنند و از مرحله عضویت عبور کنند، ثبت می‌شوند. دعوت تکراری یا دعوت خودتان شمرده نمی‌شود.',
    { reply_markup: { inline_keyboard: [[{
      text: '📤 ارسال لینک برای دوستان',
      url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(shareText)}`,
    }]] } }
  );
}

export async function handleReferralAdminMenu(chatId, config) {
  let confirmed = 0;
  let pending = 0;
  for (const user of DB.users.values()) {
    if (user.referredBy) confirmed += 1;
    else if (user.pendingReferrerId) pending += 1;
  }

  let commissionCount = 0;
  let commissionTotal = 0;
  for (const c of DB.referralRewards.values()) {
    commissionCount += 1;
    commissionTotal += c.amount || 0;
  }

  await sendMessage(config.BOT_TOKEN, chatId,
    '👥 <b>مدیریت دعوت دوستان</b>\n\n' +
    `وضعیت دعوت: <b>${config.REFERRAL_ENABLED ? 'فعال ✅' : 'غیرفعال ⏸'}</b>\n` +
    `دعوت‌های ثبت‌شده: <b>${confirmed}</b>\nدر انتظار ورود: <b>${pending}</b>\n\n` +
    `💰 وضعیت پورسانت خرید: <b>${config.REFERRAL_COMMISSION_ENABLED ? 'فعال ✅' : 'غیرفعال ⏸'}</b>\n` +
    `💰 درصد پورسانت هر خرید: <b>${config.REFERRAL_COMMISSION_PERCENT}٪</b>\n` +
    `💵 مجموع پورسانت پرداخت‌شده: <b>${commissionTotal.toLocaleString()} تومان</b> (${commissionCount} خرید)\n\n` +
    `عنوان دکمه: ${escapeHtml(config.BTN_INVITE_LABEL)}\n\n` +
    `متن دعوت:\n${escapeHtml(config.INVITE_TEXT)}\n\n` +
    'متغیر {link} با لینک اختصاصی و {shop} با نام فروشگاه جایگزین می‌شود. اگر {link} را حذف کنید، لینک خودکار به انتهای متن اضافه می‌شود.\n\n' +
    'به‌ازای هر خریدی که دوست دعوت‌شده انجام دهد، درصد تعیین‌شده از مبلغ همان خرید بلافاصله و بدون نیاز به تایید ادمین به کیف پول دعوت‌کننده واریز می‌شود.',
    { reply_markup: { inline_keyboard: [
      [{ text: config.REFERRAL_ENABLED ? '⏸ غیرفعال کردن دعوت' : '✅ فعال کردن دعوت', callback_data: 'referraladmin:toggle', style: config.REFERRAL_ENABLED ? 'danger' : 'success' }],
      [{ text: config.REFERRAL_COMMISSION_ENABLED ? '⏸ غیرفعال کردن پورسانت' : '✅ فعال کردن پورسانت', callback_data: 'referraladmin:toggle_commission', style: config.REFERRAL_COMMISSION_ENABLED ? 'danger' : 'success' }],
      [{ text: '✏️ ویرایش درصد پورسانت', callback_data: 'referraladmin:edit_commission_percent', style: 'primary' }],
      [{ text: '✏️ ویرایش متن دعوت', callback_data: 'setting_edit:INVITE_TEXT', style: 'success' }],
      [{ text: '✏️ ویرایش نام دکمه', callback_data: 'setting_edit:BTN_INVITE_LABEL', style: 'primary' }],
      [{ text: '🔄 بروزرسانی آمار', callback_data: 'referraladmin:menu', style: 'success' }],
      backNavRow('admin'),
    ] } }
  );

  const fullListText = buildAllReferralsText();
  if (!fullListText) return;
  const chunks = chunkText(fullListText);
  for (const part of chunks) {
    await sendMessage(config.BOT_TOKEN, chatId, part);
  }
}

export async function handleMainMenuText(message, config, env) {
  const chatId = message.chat.id;
  const text = message.text;

  // متن دکمه‌ها ممکن است توسط ادمین تغییر کرده باشد؛ دستورات اسلش همیشه به‌عنوان میان‌بر ثابت کار می‌کنند
  if (text === config.BTN_SHOP_LABEL || text === '/shop' || text === '/buy') {
    return handleBuyStart(chatId, config);
  }
  if (text === config.BTN_MYORDERS_LABEL || text === '/myorders' || text === '/mysubs') {
    return handleMySubscriptions(chatId, message.from.id, config);
  }
  // تاریخچه سفارش‌ها (فاکتورها) — جدا از لیست اشتراک‌ها
  if (text === '/orders') {
    return handleMyOrders(chatId, message.from.id, config);
  }
  if (text === config.BTN_RENEW_LABEL || text === '/renew') {
    return handleRenewMenu(chatId, message.from.id, config);
  }
  if (text === config.BTN_WALLET_LABEL || text === '/wallet') {
    return handleWalletMenu(chatId, message.from.id, config);
  }
  if (text === config.BTN_SUPPORT_LABEL || text === '/support') {
    // آیدی پشتیبان داخل یک دکمه شیشه‌ای (اینلاین) قرار می‌گیرد و با زدن آن، چت مستقیم با پشتیبان باز می‌شود
    const supportUsername = String(config.SUPPORT_USERNAME || '').trim().replace(/^@/, '');
    const supportOptions = supportUsername
      ? {
          reply_markup: {
            inline_keyboard: [
              [{ text: `👤 @${supportUsername}`, url: `https://t.me/${supportUsername}`, style: 'primary' }],
            ],
          },
        }
      : {};
    return sendMessage(
      config.BOT_TOKEN,
      chatId,
      `🎫 <b>پشتیبانی</b>\n\nبرای ارتباط با پشتیبانی روی دکمه زیر بزنید و پیام دهید 👇\n\n` +
        'اگر مشکل فنی در اتصال دارید، شناسه اشتراک خود را هم برای ما بفرستید.',
      supportOptions
    );
  }
  if (text === config.BTN_INVITE_LABEL || text === '/invite') {
    return handleInviteMenu(message, config);
  }
  if (text === config.BTN_TESTCONFIG_LABEL || text === '/testconfig') {
    return handleTestConfigRequest(chatId, message.from.id, config, env);
  }
  return false; // یعنی متن مرتبط با منوی اصلی نبود
}

export async function handleMyOrders(chatId, userId, config) {
  const userOrders = [...DB.orders.values()].filter((o) => String(o.userId) === String(userId));
  if (userOrders.length === 0) {
    return sendMessage(config.BOT_TOKEN, chatId, '📭 شما تاکنون هیچ سفارشی ثبت نکرده‌اید.');
  }
  let text = `📦 <b>سفارش‌های شما</b>\n\n`;
  for (const o of userOrders.slice(-15).reverse()) {
    text += `#️⃣ ${o.id} | ${escapeHtml(o.planTitle)} | ${Number(o.price || 0).toLocaleString()} تومان | ${formatOrderStatus(o.status)}\n`;
  }
  return sendMessage(config.BOT_TOKEN, chatId, text);
}

export async function handleWalletMenu(chatId, userId, config) {
  const balance = getWallet(userId);
  const text =
    `💰 <b>کیف پول شما</b>\n\n` +
    `موجودی فعلی: <b>${balance.toLocaleString()} تومان</b>\n\n` +
    'برای خرید یا تمدید اشتراک، ابتدا کیف پول خود را شارژ کنید؛ هزینه سفارش از موجودی کیف پول کسر می‌شود.';
  return sendMessage(config.BOT_TOKEN, chatId, text, { reply_markup: walletMenuKeyboard() });
}

export async function handleWalletTopupStart(callbackQuery, config) {
  const chatId = callbackQuery.message.chat.id;
  const session = getSession(chatId);
  session.step = 'awaiting_wallet_amount';
  session.data = {};
  setSession(chatId, session);
  return sendMessage(config.BOT_TOKEN, chatId, `💵 مبلغ مورد نظر برای شارژ کیف پول را به تومان (فقط عدد) ارسال کنید:\n\nℹ️ حداقل مبلغ شارژ: <b>${config.WALLET_MIN_TOPUP.toLocaleString()} تومان</b>`);
}

export async function handleWalletCardSelection(callbackQuery, cardId, config) {
  const chatId = callbackQuery.message.chat.id;
  const card = memGet(DB.cards, cardId);
  if (!card) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ این کارت دیگر معتبر نیست.', true);
  }
  const session = getSession(chatId);
  if (!session.data || !session.data.amount) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '⚠️ ابتدا مبلغ شارژ را وارد کنید.', true);
  }
  session.data.cardId = card.id;
  session.data.cardLabel = `${card.bankName} - ${card.number} (${card.holder || ''})`;
  session.step = 'awaiting_wallet_receipt';
  session.data.receiptDeadline = Date.now() + 30 * 60 * 1000;
  setSession(chatId, session);

  await editMessageText(
    config.BOT_TOKEN,
    chatId,
    callbackQuery.message.message_id,
    `💳 کارت انتخاب‌شده:\n<code>${card.number}</code>\n${card.bankName}\n\n` +
      `پس از واریز مبلغ ${session.data.amount.toLocaleString()} تومان، عکس رسید پرداخت را ارسال کنید:`
  );
}

// یک سفارش تازه از داده‌های session می‌سازد (خرید جدید یا تمدید)
// planSnapshot نگه داشته می‌شود تا اگر ادمین بسته را حذف/ویرایش کرد، تحویل سفارش خراب نشود
//
// ⚠️ همه فیلدهای اختیاری سفارش از همین‌جا با مقدار پیش‌فرض ساخته می‌شوند
// (note، subscriptionId، pgUsername، paymentId، lastError، refunded).
// دلیلش این است که این فیلدها بعداً در مراحل دیگر مقدار می‌گیرند و اگر اینجا
// تعریف نشده باشند، هر ابزار type-check روی JS (از جمله ادیتور داشبورد
// Cloudflare) روی خط‌هایی مثل «order.note = ...» خطا می‌دهد.
export function buildOrderFromSession(session, from, chatId, extra = {}) {
  ensurePlansLoaded();
  const plan = DB.plans.find((p) => p.id === session.data.planId) || null;
  return {
    id: SHARED.orderSeq++,
    userId: from.id,
    chatId,
    username: from.username || null,
    customerName: session.data.customerName || `${from.first_name || ''} ${from.last_name || ''}`.trim(),
    planId: session.data.planId,
    planTitle: session.data.planTitle,
    planSnapshot: plan ? { ...plan } : null,
    price: session.data.price,
    kind: session.data.kind || ORDER_KIND.NEW,
    renewOf: session.data.renewOf || null,
    cardId: null,
    cardLabel: '—',
    receiptFileId: null,
    paidVia: null,
    status: ORDER_STATUS.PENDING,
    // فیلدهایی که در مراحل بعدی پر می‌شوند
    note: null,
    subscriptionId: null,
    pgUsername: null,
    paymentId: null,
    lastError: null,
    refunded: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...extra,
  };
}

export async function handlePaymentMethodSelection(callbackQuery, method, config, env) {
  const chatId = callbackQuery.message.chat.id;
  const fromId = callbackQuery.from.id;
  const messageId = callbackQuery.message.message_id;
  const session = getSession(chatId);

  if (!session.data || !session.data.planId) {
    return answerCallbackQuery(
      config.BOT_TOKEN,
      callbackQuery.id,
      '⚠️ اطلاعات سفارش ناقص است. دوباره از «🛒 خرید اشتراک» شروع کنید.',
      true
    );
  }

  // خرید اشتراک فقط با کیف پول انجام می‌شود (دکمه‌های قدیمی کارت/درگاه هم اینجا بسته می‌شوند)
  if (method !== 'wallet') {
    const guardPrice = Number(session.data.price) || 0;
    const guardBalance = getWallet(fromId);
    return editMessageText(config.BOT_TOKEN, chatId, messageId, purchasePaymentPrompt(guardBalance, guardPrice), {
      reply_markup: paymentMethodKeyboard(guardBalance, config, guardPrice),
    });
  }

  // ---------- کیف پول ----------
  if (method === 'wallet') {
    const price = Number(session.data.price) || 0;
    const balance = getWallet(fromId);

    if (balance < price) {
      return editMessageText(
        config.BOT_TOKEN,
        chatId,
        messageId,
        `⚠️ موجودی کیف پول شما کافی نیست.\n\n` +
          `موجودی فعلی: ${balance.toLocaleString()} تومان\n` +
          `مبلغ بسته: ${price.toLocaleString()} تومان\n\n` +
          'ابتدا کیف پول خود را شارژ کنید و بعد سفارش را ثبت کنید.',
        { reply_markup: walletMenuKeyboard() }
      );
    }

    const provider = getPaymentProvider(walletProvider.id);
    const order = buildOrderFromSession(session, callbackQuery.from, chatId, { paidVia: provider.id });

    // Verify → کسر از کیف پول
    const verification = await provider.verify({ env, config, order, params: {} });
    if (!verification.ok) {
      return answerCallbackQuery(
        config.BOT_TOKEN,
        callbackQuery.id,
        `⚠️ ${verification.reason || 'پرداخت از کیف پول انجام نشد.'}`,
        true
      );
    }

    order.status = ORDER_STATUS.CONFIRMED;
    memSet(DB.orders, order.id, order);

    const user = memGet(DB.users, String(fromId)) || { id: String(fromId), orders: [], walletBalance: 0 };
    user.orders = [...(user.orders || []), order.id];
    user.lastOrderName = order.customerName;
    memSet(DB.users, String(fromId), user);

    resetSession(chatId);

    await dbUpsertUser(env, callbackQuery.from);
    await dbSaveOrder(env, order);
    await recordPayment(env, order, provider, verification);
    await dbSyncUserWallet(env, fromId, getWallet(fromId));

    // ⚡ اعلان فوری به ادمین — همان لحظه‌ای که مشتری سفارش را تایید کرد،
    // بدون اینکه منتظر ساخت اشتراک روی پنل بمانیم. اگر ارسال به ادمین
    // خطا بدهد، هیچ تاثیری روی ادامه سفارش مشتری ندارد.
    const notified = notifyAdmins(env, config, {
      text: formatAdminOrderMessage(order),
      replyMarkup: adminOrderKeyboard(order.id, order.status),
      orderId: order.id,
    });

    await editMessageText(
      config.BOT_TOKEN,
      chatId,
      messageId,
      `✅ پرداخت سفارش <b>#${order.id}</b> از کیف پول انجام شد.\n⏳ در حال ساخت اشتراک روی سرور…`
    );

    await notified;

    // Verify → PasarGuard API → Create Subscription → Save in D1 → Send to Telegram
    return provisionOrder(env, config, order, { notifyChatId: chatId });
  }
}

export async function handleTestConfigRequest(chatId, userId, config, env) {
  const idStr = String(userId);
  const user = memGet(DB.users, idStr) || { id: idStr, orders: [], walletBalance: 0 };
  // ادمین‌ها هر تعداد تست کانفیگ که بخواهند می‌توانند بگیرند (بدون محدودیت)
  const unlimited = isAdmin(userId, config);

  if (!unlimited && user.testConfigClaimed) {
    return sendMessage(config.BOT_TOKEN, chatId,
      '<b>شما قبلاً تست کانفیگ دریافت کرده‌اید.</b>\n' +
      'هر مشتری فقط یک‌بار تست کانفیگ رایگان دریافت می‌کند.\n\n' +
      `پشتیبانی: @${config.SUPPORT_USERNAME}`
    );
  }

  if (!pgConfigured(config)) {
    return sendMessage(config.BOT_TOKEN, chatId,
      'سرویس تست کانفیگ در حال حاضر فعال نیست.\n' +
      `پشتیبانی: @${config.SUPPORT_USERNAME}`
    );
  }

  try {
    // گروه‌های پنل: 24 = All, 25 = 222
    // اولویت: 1) PG_GROUP_IDS از Cloudflare  2) از پنل  3) فالبک [24, 25]
    let groupIds = [];
    if (config.PG_GROUP_IDS) {
      groupIds = String(config.PG_GROUP_IDS).split(',').map(Number).filter(Boolean);
    } else {
      const allGroups = await pgGetGroups(env, config); // [{id, name}]
      groupIds = allGroups.map(g => g.id);
    }
    if (groupIds.length === 0) {
      groupIds = [24, 25]; // fallback ثابت: All + 222
    }
    console.log('[TEST-CFG] groupIds:', JSON.stringify(groupIds));

    const testPlan = {
      id: 'test_50mb',
      title: 'Test 50MB',
      gb: 50 / 1024,
      days: 0,
      groupIds,
      templateId: null,
      onHold: false,
    };
    const seq = Date.now();
    console.log('[TEST-CFG] groupIds:', JSON.stringify(groupIds));
    const provisioned = await pgProvision(env, config, {
      plan: testPlan, telegramId: userId, seq,
      note: `Test 50MB | ${idStr}`,
    });

    // برای ادمین علامت «دریافت‌شده» ثبت نمی‌شود تا همیشه بتواند دوباره تست بگیرد
    if (!unlimited) {
      user.testConfigClaimed = true;
      user.testConfigClaimedAt = Date.now();
      memSet(DB.users, idStr, user);
      // در D1 هم ثبت می‌شود تا بعد از بازیابی، کاربر بتواند دوباره تست بگیرد
      await d1Run(
        env,
        `INSERT INTO users (telegram_id, test_claimed, created_at, updated_at) VALUES (?, 1, ?, ?)
         ON CONFLICT (telegram_id) DO UPDATE SET test_claimed = 1, updated_at = excluded.updated_at`,
        [idStr, nowSec(), nowSec()]
      );
    }

    const subUrl = provisioned.subscriptionUrl || '';
    return sendMessage(config.BOT_TOKEN, chatId,
      `<b>کانفیگ تست رایگان شما (50 مگابایت)</b>\n\n` +
      `لینک اشتراک:\n<code>${escapeHtml(subUrl)}</code>\n\n` +
      `حجم: <b>50 مگابایت</b> | بدون تاریخ انقضا\n` +
      (unlimited
        ? '♾ شما ادمین هستید؛ دریافت تست کانفیگ برای شما <b>نامحدود</b> است.'
        : 'این تست فقط <b>یک‌بار</b> ارسال شد. امکان دریافت مجدد وجود ندارد.')
    );
  } catch (pgErr) {
    console.warn('[TEST-CFG] error:', String(pgErr), pgErr && pgErr.status);
    return sendMessage(config.BOT_TOKEN, chatId,
      'در ساخت کانفیگ تست مشکلی پیش آمد. لطفاً کمی بعد دوباره تلاش کنید.\n' +
      `پشتیبانی: @${config.SUPPORT_USERNAME}`
    );
  }
}

export async function handleProductSelection(callbackQuery, config) {
  const chatId = callbackQuery.message.chat.id;
  await editMessageText(config.BOT_TOKEN, chatId, callbackQuery.message.message_id, '💎 یکی از سرویس‌های ما را انتخاب کنید:', {
    reply_markup: plansKeyboard(config),
  });
}

export async function handlePlanSelection(callbackQuery, planId, config) {
  const chatId = callbackQuery.message.chat.id;
  ensurePlansLoaded();
  const plan = DB.plans.find((p) => p.id === planId);
  if (!plan) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ این بسته یافت نشد.', true);
  }

  const session = getSession(chatId);
  const kind = (session.data && session.data.kind) || ORDER_KIND.NEW;
  const renewOf = (session.data && session.data.renewOf) || null;
  const knownName = (session.data && session.data.customerName) || '';

  session.data = {
    planId: plan.id,
    planTitle: plan.title,
    price: plan.price,
    kind,
    renewOf,
    customerName: knownName,
  };

  const volume = Number(plan.gb) > 0 ? `${plan.gb} گیگابایت` : 'حجم نامحدود';
  const duration = Number(plan.days) > 0 ? `${plan.days} روز` : 'بدون تاریخ انقضا';
  const summary =
    `✅ بسته انتخابی: <b>${volume}</b>\n` +
    `📅 ${duration}\n` +
    `💰 مبلغ: <b>${Number(plan.price).toLocaleString()} تومان</b>`;

  // در تمدید، نام مشتری را از قبل داریم و مستقیم به مرحله پرداخت می‌رویم
  if (kind === ORDER_KIND.RENEW && knownName) {
    session.step = 'awaiting_payment_method';
    session.startedAt = Date.now();
    setSession(chatId, session);
    const renewBalance = getWallet(callbackQuery.from.id);
    return editMessageText(
      config.BOT_TOKEN,
      chatId,
      callbackQuery.message.message_id,
      `${summary}\n\n${purchasePaymentPrompt(renewBalance, plan.price)}`,
      { reply_markup: paymentMethodKeyboard(renewBalance, config, plan.price) }
    );
  }

  session.step = 'awaiting_name';
  session.startedAt = Date.now();
  setSession(chatId, session);
  return editMessageText(
    config.BOT_TOKEN,
    chatId,
    callbackQuery.message.message_id,
    `${summary}\n\n👤 لطفاً نام و نام خانوادگی خود را ارسال کنید:`
  );
}

export async function handleOrderStepMessage(message, config, env) {
  const chatId = message.chat.id;
  const session = getSession(chatId);
  const text = message.text || '';

  // ✅ بررسی timeout سفارش — مشتری 15 دقیقه (یک ربع) فرصت دارد سفارش را ثبت کند
  // (این چک فقط تا قبل از انتخاب کارت اعمال می‌شود؛ از لحظه‌ای که کارت انتخاب
  // شد و مهلت اختصاصی 30 دقیقه‌ای ارسال رسید — receiptDeadline — تنظیم شد،
  // دیگر این تایم‌اوت 15 دقیقه‌ای اعمال نمی‌شود تا با وعده «30 دقیقه فرصت
  // دارید» که به مشتری داده شده تناقض نداشته باشد.)
  const ORDER_SESSION_TIMEOUT_MS = 15 * 60 * 1000;
  if (
    !session.data.receiptDeadline &&
    session.startedAt &&
    Date.now() - session.startedAt > ORDER_SESSION_TIMEOUT_MS
  ) {
    resetSession(chatId);
    return sendMessage(
      config.BOT_TOKEN,
      chatId,
      '⏰ مهلت ثبت سفارش شما (15 دقیقه) به پایان رسید. لطفاً دوباره از منوی «🛙 فروشگاه» اقدام کنید.'
    );
  }

  switch (session.step) {
    case 'awaiting_name': {
      if (!text.trim()) {
        return sendMessage(config.BOT_TOKEN, chatId, '⚠️ لطفاً نام معتبر ارسال کنید.');
      }
      session.data.customerName = text.trim();
      session.step = 'awaiting_payment_method';
      setSession(chatId, session);
      const balance = getWallet(message.from.id);
      const orderPrice = Number(session.data.price) || 0;
      return sendMessage(config.BOT_TOKEN, chatId, purchasePaymentPrompt(balance, orderPrice), {
        reply_markup: paymentMethodKeyboard(balance, config, orderPrice),
      });
    }
    case 'awaiting_payment_method': {
      return sendMessage(config.BOT_TOKEN, chatId, '⚠️ لطفاً یکی از دکمه‌های بالا را برای انتخاب روش پرداخت بزنید.');
    }
    case 'awaiting_receipt': {
      if (session.data.receiptDeadline && Date.now() > session.data.receiptDeadline) {
        resetSession(chatId);
        return sendMessage(config.BOT_TOKEN, chatId,
          '⏰ مهلت 30 دقیقه ارسال رسید به پایان رسید.\nلطفاً سفارش را از ابتدا ثبت کنید.');
      }
      if (message.photo && message.photo.length > 0) {
        const bestPhoto = message.photo[message.photo.length - 1];
        session.data.receiptFileId = bestPhoto.file_id;
        session.step = 'awaiting_confirm';
        setSession(chatId, session);

        const order = buildOrderPreview(session.data, message.from);
        return sendMessage(config.BOT_TOKEN, chatId, formatOrderSummary(order), {
          reply_markup: orderConfirmKeyboard(),
        });
      }
      return sendMessage(config.BOT_TOKEN, chatId, '⚠️ لطفاً عکس رسید پرداخت را ارسال کنید (به‌صورت تصویر، نه فایل متنی).');
    }
    case 'awaiting_wallet_amount': {
      const amount = Number(text.trim());
      if (!text.trim() || isNaN(amount) || amount <= 0) {
        return sendMessage(config.BOT_TOKEN, chatId, '⚠️ لطفاً یک عدد معتبر و بزرگ‌تر از صفر ارسال کنید.');
      }
      if (amount < config.WALLET_MIN_TOPUP) {
        return sendMessage(
          config.BOT_TOKEN,
          chatId,
          `⚠️ حداقل مبلغ شارژ کیف پول <b>${config.WALLET_MIN_TOPUP.toLocaleString()} تومان</b> است.\nلطفاً مبلغ بیشتری ارسال کنید:`
        );
      }
      session.data.amount = amount;
      session.step = 'awaiting_wallet_card';
      setSession(chatId, session);
      return sendMessage(
        config.BOT_TOKEN,
        chatId,
        atlaspayConfigured(config)
          ? `💳 روش واریز مبلغ ${amount.toLocaleString()} تومان را انتخاب کنید:`
          : `💳 لطفاً یکی از کارت‌های زیر را برای واریز مبلغ ${amount.toLocaleString()} تومان انتخاب کنید:`,
        { reply_markup: walletTopupCardsKeyboard(config) }
      );
    }
    case 'awaiting_wallet_receipt': {
      if (session.data.receiptDeadline && Date.now() > session.data.receiptDeadline) {
        resetSession(chatId);
        return sendMessage(config.BOT_TOKEN, chatId,
          '⏰ مهلت 30 دقیقه ارسال رسید به پایان رسید.\nلطفاً از ابتدا اقدام کنید.');
      }
      if (message.photo && message.photo.length > 0) {
        const bestPhoto = message.photo[message.photo.length - 1];
        const req = {
          id: SHARED.walletReqSeq++,
          userId: message.from.id,
          chatId,
          username: message.from.username || null,
          customerName: `${message.from.first_name || ''} ${message.from.last_name || ''}`.trim(),
          amount: session.data.amount,
          cardId: session.data.cardId,
          cardLabel: session.data.cardLabel,
          receiptFileId: bestPhoto.file_id,
          status: WALLET_REQUEST_STATUS.PENDING,
          createdAt: Date.now(),
        };
        memSet(DB.walletRequests, req.id, req);
        await dbUpsertUser(env, message.from);
        resetSession(chatId);

        await notifyAdmins(env, config, {
          orderId: `wallet:${req.id}`,
          text: formatWalletRequestMessage(req),
          photoFileId: req.receiptFileId,
          replyMarkup: walletRequestAdminKeyboard(req.id, req.status),
        });

        return sendMessage(
          config.BOT_TOKEN,
          chatId,
          `✅ درخواست شارژ شما به مبلغ ${req.amount.toLocaleString()} تومان ثبت شد و پس از تایید ادمین به کیف پول شما اضافه می‌شود.`
        );
      }
      return sendMessage(config.BOT_TOKEN, chatId, '⚠️ لطفاً عکس رسید پرداخت را ارسال کنید (به‌صورت تصویر، نه فایل متنی).');
    }
    default:
      return null; // این پیام مربوط به هیچ مرحله سفارشی نیست
  }
}

export function buildOrderPreview(data, from) {
  return {
    id: 'preview',
    userId: from.id,
    username: from.username || null,
    customerName: data.customerName,
    planTitle: data.planTitle,
    price: data.price,
    cardLabel: data.cardLabel,
    receiptFileId: data.receiptFileId,
    status: ORDER_STATUS.PENDING,
  };
}

export async function handlePlaceOrder(callbackQuery, config, env) {
  const chatId = callbackQuery.message.chat.id;
  const from = callbackQuery.from;
  const session = getSession(chatId);

  if (session.step !== 'awaiting_confirm') {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '⚠️ اطلاعات سفارش ناقص است.', true);
  }

  const provider = getPaymentProvider(manualCardProvider.id);
  const order = buildOrderFromSession(session, from, chatId, {
    cardId: session.data.cardId,
    cardLabel: session.data.cardLabel,
    receiptFileId: session.data.receiptFileId,
    paidVia: provider.id,
    status: ORDER_STATUS.PENDING,
  });
  memSet(DB.orders, order.id, order);

  const user = memGet(DB.users, String(from.id)) || { id: String(from.id), orders: [], walletBalance: 0 };
  user.orders = [...(user.orders || []), order.id];
  user.lastOrderName = order.customerName;
  memSet(DB.users, String(from.id), user);

  resetSession(chatId);

  await dbUpsertUser(env, from);
  await dbSaveOrder(env, order);
  await recordPayment(
    env,
    order,
    provider,
    paymentResult({ ok: false, reference: `card_${order.id}`, amount: order.price }),
    `pay_card_${order.id}`
  );

  const kindNote =
    order.kind === ORDER_KIND.RENEW ? '\n🔄 این سفارش یک <b>تمدید</b> است و اشتراک تازه ساخته می‌شود.' : '';

  // ⚡ اعلان فوری به ادمین + پیام تایید به مشتری، هم‌زمان.
  // allSettled استفاده می‌شود تا اگر ویرایش پیام مشتری خطا بدهد (مثلاً پیام
  // خیلی قدیمی باشد) اعلان ادمین قطعاً انجام شود و برعکس.
  // notifyAdmins خودش تضمین می‌کند اعلان گم نشود (گروه ادمین → چت خصوصی ادمین،
  // عکس → متن → متن ساده) و برای هر شماره سفارش فقط یک‌بار ارسال شود.
  const results = await Promise.allSettled([
    // چرخش دکمه مشتری فوراً متوقف شود
    answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '✅ سفارش ثبت شد'),
    notifyAdmins(env, config, {
      text: formatAdminOrderMessage(order),
      photoFileId: order.receiptFileId,
      replyMarkup: adminOrderKeyboard(order.id, order.status),
      orderId: order.id,
    }),
    editMessageText(
      config.BOT_TOKEN,
      chatId,
      callbackQuery.message.message_id,
      `✅ سفارش شما با شماره <b>#${order.id}</b> ثبت شد و در حال بررسی توسط ادمین است.${kindNote}\n` +
        'به‌محض تایید پرداخت، اشتراک به‌صورت خودکار ساخته و لینک آن همین‌جا برای شما ارسال می‌شود.'
    ),
  ]);

  for (const result of results) {
    if (result.status === 'rejected') {
      await dbLog(env, 'warn', 'telegram', `order confirm step failed: ${String(result.reason).slice(0, 200)}`, {}, {
        telegramId: from.id,
        orderId: order.id,
      });
    }
  }
}

export async function handleOrderCancel(callbackQuery, config) {
  const chatId = callbackQuery.message.chat.id;
  resetSession(chatId);
  await editMessageText(config.BOT_TOKEN, chatId, callbackQuery.message.message_id, '❌ سفارش لغو شد. هر زمان خواستید از منوی «🛍 فروشگاه» دوباره اقدام کنید.');
}

// پیام سفارش در گروه ادمین را با وضعیت تازه بازنویسی می‌کند
export async function refreshAdminOrderMessage(config, order, adminChatId, adminMsgId) {
  const markup = adminOrderKeyboard(order.id, order.status);
  if (order.receiptFileId) {
    return editCaptionSafely(config, adminChatId, adminMsgId, formatAdminOrderMessage(order), markup);
  }
  return editMessageText(config.BOT_TOKEN, adminChatId, adminMsgId, formatAdminOrderMessage(order), {
    reply_markup: markup,
  });
}

export async function handleAdminAction(callbackQuery, action, orderId, config, env) {
  const fromId = callbackQuery.from.id;
  if (!isAdmin(fromId, config)) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '⛔ شما دسترسی ادمین ندارید.', true);
  }

  const order = memGet(DB.orders, Number(orderId));
  if (!order) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ سفارش یافت نشد.', true);
  }

  const adminChatId = callbackQuery.message.chat.id;
  const adminMsgId = callbackQuery.message.message_id;

  // ---------- تایید پرداخت → ساخت خودکار اشتراک ----------
  if (action === 'confirm') {
    if (order.subscriptionId && memGet(DB.subscriptions, order.subscriptionId)) {
      return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, 'ℹ️ اشتراک این سفارش قبلاً ساخته شده است.', true);
    }

    order.status = ORDER_STATUS.CONFIRMED;
    order.updatedAt = Date.now();
    memSet(DB.orders, order.id, order);

    const provider = getPaymentProvider(order.paidVia) || manualCardProvider;
    // پرداخت‌های کیف پول و درگاه قبلاً تایید و کسر شده‌اند؛ تایید دوباره
    // نباید باعث کسر مجدد از موجودی کاربر شود.
    // پرداخت اطلس‌پی هنوز تایید نشده؟ تایید دستی فقط برای «کسری واریز» مجاز است.
    if (order.paidVia === atlaspayProvider.id && isAtlaspayAwaiting(order)) {
      return answerCallbackQuery(
        config.BOT_TOKEN,
        callbackQuery.id,
        '⏳ پرداخت اطلس‌پی هنوز تایید نشده است؛ پس از تایید خودکار، اشتراک ساخته می‌شود.',
        true
      );
    }
    const alreadyPaid =
      order.paidVia === walletProvider.id ||
      order.paidVia === gatewayProvider.id ||
      order.paidVia === atlaspayProvider.id;
    const verification = alreadyPaid
      ? paymentResult({
          ok: true,
          reference: `${provider.id}_${order.id}`,
          amount: order.price,
          raw: { reused: true },
        })
      : await provider.verify({ env, config, order, params: { adminId: fromId } });
    await recordPayment(env, order, provider, verification, `pay_${provider.id}_${order.id}`);
    await dbSaveOrder(env, order);
    await dbLog(env, 'info', 'payment', `order confirmed by admin`, { provider: provider.id }, {
      telegramId: order.userId,
      orderId: order.id,
    });

    await answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '✅ تایید شد. اشتراک در حال ساخت است…');
    await refreshAdminOrderMessage(config, order, adminChatId, adminMsgId);
    await sendMessage(
      config.BOT_TOKEN,
      order.chatId,
      `✅ پرداخت سفارش شما (#${order.id}) تایید شد.\n⏳ در حال ساخت اشتراک روی سرور…`
    );

    const result = await provisionOrder(env, config, order, { notifyChatId: order.chatId });
    if (result.ok) await refreshAdminOrderMessage(config, order, adminChatId, adminMsgId);
    return;
  }

  // ---------- رد سفارش ----------
  if (action === 'reject') {
    order.status = ORDER_STATUS.REJECTED;
    order.updatedAt = Date.now();
    memSet(DB.orders, order.id, order);

    // اگر سفارش با کیف پول پرداخت شده بود، مبلغ را به کیف پول کاربر برگردان
    if (order.paidVia === walletProvider.id && !order.refunded) {
      addWalletBalance(order.userId, order.price);
      order.refunded = true;
      memSet(DB.orders, order.id, order);
      await dbSyncUserWallet(env, order.userId, getWallet(order.userId));
    }

    await dbSaveOrder(env, order);
    await dbLog(env, 'info', 'payment', 'order rejected by admin', {}, {
      telegramId: order.userId,
      orderId: order.id,
    });

    await sendMessage(
      config.BOT_TOKEN,
      order.chatId,
      `❌ متاسفانه سفارش شما (#${order.id}) رد شد.` +
        (order.refunded ? '\n💰 مبلغ سفارش به کیف پول شما بازگردانده شد.' : '') +
        `\nدر صورت وجود سوال با پشتیبانی در تماس باشید: @${config.SUPPORT_USERNAME}`
    );
    await refreshAdminOrderMessage(config, order, adminChatId, adminMsgId);
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ سفارش رد شد.');
  }

  // ---------- ارسال دستی اکانت (پشتیبان، وقتی ساخت خودکار ناموفق بوده) ----------
  if (action === 'send') {
    const adminSession = getSession(`admin_${fromId}`);
    adminSession.step = 'awaiting_send_account';
    adminSession.data = { orderId: order.id };
    setSession(`admin_${fromId}`, adminSession);

    return answerCallbackQuery(
      config.BOT_TOKEN,
      callbackQuery.id,
      '📨 اطلاعات اکانت را در پیام بعدی ارسال کنید.',
      true
    );
  }
}

export async function editCaptionSafely(config, chatId, messageId, caption, replyMarkup) {
  return callTelegram(config.BOT_TOKEN, 'editMessageCaption', {
    chat_id: chatId,
    message_id: messageId,
    caption,
    parse_mode: 'HTML',
    reply_markup: replyMarkup,
  });
}

export async function handleWalletRequestAction(callbackQuery, action, reqId, config, env) {
  const fromId = callbackQuery.from.id;
  if (!isAdmin(fromId, config)) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '⛔ شما دسترسی ادمین ندارید.', true);
  }

  const req = memGet(DB.walletRequests, Number(reqId));
  if (!req) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ درخواست یافت نشد.', true);
  }

  const adminChatId = callbackQuery.message.chat.id;
  const adminMsgId = callbackQuery.message.message_id;

  // جلوگیری از شارژ دوباره (مثلاً کلیک روی پیام قدیمی) و از تایید پرداخت اطلس‌پیِ هنوز تاییدنشده
  if (req.status !== WALLET_REQUEST_STATUS.PENDING) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, 'ℹ️ این درخواست قبلاً رسیدگی شده است.', true);
  }
  if (isAtlaspayAwaiting(req)) {
    return answerCallbackQuery(
      config.BOT_TOKEN,
      callbackQuery.id,
      '⏳ پرداخت اطلس‌پی هنوز تایید نشده است؛ پس از تایید، خودکار شارژ می‌شود.',
      true
    );
  }

  if (action === 'approve') {
    req.status = WALLET_REQUEST_STATUS.APPROVED;
    memSet(DB.walletRequests, req.id, req);
    const newBalance = addWalletBalance(req.userId, req.amount);
    await dbSyncUserWallet(env, req.userId, newBalance);

    await sendMessage(
      config.BOT_TOKEN,
      req.chatId,
      `✅ شارژ کیف پول شما به مبلغ ${req.amount.toLocaleString()} تومان تایید شد.\nموجودی جدید: <b>${newBalance.toLocaleString()} تومان</b>`
    );
    await editCaptionSafely(config, adminChatId, adminMsgId, formatWalletRequestMessage(req), walletRequestAdminKeyboard(req.id, req.status));
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '✅ شارژ تایید و اعمال شد.');
  }

  if (action === 'reject') {
    req.status = WALLET_REQUEST_STATUS.REJECTED;
    memSet(DB.walletRequests, req.id, req);

    await sendMessage(
      config.BOT_TOKEN,
      req.chatId,
      `❌ متاسفانه درخواست شارژ کیف پول شما (${req.amount.toLocaleString()} تومان) رد شد.\nبرای اطلاعات بیشتر با پشتیبانی در تماس باشید: @${config.SUPPORT_USERNAME}`
    );
    await editCaptionSafely(config, adminChatId, adminMsgId, formatWalletRequestMessage(req), walletRequestAdminKeyboard(req.id, req.status));
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ درخواست رد شد.');
  }
}

export async function handleCheckJoin(callbackQuery, config, env) {
  const chatId = callbackQuery.message.chat.id;
  const fromId = callbackQuery.from.id;
  const member = !DB.forceJoinEnabled || isAdmin(fromId, config) || await isChannelMember(config, fromId);
  if (member) {
    registerUser(callbackQuery.from);
    if (callbackQuery.message.chat.type === 'private') await confirmReferralAndReward(fromId, config, env);
    await answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '✅ عضویت شما تایید شد.');
    return sendMessage(
      config.BOT_TOKEN,
      chatId,
      '🎉 عضویت شما تایید شد! خوش آمدید 👋\n\nاز منوی زیر یکی از گزینه‌ها را انتخاب کنید:',
      { reply_markup: mainReplyKeyboard(config) }
    );
  }
  return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '⚠️ شما هنوز عضو کانال نشده‌اید. لطفاً ابتدا عضو شوید.', true);
}

export async function handleForceJoinMenu(chatId, config) {
  let text = '🔒 <b>عضویت اجباری در کانال</b>\n\n';
  text += 'در صورت فعال بودن این قابلیت، کاربران قبل از استفاده از ربات باید عضو کانال شما شوند.\n\n';
  text += `📢 کانال تنظیم‌شده: ${escapeHtml(config.CHANNEL_ID)}\n`;
  text += `⚙️ وضعیت فعلی: ${DB.forceJoinEnabled ? '✅ فعال' : '❌ غیرفعال'}\n\n`;
  text += '⚠️ توجه: برای کارکرد صحیح این قابلیت، ربات باید ادمین کانال باشد؛ در غیر این صورت کاربران مسدود نمی‌شوند.';
  return sendMessage(config.BOT_TOKEN, chatId, text, { reply_markup: forceJoinAdminKeyboard() });
}

export async function handleForceJoinToggle(callbackQuery, config) {
  DB.forceJoinEnabled = !DB.forceJoinEnabled;
  await answerCallbackQuery(
    config.BOT_TOKEN,
    callbackQuery.id,
    DB.forceJoinEnabled ? '✅ عضویت اجباری فعال شد.' : '❌ عضویت اجباری غیرفعال شد.'
  );
  return handleForceJoinMenu(callbackQuery.message.chat.id, config);
}

// ---------- مدیریت کانفیگ کاربران (فعال/غیرفعال/حذف) ----------
// همه کانفیگ‌های ثبت‌شده در ربات (جدیدترین اول)، بدون هیچ سقفی؛ فقط برای نمایش صفحه‌به‌صفحه می‌شوند
export const UCFG_PAGE_SIZE = 20;

export function allSubscriptionsSorted() {
  return [...DB.subscriptions.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// شماره صفحه‌ای که یک اشتراک در لیست ادمین در آن قرار دارد (برای دکمه بازگشت به همان صفحه)
export function userConfigsPageOf(subId) {
  const index = allSubscriptionsSorted().findIndex((sub) => sub.id === subId);
  return index < 0 ? 0 : Math.floor(index / UCFG_PAGE_SIZE);
}

export function userConfigStatusIcon(status) {
  if (status === 'disabled') return '🔴';
  if (status === 'on_hold') return '⏸';
  if (status === 'limited') return '🟠';
  if (status === 'expired') return '⚫';
  if (status === 'revoked') return '⚪';
  return '🟢';
}

export function buildUserConfigsView(page = 0) {
  const allSubs = allSubscriptionsSorted();
  if (allSubs.length === 0) return null;

  const pages = Math.ceil(allSubs.length / UCFG_PAGE_SIZE);
  const current = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const slice = allSubs.slice(current * UCFG_PAGE_SIZE, (current + 1) * UCFG_PAGE_SIZE);

  const rows = slice.map((sub) => {
    const style =
      sub.status === 'on_hold'
        ? 'primary'
        : sub.status === 'active'
          ? 'success'
          : 'danger';
    return [
      {
        text: `${userConfigStatusIcon(sub.status)} ${sub.pgUsername} — ${sub.planTitle || '-'}`,
        callback_data: `ucfg:sel:${sub.id}`,
        style,
      },
    ];
  });

  if (pages > 1) {
    const nav = [];
    if (current > 0) nav.push({ text: '◀️ قبلی', callback_data: `ucfg:page:${current - 1}`, style: 'primary' });
    nav.push({ text: `📄 ${current + 1} / ${pages}`, callback_data: 'noop' });
    if (current < pages - 1) nav.push({ text: 'بعدی ▶️', callback_data: `ucfg:page:${current + 1}`, style: 'primary' });
    rows.push(nav);
  }
  rows.push(backNavRow('admin'));

  const from = current * UCFG_PAGE_SIZE + 1;
  const to = current * UCFG_PAGE_SIZE + slice.length;
  const text =
    `🚦 <b>مدیریت کانفیگ کاربران</b>\n` +
    `📊 مجموع همه کانفیگ‌ها: <b>${allSubs.length}</b> | نمایش ${from} تا ${to}\n` +
    `🟢 فعال | 🔴 غیرفعال | ⏸ توقف | 🟠 حجم‌تمام | ⚫ منقضی | ⚪ باطل‌شده\n\n` +
    `یک کانفیگ را انتخاب کنید:`;
  return { text, reply_markup: { inline_keyboard: rows } };
}

export async function handleUserConfigsMenu(chatId, config, page = 0) {
  const view = buildUserConfigsView(page);
  if (!view) {
    return sendMessage(config.BOT_TOKEN, chatId, '📭 هیچ کانفیگی ثبت نشده است.');
  }
  return sendMessage(config.BOT_TOKEN, chatId, view.text, { reply_markup: view.reply_markup });
}

export async function handleAdminPanel(message, config, env) {
  const chatId = message.chat.id;
  if (!isAdmin(message.from.id, config)) {
    return sendMessage(config.BOT_TOKEN, chatId, '⛔ شما دسترسی به پنل مدیریت ندارید.');
  }
  let text = '🛠 <b>پنل مدیریت</b>\nیکی از گزینه‌ها را انتخاب کنید:';
  if (!isPersistenceEnabled(env)) {
    text += '\n\n⚠️ حافظه دائمی (KV) وصل نیست. برای اطلاعات بیشتر ابتدای کد را ببینید.';
  }
  return sendMessage(config.BOT_TOKEN, chatId, text, { reply_markup: adminReplyKeyboard() });
}

export const AD_TEXT_MAX = 1000;

export const AD_BUTTON_TEXT_MAX = 64;

export function isValidButtonUrl(url) {
  return /^(https?:\/\/|tg:\/\/)\S+$/i.test(String(url || '').trim());
}

export async function getBotUsernameCached(config) {
  if (SHARED.cachedBotUsername) return SHARED.cachedBotUsername;
  try {
    const me = await getMe(config.BOT_TOKEN);
    const username = me && me.ok && me.result && me.result.username;
    if (username && /^[a-zA-Z0-9_]+$/.test(username)) {
      SHARED.cachedBotUsername = username;
      return username;
    }
  } catch (_) {
    // نادیده گرفته می‌شود؛ فراخوان مقدار null را مدیریت می‌کند
  }
  return null;
}

/**
 * مقدار خام لینک دکمه تبلیغ را به یک URL واقعی تبدیل می‌کند.
 * اگر مقدار خالی باشد یا برابر کلمهٔ ویژه «shop» باشد، لینک عمیق ربات با
 * start=shop ساخته می‌شود (باز شدن مستقیم منوی «خرید اشتراک»). در غیر این
 * صورت همان لینکی که ادمین وارد کرده برگردانده می‌شود.
 */
export async function resolveAdButtonUrl(config, rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value || value.toLowerCase() === 'shop') {
    const username = await getBotUsernameCached(config);
    if (!username) return null;
    return `https://t.me/${username}?start=shop`;
  }
  return value;
}

// نکته: تا نسخه Bot API 9.4 (فوریه ۲۰۲۶)، تلگرام هیچ راهی برای رنگی‌کردن
// دکمه‌های شیشه‌ای (inline keyboard) نداشت. از آن نسخه به بعد فیلد «style»
// اضافه شده و اجازه می‌دهد دکمه واقعاً سبز (success)، آبی (primary) یا
// قرمز (danger) رنگ شود — بدون نیاز به ایموجی یا ترفند بصری.
export function adButtonKeyboard(text, url) {
  return { inline_keyboard: [[{ text, url, style: 'success' }]] };
}

// متن قابل‌نمایش لینک پیش‌فرض دکمه تبلیغ (برای پیام‌های راهنما)
export function describeAdDefaultButtonUrl(config) {
  const value = String(config.AD_DEFAULT_BUTTON_URL || '').trim();
  if (!value || value.toLowerCase() === 'shop') return 'باز شدن خودکار منوی «خرید اشتراک» در ربات';
  return value;
}

export function adBuildKeyboard(ad) {
  if (ad.buttonText && ad.buttonUrl) {
    return adButtonKeyboard(ad.buttonText, ad.buttonUrl);
  }
  return { inline_keyboard: [] };
}

export function formatAdPreview(ad) {
  const shortText = (ad.text || '').slice(0, 200);
  const lines = [
    `🆔 <code>${ad.id}</code>`,
    `📡 کانال: <code>${escapeHtml(ad.channelId || ad.chatId || '—')}</code>`,
    `📝 متن:\n${escapeHtml(shortText)}${(ad.text || '').length > 200 ? '…' : ''}`,
    ad.photoFileId ? '🖼 دارای عکس' : '🖼 بدون عکس',
    ad.buttonText && ad.buttonUrl
      ? `🔘 دکمه: ${escapeHtml(ad.buttonText)} → ${escapeHtml(ad.buttonUrl)}`
      : '🔘 بدون دکمه',
    `🕐 آخرین بروزرسانی: ${formatDate(ad.updatedAt || ad.createdAt)}`,
  ];
  return lines.join('\n');
}

export async function handleChannelAdMenu(chatId, config) {
  const ads = [...DB.channelAds.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const rows = ads.slice(0, 25).map((ad) => {
    const label = (ad.text || '(بدون متن)').replace(/\n/g, ' ').slice(0, 34);
    return [{ text: `📢 ${label}${(ad.text || '').length > 34 ? '…' : ''}`, callback_data: `ad_open:${ad.id}`, style: 'primary' }];
  });
  rows.push([{ text: '➕ ارسال تبلیغ جدید', callback_data: 'ad_new', style: 'success' }]);
  rows.push(backNavRow('admin'));

  return sendMessage(config.BOT_TOKEN, chatId,
    '📣 <b>تبلیغ در کانال</b>\n\n' +
    'هر آگهی به کانالی که موقع ساختنش مشخص می‌کنید ارسال می‌شود (نه لزوماً کانال پیش‌فرض تنظیمات).\n' +
    `کانال پیش‌فرض تنظیمات (فقط برای عضویت اجباری): <code>${escapeHtml(config.CHANNEL_ID)}</code>\n` +
    `تعداد آگهی‌های ارسال‌شده: <b>${ads.length}</b>\n\n` +
    (ads.length > 0
      ? 'یک آگهی را برای مشاهده و ویرایش انتخاب کنید، یا آگهی جدید بسازید:'
      : 'هنوز آگهی‌ای ارسال نشده. برای شروع، آگهی جدید بسازید:'),
    { reply_markup: { inline_keyboard: rows } }
  );
}

export function channelAdDetailKeyboard(ad) {
  const rows = [
    [{ text: '✏️ ویرایش متن', callback_data: `ad_edit:text:${ad.id}`, style: 'primary' }],
  ];
  rows.push([{
    text: ad.photoFileId ? '🖼 تعویض عکس' : '🖼 عکس ندارد (نیاز به آگهی جدید)',
    callback_data: ad.photoFileId ? `ad_edit:photo:${ad.id}` : 'noop',
    style: 'success',
  }]);
  rows.push([{ text: ad.buttonText ? '🔘 ویرایش دکمه' : '➕ افزودن دکمه', callback_data: `ad_edit:button:${ad.id}`, style: 'primary' }]);
  if (ad.buttonText) rows.push([{ text: '🗑 حذف دکمه', callback_data: `ad_edit:removebtn:${ad.id}`, style: 'danger' }]);
  rows.push([{ text: '🗑 حذف کامل آگهی', callback_data: `ad_delete:${ad.id}`, style: 'danger' }]);
  rows.push([{ text: '🔙 بازگشت به لیست', callback_data: 'ad_menu' }]);
  return { inline_keyboard: rows };
}

export async function handleChannelAdOpen(callbackQuery, adId, config) {
  const ad = memGet(DB.channelAds, adId);
  if (!ad) return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ آگهی یافت نشد.', true);
  return sendMessage(config.BOT_TOKEN, callbackQuery.message.chat.id,
    `📣 <b>جزئیات آگهی</b>\n\n${formatAdPreview(ad)}`,
    { reply_markup: channelAdDetailKeyboard(ad) }
  );
}

export async function handleChannelAdNewStart(callbackQuery, config) {
  const fromId = callbackQuery.from.id;
  const session = getSession(`admin_${fromId}`);
  session.step = 'awaiting_ad_channel_id';
  session.data = {};
  setSession(`admin_${fromId}`, session);
  return sendMessage(config.BOT_TOKEN, callbackQuery.message.chat.id,
    '📣 <b>ساخت آگهی جدید</b>\n\n' +
    '📡 اول بگویید این آگهی در <b>چه کانالی</b> ارسال شود — آیدی عددی همان کانال را بفرستید ' +
    '(مثل <code>-1001234567890</code>)،\n' +
    'یا اگر نمی‌دانید آیدی عددی چیست، فقط یک پست از همان کانال را همین‌جا برای ربات <b>فوروارد</b> کنید ' +
    'تا آیدی آن خودکار استخراج شود.\n\n' +
    `📌 کانال پیش‌فرض تنظیمات فعلی شما (<code>${escapeHtml(String(config.CHANNEL_ID || '—'))}</code>) ` +
    'فقط برای اطلاع است و با این کار <b>هیچ‌وقت</b> تغییر نمی‌کند؛ فقط همین یک آگهی به کانالی که الان مشخص می‌کنید ارسال می‌شود.\n\n' +
    '⚠️ ربات باید از قبل در آن کانال «ادمین» باشد.\n' +
    'برای لغو دستور /cancel را بفرستید.'
  );
}

export async function handleChannelAdEditStart(callbackQuery, subaction, adId, config) {
  const ad = memGet(DB.channelAds, adId);
  if (!ad) return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ آگهی یافت نشد.', true);
  const fromId = callbackQuery.from.id;
  const session = getSession(`admin_${fromId}`);
  const chatId = callbackQuery.message.chat.id;

  if (subaction === 'text') {
    session.step = 'awaiting_ad_edit_text';
    session.data = { adId };
    setSession(`admin_${fromId}`, session);
    return sendMessage(config.BOT_TOKEN, chatId,
      `✏️ متن جدید آگهی را ارسال کنید (حداکثر ${AD_TEXT_MAX} کاراکتر):\n\nمتن فعلی:\n${escapeHtml(ad.text || '')}`
    );
  }

  if (subaction === 'photo') {
    if (!ad.photoFileId) {
      return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id,
        '⚠️ این آگهی بدون عکس ارسال شده و تلگرام اجازه نمی‌دهد پیام متنی به پیام عکس‌دار تبدیل شود. برای افزودن عکس، آگهی جدید بسازید.', true);
    }
    session.step = 'awaiting_ad_edit_photo';
    session.data = { adId };
    setSession(`admin_${fromId}`, session);
    return sendMessage(config.BOT_TOKEN, chatId, '🖼 عکس جدید آگهی را ارسال کنید:');
  }

  if (subaction === 'button') {
    session.step = 'awaiting_ad_edit_button_text';
    session.data = { adId };
    setSession(`admin_${fromId}`, session);
    return sendMessage(config.BOT_TOKEN, chatId,
      `🔘 متن جدید دکمه را ارسال کنید (حداکثر ${AD_BUTTON_TEXT_MAX} کاراکتر):\n\n` +
      (ad.buttonText ? `متن فعلی: ${escapeHtml(ad.buttonText)}` : 'در حال حاضر دکمه‌ای ندارد.') +
      `\n\nبرای استفاده از دکمه پیش‌فرض «${config.AD_DEFAULT_BUTTON_TEXT}» → ${describeAdDefaultButtonUrl(config)} دستور /default را بفرستید.`
    );
  }

  if (subaction === 'removebtn') {
    if (!ad.buttonText) {
      return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, 'ℹ️ این آگهی در حال حاضر دکمه‌ای ندارد.', true);
    }
    ad.buttonText = null;
    ad.buttonUrl = null;
    ad.updatedAt = Date.now();
    memSet(DB.channelAds, ad.id, ad);
    await editMessageReplyMarkup(config.BOT_TOKEN, ad.chatId, ad.messageId, { inline_keyboard: [] });
    await answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '✅ دکمه حذف شد.');
    return sendMessage(config.BOT_TOKEN, chatId, `📣 <b>جزئیات آگهی</b>\n\n${formatAdPreview(ad)}`, {
      reply_markup: channelAdDetailKeyboard(ad),
    });
  }

  return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id);
}

export async function handleChannelAdDelete(callbackQuery, adId, config) {
  const ad = memGet(DB.channelAds, adId);
  if (!ad) return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ آگهی یافت نشد.', true);
  await deleteMessage(config.BOT_TOKEN, ad.chatId, ad.messageId);
  memDelete(DB.channelAds, adId);
  await answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '🗑 آگهی حذف شد.');
  return handleChannelAdMenu(callbackQuery.message.chat.id, config);
}

// ساخت و ارسال آگهی جدید به کانال بر اساس داده‌های جمع‌آوری‌شده در سشن
// توجه: کانال مقصد از session.data.channelId (همان چیزی که ادمین موقع ساخت
// آگهی وارد کرده) خوانده می‌شود، نه از config.CHANNEL_ID — تنظیمات پیش‌فرض
// کانال هرگز توسط این تابع تغییر نمی‌کند.
export async function finalizeNewChannelAd(config, chatId, session) {
  const { text, photoFileId, buttonText, buttonUrl, channelId } = session.data;
  const targetChannelId = channelId;
  const replyMarkup = buttonText && buttonUrl
    ? adButtonKeyboard(buttonText, buttonUrl)
    : undefined;
  const extra = replyMarkup ? { reply_markup: replyMarkup } : {};

  const sent = photoFileId
    ? await sendPhoto(config.BOT_TOKEN, targetChannelId, photoFileId, text, extra)
    : await sendMessage(config.BOT_TOKEN, targetChannelId, text, extra);

  if (!sent || !sent.ok) {
    const desc = (sent && sent.description) || 'خطای نامشخص';
    const chatNotFound = /chat not found/i.test(desc);
    await sendMessage(config.BOT_TOKEN, chatId,
      `⚠️ ارسال آگهی به کانال ناموفق بود: ${desc}\n\n` +
      `کانالی که وارد کردید: <code>${escapeHtml(String(targetChannelId || ''))}</code>\n\n` +
      (chatNotFound
        ? '👉 این خطا معمولاً یعنی آیدی وارد‌شده اشتباه است یا ربات در آن کانال ادمین نیست. ' +
          'یک پست از همان کانال را برای ربات فوروارد کنید تا آیدی عددی صحیح دوباره استخراج شود؛ ' +
          'همچنین مطمئن شوید ربات از قبل در آن کانال «ادمین» است.'
        : 'مطمئن شوید ربات در آن کانال ادمین است و آیدی وارد‌شده درست است.')
    );
    return null;
  }

  const ad = {
    id: newId('ad'),
    text,
    photoFileId: photoFileId || null,
    buttonText: buttonText || null,
    buttonUrl: buttonUrl || null,
    channelId: String(targetChannelId || ''),
    chatId: String(sent.result.chat.id),
    messageId: sent.result.message_id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  memSet(DB.channelAds, ad.id, ad);
  return ad;
}

export async function handleAdminReplyKeyboardText(message, config, env) {
  const chatId = message.chat.id;
  const fromId = message.from.id;
  const text = message.text;

  if (!isAdmin(fromId, config)) return false;

  if (text === '⏳ سفارش‌های در انتظار') {
    const pending = [...DB.orders.values()].filter((o) => o.status === ORDER_STATUS.PENDING && !isAtlaspayAwaiting(o));
    if (pending.length === 0) {
      await sendMessage(config.BOT_TOKEN, chatId, '📭 سفارش در انتظاری وجود ندارد.');
      return true;
    }
    for (const order of pending.slice(-10)) {
      if (order.receiptFileId) {
        await sendPhoto(config.BOT_TOKEN, chatId, order.receiptFileId, formatAdminOrderMessage(order), {
          reply_markup: adminOrderKeyboard(order.id, order.status),
        });
      } else {
        await sendMessage(config.BOT_TOKEN, chatId, formatAdminOrderMessage(order), {
          reply_markup: adminOrderKeyboard(order.id, order.status),
        });
      }
    }
    return true;
  }

  if (text === '💳 مدیریت کارت‌ها') {
    await handleCardsManagementMenu(chatId, config);
    return true;
  }

  if (text === '📦 مدیریت بسته‌ها') {
    await handlePlansManagementMenu(chatId, config);
    return true;
  }

  if (text === '🎓 مدیریت آموزش‌ها') {
    await handleTutorialsManagementMenu(chatId, config);
    return true;
  }

  if (text === '🛰 پاسارگارد') {
    await handlePasarguardMenu(chatId, config, env);
    return true;
  }

  if (text === '🎁 مدیریت تست کانفیگ') {
    await handleTestConfigsManagementMenu(chatId, config);
    return true;
  }

  if (text === '💳 پنل اطلس‌پی') {
    await sendMessage(
      config.BOT_TOKEN,
      chatId,
      '💳 <b>پنل اطلس‌پی</b>\n\nبرای ورود به پنل، تنظیم وبهوک و پشتیبانی، روی دکمه زیر بزنید و در ربات اطلس‌پی «Start» را بزنید:',
      { reply_markup: { inline_keyboard: [[{ text: '🚀 باز کردن پنل اطلس‌پی', url: 'https://t.me/atlaspaybot' }]] } }
    );
    return true;
  }

  if (text === '💰 مدیریت کیف پول') {
    await handleWalletAdminMenu(chatId, config);
    return true;
  }

  if (text === '🔒 عضویت اجباری') {
    await handleForceJoinMenu(chatId, config);
    return true;
  }

  if (text === '👤 مدیریت ادمین‌ها') {
    await handleAdminsManagementMenu(chatId, config);
    return true;
  }

  if (text === '👥 مدیریت دعوت دوستان') {
    await handleReferralAdminMenu(chatId, config);
    return true;
  }

  if (text === '⚙️ تنظیمات فروشگاه') {
    await handleSettingsMenu(chatId, config);
    return true;
  }

  if (text === '📊 آمار فروشگاه') {
    await handleStats(chatId, config, env);
    return true;
  }

  if (text === '🔙 بازگشت به منوی کاربری') {
    await sendMessage(config.BOT_TOKEN, chatId, '🏠 بازگشت به منوی اصلی.', {
      reply_markup: mainReplyKeyboard(config),
    });
    return true;
  }

  if (text === '🚦 مدیریت کانفیگ کاربران') {
    await handleUserConfigsMenu(chatId, config);
    return true;
  }

  if (text === '📢 پیام همگانی') {
    const adminSession = getSession(`admin_${fromId}`);
    adminSession.step = 'awaiting_broadcast_message';
    adminSession.data = {};
    setSession(`admin_${fromId}`, adminSession);
    const userCount = DB.users.size;
    await sendMessage(
      config.BOT_TOKEN,
      chatId,
      `📢 <b>پیام همگانی</b>\n\n` +
        `👥 تعداد کاربران ثبت‌شده: <b>${userCount}</b> نفر\n\n` +
        'متن پیام همگانی را ارسال کنید (پشتیبانی HTML دارد):\n' +
        'برای لغو دستور /cancel را بفرستید.'
    );
    return true;
  }

  if (text === '📣 تبلیغ در کانال') {
    await handleChannelAdMenu(chatId, config);
    return true;
  }

  return false;
}

export async function handleStats(chatId, config, env) {
  ensurePlansLoaded();
  const orders = [...DB.orders.values()];
  const count = (status) => orders.filter((o) => o.status === status).length;
  const subs = [...DB.subscriptions.values()];
  const activeSubs = subs.filter((s) => s.status === 'active' || s.status === 'on_hold').length;
  const totalWalletBalance = [...DB.users.values()].reduce((sum, u) => sum + (u.walletBalance || 0), 0);
  const pendingWalletRequests = [...DB.walletRequests.values()].filter(
    (r) => r.status === WALLET_REQUEST_STATUS.PENDING
  ).length;

  let text =
    `📊 <b>آمار فروشگاه</b>\n\n` +
    `👥 کاربران: ${DB.users.size}\n` +
    `📦 کل سفارش‌ها: ${DB.orders.size}\n` +
    `⏳ در انتظار: ${count(ORDER_STATUS.PENDING)}\n` +
    `✅ تایید شده: ${count(ORDER_STATUS.CONFIRMED)}\n` +
    `📨 تحویل شده: ${count(ORDER_STATUS.SENT)}\n` +
    `❌ رد شده: ${count(ORDER_STATUS.REJECTED)}\n\n` +
    `🛰 اشتراک‌های ساخته‌شده: ${subs.length}\n` +
    `🟢 اشتراک‌های فعال: ${activeSubs}\n` +
    `🔄 تمدیدها: ${orders.filter((o) => o.kind === ORDER_KIND.RENEW).length}\n\n` +
    `💳 تعداد کارت‌های فعال: ${DB.cards.size}\n` +
    `📶 تعداد بسته‌های فعال: ${DB.plans.length}\n` +
    `🎁 تست کانفیگ (موجود/استفاده‌شده): ${DB.testConfigs.filter((c) => !c.used).length}/${
      DB.testConfigs.filter((c) => c.used).length
    }\n` +
    `💰 مجموع موجودی کیف پول‌ها: ${totalWalletBalance.toLocaleString()} تومان\n` +
    `📋 درخواست‌های شارژ در انتظار: ${pendingWalletRequests}\n` +
    `🔒 عضویت اجباری در کانال: ${DB.forceJoinEnabled ? 'فعال' : 'غیرفعال'}\n` +
    '🗄 دیتابیس: SQLite تلگرام (متصل)';

  const stats = await dbStats(env);
  if (stats) {
    text +=
      `\n\n<b>گزارش دیتابیس</b>\n` +
      `🧾 پرداخت‌های تاییدشده: ${stats.pay_verified}\n` +
      `💵 مجموع مبالغ تاییدشده: ${Number(stats.pay_sum || 0).toLocaleString()} تومان\n` +
      `🚨 خطاهای ثبت‌شده: ${stats.log_errors}`;
  }

  return sendMessage(config.BOT_TOKEN, chatId, text);
}

export async function handleCardsManagementMenu(chatId, config) {
  let text = '💳 <b>مدیریت کارت‌های بانکی</b>\n\n';
  if (DB.cards.size === 0) {
    text += 'در حال حاضر هیچ کارتی ثبت نشده است.\n';
  } else {
    for (const card of DB.cards.values()) {
      text += `🔹 ${card.bankName} | <code>${card.number}</code> | ${card.holder || '-'}\n`;
    }
  }
  text += '\nبرای افزودن یا حذف کارت از دکمه‌های زیر استفاده کنید:';

  return sendMessage(config.BOT_TOKEN, chatId, text, { reply_markup: cardsAdminInlineKeyboard() });
}

export async function handleCardAddStart(callbackQuery, config) {
  const fromId = callbackQuery.from.id;
  const session = getSession(`admin_${fromId}`);
  session.step = 'awaiting_card_bank';
  session.data = {};
  setSession(`admin_${fromId}`, session);
  return sendMessage(config.BOT_TOKEN, callbackQuery.message.chat.id, '🏦 نام بانک را ارسال کنید (مثلاً: بانک ملی):');
}

export async function handleCardDelete(callbackQuery, cardId, config) {
  const found = memGet(DB.cards, Number(cardId));
  if (!found) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ کارت یافت نشد.', true);
  }
  memDelete(DB.cards, Number(cardId));
  await answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '🗑 کارت حذف شد و برای همیشه ذخیره شد.');
  return handleCardsManagementMenu(callbackQuery.message.chat.id, config);
}

export async function handlePlansManagementMenu(chatId, config) {
  ensurePlansLoaded();
  let text = '📦 <b>مدیریت بسته‌های اینترنت</b>\n\n';
  if (DB.plans.length === 0) {
    text += 'در حال حاضر هیچ بسته‌ای ثبت نشده است.\n';
  } else {
    for (const plan of DB.plans) {
      const target = plan.templateId
        ? `قالب ${plan.templateId}`
        : Array.isArray(plan.groupIds) && plan.groupIds.length
          ? `گروه‌های ${plan.groupIds.join('،')}`
          : '⚠️ بدون گروه';
      text += `🔹 ${escapeHtml(plan.title)} | ${plan.gb} گیگ | ${plan.price.toLocaleString()} تومان | ${target}\n`;
    }
  }
  text += '\nبرای ویرایش یا حذف روی دکمه مربوطه بزنید، یا بسته جدید اضافه کنید:';

  return sendMessage(config.BOT_TOKEN, chatId, text, { reply_markup: plansAdminInlineKeyboard() });
}

// قیمت‌گذاری یکجا: قیمت هر بسته = حجم × قیمت هر گیگ؛ گروه‌ها 24 و 25 و بدون قالب
export async function handlePlansBulkPriceStart(callbackQuery, config) {
  const fromId = callbackQuery.from.id;
  const session = getSession(`admin_${fromId}`);
  session.step = 'awaiting_plans_per_gb';
  session.data = {};
  setSession(`admin_${fromId}`, session);
  return sendMessage(
    config.BOT_TOKEN,
    callbackQuery.message.chat.id,
    '💲 <b>قیمت‌گذاری یکجا</b>\n\n' +
      'قیمت هر گیگابایت را به تومان ارسال کنید. مثلاً <code>4000</code> یا <code>3000</code>\n' +
      '(اگر عدد کمتر از ۱۰۰۰ بفرستید، «هزار تومان» حساب می‌شود؛ یعنی <code>4</code> = ۴٬۰۰۰ تومان)\n\n' +
      '⚠️ با این کار برای <b>همه بسته‌ها</b>:\n' +
      '• قیمت = حجم × قیمت هر گیگ\n' +
      `• شناسه گروه‌ها = ${DEFAULT_PLAN_GROUP_IDS.join(' و ')}\n` +
      '• قالب کاربری حذف می‌شود\n' +
      '(بسته‌های نامحدود فقط گروه‌ها/قالبشان تنظیم می‌شود و قیمتشان تغییر نمی‌کند)'
  );
}

export async function handlePlanAddStart(callbackQuery, config) {
  const fromId = callbackQuery.from.id;
  const session = getSession(`admin_${fromId}`);
  session.step = 'awaiting_plan_title';
  session.data = { mode: 'add' };
  setSession(`admin_${fromId}`, session);
  return sendMessage(config.BOT_TOKEN, callbackQuery.message.chat.id, '✏️ عنوان بسته جدید را ارسال کنید (مثلاً: گیگ 5):');
}

export async function handlePlanEditStart(callbackQuery, planId, config) {
  ensurePlansLoaded();
  const plan = DB.plans.find((p) => p.id === planId);
  if (!plan) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ بسته یافت نشد.', true);
  }
  const fromId = callbackQuery.from.id;
  const session = getSession(`admin_${fromId}`);
  session.step = 'awaiting_plan_gb';
  session.data = { mode: 'edit', planId, title: plan.title };
  setSession(`admin_${fromId}`, session);
  return sendMessage(
    config.BOT_TOKEN,
    callbackQuery.message.chat.id,
    `✏️ ویرایش بسته — مقادیر را مرحله‌به‌مرحله می‌پرسم.\n\n` +
      `حجم: ${plan.gb} گیگ | قیمت: ${plan.price.toLocaleString()} تومان\n` +
      `گروه‌ها: ${Array.isArray(plan.groupIds) && plan.groupIds.length ? plan.groupIds.join('،') : '—'}` +
      ` | قالب: ${plan.templateId || '—'}\n\n` +
      `📶 حجم جدید بسته را به گیگابایت ارسال کنید (فقط عدد، ۰ = نامحدود):`
  );
}

export async function handlePlanDelete(callbackQuery, planId, config, env) {
  ensurePlansLoaded();
  const idx = DB.plans.findIndex((p) => p.id === planId);
  if (idx === -1) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ بسته یافت نشد.', true);
  }
  DB.plans.splice(idx, 1);
  await dbDeactivatePlan(env, planId);
  await answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '🗑 بسته حذف شد و برای همیشه ذخیره شد.');
  return handlePlansManagementMenu(callbackQuery.message.chat.id, config);
}

export async function handleTutorialsManagementMenu(chatId, config) {
  let text = '🎓 <b>مدیریت آموزش‌ها</b>\n\n';
  if (DB.tutorials.size === 0) {
    text += 'در حال حاضر هیچ آموزشی ثبت نشده است.\n';
  } else {
    for (const tutorial of DB.tutorials.values()) {
      text += `🔹 ${escapeHtml(tutorial.title)}\n${escapeHtml(tutorial.url)}\n\n`;
    }
  }
  text += 'برای ویرایش یا حذف روی دکمه مربوطه بزنید، یا آموزش جدید اضافه کنید:';

  return sendMessage(config.BOT_TOKEN, chatId, text, { reply_markup: tutorialsAdminInlineKeyboard() });
}

export async function handleTutorialAddStart(callbackQuery, config) {
  const fromId = callbackQuery.from.id;
  const session = getSession(`admin_${fromId}`);
  session.step = 'awaiting_tutorial_title';
  session.data = { mode: 'add' };
  setSession(`admin_${fromId}`, session);
  return sendMessage(
    config.BOT_TOKEN,
    callbackQuery.message.chat.id,
    '✏️ عنوان آموزش جدید را ارسال کنید (مثلاً: آموزش اتصال با v2rayNG):'
  );
}

export async function handleTutorialEditStart(callbackQuery, tutorialId, config) {
  tutorialId = Number(tutorialId);
  const tutorial = memGet(DB.tutorials, tutorialId);
  if (!tutorial) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ آموزش یافت نشد.', true);
  }
  const fromId = callbackQuery.from.id;
  const session = getSession(`admin_${fromId}`);
  session.step = 'awaiting_tutorial_title';
  session.data = { mode: 'edit', tutorialId };
  setSession(`admin_${fromId}`, session);
  return sendMessage(
    config.BOT_TOKEN,
    callbackQuery.message.chat.id,
    `✏️ ویرایش آموزش — مقادیر فعلی:\n` +
      `عنوان: ${escapeHtml(tutorial.title)}\nلینک: ${escapeHtml(tutorial.url)}\n\n` +
      `عنوان جدید را ارسال کنید:`
  );
}

export async function handleTutorialDelete(callbackQuery, tutorialId, config) {
  tutorialId = Number(tutorialId);
  const found = memGet(DB.tutorials, tutorialId);
  if (!found) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ آموزش یافت نشد.', true);
  }
  memDelete(DB.tutorials, tutorialId);
  await answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '🗑 آموزش حذف شد و برای همیشه ذخیره شد.');
  return handleTutorialsManagementMenu(callbackQuery.message.chat.id, config);
}

// نمایش لینک‌های آموزش به مشتری (با زدن دکمه شیشه‌ای زیر پیام تحویل سرویس)
export async function handleTutorialsView(callbackQuery, config) {
  const chatId = callbackQuery.message.chat.id;
  if (DB.tutorials.size === 0) {
    return sendMessage(config.BOT_TOKEN, chatId, '📭 فعلاً آموزشی ثبت نشده است. لطفاً بعداً دوباره بررسی کنید.');
  }
  return sendMessage(config.BOT_TOKEN, chatId, '🎓 <b>آموزش‌های مرتبط:</b>\nبرای مشاهده هر آموزش روی دکمه مربوطه بزنید:', {
    reply_markup: tutorialsViewKeyboard(),
  });
}

export async function handleTestConfigsManagementMenu(chatId, config) {
  const total = DB.testConfigs.length;
  const usedCount = DB.testConfigs.filter((c) => c.used).length;
  const unusedCount = total - usedCount;

  let text = '🎁 <b>مدیریت تست کانفیگ‌ها</b>\n\n';
  text += `📦 ظرفیت کل: ${MAX_TEST_CONFIGS} عدد\n`;
  text += `✅ موجود (آماده ارسال): ${unusedCount}\n`;
  text += `📨 استفاده‌شده (تحویل‌داده‌شده به مشتری): ${usedCount}\n`;
  text += `🧮 مجموع ثبت‌شده: ${total} از ${MAX_TEST_CONFIGS}\n\n`;
  text +=
    'برای افزودن، دکمه «➕ افزودن کانفیگ تست» را بزنید و می‌توانید چند کانفیگ را هر کدام در یک خط جداگانه در یک پیام ارسال کنید (تا سقف ظرفیت باقیمانده).';

  return sendMessage(config.BOT_TOKEN, chatId, text, { reply_markup: testConfigsAdminInlineKeyboard() });
}

export async function handleTestConfigAddStart(callbackQuery, config) {
  const remaining = MAX_TEST_CONFIGS - DB.testConfigs.length;
  if (remaining <= 0) {
    return answerCallbackQuery(
      config.BOT_TOKEN,
      callbackQuery.id,
      `⛔ ظرفیت پر است (حداکثر ${MAX_TEST_CONFIGS} کانفیگ). ابتدا کانفیگ‌های استفاده‌نشده را حذف کنید.`,
      true
    );
  }
  const fromId = callbackQuery.from.id;
  const session = getSession(`admin_${fromId}`);
  session.step = 'awaiting_test_configs_bulk';
  session.data = {};
  setSession(`admin_${fromId}`, session);

  return sendMessage(
    config.BOT_TOKEN,
    callbackQuery.message.chat.id,
    `✏️ کانفیگ‌های تست را ارسال کنید — هر کانفیگ در یک خط جداگانه (می‌توانید همه را در یک پیام بفرستید).\n` +
      `ظرفیت باقیمانده: ${remaining} عدد از ${MAX_TEST_CONFIGS} کل.`
  );
}

export async function handleTestConfigsClearUnused(callbackQuery, config) {
  const before = DB.testConfigs.length;
  DB.testConfigs = DB.testConfigs.filter((c) => c.used);
  const removed = before - DB.testConfigs.length;
  await answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, `🗑 ${removed} کانفیگ استفاده‌نشده حذف شد و ذخیره شد.`);
  return handleTestConfigsManagementMenu(callbackQuery.message.chat.id, config);
}

export async function handleWalletAdminMenu(chatId, config) {
  const pendingCount = [...DB.walletRequests.values()].filter(
    (r) => r.status === WALLET_REQUEST_STATUS.PENDING && !isAtlaspayAwaiting(r)
  ).length;
  const totalWallets = [...DB.users.values()].reduce((sum, u) => sum + (u.walletBalance || 0), 0);

  let text = '💰 <b>مدیریت کیف پول</b>\n\n';
  text += `📋 درخواست‌های شارژ در انتظار: ${pendingCount}\n`;
  text += `🧮 مجموع موجودی کیف پول همه کاربران: ${totalWallets.toLocaleString()} تومان\n`;
  text += `💵 حداقل مبلغ شارژ: ${getWalletMinTopup().toLocaleString()} تومان\n\n`;
  text += 'برای مشاهده و تایید/رد درخواست‌های شارژ یا تغییر دستی موجودی یک کاربر از دکمه‌های زیر استفاده کنید:';

  return sendMessage(config.BOT_TOKEN, chatId, text, { reply_markup: walletAdminInlineKeyboard() });
}

export async function handleWalletAdminPendingList(chatId, config) {
  const pending = [...DB.walletRequests.values()].filter(
    (r) => r.status === WALLET_REQUEST_STATUS.PENDING && !isAtlaspayAwaiting(r)
  );
  if (pending.length === 0) {
    return sendMessage(config.BOT_TOKEN, chatId, '📭 درخواست شارژ در انتظاری وجود ندارد.');
  }
  for (const req of pending.slice(-10)) {
    const extra = { reply_markup: walletRequestAdminKeyboard(req.id, req.status) };
    if (req.receiptFileId) {
      await sendPhoto(config.BOT_TOKEN, chatId, req.receiptFileId, formatWalletRequestMessage(req), extra);
    } else {
      await sendMessage(config.BOT_TOKEN, chatId, formatWalletRequestMessage(req), extra);
    }
  }
}

export async function handleWalletAdjustStart(callbackQuery, config) {
  const fromId = callbackQuery.from.id;
  const session = getSession(`admin_${fromId}`);
  session.step = 'awaiting_wallet_adjust_id';
  session.data = {};
  setSession(`admin_${fromId}`, session);
  return sendMessage(
    config.BOT_TOKEN,
    callbackQuery.message.chat.id,
    '👤 یک پیام از کاربر مورد نظر برای ما «فوروارد» کنید، یا مستقیماً آیدی عددی او را ارسال کنید:'
  );
}

export async function handleAdminsManagementMenu(chatId, config) {
  let text = '👤 <b>مدیریت ادمین‌ها</b>\n\n';
  text += `👑 ادمین اصلی (غیرقابل حذف): <code>${config.ADMIN_USER_ID}</code>\n`;
  if (DB.admins.size > 0) {
    text += '\nادمین‌های اضافه‌شده:\n';
    for (const id of DB.admins) {
      text += `🔹 <code>${id}</code>\n`;
    }
  } else {
    text += '\nادمین اضافه‌ای ثبت نشده است.\n';
  }
  text += '\nبرای افزودن یا حذف ادمین از دکمه‌های زیر استفاده کنید:';

  return sendMessage(config.BOT_TOKEN, chatId, text, { reply_markup: adminsAdminInlineKeyboard() });
}

export async function handleAdminAddStart(callbackQuery, config) {
  const fromId = callbackQuery.from.id;
  const session = getSession(`admin_${fromId}`);
  session.step = 'awaiting_admin_id';
  session.data = {};
  setSession(`admin_${fromId}`, session);
  return sendMessage(
    config.BOT_TOKEN,
    callbackQuery.message.chat.id,
    '👤 یک پیام از کاربر مورد نظر برای ما «فوروارد» کنید، یا مستقیماً آیدی عددی او را ارسال کنید:'
  );
}

export async function handleAdminDelete(callbackQuery, targetId, config) {
  if (targetId === config.ADMIN_USER_ID) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '⛔ ادمین اصلی قابل حذف نیست.', true);
  }
  DB.admins.delete(targetId);
  await answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '🗑 ادمین حذف شد و برای همیشه ذخیره شد.');
  return handleAdminsManagementMenu(callbackQuery.message.chat.id, config);
}

export async function handleSettingsMenu(chatId, config) {
  let text = '⚙️ <b>تنظیمات فروشگاه</b>\n\n';
  for (const field of Object.keys(SETTINGS_FIELDS)) {
    text += `${SETTINGS_FIELDS[field]}: <code>${escapeHtml(config[field])}</code>\n`;
  }
  text += '\nℹ️ توکن ربات (BOT_TOKEN) از اینجا قابل تغییر نیست و فقط در فایل tgcloud/lib/secrets.js عوض می‌شود.';
  text += '\n\nبرای تغییر هر مورد، روی دکمه مربوطه بزنید:';

  return sendMessage(config.BOT_TOKEN, chatId, text, { reply_markup: settingsInlineKeyboard() });
}

// کیبورد انتخاب رنگ برای یک دکمه خاص از منوی اصلی
export function btnStyleKeyboard(config) {
  const rows = Object.keys(BTN_STYLE_TARGETS).map((key) => {
    const current = config[key] || '';
    return BTN_STYLE_CHOICES.map((choice) => ({
      text: `${choice.value === current ? '✅' : choice.emoji} ${choice.label}`,
      callback_data: `btnstyle_set:${key}:${choice.value}`,
      ...(choice.value ? { style: choice.value } : {}),
    }));
  });
  rows.push(backNavRow('settings'));
  return { inline_keyboard: rows };
}

// کیبورد انتخاب رنگ سراسری برای دکمه‌های شیشه‌ای (اینلاین) ربات — یک ردیف
// برای دکمه‌های اصلی و یک ردیف جدا برای دکمه «بازگشت به منوی قبلی»
export function glassStyleKeyboard(config) {
  const rows = Object.keys(GLASS_STYLE_TARGETS).map((key) => {
    const current = config[key] || '';
    return GLASS_BTN_STYLE_CHOICES.map((choice) => ({
      text: `${choice.value === current ? '✅' : choice.emoji} ${choice.label}`,
      callback_data: `glassstyle_set:${key}:${choice.value}`,
      ...(choice.value ? { style: choice.value } : {}),
    }));
  });
  rows.push(backNavRow('settings'));
  return { inline_keyboard: rows };
}

export async function handleGlassStyleMenu(chatId, config) {
  let text =
    '🎨 <b>رنگ دکمه‌های شیشه‌ای (اینلاین)</b>\n\n' +
    'این تنظیم روی همه دکمه‌های شیشه‌ای ربات در همه بخش‌ها (فروشگاه، ادمین، اشتراک‌ها و ...) یکجا اعمال می‌شود؛ دکمه «بازگشت به منوی قبلی» جدا و با رنگ خودش تنظیم می‌شود تا از بقیه دکمه‌ها متمایز باشد.\n' +
    'دکمه‌هایی که از قبل رنگ اختصاصی دارند (مثل دکمه‌های تبلیغ در کانال) تحت تاثیر قرار نمی‌گیرند.\n\n';
  for (const key of Object.keys(GLASS_STYLE_TARGETS)) {
    const target = GLASS_STYLE_TARGETS[key];
    const current = GLASS_BTN_STYLE_CHOICES.find((c) => c.value === (config[key] || '')) || GLASS_BTN_STYLE_CHOICES[0];
    text += `${current.emoji} ${target.title}\n`;
  }
  text += '\nبرای تغییر هر رنگ، از ردیف مربوطه در پایین انتخاب کنید:';
  return sendMessage(config.BOT_TOKEN, chatId, text, { reply_markup: glassStyleKeyboard(config) });
}

export async function handleGlassStyleSet(callbackQuery, key, style, config, env) {
  if (!GLASS_STYLE_TARGETS[key]) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ مورد نامعتبر است.', true);
  }
  const validStyle = GLASS_BTN_STYLE_CHOICES.some((c) => c.value === style) ? style : '';
  if (!DB.settings) DB.settings = {};
  DB.settings[key] = validStyle;
  await saveState(env);
  await answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '✅ رنگ دکمه‌های شیشه‌ای بروزرسانی شد.');
  return handleGlassStyleMenu(callbackQuery.message.chat.id, getConfig(env));
}

export async function handleBtnStyleMenu(chatId, config) {
  let text = '🎨 <b>رنگ دکمه‌های منوی اصلی</b>\n\n';
  text += 'از نسخه Bot API 9.4 تلگرام، دکمه‌های ربات فقط می‌توانند یکی از سه رنگ ثابت را بگیرند: 🔵 آبی، 🟢 سبز، 🔴 قرمز (یا ⚪ بدون رنگ خاص/پیش‌فرض کلاینت). رنگ دلخواه (HEX) روی دکمه‌های واقعی چت پشتیبانی نمی‌شود.\n\n';
  for (const key of Object.keys(BTN_STYLE_TARGETS)) {
    const target = BTN_STYLE_TARGETS[key];
    const current = BTN_STYLE_CHOICES.find((c) => c.value === (config[key] || '')) || BTN_STYLE_CHOICES[0];
    text += `${current.emoji} ${target.title} («${escapeHtml(config[target.labelKey])}»)\n`;
  }
  text += '\nبرای تغییر رنگ هر دکمه، از ردیف مربوطه در پایین انتخاب کنید:';
  return sendMessage(config.BOT_TOKEN, chatId, text, { reply_markup: btnStyleKeyboard(config) });
}

export async function handleBtnStyleSet(callbackQuery, key, style, config, env) {
  if (!BTN_STYLE_TARGETS[key]) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ دکمه نامعتبر است.', true);
  }
  const validStyle = BTN_STYLE_CHOICES.some((c) => c.value === style) ? style : '';
  if (!DB.settings) DB.settings = {};
  DB.settings[key] = validStyle;
  await saveState(env);
  await answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '✅ رنگ بروزرسانی شد.');
  return handleBtnStyleMenu(callbackQuery.message.chat.id, getConfig(env));
}

export async function handleSettingEditStart(callbackQuery, field, config) {
  if (!SETTINGS_FIELDS[field]) {
    return answerCallbackQuery(config.BOT_TOKEN, callbackQuery.id, '❌ فیلد نامعتبر است.', true);
  }
  const fromId = callbackQuery.from.id;
  const session = getSession(`admin_${fromId}`);
  session.step = 'awaiting_setting_value';
  session.data = { field };
  setSession(`admin_${fromId}`, session);

  const channelHint = field === 'CHANNEL_ID'
    ? '\n\nℹ️ اگر کانال شما <b>عمومی</b> است، کافی است @username یا لینک آن را بفرستید.\n' +
      'اگر کانال شما <b>خصوصی</b> است (لینک آن با t.me/+ شروع می‌شود)، آن لینک را مستقیماً '
      + 'نمی‌توان استفاده کرد؛ در عوض <b>یک پست از همان کانال را همین‌جا برای ربات فوروارد کنید</b> '
      + 'تا آیدی عددی صحیح خودکار ذخیره شود.'
    : '';
  const lowVolumeHint = field === 'LOW_VOLUME_ALERT_TEXT'
    ? '\n\nℹ️ متغیرهای قابل استفاده (خودکار جایگزین و پررنگ می‌شوند):\n' +
      '<code>{plan}</code> نام اشتراک\n<code>{total}</code> حجم کل\n' +
      '<code>{used}</code> مصرف‌شده\n<code>{remaining}</code> باقی‌مانده\n\n' +
      'برای برگشت به متن اصلی، کلمه <code>default</code> را بفرستید.'
    : '';
  return sendMessage(
    config.BOT_TOKEN,
    callbackQuery.message.chat.id,
    `✏️ مقدار جدید برای «${SETTINGS_FIELDS[field]}» را ارسال کنید:\n\nمقدار فعلی: <code>${escapeHtml(config[field])}</code>${channelHint}${lowVolumeHint}`
  );
}

export async function handleWalletMinTopupEditStart(callbackQuery, config) {
  const fromId = callbackQuery.from.id;
  const session = getSession(`admin_${fromId}`);
  session.step = 'awaiting_wallet_min_topup';
  session.data = {};
  setSession(`admin_${fromId}`, session);

  return sendMessage(
    config.BOT_TOKEN,
    callbackQuery.message.chat.id,
    '✏️ حداقل مبلغ شارژ کیف پول را به تومان ارسال کنید (فقط عدد، حداقل ۱٬۰۰۰):\n\n' +
      `مقدار فعلی: <code>${getWalletMinTopup()}</code>\n\n` +
      'ℹ️ این حداقل برای همه روش‌های شارژ (کارت‌به‌کارت و اطلس‌پی) اعمال می‌شود. ' +
      'اطلس‌پی ممکن است خودش هم حداقل مبلغ داشته باشد.'
  );
}

export async function handleReferralCommissionPercentEditStart(callbackQuery, config) {
  const fromId = callbackQuery.from.id;
  const session = getSession(`admin_${fromId}`);
  session.step = 'awaiting_referral_commission_percent';
  session.data = {};
  setSession(`admin_${fromId}`, session);

  return sendMessage(
    config.BOT_TOKEN,
    callbackQuery.message.chat.id,
    `✏️ درصد پورسانت هر خرید را ارسال کنید (فقط عدد بین ۱ تا ۱۰۰):\n\nمقدار فعلی: <code>${config.REFERRAL_COMMISSION_PERCENT}</code>`
  );
}

// 📦 اشتراک من — لیست اشتراک‌های ساخته‌شده روی پاسارگارد
export async function handleMySubscriptions(chatId, userId, config) {
  const subs = listUserSubscriptions(userId);
  if (subs.length === 0) {
    return sendMessage(
      config.BOT_TOKEN,
      chatId,
      '📭 هنوز اشتراکی ندارید.\n\nبرای خرید، دکمه «🛒 خرید اشتراک» را بزنید.',
      { reply_markup: mainReplyKeyboard(config) }
    );
  }

  let text = `📦 <b>اشتراک‌های شما</b> (${subs.length} مورد)\n\n`;
  for (const sub of subs.slice(0, 10)) {
    const expirePart = sub.expireAt ? ` | انقضا: ${formatDate(sub.expireAt)}` : '';
    text +=
      `${PG_STATUS_LABEL[sub.status] || sub.status} | <b>${escapeHtml(sub.planTitle || '-')}</b>\n` +
      `   حجم: ${formatBytes(sub.dataLimitBytes)}${expirePart}\n` +
      `   <code>${escapeHtml(sub.subscriptionUrl || '—')}</code>\n\n`;
  }
  text += 'برای دیدن مصرف لحظه‌ای، روی دکمه اشتراک مورد نظر بزنید:';

  return sendMessage(config.BOT_TOKEN, chatId, text, {
    reply_markup: subscriptionsKeyboard(subs, 'substatus'),
  });
}

// 🔄 تمدید اشتراک — طبق سیاست انتخاب‌شده، یک اشتراک تازه ساخته می‌شود
export async function handleRenewMenu(chatId, userId, config) {
  const subs = listUserSubscriptions(userId);
  if (subs.length === 0) {
    return sendMessage(
      config.BOT_TOKEN,
      chatId,
      '📭 اشتراکی برای تمدید ندارید. ابتدا از «🛒 خرید اشتراک» یک بسته تهیه کنید.',
      { reply_markup: mainReplyKeyboard(config) }
    );
  }
  return sendMessage(
    config.BOT_TOKEN,
    chatId,
    '🔄 <b>تمدید اشتراک</b>\n\n' +
      'کدام اشتراک را می‌خواهید تمدید کنید؟\n' +
      'ℹ️ با تمدید، یک اشتراک تازه با لینک جدید برای شما ساخته می‌شود و اشتراک قبلی تا پایان اعتبارش کار می‌کند.',
    { reply_markup: subscriptionsKeyboard(subs, 'renew') }
  );
}

// 🛒 خرید اشتراک — شروع فرآیند خرید جدید
export async function handleBuyStart(chatId, config) {
  const session = getSession(chatId);
  session.step = 'idle';
  session.data = { kind: ORDER_KIND.NEW };
  setSession(chatId, session);
  return sendMessage(config.BOT_TOKEN, chatId, config.PRODUCT_SELECT_TEXT, {
    reply_markup: productsKeyboard(config),
  });
}

export async function handlePasarguardMenu(chatId, config, env) {
  const authMode = config.PG_API_TOKEN
    ? '🔑 API Key (X-Api-Key)'
    : config.PG_USERNAME && config.PG_PASSWORD
      ? '👤 نام کاربری/رمز (JWT از /api/admin/token)'
      : '❌ تنظیم نشده';

  ensurePlansLoaded();
  const plansWithoutTarget = DB.plans.filter(
    (p) => !p.templateId && (!Array.isArray(p.groupIds) || p.groupIds.length === 0)
  ).length;

  let text = '🛰 <b>اتصال پاسارگارد</b>\n\n';
  text += `🌐 آدرس پنل: <code>${escapeHtml(config.PG_BASE_URL || '— تنظیم نشده —')}</code>\n`;
  text += `🔐 روش احراز هویت: ${authMode}\n`;
  text += `🔗 پایه لینک اشتراک: <code>${escapeHtml(config.PG_SUB_BASE_URL || '—')}</code>\n`;
  text += `🧩 پیشوند نام کاربری: <code>${escapeHtml(config.PG_USERNAME_PREFIX)}</code>\n`;
  text += '🗄 دیتابیس: ✅ SQLite تلگرام\n';
  text += `📦 تعداد اشتراک‌های ثبت‌شده: ${DB.subscriptions.size}\n\n`;

  // اگر چیزی ست نشده، دقیقاً بگو کدام متغیر
  const missing = pgMissingConfig(config);
  if (missing.length) {
    text +=
      `❌ <b>این مقدارها ست نشده‌اند:</b>\n` +
      missing.map((name) => `• <code>${escapeHtml(name)}</code>`).join('\n') +
      '\n\nراه ست کردن: این مقدارها را در فایل <code>tgcloud/lib/secrets.js</code> بنویسید و دوباره <code>npx tgcloud push</code> بزنید.\n' +
      '⚠️ نام متغیرها باید مو‌به‌مو همین باشد (حساس به حروف بزرگ/کوچک) و مقدار داخل کوتیشن گذاشته نشود.\n\n';
  }

  for (const warning of pgConfigWarnings(config)) {
    text += `⚠️ ${escapeHtml(warning)}\n\n`;
  }

  if (plansWithoutTarget > 0) {
    text +=
      `⚠️ <b>${plansWithoutTarget}</b> بسته نه گروه (group_ids) دارد و نه قالب (template).\n` +
      'کاربری که بدون گروه ساخته شود هیچ اینباند/کانفیگی نخواهد داشت. از «📋 دریافت لیست گروه‌ها» ' +
      'شناسه‌ها را بگیرید و در «📦 مدیریت بسته‌ها» ست کنید.\n\n';
  }

  text += 'برای بررسی اتصال از دکمه‌های زیر استفاده کنید:';
  await sendMessage(config.BOT_TOKEN, chatId, text, { reply_markup: pasarguardAdminKeyboard() });
  return handlePgRecentErrors(chatId, config, env);
}

// آخرین خطاهای ثبت‌شده در D1 — برای عیب‌یابی سریع ساخت اشتراک
export async function handlePgRecentErrors(chatId, config, env) {
  if (!hasD1(env)) return null;
  const rows = await d1All(
    env,
    `SELECT level, scope, message, created_at FROM logs
     WHERE level IN ('error', 'warn') ORDER BY created_at DESC LIMIT 5`
  );
  if (!rows.length) return null;
  let text = '🧾 <b>آخرین خطاهای ثبت‌شده</b>\n\n';
  for (const row of rows) {
    const when = formatDate(Number(row.created_at) * 1000);
    text += `${row.level === 'error' ? '🔴' : '🟠'} [${escapeHtml(String(row.scope || '-'))}] ${escapeHtml(
      String(row.message || '')
    )}\n<i>${when}</i>\n\n`;
  }
  return sendMessage(config.BOT_TOKEN, chatId, text);
}
