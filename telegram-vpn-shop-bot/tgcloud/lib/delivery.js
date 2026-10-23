// tgcloud/lib/delivery.js — ported from the Cloudflare Worker version of the bot.
import { DB, DEFAULTS, FINISHED_SUB_DELETE_AFTER_MS, FINISHED_SUB_SCAN_BATCH, GIGABYTE, LOW_VOLUME_ALERT_BYTES, LOW_VOLUME_KV_KEY, LOW_VOLUME_SCAN_BATCH, LOW_VOLUME_SCAN_INTERVAL_MS, ORDER_KIND, ORDER_STATUS, PG_STATUS_LABEL, SHARED, SUB_STATUS, addWalletBalance, dbLog, dbSaveOrder, dbSaveSubscription, dbSyncPlan, dbSyncUserWallet, dbUpsertUser, ensurePlansLoaded, memGet, memSet, newId, notifyAdmins, sendMessage } from './core.js';
import { PgError, normalizePgUser, pgConfigured, pgDeleteUser, pgErrorHint, pgGetUser, pgProvision } from './pasarguard.js';
import { escapeHtml } from './atlaspay.js';
import { adminOrderKeyboard, formatBytes, formatDate, isLowVolumeAlertEnabled, mainReplyKeyboard } from './keyboards.js';

export function daysLeft(ms) {
  if (!ms) return null;
  return Math.ceil((ms - Date.now()) / 86400000);
}

// بسته مرتبط با سفارش؛ اگر ادمین بسته را حذف کرده باشد از snapshot خود سفارش
export function resolveOrderPlan(order) {
  if (order && order.planSnapshot) return order.planSnapshot;
  ensurePlansLoaded();
  const found = DB.plans.find((p) => p.id === (order && order.planId));
  if (found) return found;
  return null;
}

// شماره ترتیبی اشتراک برای ساخت نام کاربری یکتا روی پنل
export function nextSubSeq(userId) {
  const idStr = String(userId);
  let max = 0;
  for (const sub of DB.subscriptions.values()) {
    if (String(sub.userId) === idStr) max = Math.max(max, Number(sub.seq) || 0);
  }
  return max + 1;
}

// متن پیام تحویل اشتراک به مشتری
export function formatSubscriptionMessage(config, sub, plan) {
  const lines = [
    '🎉 <b>اشتراک شما آماده است!</b>',
    '',
    `📶 حجم: <b>${formatBytes(sub.dataLimitBytes)}</b>`,
  ];

  // کانفیگ‌ها تاریخ انقضا ندارند؛ خط انقضا فقط وقتی نمایش داده می‌شود که
  // واقعاً تاریخی روی اشتراک ست شده باشد (مثلاً بسته‌های قالب‌دار پنل).
  if (sub.status === 'on_hold') {
    const days = plan && Number(plan.days) ? Number(plan.days) : 0;
    if (days > 0) lines.push(`⏳ مدت اعتبار: <b>${days} روز</b> (از اولین اتصال شما شروع می‌شود)`);
  } else if (sub.expireAt) {
    lines.push(`📅 تاریخ انقضا: <b>${formatDate(sub.expireAt)}</b>`);
  }

  lines.push(
    '',
    '🔗 <b>لینک اشتراک (Subscription):</b>',
    `<code>${escapeHtml(sub.subscriptionUrl)}</code>`,
    '',
    'این لینک را در برنامه‌ای مثل v2rayNG، Streisand، Hiddify یا Clash در بخش',
    '«افزودن از لینک اشتراک / Add from subscription» وارد کنید.',
    '',
    `🆔 شناسه اشتراک: <code>${escapeHtml(sub.id)}</code>`,
    `🎫 پشتیبانی: @${escapeHtml(config.SUPPORT_USERNAME)}`
  );
  return lines.join('\n');
}

