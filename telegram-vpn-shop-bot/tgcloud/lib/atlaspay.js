// tgcloud/lib/atlaspay.js — ported from the Cloudflare Worker version of the bot.
import { fetch } from 'sdk';
import { stripTrailingSlash } from './core.js';
import { gatewayProvider, manualCardProvider, paymentResult, paymentStart, walletProvider } from './payments.js';

export const ATLASPAY_DEFAULT_BASE_URL = 'https://api.atlaspay.space/api/v1';

export const ATLASPAY_SUCCESS_STATUSES = ['confirmed', 'settled'];

export const ATLASPAY_DEAD_STATUSES = ['rejected', 'expired', 'cancelled'];

export const ATLASPAY_POLL_INTERVAL_MS = 20 * 1000;

export const ATLASPAY_POLL_BATCH = 10;

export const ATLASPAY_POLL_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export const ATLASPAY_MIN_RECHECK_MS = 8 * 1000;

export const atlasLocks = new Set();

export class AtlasPayError extends Error {
  constructor(message, status = 0, data = null) {
    super(message);
    this.name = 'AtlasPayError';
    this.status = status;
    this.data = data;
  }
}

export function atlaspayConfigured(config) {
  return Boolean(config && config.ATLASPAY_API_KEY);
}

export function atlaspayErrorMessage(status, data) {
  const apiMsg = data && typeof data === 'object' ? String(data.message || data.error || '').trim() : '';
  if (status === 401) return 'کلید API اطلس‌پی نامعتبر است یا ارسال نشده است.';
  if (status === 404) return 'سفارش در اطلس‌پی پیدا نشد.';
  if (status === 503) return 'سرویس اطلس‌پی موقتاً غیرفعال است.';
  if (status === 400) return apiMsg ? `ورودی نامعتبر: ${apiMsg}` : 'ورودی نامعتبر (مثلاً مبلغ خارج از محدوده مجاز).';
  return apiMsg || `خطای اطلس‌پی (${status})`;
}

// تماس با API اطلس‌پی؛ کلید فقط در هدر X-API-Key فرستاده می‌شود و هرگز لاگ نمی‌شود
export async function atlaspayFetch(config, method, path, body = null) {
  if (!atlaspayConfigured(config)) {
    throw new AtlasPayError('کلید API اطلس‌پی تنظیم نشده است (ATLASPAY_API_KEY).', 0);
  }
  const base = stripTrailingSlash(config.ATLASPAY_BASE_URL) || ATLASPAY_DEFAULT_BASE_URL;
  try {
    const headers = { 'X-API-Key': config.ATLASPAY_API_KEY, Accept: 'application/json' };
    const init = { method, headers };
    if (body !== null && body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = null;
    }
    if (!res.ok) throw new AtlasPayError(atlaspayErrorMessage(res.status, data), res.status, data);
    if (data === null || typeof data !== 'object') {
      throw new AtlasPayError('پاسخ نامعتبر از اطلس‌پی دریافت شد.', res.status || 0);
    }
    return data;
  } catch (err) {
    if (err instanceof AtlasPayError) throw err;
    const aborted = err && err.name === 'AbortError';
    throw new AtlasPayError(aborted ? 'پاسخ اطلس‌پی دیر رسید (Timeout).' : 'ارتباط با اطلس‌پی برقرار نشد.', 0);
  }
}

// ساخت سفارش در اطلس‌پی (POST /orders)
export async function atlaspayCreateOrder(config, { ref, amountToman, telegramId }) {
  const payload = { merchantOrderRef: ref, baseAmountToman: Math.round(Number(amountToman) || 0) };
  if (!(payload.baseAmountToman > 0)) throw new AtlasPayError('مبلغ سفارش نامعتبر است.', 400);
  const tid = Number(telegramId);
  if (Number.isFinite(tid) && tid > 0) payload.customerTelegramId = tid;

  const data = await atlaspayFetch(config, 'POST', '/orders', payload);
  if (!data.orderId || !data.customerStartLink) {
    throw new AtlasPayError('پاسخ ساخت سفارش اطلس‌پی ناقص بود.', 0, data);
  }
  // فقط فیلدهای لازم نگه داشته می‌شود (شماره‌کارت کامل، اگر فعال باشد، ذخیره نمی‌شود)
  return {
    orderId: data.orderId,
    trackingCode: String(data.trackingCode || ''),
    merchantOrderRef: ref,
    baseAmountToman: payload.baseAmountToman,
    totalAmountToman: Math.round(Number(data.totalAmountToman) || payload.baseAmountToman),
    paymentDeadlineAt: data.paymentDeadlineAt || null,
    customerStartLink: String(data.customerStartLink),
    createdAt: Date.now(),
    lastCheckedAt: 0,
    done: false,
    manual: false,
  };
}

