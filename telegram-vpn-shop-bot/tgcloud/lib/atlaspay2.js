// tgcloud/lib/atlaspay2.js — ported from the Cloudflare Worker version of the bot.
import { DB, ORDER_STATUS, PAYMENT_STATUS, SHARED, WALLET_REQUEST_STATUS, addWalletBalance, dbLog, dbSaveOrder, dbSavePayment, dbSyncUserWallet, dbUpsertUser, editMessageText, getSession, isAdmin, memGet, memSet, newId, notifyAdmins, resetSession, saveState, sendMessage } from './core.js';
import { paymentResult } from './payments.js';
import { ATLASPAY_MIN_RECHECK_MS, ATLASPAY_POLL_BATCH, ATLASPAY_POLL_INTERVAL_MS, ATLASPAY_POLL_MAX_AGE_MS, AtlasPayError, atlasLocks, atlaspayCheckOrder, atlaspayConfigured, atlaspayCustomerKeyboard, atlaspayFetch, atlaspayProvider, escapeHtml } from './atlaspay.js';
import { formatAdminOrderMessage, formatWalletRequestMessage } from './format.js';
import { adminOrderKeyboard, isAtlaspayAwaiting, walletRequestAdminKeyboard, walletTopupCardsKeyboard } from './keyboards.js';
import { provisionOrder } from './delivery.js';

// رکورد پرداخت را در KV و D1 ثبت می‌کند
// paymentId ثابت (مثل pay_card_12) باعث می‌شود تایید بعدی همان رکورد را آپدیت کند
// و رکورد تکراری ساخته نشود (ایندکس یکتا روی provider+reference).
export async function recordPayment(env, order, provider, verification, paymentId = null) {
  const payment = {
    id: paymentId || newId('pay'),
    orderId: order.id,
    userId: order.userId,
    provider: provider.id,
    amount: verification && verification.amount ? verification.amount : order.price,
    currency: 'IRT',
    status: verification && verification.ok ? PAYMENT_STATUS.VERIFIED : PAYMENT_STATUS.PENDING,
    reference: (verification && verification.reference) || null,
    raw: (verification && verification.raw) || {},
    verifiedAt: verification && verification.ok ? Date.now() : null,
    createdAt: Date.now(),
  };
  memSet(DB.payments, payment.id, payment);
  await dbSavePayment(env, payment);
  return payment;
}

export function findAtlaspayEntity(kind, id) {
  const numeric = Number(id);
  if (kind === 'o') return memGet(DB.orders, numeric) || memGet(DB.orders, String(id)) || null;
  if (kind === 'w') return memGet(DB.walletRequests, numeric) || memGet(DB.walletRequests, String(id)) || null;
  return null;
}

// خطای فنی را فقط برای ادمین گزارش می‌کند (حداکثر یک‌بار در ساعت برای هر پیام)
export async function atlaspayReportFailure(env, config, where, message) {
  const msg = String(message || 'خطای نامشخص');
  try {
    await dbLog(env, 'error', 'atlaspay', `${where}: ${msg}`, {}, {});
    await notifyAdmins(env, config, {
      text: `⚠️ <b>خطای اطلس‌پی</b> (${escapeHtml(where)})\n${escapeHtml(msg)}`,
      orderId: `atlas-err:${msg.slice(0, 60)}:${Math.floor(Date.now() / 3600000)}`,
    });
  } catch (err) {
    console.error('atlaspayReportFailure failed:', err);
  }
}

export const ATLASPAY_CUSTOMER_START_ERROR =
  'ساخت سفارش پرداخت ممکن نشد. لطفاً چند لحظه بعد دوباره تلاش کنید یا روش پرداخت دیگری انتخاب کنید.';