// متن وضعیت اشتراک (پس از همگام‌سازی با پنل)
export function formatSubscriptionStatus(sub) {
  const remaining = Math.max(0, (Number(sub.dataLimitBytes) || 0) - (Number(sub.usedTrafficBytes) || 0));
  const left = daysLeft(sub.expireAt);
  const lines = [
    '📊 <b>وضعیت اشتراک</b>',
    '',
    `📌 وضعیت: <b>${PG_STATUS_LABEL[sub.status] || escapeHtml(sub.status)}</b>`,
    `📶 حجم کل: <b>${formatBytes(sub.dataLimitBytes)}</b>`,
    `📉 مصرف‌شده: <b>${formatBytes(sub.usedTrafficBytes)}</b>`,
  ];
  if (Number(sub.dataLimitBytes) > 0) {
    lines.push(`✅ باقیمانده: <b>${formatBytes(remaining)}</b>`);
  }
  if (sub.expireAt) {
    lines.push(`📅 انقضا: <b>${formatDate(sub.expireAt)}</b>`);
    if (left !== null) {
      lines.push(left >= 0 ? `⏳ روزهای باقیمانده: <b>${left}</b>` : '⌛ این اشتراک منقضی شده است.');
    }
  }
  if (sub.subscriptionUrl) {
    lines.push('', '🔗 لینک اشتراک:', `<code>${escapeHtml(sub.subscriptionUrl)}</code>`);
  }
  return lines.join('\n');
}

/**
 * ساخت اشتراک روی پاسارگارد و تحویل آن به مشتری.
 * این تابع idempotent است: اگر سفارش قبلاً تحویل شده باشد، اشتراک موجود را
 * برمی‌گرداند و اشتراک تکراری نمی‌سازد (مهم برای callback درگاه).
 */
