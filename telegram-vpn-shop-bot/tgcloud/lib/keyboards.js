// tgcloud/lib/keyboards.js — ported from the Cloudflare Worker version of the bot.
import { BACK_BUTTON_TEXT, DB, GIGABYTE, ORDER_STATUS, PRODUCT_CATEGORY_ID, SETTINGS_FIELDS, WALLET_REQUEST_STATUS, backNavRow, ensurePlansLoaded, getWalletMinTopup, withButtonStyle } from './core.js';
import { atlaspayConfigured, atlaspayProvider } from './atlaspay.js';

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return 'نامحدود';
  if (value >= GIGABYTE) return `${(value / GIGABYTE).toFixed(2)} گیگابایت`;
  return `${(value / (1024 * 1024)).toFixed(0)} مگابایت`;
}

export function formatDate(ms) {
  if (!ms) return 'بدون تاریخ انقضا';
  try {
    return new Date(ms).toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch (err) {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export function listUserSubscriptions(userId) {
  const idStr = String(userId);
  return [...DB.subscriptions.values()]
    .filter((sub) => String(sub.userId) === idStr)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// ادمین می‌تواند از «تنظیمات فروشگاه» این قابلیت را خاموش/روشن کند (پیش‌فرض: روشن)
export function isLowVolumeAlertEnabled() {
  return !DB.settings || DB.settings.LOW_VOLUME_ALERT_ENABLED !== false;
}

// --- Reply Keyboard (Custom Keyboard) - منوی اصلی ---
// متن دکمه‌ها از تنظیمات (قابل تغییر توسط ادمین) خوانده می‌شود
export function mainReplyKeyboard(config) {
  return {
    keyboard: [
      [
        withButtonStyle({ text: config.BTN_MYORDERS_LABEL }, config.BTN_STYLE_MYORDERS),
        withButtonStyle({ text: config.BTN_SHOP_LABEL }, config.BTN_STYLE_SHOP),
      ],
      [
        withButtonStyle({ text: config.BTN_RENEW_LABEL }, config.BTN_STYLE_RENEW),
      ],
      [
        withButtonStyle({ text: config.BTN_TESTCONFIG_LABEL }, config.BTN_STYLE_TESTCONFIG),
        withButtonStyle({ text: config.BTN_WALLET_LABEL }, config.BTN_STYLE_WALLET),
      ],
      ...(config.REFERRAL_ENABLED
        ? [[withButtonStyle({ text: config.BTN_INVITE_LABEL }, config.BTN_STYLE_INVITE)]]
        : []),
      [
        withButtonStyle({ text: config.BTN_SUPPORT_LABEL }, config.BTN_STYLE_SUPPORT),
      ],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

// --- Reply Keyboard مخصوص ادمین ---
export function adminReplyKeyboard() {
  return {
    keyboard: [
      // رنگ دکمه‌ها: primary=آبی، success=سبز، danger=قرمز (تنوع رنگی پنل ادمین)
      [{ text: '⏳ سفارش‌های در انتظار', style: 'danger' }, { text: '💳 مدیریت کارت‌ها', style: 'success' }],
      [{ text: '📦 مدیریت بسته‌ها', style: 'primary' }, { text: '🛰 پاسارگارد', style: 'success' }],
      [{ text: '🎓 مدیریت آموزش‌ها', style: 'primary' }],
      [{ text: '🎁 مدیریت تست کانفیگ', style: 'success' }, { text: '💰 مدیریت کیف پول', style: 'primary' }],
      [{ text: '🔒 عضویت اجباری', style: 'danger' }],
      [{ text: '👤 مدیریت ادمین‌ها', style: 'primary' }, { text: '⚙️ تنظیمات فروشگاه', style: 'success' }],
      [{ text: '🚦 مدیریت کانفیگ کاربران', style: 'primary' }],
      [{ text: '📊 آمار فروشگاه', style: 'success' }, { text: '🔙 بازگشت به منوی کاربری', style: 'danger' }],
      [{ text: '👥 مدیریت دعوت دوستان', style: 'success' }, { text: '💳 پنل اطلس‌پی', style: 'primary' }],
      [{ text: '📢 پیام همگانی', style: 'primary' }, { text: '📣 تبلیغ در کانال', style: 'success' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

// --- کیبورد دسته‌بندی محصولات (اینلاین) ---
// عنوان دسته‌بندی از تنظیمات قابل‌تغییر خوانده می‌شود
export function productsKeyboard(config) {
  return {
    inline_keyboard: [
      [withButtonStyle(
        { text: `${config.PRODUCT_CATEGORY_TITLE}`, callback_data: `product:${PRODUCT_CATEGORY_ID}` },
        config.INLINE_CATEGORY_BTN_STYLE
      )],
      backNavRow('main'),
    ],
  };
}

// --- کیبورد بسته‌ها (اینلاین) ---
// لیست بسته‌ها از DB.plans (قابل مدیریت کامل توسط ادمین) خوانده می‌شود.
// کانفیگ‌ها تاریخ انقضا ندارند، پس فقط حجم و قیمت نمایش داده می‌شود.
export function planLabel(plan) {
  const RLM = '\u200F'; // Right-to-Left Mark: جلوگیری از بهم‌ریختگی نمایش عدد+فارسی روی دسکتاپ
  const volume = Number(plan.gb) > 0 ? `${RLM}${plan.gb}${RLM} گیگ` : 'نامحدود';
  const price = `${RLM}${Number(plan.price).toLocaleString()}${RLM} ت`;
  return `${RLM}${volume}${RLM} | ${price}`;
}

export function plansKeyboard(config, backData = 'back:products') {
  ensurePlansLoaded();
  const rows = [];
  const plans = DB.plans;
  for (let i = 0; i < plans.length; i += 2) {
    const hasPair = Boolean(plans[i + 1]);
    if (hasPair) {
      // ردیف زوجی: دکمه اول آرایه در کلاینت راست‌چین به‌صورت «ستون راست» و
      // دکمه دوم به‌صورت «ستون چپ» نمایش داده می‌شود.
      const row = [
        withButtonStyle(
          { text: planLabel(plans[i]), callback_data: `plan:${plans[i].id}` },
          config.INLINE_PLAN_RIGHT_BTN_STYLE
        ),
        withButtonStyle(
          { text: planLabel(plans[i + 1]), callback_data: `plan:${plans[i + 1].id}` },
          config.INLINE_PLAN_LEFT_BTN_STYLE
        ),
      ];
      rows.push(row);
    } else {
      // آخرین بسته وقتی تعداد فرد باشد و جفت نداشته باشد (تک‌ستونی)
      rows.push([
        withButtonStyle(
          { text: planLabel(plans[i]), callback_data: `plan:${plans[i].id}` },
          config.INLINE_PLAN_LAST_BTN_STYLE
        ),
      ]);
    }
  }
  if (plans.length === 0) {
    rows.push([{ text: '⚠️ در حال حاضر بسته‌ای ثبت نشده', callback_data: 'noop' }]);
  }
  rows.push([{ text: BACK_BUTTON_TEXT, callback_data: backData }]);
  return { inline_keyboard: rows };
}

// --- کیبورد انتخاب روش پرداخت ---
// درگاه آنلاین فقط وقتی نمایش داده می‌شود که PAYMENT_CALLBACK_SECRET ست شده باشد
// خرید اشتراک فقط از موجودی کیف پول انجام می‌شود؛ مشتری باید قبل از ثبت سفارش
// کیف پول خود را شارژ کند. اگر موجودی کافی نباشد فقط دکمه «شارژ کیف پول» نمایش داده می‌شود.
export function paymentMethodKeyboard(walletBalance, config, price = 0) {
  const balance = Number(walletBalance) || 0;
  const cost = Number(price) || 0;
  const rows = [];

  if (cost > 0 && balance < cost) {
    rows.push([{ text: '➕ شارژ کیف پول', callback_data: 'wallet:topup' }]);
  } else {
    rows.push([
      {
        text: `💰 پرداخت از کیف پول (موجودی: ${balance.toLocaleString()} ت)`,
        callback_data: 'paymethod:wallet',
      },
    ]);
  }
  rows.push([{ text: BACK_BUTTON_TEXT, callback_data: 'back:plans' }]);
  return { inline_keyboard: rows };
}

// متن مرحله پرداخت خرید اشتراک (فقط کیف پول)
export function purchasePaymentPrompt(walletBalance, price) {
  const balance = Number(walletBalance) || 0;
  const cost = Number(price) || 0;
  if (balance >= cost) {
    return (
      '💰 <b>پرداخت از کیف پول</b>\n\n' +
      `مبلغ بسته: <b>${cost.toLocaleString()} تومان</b>\n` +
      `موجودی کیف پول: <b>${balance.toLocaleString()} تومان</b>\n\n` +
      'برای ثبت سفارش، دکمه زیر را بزنید:'
    );
  }
  return (
    '⚠️ <b>برای خرید اشتراک، ابتدا باید کیف پول خود را شارژ کنید.</b>\n\n' +
    `مبلغ بسته: <b>${cost.toLocaleString()} تومان</b>\n` +
    `موجودی کیف پول: <b>${balance.toLocaleString()} تومان</b>\n` +
    `کسری موجودی: <b>${(cost - balance).toLocaleString()} تومان</b>\n\n` +
    'بعد از شارژ کیف پول، دوباره از منوی «🛒 خرید اشتراک» بسته را انتخاب و سفارش را ثبت کنید.'
  );
}

// --- کیبورد انتخاب کارت برای شارژ کیف پول (مشتری، اینلاین) ---
export function walletTopupCardsKeyboard(config) {
  const rows = [];
  if (config && atlaspayConfigured(config)) {
    rows.push([{ text: atlaspayProvider.label, callback_data: 'walletatlas:pay' }]);
  }
  const cardRows = [];
  for (const card of DB.cards.values()) {
    cardRows.push([{ text: `🔵 ${card.bankName} - ${card.number}`, callback_data: `walletcard:${card.id}` }]);
  }
  if (cardRows.length === 0 && rows.length === 0) {
    cardRows.push([{ text: '⚠️ در حال حاضر کارتی ثبت نشده', callback_data: 'noop' }]);
  }
  rows.push(...cardRows);
  rows.push([{ text: BACK_BUTTON_TEXT, callback_data: 'wallet:menu' }]);
  return { inline_keyboard: rows };
}

// --- کیبورد منوی کیف پول (مشتری، اینلاین) ---
export function walletMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '➕ شارژ کیف پول', callback_data: 'wallet:topup' }],
      backNavRow('main'),
    ],
  };
}

// --- کیبورد مدیریت کارت‌ها (ادمین، اینلاین) ---
export function cardsAdminInlineKeyboard() {
  const rows = [];
  for (const card of DB.cards.values()) {
    rows.push([{ text: `🔴 حذف: ${card.bankName} - ${card.number}`, callback_data: `card_del:${card.id}`, style: 'danger' }]);
  }
  rows.push([{ text: '🟢 افزودن کارت جدید', callback_data: 'card_add', style: 'success' }]);
  rows.push(backNavRow('admin'));
  return { inline_keyboard: rows };
}

// --- کیبورد مدیریت ادمین‌ها (ادمین، اینلاین) ---
export function adminsAdminInlineKeyboard() {
  const rows = [];
  for (const id of DB.admins) {
    rows.push([{ text: `🔴 حذف ادمین: ${id}`, callback_data: `adminmgmt_del:${id}`, style: 'danger' }]);
  }
  rows.push([{ text: '🟢 افزودن ادمین جدید', callback_data: 'adminmgmt_add', style: 'success' }]);
  rows.push(backNavRow('admin'));
  return { inline_keyboard: rows };
}

// --- کیبورد تنظیمات فروشگاه (ادمین، اینلاین) ---
export function settingsInlineKeyboard() {
  return {
    inline_keyboard: [
      ...Object.keys(SETTINGS_FIELDS).map((field, i) => [
        {
          text: `🟣 ${SETTINGS_FIELDS[field]}`,
          callback_data: `setting_edit:${field}`,
          style: i % 2 === 0 ? 'primary' : 'success', // یکی‌درمیان آبی/سبز
        },
      ]),
      [
        {
          text: isLowVolumeAlertEnabled() ? '🔔 هشدار کم‌شدن حجم (۱ گیگ): روشن' : '🔕 هشدار کم‌شدن حجم (۱ گیگ): خاموش',
          callback_data: 'lowvol_toggle',
          style: isLowVolumeAlertEnabled() ? 'success' : 'danger',
        },
      ],
      [{ text: '🎨 رنگ دکمه‌های منو', callback_data: 'btnstyle_menu', style: 'success' }],
      [{ text: '🎨 رنگ دکمه‌های شیشه‌ای (همه بخش‌ها)', callback_data: 'glassstyle_menu', style: 'primary' }],
      backNavRow('admin'),
    ],
  };
}

// --- کیبورد مدیریت بسته‌ها (ادمین، اینلاین) ---
// کانفیگ‌ها تاریخ انقضا ندارند، پس فقط حجم و مقصد (گروه/قالب) نمایش داده می‌شود.
export function plansAdminInlineKeyboard() {
  ensurePlansLoaded();
  const rows = [];
  for (const plan of DB.plans) {
    const volume = Number(plan.gb) > 0 ? `${plan.gb}گیگ` : 'نامحدود';
    const target = plan.templateId
      ? `قالب ${plan.templateId}`
      : Array.isArray(plan.groupIds) && plan.groupIds.length
        ? `گروه ${plan.groupIds.join('،')}`
        : '⚠️ بی‌گروه';
    rows.push([
      {
        text: `🟡 ${plan.title} | ${volume} | ${target}`,
        callback_data: `plan_edit:${plan.id}`,
        style: 'primary',
      },
      { text: '🔴 حذف', callback_data: `plan_del:${plan.id}`, style: 'danger' },
    ]);
  }
  rows.push([{ text: '💲 قیمت همه بسته‌ها (هر گیگ)', callback_data: 'plan_bulk_price', style: 'primary' }]);
  rows.push([{ text: '🟢 افزودن بسته جدید', callback_data: 'plan_add', style: 'success' }]);
  rows.push(backNavRow('admin'));
  return { inline_keyboard: rows };
}

// --- کیبورد مدیریت آموزش‌ها (ادمین، اینلاین) ---
export function tutorialsAdminInlineKeyboard() {
  const rows = [];
  for (const tutorial of DB.tutorials.values()) {
    rows.push([
      { text: `🟡 ${tutorial.title}`, callback_data: `tut_edit:${tutorial.id}`, style: 'primary' },
      { text: '🔴 حذف', callback_data: `tut_del:${tutorial.id}`, style: 'danger' },
    ]);
  }
  rows.push([{ text: '🟢 افزودن آموزش جدید', callback_data: 'tut_add', style: 'success' }]);
  rows.push(backNavRow('admin'));
  return { inline_keyboard: rows };
}

// --- کیبورد نمایش لینک‌های آموزش (مشتری، اینلاین) ---
export function tutorialsViewKeyboard() {
  const rows = [];
  for (const tutorial of DB.tutorials.values()) {
    rows.push([{ text: `🔗 ${tutorial.title}`, url: tutorial.url }]);
  }
  return { inline_keyboard: rows };
}

// --- کیبورد مدیریت استخر تست کانفیگ (ادمین، اینلاین) ---
export function testConfigsAdminInlineKeyboard() {
  const unusedCount = DB.testConfigs.filter((c) => !c.used).length;
  const rows = [
    [{ text: '🟢 افزودن کانفیگ تست (چندتایی)', callback_data: 'testcfg_add', style: 'success' }],
  ];
  if (unusedCount > 0) {
    rows.push([{ text: '🔴 حذف همه کانفیگ‌های استفاده‌نشده', callback_data: 'testcfg_clear_unused', style: 'danger' }]);
  }
  rows.push(backNavRow('admin'));
  return { inline_keyboard: rows };
}

// --- کیبورد مدیریت کیف پول (ادمین، اینلاین) ---
export function walletAdminInlineKeyboard() {
  const pendingCount = [...DB.walletRequests.values()].filter(
    (r) => r.status === WALLET_REQUEST_STATUS.PENDING && !isAtlaspayAwaiting(r)
  ).length;
  return {
    inline_keyboard: [
      [{ text: `📋 درخواست‌های شارژ در انتظار (${pendingCount})`, callback_data: 'walletadmin:pending', style: 'primary' }],
      [{ text: '✏️ تغییر دستی موجودی کاربر', callback_data: 'walletadmin:adjust', style: 'success' }],
      [{ text: `💵 حداقل مبلغ شارژ (${getWalletMinTopup().toLocaleString()} ت)`, callback_data: 'walletadmin:min_topup', style: 'primary' }],
      backNavRow('admin'),
    ],
  };
}

// --- کیبورد اقدام ادمین روی درخواست شارژ کیف پول (اینلاین) ---
export function walletRequestAdminKeyboard(reqId, status) {
  if (status === WALLET_REQUEST_STATUS.PENDING) {
    return {
      inline_keyboard: [
        [
          { text: '🟢 تایید و شارژ', callback_data: `walletreq:approve:${reqId}`, style: 'success' },
          { text: '🔴 رد', callback_data: `walletreq:reject:${reqId}`, style: 'danger' },
        ],
      ],
    };
  }
  return { inline_keyboard: [] };
}

// --- کیبورد مدیریت عضویت اجباری (ادمین، اینلاین) ---
export function forceJoinAdminKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: DB.forceJoinEnabled ? '🟡 غیرفعال کردن عضویت اجباری' : '🟠 فعال کردن عضویت اجباری',
          callback_data: 'forcejoin_toggle',
          style: DB.forceJoinEnabled ? 'danger' : 'success',
        },
      ],
      backNavRow('admin'),
    ],
  };
}

// --- کیبورد عضویت در کانال برای کاربرانی که هنوز عضو نشده‌اند ---
export function joinChannelKeyboard(config) {
  const channelId = String(config.CHANNEL_ID || '').replace(/^@/, '');
  const rows = [];
  if (channelId && !channelId.startsWith('-')) {
    rows.push([{ text: '📢 عضویت در کانال', url: `https://t.me/${channelId}` }]);
  }
  rows.push([{ text: '✅ عضو شدم، بررسی مجدد', callback_data: 'checkjoin' }]);
  return { inline_keyboard: rows };
}

// --- کیبورد تایید نهایی سفارش توسط مشتری (اینلاین) ---
export function orderConfirmKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '✅ تایید و ثبت سفارش', callback_data: 'order:confirm' }],
      [{ text: '🔴 انصراف از سفارش', callback_data: 'order:cancel' }],
    ],
  };
}