// ---------- پرداخت کامل ----------
export async function atlaspayHandlePaid(env, config, kind, entity, check) {
  const atlas = entity.atlaspay;
  atlas.done = true;
  atlas.paidAt = Date.now();
  atlas.actualReceivedAmountToman = check.actualReceivedAmountToman;

  const raw = {
    method: 'atlaspay',
    status: check.status,
    trackingCode: atlas.trackingCode,
    totalAmountToman: atlas.totalAmountToman,
    actualReceivedAmountToman: check.actualReceivedAmountToman,
  };

  // ----- شارژ کیف پول: واریز خودکار مبلغ درخواستی -----
  if (kind === 'w') {
    const req = entity;
    req.status = WALLET_REQUEST_STATUS.APPROVED;
    memSet(DB.walletRequests, req.id, req);
    const newBalance = addWalletBalance(req.userId, req.amount);
    await dbSyncUserWallet(env, req.userId, newBalance);

    const payment = {
      id: `pay_${atlaspayProvider.id}_w${req.id}`,
      orderId: null,
      userId: req.userId,
      provider: atlaspayProvider.id,
      amount: req.amount,
      currency: 'IRT',
      status: PAYMENT_STATUS.VERIFIED,
      reference: String(atlas.orderId),
      raw,
      verifiedAt: Date.now(),
      createdAt: req.createdAt || Date.now(),
    };
    memSet(DB.payments, payment.id, payment);
    await dbSavePayment(env, payment);

    await sendMessage(
      config.BOT_TOKEN,
      req.chatId,
      `✅ پرداخت شما تایید و کیف پول‌تان به مبلغ ${req.amount.toLocaleString()} تومان شارژ شد.\n` +
        `موجودی جدید: <b>${newBalance.toLocaleString()} تومان</b>`
    );
    await notifyAdmins(env, config, {
      text: `✅ <b>شارژ خودکار کیف پول (اطلس‌پی)</b>\n\n${formatWalletRequestMessage(req)}`,
      orderId: `atlas-wallet:${req.id}`,
    });
    return;
  }

  // ----- سفارش اشتراک: تایید ← ساخت اشتراک روی پاسارگارد ← ارسال به مشتری -----
  const order = entity;
  order.status = ORDER_STATUS.CONFIRMED;
  order.paidVia = atlaspayProvider.id;
  order.updatedAt = Date.now();
  memSet(DB.orders, order.id, order);

  const payment = await recordPayment(
    env,
    order,
    atlaspayProvider,
    paymentResult({
      ok: true,
      reference: String(atlas.orderId),
      amount: Math.round(Number(order.price) || 0),
      raw,
    }),
    `pay_${atlaspayProvider.id}_${order.id}`
  );
  order.paymentId = payment.id;
  memSet(DB.orders, order.id, order);
  await dbSaveOrder(env, order);
  await dbLog(env, 'info', 'payment', 'atlaspay order confirmed', { trackingCode: atlas.trackingCode }, {
    telegramId: order.userId,
    orderId: order.id,
  });

  await notifyAdmins(env, config, {
    text: formatAdminOrderMessage(order),
    replyMarkup: adminOrderKeyboard(order.id, order.status),
    orderId: order.id,
  });
  await sendMessage(
    config.BOT_TOKEN,
    order.chatId,
    `✅ پرداخت سفارش <b>#${order.id}</b> تایید شد.\n⏳ در حال ساخت اشتراک روی سرور…`
  );
  await provisionOrder(env, config, order, { notifyChatId: order.chatId });
}

// ---------- کسری واریز: هیچ‌چیز خودکار تحویل داده نمی‌شود ----------
export async function atlaspayHandleUnderpaid(env, config, kind, entity, check) {
  const atlas = entity.atlaspay;
  if (atlas.manual) return;
  atlas.manual = true;
  atlas.actualReceivedAmountToman = check.actualReceivedAmountToman;

  const expected = kind === 'o' ? Number(entity.price) || 0 : Number(entity.amount) || 0;
  const actualText =
    check.actualReceivedAmountToman === null ? '—' : `${check.actualReceivedAmountToman.toLocaleString()} تومان`;
  const header =
    '⚠️ <b>پرداخت اطلس‌پی با «کسری واریز» تایید شد — نیاز به بررسی دستی</b>\n' +
    `💵 مبلغ ${kind === 'o' ? 'سفارش' : 'درخواستی'}: ${expected.toLocaleString()} تومان\n` +
    `💰 مبلغ واقعی دریافت‌شده: ${actualText}\n` +
    'با «تایید»، سفارش/شارژ به‌طور کامل اعمال می‌شود؛ با «رد»، چیزی تحویل داده نمی‌شود.\n\n';

  const userText =
    `⚠️ مبلغ واریزی شما کمتر از مبلغ ${kind === 'o' ? `سفارش #${entity.id}` : `درخواست شارژ #${entity.id}`} بود.\n` +
    `موضوع برای بررسی به مدیر ارجاع شد؛ لطفاً با پشتیبانی در تماس باشید: @${config.SUPPORT_USERNAME}`;

  if (kind === 'o') {
    entity.note = 'atlaspay_underpaid';
    entity.updatedAt = Date.now();
    memSet(DB.orders, entity.id, entity);
    await dbSaveOrder(env, entity);
    await notifyAdmins(env, config, {
      text: header + formatAdminOrderMessage(entity),
      replyMarkup: adminOrderKeyboard(entity.id, entity.status),
      orderId: `atlas-under:o:${entity.id}`,
    });
  } else {
    memSet(DB.walletRequests, entity.id, entity);
    await notifyAdmins(env, config, {
      text: header + formatWalletRequestMessage(entity),
      replyMarkup: walletRequestAdminKeyboard(entity.id, entity.status),
      orderId: `atlas-under:w:${entity.id}`,
    });
  }
  await sendMessage(config.BOT_TOKEN, entity.chatId, userText);
}