export async function provisionOrder(env, config, order, options = {}) {
  const notifyChatId = options.notifyChatId || order.chatId || order.userId;

  if (order.subscriptionId) {
    const existing = memGet(DB.subscriptions, order.subscriptionId);
    if (existing) return { ok: true, subscription: existing, alreadyDone: true };
  }

  const plan = resolveOrderPlan(order);
  if (!plan) {
    await failOrder(env, config, order, 'بسته این سفارش دیگر در لیست بسته‌ها موجود نیست.', notifyChatId);
    return { ok: false, error: 'plan_not_found' };
  }

  if (!pgConfigured(config)) {
    await failOrder(
      env,
      config,
      order,
      'اتصال پنل پاسارگارد تنظیم نشده است (PASARGUARD_BASE_URL و کلید API).',
      notifyChatId
    );
    return { ok: false, error: 'pasarguard_not_configured' };
  }

  let pgUser;
  const seq = nextSubSeq(order.userId);
  try {
    pgUser = await pgProvision(env, config, {
      plan,
      telegramId: order.userId,
      seq,
      // نام فارسی مشتری در پنل به‌عنوان یادداشت ثبت می‌شود تا اشتراک قابل شناسایی باشد
      note: order.customerName || '',
    });
  } catch (err) {
    const message = err instanceof PgError ? err.message : 'خطای نامشخص در ارتباط با پنل';
    const hint = pgErrorHint(err, plan);
    await dbLog(env, 'error', 'pasarguard', `provision failed: ${message}`, { planId: plan.id }, {
      telegramId: order.userId,
      orderId: order.id,
    });
    await failOrder(env, config, order, `${message}${hint}`, notifyChatId);
    return { ok: false, error: message };
  }

  const sub = {
    id: newId('sub'),
    userId: String(order.userId),
    chatId: order.chatId || order.userId,
    seq,
    orderId: order.id,
    planId: plan.id,
    planTitle: plan.title,
    pgUsername: pgUser.pgUsername,
    pgUserId: pgUser.pgUserId,
    dataLimitBytes: pgUser.dataLimitBytes,
    usedTrafficBytes: pgUser.usedTrafficBytes,
    startAt: Date.now(),
    expireAt: pgUser.expireAt,
    subscriptionUrl: pgUser.subscriptionUrl,
    status: pgUser.status,
    previousId: order.renewOf || null,
    lastSyncedAt: Date.now(),
    createdAt: Date.now(),
  };
  memSet(DB.subscriptions, sub.id, sub);

  order.status = ORDER_STATUS.SENT;
  order.subscriptionId = sub.id;
  order.pgUsername = sub.pgUsername;
  order.updatedAt = Date.now();
  memSet(DB.orders, order.id, order);

  // ذخیره در D1 (اگر binding وصل باشد)
  await dbUpsertUser(env, { id: order.userId, username: order.username });
  await dbSyncPlan(env, plan);
  await dbSaveOrder(env, order);
  await dbSaveSubscription(env, sub);
  await dbLog(
    env,
    'info',
    'pasarguard',
    `subscription created (${sub.pgUsername})`,
    { planId: plan.id, kind: order.kind || ORDER_KIND.NEW },
    { telegramId: order.userId, orderId: order.id }
  );

  // ارسال لینک اشتراک به مشتری
  await sendMessage(config.BOT_TOKEN, notifyChatId, formatSubscriptionMessage(config, sub, plan), {
    reply_markup: mainReplyKeyboard(config),
  });

  // دکمه شیشه‌ای «🎓 آموزش‌ها» زیر پیام تحویل — تلگرام روی هر پیام فقط یک نوع
  // reply_markup می‌پذیرد، پس این دکمه در یک پیام کوتاه جداگانه (بلافاصله زیر
  // پیام تحویل) ارسال می‌شود. محتوای آن از پنل ادمین (مدیریت آموزش‌ها) قابل
  // افزودن/ویرایش/حذف است.
  if (DB.tutorials.size > 0) {
    await sendMessage(config.BOT_TOKEN, notifyChatId, '📚 برای آموزش اتصال و استفاده از سرویس روی دکمه زیر بزنید:', {
      reply_markup: { inline_keyboard: [[{ text: '🎓 آموزش‌ها', callback_data: 'tutorials:view' }]] },
    });
  }

  // اطلاع به ادمین (اگر گروه ادمین در دسترس نباشد، به چت خصوصی ادمین می‌رود)
  await notifyAdmins(env, config, {
    orderId: `sub:${order.id}`,
    text:
      `✅ <b>اشتراک ساخته و ارسال شد</b> — سفارش #${order.id}\n` +
      `👤 مشتری: ${escapeHtml(order.customerName || '—')} (<code>${order.userId}</code>)\n` +
      `🧾 نام کاربری پنل: <code>${escapeHtml(sub.pgUsername)}</code>\n` +
      `📦 ${escapeHtml(sub.planTitle || '—')} | ${formatBytes(sub.dataLimitBytes)}${
        sub.expireAt ? ` | ${formatDate(sub.expireAt)}` : ''
      }`,
  });

  // پورسانت خودکار دعوت دوست: اگر خریدار از طریق لینک دعوت شخص دیگری آمده،
  // درصدی از مبلغ این خرید به کیف پول دعوت‌کننده واریز می‌شود.
  await creditReferralCommission(env, config, order);

  return { ok: true, subscription: sub };
}