// تفسیر پاسخ اطلس‌پی به یکی از حالت‌های: paid | underpaid | dead | pending | mismatch
export function atlaspayInterpret(data, atlas) {
  const status = String((data && data.status) || '');
  const actual = data && data.actualReceivedAmountToman !== null && data.actualReceivedAmountToman !== undefined
    ? Math.round(Number(data.actualReceivedAmountToman) || 0)
    : null;
  const info = { status, actualReceivedAmountToman: actual, totalAmountToman: Number(data && data.totalAmountToman) || null };

  // اطمینان از اینکه پاسخ واقعاً مربوط به همین سفارش ماست
  if (
    atlas &&
    atlas.merchantOrderRef &&
    data &&
    data.merchantOrderRef &&
    String(data.merchantOrderRef) !== String(atlas.merchantOrderRef)
  ) {
    return { state: 'mismatch', ...info };
  }

  const paid = (data && data.paid === true) || ATLASPAY_SUCCESS_STATUSES.includes(status);
  if (paid) {
    // ⚠️ طبق مستندات: قبل از تحویل، حتماً requiresManualDelivery هم چک شود
    return { state: data && data.requiresManualDelivery ? 'underpaid' : 'paid', ...info };
  }
  if (ATLASPAY_DEAD_STATUSES.includes(status)) return { state: 'dead', ...info };
  return { state: 'pending', ...info };
}

// استعلام وضعیت: GET /orders/{id} (یا POST /orders/{id}/verify وقتی مشتری دکمه «بررسی» را می‌زند)
export async function atlaspayCheckOrder(config, atlas, { verify = false } = {}) {
  const data = verify
    ? await atlaspayFetch(config, 'POST', `/orders/${atlas.orderId}/verify`)
    : await atlaspayFetch(config, 'GET', `/orders/${atlas.orderId}`);
  return atlaspayInterpret(data, atlas);
}

// متن پیام تایید سفارش به مشتری (مطابق بخش ۲.۱ مستندات)؛ دو جای‌خالی با مقدار واقعی پر می‌شود
export function formatAtlaspayCustomerMessage(atlas) {
  const amount = Number(atlas.totalAmountToman).toLocaleString('en-US');
  const tracking = escapeHtml(atlas.trackingCode);
  return (
    '⚠️ پیش از پرداخت، لطفاً موارد زیر را با دقت مطالعه فرمایید:\n\n' +
    '🔹 مبلغ را دقیقاً مطابق عدد ذکرشده در پایین واریز نمایید. واریز مبلغ رند یا متفاوت با مبلغ ذکرشده، ممکن است موجب تأخیر در تأیید شود.\n' +
    '🔹 پرداخت باید در بازه‌ی زمانی اعلام‌شده انجام شود؛ در غیر این صورت سفارش منقضی خواهد شد.\n' +
    '🔹 مسئولیت واریز به شماره‌کارت یا مبلغ نادرست، بر عهده‌ی پرداخت‌کننده است.\n\n' +
    `💰 مبلغ قابل پرداخت: <b>${amount}</b> تومان\n` +
    'این مبلغ شامل کلیه‌ی کارمزدها است و نیازی به محاسبه‌ی جداگانه نیست.\n\n' +
    '⏱ مهلت پرداخت: ۲۰ دقیقه از همین لحظه\n\n' +
    '🌐 برای ادامه، از دکمه‌ی زیر وارد صفحه‌ی پرداخت شوید. شماره‌کارت مقصد واریز همانجا نمایش داده خواهد شد.\n\n' +
    '✅ پس از واریز، رسید پرداخت را از همان صفحه بارگذاری نمایید و منتظر تأیید بمانید. در صورت بروز هرگونه مشکل، مراتب را به‌همراه تصویر رسید به پشتیبانی اطلاع دهید.\n\n' +
    `🔖 شماره‌ی پیگیری سفارش: <code>${tracking}</code>`
  );
}