// --- کیبورد اقدامات ادمین روی سفارش (اینلاین) ---
export function adminOrderKeyboard(orderId, status) {
  if (status === ORDER_STATUS.PENDING) {
    return {
      inline_keyboard: [
        [
          { text: '🟢 تایید سفارش', callback_data: `admin:confirm:${orderId}`, style: 'success' },
          { text: '🔴 رد سفارش', callback_data: `admin:reject:${orderId}`, style: 'danger' },
        ],
      ],
    };
  }
  if (status === ORDER_STATUS.CONFIRMED) {
    return {
      inline_keyboard: [[{ text: '🔵 ارسال اکانت به مشتری', callback_data: `admin:send:${orderId}`, style: 'primary' }]],
    };
  }
  return { inline_keyboard: [] };
}

// لیست اشتراک‌های کاربر به‌صورت دکمه؛ action مشخص می‌کند کلیک چه کاری بکند
// (کانفیگ‌ها انقضا ندارند، پس حجم روی دکمه نمایش داده می‌شود)
export function subscriptionsKeyboard(subs, action) {
  const rows = [];
  for (const sub of subs.slice(0, 10)) {
    const badge = sub.status === 'active' ? '🟢' : sub.status === 'on_hold' ? '⏸' : '🔴';
    const detail = sub.expireAt ? formatDate(sub.expireAt) : formatBytes(sub.dataLimitBytes);
    rows.push([
      {
        text: `${badge} ${sub.planTitle || 'اشتراک'} — ${detail}`,
        callback_data: `${action}:${sub.id}`,
      },
    ]);
  }
  if (rows.length === 0) {
    rows.push([{ text: '⚠️ اشتراکی یافت نشد', callback_data: 'noop' }]);
  }
  rows.push(backNavRow('main'));
  return { inline_keyboard: rows };
}