// ---------- منقضی / رد / لغو ----------
export async function atlaspayHandleDead(env, config, kind, entity, check) {
  const atlas = entity.atlaspay;
  atlas.done = true;
  atlas.finalStatus = check.status;

  if (kind === 'o') {
    entity.status = ORDER_STATUS.REJECTED;
    entity.note = `atlaspay_${check.status}`;
    entity.updatedAt = Date.now();
    memSet(DB.orders, entity.id, entity);
    await dbSaveOrder(env, entity);
  } else {
    entity.status = WALLET_REQUEST_STATUS.REJECTED;
    memSet(DB.walletRequests, entity.id, entity);
  }

  const label = kind === 'o' ? `سفارش #${entity.id}` : `درخواست شارژ #${entity.id}`;
  let text;
  if (check.status === 'expired') {
    text =
      `⏰ مهلت پرداخت ${label} بدون واریز به پایان رسید.\n` +
      'اگر پرداخت نکرده‌اید، لطفاً دوباره از ابتدا اقدام کنید. ' +
      `اگر واریز کرده‌اید، با پشتیبانی در تماس باشید: @${config.SUPPORT_USERNAME}`;
  } else if (check.status === 'cancelled') {
    text = `🚫 ${label} لغو شد.`;
  } else {
    text = `❌ پرداخت ${label} رد شد.\nبرای اطلاعات بیشتر با پشتیبانی در تماس باشید: @${config.SUPPORT_USERNAME}`;
  }
  await sendMessage(config.BOT_TOKEN, entity.chatId, text);
}

/**
 * استعلام و پردازش یک پرداخت اطلس‌پی (idempotent و ضد تحویل تکراری).
 * @returns {Promise<{state: string, status?: string, error?: string}>}
 */
export async function atlaspayProcess(env, config, kind, entity, opts = {}) {
  const atlas = entity && entity.atlaspay;
  if (!atlas) return { state: 'none' };
  if (atlas.done) return { state: 'done' };
  if (entity.status !== ORDER_STATUS.PENDING) return { state: 'skipped' }; // ادمین دستی رسیدگی کرده

  const lockKey = `${kind}:${entity.id}`;
  if (atlasLocks.has(lockKey)) return { state: 'busy' };
  atlasLocks.add(lockKey);
  try {
    atlas.lastCheckedAt = Date.now();
    let check;
    try {
      check = await atlaspayCheckOrder(config, atlas, { verify: Boolean(opts.verify) });
    } catch (err) {
      const msg = err instanceof AtlasPayError ? err.message : 'خطای نامشخص';
      await dbLog(env, 'warn', 'atlaspay', `check failed: ${msg}`, { kind, id: entity.id }, {
        telegramId: entity.userId,
      });
      return { state: 'error', error: msg };
    }

    if (check.state === 'paid') await atlaspayHandlePaid(env, config, kind, entity, check);
    else if (check.state === 'underpaid') await atlaspayHandleUnderpaid(env, config, kind, entity, check);
    else if (check.state === 'dead') await atlaspayHandleDead(env, config, kind, entity, check);
    else if (check.state === 'mismatch') {
      await atlaspayReportFailure(env, config, `${kind}:${entity.id}`, 'پاسخ اطلس‌پی با شناسه سفارش ما نمی‌خواند (merchantOrderRef).');
    }
    return check;
  } finally {
    atlasLocks.delete(lockKey);
  }
}