// دکمه‌های زیر پیام پرداخت: kind = 'o' (سفارش) | 'w' (شارژ کیف پول)
export function atlaspayCustomerKeyboard(atlas, kind, entityId) {
  return {
    inline_keyboard: [
      [{ text: '💳 پرداخت', url: atlas.customerStartLink }],
      [{ text: '🔄 بررسی وضعیت پرداخت', callback_data: `atlas:check:${kind}:${entityId}` }],
      [{ text: '❌ لغو این پرداخت', callback_data: `atlas:cancel:${kind}:${entityId}` }],
    ],
  };
}

// ---------- Provider ۴: اطلس‌پی ----------
//  start(ctx):  ctx.order = { id, userId, price }، اختیاری: ctx.amount و ctx.refPrefix
//               خروجی: redirectUrl = لینک مینی‌اپ، meta = اطلاعات سفارش اطلس‌پی
//  verify(ctx): ctx.order.atlaspay لازم است؛ فقط وقتی «پرداخت کامل» باشد ok=true برمی‌گرداند
export const atlaspayProvider = {
  id: 'atlaspay',
  label: '⚡ پرداخت آنلاین (اطلس‌پی)',
  autoVerify: true,
  async start(ctx) {
    try {
      const orderRef = `${ctx.refPrefix || 'bot-order'}-${ctx.order.id}-${Date.now()}`;
      const atlas = await atlaspayCreateOrder(ctx.config, {
        ref: orderRef,
        amountToman: ctx.amount !== undefined && ctx.amount !== null ? ctx.amount : ctx.order.price,
        telegramId: ctx.order.userId,
      });
      return paymentStart({
        instructions: formatAtlaspayCustomerMessage(atlas),
        redirectUrl: atlas.customerStartLink,
        reference: String(atlas.orderId),
        meta: atlas,
      });
    } catch (err) {
      return paymentStart({
        error: err instanceof AtlasPayError ? err.message : 'شروع پرداخت اطلس‌پی ممکن نشد.',
      });
    }
  },
  async verify(ctx) {
    const atlas = ctx.order && ctx.order.atlaspay;
    if (!atlas) return paymentResult({ reason: 'اطلاعات پرداخت اطلس‌پی روی این سفارش ثبت نشده است' });
    try {
      const check = await atlaspayCheckOrder(ctx.config, atlas);
      const raw = {
        method: 'atlaspay',
        status: check.status,
        trackingCode: atlas.trackingCode,
        totalAmountToman: atlas.totalAmountToman,
        actualReceivedAmountToman: check.actualReceivedAmountToman,
      };
      if (check.state === 'paid') {
        return paymentResult({
          ok: true,
          reference: String(atlas.orderId),
          amount: Math.round(Number(ctx.order.price) || 0),
          raw,
        });
      }
      if (check.state === 'underpaid') {
        return paymentResult({ reason: 'پرداخت با کسری واریز تایید شده و نیاز به تصمیم دستی دارد', raw });
      }
      return paymentResult({ reason: `پرداخت هنوز تایید نشده (${check.status || 'نامشخص'})`, raw });
    } catch (err) {
      return paymentResult({ reason: err instanceof AtlasPayError ? err.message : 'استعلام اطلس‌پی ناموفق بود' });
    }
  },
};

// ثبت Providerها — درگاه خودتان را همین‌جا اضافه کنید
export const PAYMENT_PROVIDERS = {
  [walletProvider.id]: walletProvider,
  [manualCardProvider.id]: manualCardProvider,
  [gatewayProvider.id]: gatewayProvider,
  [atlaspayProvider.id]: atlaspayProvider,
};

export function getPaymentProvider(id) {
  return PAYMENT_PROVIDERS[String(id || '')] || null;
}

export function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