// دکمه‌های زیر پیام وضعیت یک اشتراک
export function subscriptionActionsKeyboard(sub) {
  const rows = [
    [{ text: '🔁 بروزرسانی وضعیت', callback_data: `substatus:${sub.id}` }],
    [{ text: '🔄 تمدید همین اشتراک', callback_data: `renew:${sub.id}` }],
  ];
  // دکمه شیشه‌ای «🎓 آموزش‌ها» — فقط وقتی حداقل یک آموزش از پنل ادمین ثبت
  // شده باشد نمایش داده می‌شود. محتوای آن (افزودن/ویرایش/حذف) کاملاً از
  // پنل ادمین → مدیریت آموزش‌ها قابل کنترل است (همان سیستم tutorials موجود).
  if (DB.tutorials.size > 0) {
    rows.push([{ text: '🎓 آموزش‌ها', callback_data: 'tutorials:view' }]);
  }
  // اگر کاربر چند اشتراک دارد، «مرحله قبل» همان لیست اشتراک‌هاست؛ وگرنه منوی اصلی
  rows.push(backNavRow(listUserSubscriptions(sub.userId).length > 1 ? 'subs:substatus' : 'main'));
  return {
    inline_keyboard: rows,
  };
}

// کیبورد پنل ادمین برای بخش پاسارگارد
export function pasarguardAdminKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🔍 تست اتصال به پنل', callback_data: 'pg:ping', style: 'success' }],
      [{ text: '📋 دریافت لیست گروه‌ها (شناسه‌ها)', callback_data: 'pg:groups', style: 'primary' }],
      [{ text: '🧪 ساخت اشتراک آزمایشی برای خودم', callback_data: 'pg:selftest', style: 'success' }],
      backNavRow('admin'),
    ],
  };
}

// پرداختی که هنوز نه تایید شده و نه برای بررسی دستی به ادمین رفته (نباید در لیست‌های ادمین بیاید)
export function isAtlaspayAwaiting(entity) {
  const atlas = entity && entity.atlaspay;
  return Boolean(atlas && !atlas.done && !atlas.manual);
}