// ---------- Polling (Cron، یا بعد از هر پیام کاربران با فاصله زمانی) ----------
export async function pollAtlaspayOrders(env, config, { force = false } = {}) {
  if (!atlaspayConfigured(config)) return { checked: 0 };
  const now = Date.now();
  if (!force && now - SHARED.lastAtlasPollAt < ATLASPAY_POLL_INTERVAL_MS) return { checked: 0, throttled: true };
  SHARED.lastAtlasPollAt = now;

  const due = (entity, createdAt) =>
    isAtlaspayAwaiting(entity) &&
    entity.status === ORDER_STATUS.PENDING &&
    now - (createdAt || 0) < ATLASPAY_POLL_MAX_AGE_MS &&
    now - (entity.atlaspay.lastCheckedAt || 0) >= ATLASPAY_MIN_RECHECK_MS;

  const items = [];
  for (const order of DB.orders.values()) {
    if (order && order.paidVia === atlaspayProvider.id && due(order, order.createdAt)) {
      items.push({ kind: 'o', entity: order });
    }
  }
  for (const req of DB.walletRequests.values()) {
    if (req && req.via === atlaspayProvider.id && due(req, req.createdAt)) {
      items.push({ kind: 'w', entity: req });
    }
  }
  if (items.length === 0) return { checked: 0 };

  items.sort((a, b) => (a.entity.atlaspay.lastCheckedAt || 0) - (b.entity.atlaspay.lastCheckedAt || 0));
  const batch = items.slice(0, ATLASPAY_POLL_BATCH);

  const results = await Promise.allSettled(
    batch.map(({ kind, entity }) => atlaspayProcess(env, config, kind, entity))
  );
  let changed = false;
  for (const r of results) {
    if (r.status === 'rejected') {
      console.error('atlaspay poll error:', r.reason);
      changed = true; // ممکن است نیمه‌کاره تغییر کرده باشد؛ ذخیره می‌کنیم
    } else if (r.value && ['paid', 'underpaid', 'dead'].includes(r.value.state)) {
      changed = true;
    }
  }
  if (changed) await saveState(env);
  return { checked: batch.length, changed };
}

// ---------- ساخت پرداخت اطلس‌پی برای شارژ کیف پول ----------
export async function handleWalletAtlasPay(callbackQuery, config, env) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const from = callbackQuery.from;

  if (!atlaspayConfigured(config)) {
    return editMessageText(config.BOT_TOKEN, chatId, messageId, '⚠️ پرداخت آنلاین (اطلس‌پی) در حال حاضر فعال نیست.', {
      reply_markup: walletTopupCardsKeyboard(config),
    });
  }
  const session = getSession(chatId);
  const amount = Math.round(Number(session.data && session.data.amount) || 0);
  if (!(amount > 0)) {
    return sendMessage(config.BOT_TOKEN, chatId, '⚠️ ابتدا مبلغ شارژ را وارد کنید.');
  }

  const req = {
    id: SHARED.walletReqSeq++,
    userId: from.id,
    chatId,
    username: from.username || null,
    customerName: `${from.first_name || ''} ${from.last_name || ''}`.trim(),
    amount,
    cardId: null,
    cardLabel: '⚡ پرداخت آنلاین (اطلس‌پی)',
    receiptFileId: null,
    via: atlaspayProvider.id,
    status: WALLET_REQUEST_STATUS.PENDING,
    createdAt: Date.now(),
    atlaspay: null,
  };

  const started = await atlaspayProvider.start({
    env,
    config,
    order: { id: req.id, userId: from.id, price: amount },
    refPrefix: 'bot-wallet',
    params: {},
  });
  if (!started || started.error || !started.meta) {
    await atlaspayReportFailure(env, config, `wallet-topup user ${from.id}`, (started && started.error) || 'start failed');
    return editMessageText(config.BOT_TOKEN, chatId, messageId, `⚠️ ${ATLASPAY_CUSTOMER_START_ERROR}`, {
      reply_markup: walletTopupCardsKeyboard(config),
    });
  }

  req.atlaspay = started.meta;
  memSet(DB.walletRequests, req.id, req);
  await dbUpsertUser(env, from);
  resetSession(chatId);

  return editMessageText(config.BOT_TOKEN, chatId, messageId, started.instructions, {
    reply_markup: atlaspayCustomerKeyboard(started.meta, 'w', req.id),
  });
}