// ثبت شکست سفارش: بازگشت پول کیف پول، اطلاع به مشتری و ادمین
export async function failOrder(env, config, order, reason, notifyChatId) {
  order.status = ORDER_STATUS.CONFIRMED; // پرداخت معتبر بوده، فقط تحویل انجام نشده
  order.lastError = String(reason).slice(0, 300);
  order.updatedAt = Date.now();
  memSet(DB.orders, order.id, order);
  await dbSaveOrder(env, order);

  let refundNote = '';
  if (order.paidVia === 'wallet' && !order.refunded) {
    const balance = addWalletBalance(order.userId, order.price);
    order.refunded = true;
    memSet(DB.orders, order.id, order);
    await dbSyncUserWallet(env, order.userId, balance);
    refundNote = '\n💰 مبلغ به کیف پول شما بازگردانده شد.';
  }

  await sendMessage(
    config.BOT_TOKEN,
    notifyChatId,
    `⚠️ پرداخت شما ثبت شد، اما ساخت خودکار اشتراک انجام نشد.${refundNote}\n\n` +
      `همکاران ما در جریان قرار گرفتند و اشتراک به‌صورت دستی برای شما ارسال می‌شود.\n` +
      `🎫 پشتیبانی: @${escapeHtml(config.SUPPORT_USERNAME)}`
  );

  if (config.ADMIN_GROUP_ID || (config.ADMIN_IDS && config.ADMIN_IDS.length)) {
    await notifyAdmins(env, config, {
      orderId: `fail:${order.id}`,
      replyMarkup: adminOrderKeyboard(order.id, ORDER_STATUS.CONFIRMED),
      text:
        `🚨 <b>ساخت اشتراک ناموفق</b> — سفارش #${order.id}\n` +
        `👤 مشتری: ${escapeHtml(order.customerName || '—')} (<code>${order.userId}</code>)\n` +
        `📦 بسته: ${escapeHtml(order.planTitle || '-')}\n` +
        `❌ دلیل: ${escapeHtml(String(reason).slice(0, 700))}\n\n` +
        `با دکمه «ارسال اکانت به مشتری» می‌توانید دستی تحویل دهید.`,
    });
  }
}

// فهرست اشتراک‌هایی که قبلاً برایشان هشدار رفته: { subId: حجمِ کلِ آن لحظه }
// جدا از state اصلی ذخیره می‌شود تا بررسی طولانی پنل، داده‌های دیگر را بازنویسی نکند.
export async function loadLowVolumeAlerts(env) {
  if (!env.SHOP_KV) return SHARED.lowVolumeAlertsMemo;
  try {
    const raw = await env.SHOP_KV.get(LOW_VOLUME_KV_KEY);
    return raw ? JSON.parse(raw) || {} : {};
  } catch (err) {
    console.error('loadLowVolumeAlerts error:', err);
    return SHARED.lowVolumeAlertsMemo;
  }
}

export async function saveLowVolumeAlerts(env, alerts) {
  SHARED.lowVolumeAlertsMemo = alerts;
  if (!env.SHOP_KV) return;
  try {
    await env.SHOP_KV.put(LOW_VOLUME_KV_KEY, JSON.stringify(alerts));
  } catch (err) {
    console.error('saveLowVolumeAlerts error:', err);
  }
}

// preview=true: فقط برای پیش‌نمایش ادمین؛ دکمه‌ها نمایشی‌اند و کاری انجام نمی‌دهند
export function lowVolumeAlertKeyboard(sub, preview = false) {
  return {
    inline_keyboard: [
      [{ text: '🔄 تمدید حجم', callback_data: preview ? 'noop' : `renew:${sub.id}`, style: 'success' }],
      [{ text: '📊 وضعیت اشتراک', callback_data: preview ? 'noop' : `substatus:${sub.id}`, style: 'primary' }],
    ],
  };
}

// متن هشدار از تنظیمات ادمین خوانده می‌شود؛ متغیرها {plan} {total} {used} {remaining}
// خودکار جایگزین و پررنگ می‌شوند و بقیه متن برای امنیت HTML-escape می‌شود.
export function formatLowVolumeAlert(sub, remaining, config) {
  const template = String((config && config.LOW_VOLUME_ALERT_TEXT) || DEFAULTS.LOW_VOLUME_ALERT_TEXT);
  const values = {
    plan: sub.planTitle || 'اشتراک',
    total: formatBytes(sub.dataLimitBytes),
    used: formatBytes(sub.usedTrafficBytes),
    remaining: remaining > 0 ? formatBytes(remaining) : '۰ مگابایت',
  };
  return escapeHtml(template).replace(/\{(plan|total|used|remaining)\}/g, (_, key) => `<b>${escapeHtml(values[key])}</b>`);
}

