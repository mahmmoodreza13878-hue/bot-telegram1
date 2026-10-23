// tgcloud/lib/payments.js — ported from the Cloudflare Worker version of the bot.
import { deductWalletBalance } from './core.js';

// شکل ثابت پاسخ‌ها — همه Providerها از همین دو سازنده استفاده می‌کنند
export function paymentStart({ instructions = null, redirectUrl = null, reference = null, error = null, meta = null } = {}) {
  return { instructions, redirectUrl, reference, error, meta };
}

export function paymentResult({ ok = false, reference = null, amount = 0, raw = {}, reason = null } = {}) {
  return { ok, reference, amount, raw, reason };
}

// ---------- Provider ۱: کیف پول داخلی ----------
export const walletProvider = {
  id: 'wallet',
  label: '💰 پرداخت از کیف پول',
  autoVerify: true,
  async start() {
    return paymentStart({ instructions: 'مبلغ از موجودی کیف پول شما کسر می‌شود.' });
  },
  async verify(ctx) {
    const amount = Math.round(Number(ctx.order.price) || 0);
    const deducted = deductWalletBalance(ctx.order.userId, amount);
    if (!deducted) return paymentResult({ reason: 'موجودی کیف پول کافی نیست' });
    return paymentResult({
      ok: true,
      reference: `wallet_${ctx.order.id}`,
      amount,
      raw: { method: 'wallet' },
    });
  },
};

// ---------- Provider ۲: کارت به کارت با تایید ادمین ----------
export const manualCardProvider = {
  id: 'card',
  label: '💳 کارت به کارت',
  autoVerify: false,
  async start(ctx) {
    return paymentStart({
      instructions: 'پس از واریز، عکس رسید را ارسال کنید تا ادمین بررسی کند.',
      reference: String(ctx.order.id),
    });
  },
  // تایید نهایی با دکمه «تایید سفارش» توسط ادمین انجام می‌شود
  async verify(ctx) {
    return paymentResult({
      ok: true,
      reference: `card_${ctx.order.id}`,
      amount: Math.round(Number(ctx.order.price) || 0),
      raw: {
        method: 'card',
        approvedBy: ctx.params && ctx.params.adminId ? String(ctx.params.adminId) : null,
      },
    });
  },
};

// ---------- Provider ۳: درگاه پرداخت (اسکلت آماده) ----------
//  این Provider فقط زمانی فعال است که PAYMENT_CALLBACK_SECRET ست شده باشد.
//  callback باید با این پارامترها به /payment/callback بیاید:
//    order_id, amount, reference, status(=ok)، signature
//  و signature باید HMAC-SHA256 هگز از رشته زیر با همان کلید باشد:
//    `${order_id}|${amount}|${reference}|${status}`
// درگاه پرداخت آنلاین عمومی: روی هاست Serverless تلگرام آدرس عمومی برای callback وجود ندارد،
// پس این Provider فقط یک جای‌گزین غیرفعال است تا بقیه کد (که به id آن ارجاع می‌دهد) سالم بماند.
export const gatewayProvider = {
  id: 'gateway',
  label: '🌐 درگاه پرداخت آنلاین',
  autoVerify: true,
  async start() {
    return paymentStart({ error: 'درگاه پرداخت آنلاین روی هاست Serverless تلگرام پشتیبانی نمی‌شود.' });
  },
  async verify() {
    return paymentResult({ reason: 'درگاه پرداخت آنلاین روی هاست Serverless تلگرام پشتیبانی نمی‌شود.' });
  },
};