// ---------- دکمه‌های «بررسی وضعیت» و «لغو» ----------
export async function handleAtlaspayButton(callbackQuery, data, config, env) {
  const [, action, kind, id] = String(data).split(':');
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const entity = findAtlaspayEntity(kind, id);

  if (!entity || !entity.atlaspay) {
    return sendMessage(config.BOT_TOKEN, chatId, '❌ این پرداخت دیگر معتبر نیست.');
  }
  if (String(entity.userId) !== String(callbackQuery.from.id) && !isAdmin(callbackQuery.from.id, config)) {
    return sendMessage(config.BOT_TOKEN, chatId, '⛔ این پرداخت متعلق به شما نیست.');
  }

  const atlas = entity.atlaspay;
  const label = kind === 'o' ? `سفارش #${entity.id}` : `درخواست شارژ #${entity.id}`;

  // پرداخت قبلاً به نتیجه رسیده است
  if (atlas.done || entity.status !== ORDER_STATUS.PENDING) {
    const ok = kind === 'o'
      ? [ORDER_STATUS.CONFIRMED, ORDER_STATUS.SENT].includes(entity.status)
      : entity.status === WALLET_REQUEST_STATUS.APPROVED;
    return sendMessage(
      config.BOT_TOKEN,
      chatId,
      ok ? `✅ پرداخت ${label} قبلاً تایید شده است.` : `ℹ️ ${label} دیگر در انتظار پرداخت نیست.`
    );
  }
  if (atlas.manual) {
    return sendMessage(
      config.BOT_TOKEN,
      chatId,
      `⚠️ ${label} با کسری واریز ثبت شده و در حال بررسی توسط مدیر است: @${config.SUPPORT_USERNAME}`
    );
  }

  // ----- بررسی وضعیت -----
  if (action === 'check') {
    if (Date.now() - (atlas.lastCheckedAt || 0) < 3000) {
      return sendMessage(config.BOT_TOKEN, chatId, '⏳ لطفاً چند ثانیه بعد دوباره امتحان کنید.');
    }
    const result = await atlaspayProcess(env, config, kind, entity, { verify: true });
    if (result.state === 'pending') {
      const text =
        result.status === 'admin_review' || result.status === 'underpaid_review'
          ? `🔎 رسید ${label} دریافت شد و در حال بررسی است. پس از تایید، خودکار به شما اطلاع می‌دهیم.`
          : `⏳ هنوز پرداختی برای ${label} ثبت نشده است.\nپس از واریز دقیقِ مبلغ، چند ثانیه صبر کنید و دوباره دکمه را بزنید.`;
      return sendMessage(config.BOT_TOKEN, chatId, text);
    }
    if (result.state === 'busy') {
      return sendMessage(config.BOT_TOKEN, chatId, '⏳ پرداخت شما در حال پردازش است…');
    }
    if (result.state === 'error') {
      return sendMessage(config.BOT_TOKEN, chatId, '⚠️ بررسی وضعیت الان ممکن نشد. لطفاً کمی بعد دوباره تلاش کنید.');
    }
    return; // paid / underpaid / dead: پیام مناسب داخل پردازش ارسال شده است
  }

  // ----- لغو -----
  if (action === 'cancel') {
    try {
      const res = await atlaspayFetch(config, 'POST', `/orders/${atlas.orderId}/cancel`);
      if (res.success === false) throw new AtlasPayError(String(res.message || 'قابل لغو نیست'), 400, res);
    } catch (err) {
      const apiMsg = err && err.data && err.data.message ? String(err.data.message) : err.message;
      return sendMessage(config.BOT_TOKEN, chatId, `⚠️ لغو انجام نشد:\n${escapeHtml(apiMsg)}`);
    }
    atlas.done = true;
    atlas.finalStatus = 'cancelled';
    if (kind === 'o') {
      entity.status = ORDER_STATUS.REJECTED;
      entity.note = 'atlaspay_cancelled_by_user';
      entity.updatedAt = Date.now();
      memSet(DB.orders, entity.id, entity);
      await dbSaveOrder(env, entity);
    } else {
      entity.status = WALLET_REQUEST_STATUS.REJECTED;
      memSet(DB.walletRequests, entity.id, entity);
    }
    return editMessageText(config.BOT_TOKEN, chatId, messageId, `🚫 ${label} لغو شد.`);
  }
}