// پیش‌نمایش پیام هشدار برای ادمین (با اطلاعات نمونه و همان دو دکمه‌ی نمایشی)
export async function sendLowVolumePreview(chatId, config) {
  const sample = { planTitle: 'اشتراک نمونه', dataLimitBytes: 10 * GIGABYTE, usedTrafficBytes: 9.5 * GIGABYTE };
  return sendMessage(
    config.BOT_TOKEN,
    chatId,
    '👀 <b>پیش‌نمایش پیام هشدار</b> (با اطلاعات نمونه؛ دکمه‌ها فقط نمایشی‌اند):\n\n' +
      formatLowVolumeAlert(sample, 0.5 * GIGABYTE, config),
    { reply_markup: lowVolumeAlertKeyboard(sample, true) }
  );
}

// اشتراک‌ها را (به‌صورت چرخشی) از پنل می‌خواند و برای هرکدام که یک گیگ یا کمتر
// حجم دارد، یک‌بار پیام تمدید می‌فرستد.
export async function checkLowVolumeSubscriptions(env, config) {
  const summary = { checked: 0, alerted: 0 };
  if (!isLowVolumeAlertEnabled() || !pgConfigured(config) || !config.BOT_TOKEN) return summary;

  const alerts = await loadLowVolumeAlerts(env);
  let alertsChanged = false;

  // فقط اشتراک‌های فعالی که حجم کلشان بیشتر از آستانه است (تا کانفیگ تست ۵۰ مگابایتی
  // و بسته‌های ≤۱ گیگ از همان ابتدا هشدار نگیرند). قدیمی‌ترین بررسی‌شده‌ها اول می‌آیند.
  const candidates = [...DB.subscriptions.values()]
    .filter(
      (sub) =>
        sub &&
        sub.userId &&
        sub.pgUsername &&
        sub.status === SUB_STATUS.ACTIVE &&
        Number(sub.dataLimitBytes) > LOW_VOLUME_ALERT_BYTES
    )
    .sort((a, b) => (a.lastSyncedAt || 0) - (b.lastSyncedAt || 0))
    .slice(0, LOW_VOLUME_SCAN_BATCH);

  for (const candidate of candidates) {
    summary.checked += 1;
    const result = await syncSubscription(env, config, candidate);
    if (!result.ok) continue;

    const sub = result.sub;
    const limit = Number(sub.dataLimitBytes) || 0;
    const remaining = limit - (Number(sub.usedTrafficBytes) || 0);
    if (sub.status !== SUB_STATUS.ACTIVE || limit <= LOW_VOLUME_ALERT_BYTES) continue;

    if (remaining > LOW_VOLUME_ALERT_BYTES) {
      // حجم دوباره زیاد شده (مثلاً ریست یا افزایش حجم) → برای دفعه بعد آماده شود
      if (alerts[sub.id] !== undefined) {
        delete alerts[sub.id];
        alertsChanged = true;
      }
      continue;
    }
    if (Number(alerts[sub.id]) === limit) continue; // همین حجم قبلاً هشدار گرفته

    const sent = await sendMessage(config.BOT_TOKEN, sub.userId, formatLowVolumeAlert(sub, remaining, config), {
      reply_markup: lowVolumeAlertKeyboard(sub),
    });
    // حتی اگر ارسال نشد (مثلاً کاربر ربات را بلاک کرده) علامت می‌زنیم تا هر بار تکرار نشود
    alerts[sub.id] = limit;
    alertsChanged = true;
    if (sent && sent.ok) {
      summary.alerted += 1;
    } else {
      await dbLog(env, 'warn', 'low-volume', 'alert send failed', { subId: sub.id }, { telegramId: sub.userId });
    }
  }

  if (alertsChanged) {
    for (const subId of Object.keys(alerts)) {
      if (!DB.subscriptions.has(subId)) delete alerts[subId]; // پاکسازی اشتراک‌های حذف‌شده
    }
    await saveLowVolumeAlerts(env, alerts);
  }
  return summary;
}

// زمان تمام‌شدن یک اشتراک: برای منقضی‌شده‌ها تاریخ انقضا، برای حجم‌تمام‌شده‌ها اولین باری که ربات دیده
export function subFinishedAt(sub) {
  if (sub.status === SUB_STATUS.EXPIRED && Number(sub.expireAt) > 0) return Number(sub.expireAt);
  return Number(sub.finishedAt) || 0;
}

