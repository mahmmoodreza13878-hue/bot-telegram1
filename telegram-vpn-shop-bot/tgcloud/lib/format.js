// tgcloud/lib/format.js — ported from the Cloudflare Worker version of the bot.
import { ORDER_KIND, STATUS_LABEL, WALLET_STATUS_LABEL } from './core.js';
import { escapeHtml } from './atlaspay.js';

export function formatOrderSummary(order) {
  return (
    `🧾 <b>خلاصه سفارش شما</b>\n\n` +
    `📦 بسته: <b>${escapeHtml(order.planTitle)}</b>\n` +
    `💰 مبلغ: <b>${Number(order.price || 0).toLocaleString()} تومان</b>\n` +
    `👤 نام: <b>${escapeHtml(order.customerName)}</b>\n` +
    `💳 کارت مقصد: <b>${escapeHtml(order.cardLabel)}</b>\n` +
    `🖼 رسید: ${order.receiptFileId ? '✅ دریافت شد' : '❌ ارسال نشده'}\n\n` +
    `در صورت تایید اطلاعات، دکمه «✅ تایید و ثبت سفارش» را بزنید.`
  );
}

export function formatAdminOrderMessage(order) {
  const quantity = Number(order.quantity) || 1;
  const paidViaLabel =
    order.paidVia === 'wallet'
      ? '💰 کیف پول (پرداخت‌شده)'
      : order.paidVia === 'gateway'
        ? '🌐 درگاه آنلاین'
        : order.paidVia === 'atlaspay'
        ? '⚡ اطلس‌پی (آنلاین)'
        : `💳 کارت به کارت${order.cardLabel && order.cardLabel !== '—' ? ` — ${escapeHtml(order.cardLabel)}` : ''}`;

  return (
    `🛍️ <b>سفارش جدید ثبت شد!</b>${order.kind === ORDER_KIND.RENEW ? ' (تمدید)' : ''}\n\n` +
    `👤 نام مشتری: ${escapeHtml(order.customerName || '—')}\n` +
    `🆔 Telegram ID: <code>${order.userId}</code>\n` +
    `📱 Username: ${order.username ? `@${escapeHtml(order.username)}` : '—'}\n` +
    `📦 شماره سفارش: <b>#${order.id}</b>\n` +
    `🛒 محصولات: ${escapeHtml(order.planTitle || '—')} × ${quantity}\n` +
    `💰 مبلغ نهایی: <b>${Number(order.price || 0).toLocaleString()} تومان</b>\n` +
    `💳 روش پرداخت: ${paidViaLabel}\n` +
    `🕐 زمان ثبت سفارش: ${new Date(order.createdAt || Date.now()).toLocaleString('fa-IR')}\n` +
    `✅ تایید نهایی مشتری: انجام شد\n` +
    `📌 وضعیت سفارش: ${formatOrderStatus(order.status)}` +
    `${order.pgUsername ? `\n🧾 نام کاربری پنل: <code>${escapeHtml(order.pgUsername)}</code>` : ''}` +
    `${order.lastError ? `\n⚠️ آخرین خطا: ${escapeHtml(String(order.lastError).slice(0, 200))}` : ''}`
  );
}

export function formatOrderStatus(status) {
  return STATUS_LABEL[status] || status;
}

export function formatWalletRequestMessage(req) {
  return (
    `💰 <b>درخواست شارژ کیف پول</b> #${req.id}\n\n` +
    `🆔 آیدی: <code>${req.userId}</code>\n` +
    `👤 نام: ${escapeHtml(req.customerName || '-')}\n` +
    `🔗 یوزرنیم: ${req.username ? '@' + req.username : '—'}\n\n` +
    `💵 مبلغ: <b>${req.amount.toLocaleString()} تومان</b>\n` +
    `💳 کارت مقصد: ${escapeHtml(req.cardLabel || '-')}\n\n` +
    `📅 تاریخ ثبت: ${new Date(req.createdAt).toLocaleString('fa-IR')}\n` +
    `📌 وضعیت: ${WALLET_STATUS_LABEL[req.status] || req.status}`
  );
}