// اشتراک‌هایی که تمام شده‌اند (منقضی یا حجم تمام) و بعد از ۱ روز تمدید نشده‌اند
// از پنل پاسارگارد حذف می‌شوند و در دیتابیس ربات «باطل» ثبت می‌شوند.
export async function deleteFinishedSubscriptions(env, config) {
  const summary = { checked: 0, deleted: 0 };
  if (!pgConfigured(config)) return summary;

  const now = Date.now();
  const candidates = [...DB.subscriptions.values()]
    .filter((sub) => {
      if (!sub || !sub.pgUsername || sub.status === SUB_STATUS.REVOKED) return false;
      const finished = sub.status === SUB_STATUS.EXPIRED || sub.status === SUB_STATUS.LIMITED;
      if (finished) {
        const at = subFinishedAt(sub);
        return !at || now - at >= FINISHED_SUB_DELETE_AFTER_MS; // زمان نامشخص → اول همگام‌سازی شود
      }
      // وضعیت ذخیره‌شده هنوز «فعال» است ولی تاریخ انقضا بیش از ۱ روز پیش گذشته (همگام‌سازی نشده)
      return (
        sub.status === SUB_STATUS.ACTIVE &&
        Number(sub.expireAt) > 0 &&
        now - Number(sub.expireAt) >= FINISHED_SUB_DELETE_AFTER_MS
      );
    })
    .sort((a, b) => (a.lastSyncedAt || 0) - (b.lastSyncedAt || 0))
    .slice(0, FINISHED_SUB_SCAN_BATCH);

  for (const candidate of candidates) {
    summary.checked += 1;
    // قبل از حذف (کاری برگشت‌ناپذیر) وضعیت واقعی از پنل خوانده می‌شود تا تمدیدشده‌ها حذف نشوند
    const result = await syncSubscription(env, config, candidate);
    if (!result.ok) continue;
    const sub = result.sub;
    if (sub.status !== SUB_STATUS.EXPIRED && sub.status !== SUB_STATUS.LIMITED) continue;
    const at = subFinishedAt(sub);
    if (!at || Date.now() - at < FINISHED_SUB_DELETE_AFTER_MS) continue;

    try {
      await pgDeleteUser(env, config, sub.pgUsername);
    } catch (err) {
      if (!(err instanceof PgError) || err.status !== 404) {
        const message = err instanceof PgError ? err.message : 'خطای نامشخص';
        await dbLog(env, 'error', 'pasarguard', `auto-delete failed: ${message}`, { subId: sub.id }, {
          telegramId: sub.userId,
        });
        continue;
      }
    }

    sub.status = SUB_STATUS.REVOKED;
    sub.updatedAt = Date.now();
    memSet(DB.subscriptions, sub.id, sub);
    await dbSaveSubscription(env, sub);
    await dbLog(env, 'info', 'pasarguard', 'finished subscription auto-deleted after 1 day', { subId: sub.id }, {
      telegramId: sub.userId,
    });
    summary.deleted += 1;
  }
  return summary;
}

// اگر Cron Trigger تنظیم نشده باشد، به‌ازای فعالیت کاربران حداکثر هر ۳۰ دقیقه یک‌بار اجرا می‌شود
export async function maybeScanLowVolume(env, config) {
  const now = Date.now();
  if (now - SHARED.lastLowVolumeScanAt < LOW_VOLUME_SCAN_INTERVAL_MS) return;
  SHARED.lastLowVolumeScanAt = now;
  try {
    await checkLowVolumeSubscriptions(env, config);
  } catch (err) {
    console.error('low-volume scan error:', err);
  }
  try {
    await deleteFinishedSubscriptions(env, config);
  } catch (err) {
    console.error('finished-subscriptions cleanup error:', err);
  }
}

export async function syncSubscription(env, config, sub) {
  try {
    const fresh = normalizePgUser(config, await pgGetUser(env, config, sub.pgUsername));
    sub.usedTrafficBytes = fresh.usedTrafficBytes;
    sub.dataLimitBytes = fresh.dataLimitBytes;
    sub.expireAt = fresh.expireAt;
    sub.status = fresh.status;
    // زمان تمام‌شدن اشتراک (انقضا یا اتمام حجم) برای حذف خودکار بعد از ۱ روز؛ با تمدید پاک می‌شود
    if (sub.status === SUB_STATUS.EXPIRED || sub.status === SUB_STATUS.LIMITED) {
      if (!sub.finishedAt) sub.finishedAt = Date.now();
    } else if (sub.finishedAt) {
      delete sub.finishedAt;
    }
    if (!sub.subscriptionUrl && fresh.subscriptionUrl) sub.subscriptionUrl = fresh.subscriptionUrl;
    sub.lastSyncedAt = Date.now();
    memSet(DB.subscriptions, sub.id, sub);
    await dbSaveSubscription(env, sub);
    return { ok: true, sub };
  } catch (err) {
    const message = err instanceof PgError ? err.message : 'خطای نامشخص در ارتباط با پنل';
    if (err instanceof PgError && err.status === 404) {
      sub.status = SUB_STATUS.REVOKED;
      sub.lastSyncedAt = Date.now();
      memSet(DB.subscriptions, sub.id, sub);
      await dbSaveSubscription(env, sub);
    }
    await dbLog(env, 'warn', 'pasarguard', `sync failed: ${message}`, { pgUsername: sub.pgUsername }, {
      telegramId: sub.userId,
    });
    return { ok: false, error: message, sub };
  }
}

// به‌ازای هر خرید موفق (تحویل‌شده) یک کاربر که از طریق لینک دعوت شخص دیگری
// آمده، درصدی از مبلغ همان خرید به‌صورت خودکار به کیف پول دعوت‌کننده
// واریز می‌شود؛ نیازی به تایید دستی ادمین نیست.
export async function creditReferralCommission(env, config, order) {
  if (!config.REFERRAL_ENABLED || !config.REFERRAL_COMMISSION_ENABLED) return;
  const price = Number(order.price) || 0;
  if (price <= 0) return;

  const buyer = DB.users.get(String(order.userId));
  const referrerId = buyer && buyer.referredBy ? String(buyer.referredBy) : null;
  if (!referrerId || referrerId === String(order.userId)) return;

  const percent = config.REFERRAL_COMMISSION_PERCENT;
  const amount = Math.floor((price * percent) / 100);
  if (amount <= 0) return;

  const balance = addWalletBalance(referrerId, amount);
  await dbSyncUserWallet(env, referrerId, balance);

  const commission = {
    id: newId('rwd'),
    referrerId,
    refereeId: String(order.userId),
    orderId: order.id,
    amount,
    percent,
    createdAt: Date.now(),
  };
  memSet(DB.referralRewards, commission.id, commission);

  await dbLog(env, 'info', 'referral', `commission credited (${amount} تومان)`, { percent }, {
    telegramId: referrerId,
    orderId: order.id,
  });

  const referee = DB.users.get(String(order.userId));
  const refereeLabel = referee ? formatUserIdentityLine(referee) : `<code>${order.userId}</code>`;

  await sendMessage(config.BOT_TOKEN, referrerId,
    '💰 <b>پورسانت دعوت دوست</b>\n\n' +
    `دوست دعوت‌شده شما (${refereeLabel}) یک خرید انجام داد.\n` +
    `${percent}٪ از مبلغ خرید (<b>${amount.toLocaleString()} تومان</b>) به کیف پول شما اضافه شد. 🎉`
  ).catch(() => {});
}

// نمایش اطلاعات یک کاربر: نام، آیدی (یوزرنیم) و آیدی عددی
export function formatUserIdentityLine(user) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  const namePart = name ? escapeHtml(name) : '—';
  const usernamePart = user.username ? `@${escapeHtml(user.username)}` : '—';
  return `${namePart} | ${usernamePart} | <code>${user.id}</code>`;
}
