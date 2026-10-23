// tgcloud/lib/core.js — ported from the Cloudflare Worker version of the bot.
import { api, BotApiError } from 'sdk';

export const DEFAULTS = {
  ADMIN_GROUP_ID: '',
  SUPPORT_USERNAME: 'YOUR_SUPPORT_USERNAME',
  CHANNEL_ID: '@YOUR_CHANNEL',
  SHOP_NAME: 'فروش فیلترشکن پارس وی پی ان',
  BTN_SHOP_LABEL: '🛒 خرید اشتراک',
  BTN_MYORDERS_LABEL: '📦 اشتراک من',
  BTN_RENEW_LABEL: '🔄 تمدید اشتراک',
  BTN_STATUS_LABEL: '📊 وضعیت اشتراک',
  BTN_WALLET_LABEL: '💰 کیف پول',
  BTN_SUPPORT_LABEL: '🎫 پشتیبانی',
  BTN_CHANNEL_LABEL: '📢 کانال',
  BTN_TESTCONFIG_LABEL: '🎁 تست کانفیگ رایگان',
  BTN_INVITE_LABEL: '👥 دعوت دوستان',
  INVITE_TEXT: 'دوستت را به {shop} دعوت کن! 💙\nبا لینک زیر وارد ربات شو:\n{link}',
  // متن هشدار «کم‌شدن حجم» که وقتی یک گیگ یا کمتر باقی بماند برای مشتری ارسال می‌شود (قابل‌تغییر از تنظیمات ادمین)
  LOW_VOLUME_ALERT_TEXT:
    '⚠️ حجم اشتراک شما رو به اتمام است\n\n' +
    '📦 اشتراک: {plan}\n' +
    '📶 حجم کل: {total}\n' +
    '📉 مصرف‌شده: {used}\n' +
    '⏳ باقی‌مانده: {remaining}\n\n' +
    'برای اینکه اتصالتان قطع نشود، همین حالا حجم را تمدید کنید 👇',
  // متن و لینک پیش‌فرض دکمه شیشه‌ای زیر «تبلیغ در کانال» — هنگام ساخت آگهی
  // جدید با دستور /default قابل استفاده است و از داخل پنل ادمین قابل تغییر است.
  // مقدار ویژه «shop» برای لینک یعنی: با زدن دکمه، کاربر مستقیماً وارد ربات
  // شده و منوی «خرید اشتراک» برایش باز می‌شود (نیازی به لینک دستی نیست).
  // ادمین می‌تواند این مقدار را از پنل تنظیمات با یک لینک دلخواه (کانال،
  // گروه پشتیبانی و ...) جایگزین کند.
  AD_DEFAULT_BUTTON_TEXT: '🛒 خرید اشتراک',
  AD_DEFAULT_BUTTON_URL: 'shop',
  // ---------- رنگ‌بندی دکمه‌های صفحه وضعیت (/) — از پنل مدیریتی /theme قابل تغییر است ----------
  THEME_COLOR_GREEN: '#62C457',
  THEME_COLOR_BLUE: '#4AA9E5',
  THEME_COLOR_RED: '#E16668',
  THEME_COLOR_BG: '#EEF5F2',
  // ---------- رنگ دکمه‌های واقعی ربات تلگرام (منوی اصلی) ----------
  // از نسخه Bot API 9.4 (فوریه ۲۰۲۶) تلگرام فیلد «style» را به دکمه‌های
  // Reply Keyboard و Inline Keyboard اضافه کرد که فقط سه مقدار می‌پذیرد:
  // 'primary' (آبی)، 'success' (سبز)، 'danger' (قرمز). رنگ دلخواه/HEX روی
  // دکمه‌های واقعی چت تلگرام امکان‌پذیر نیست؛ فقط همین سه گزینه.
  BTN_STYLE_SHOP: 'success',
  BTN_STYLE_MYORDERS: 'primary',
  BTN_STYLE_RENEW: 'success',
  BTN_STYLE_STATUS: 'primary',
  BTN_STYLE_WALLET: 'primary',
  BTN_STYLE_TESTCONFIG: 'success',
  BTN_STYLE_INVITE: 'primary',
  BTN_STYLE_SUPPORT: 'danger',
  BTN_STYLE_CHANNEL: 'primary',
  PRODUCT_CATEGORY_TITLE: '📦 بسته‌های اینترنت',
  // متن پیام بالای دکمه‌های دسته‌بندی، وقتی کاربر روی «🛒 خرید اشتراک» یا
  // «⚪ بازگشت» از صفحه بسته‌ها می‌زند و به این صفحه برمی‌گردد.
  PRODUCT_SELECT_TEXT: '📦 دسته‌بندی را انتخاب کنید:',
  WELCOME_EXTRA_TEXT:
    '🌟 به پارس VPN خوش اومدی! 🌟\n' +
    'ممنون که ما رو انتخاب کردی 💙\n' +
    'اینجا قراره با سرعت بالا، اتصال پایدار، امنیت مطمئن و لوکیشن‌های متنوع یک تجربه متفاوت از اینترنت داشته باشی. 🚀🌐\n\n' +
    '💰 گیگی فقط ۴ هزار تومان\n' +
    '🎧 پشتیبانی ۲۴ ساعته\n' +
    '⚡ سرعت و پایداری بالا\n' +
    '🔒 امنیت پیشرفته\n' +
    '📩 برای خرید و راهنمایی پیام بده: @YOUR_SUPPORT_USERNAME\n\n' +
    '❤️ پارس VPN؛ سریع وصل شو، راحت استفاده کن!',
};

// فیلدهایی از تنظیمات که ادمین می‌تواند از داخل ربات تغییر دهد و برای همیشه ذخیره شود
export const SETTINGS_FIELDS = {
  SHOP_NAME: 'نام فروشگاه',
  SUPPORT_USERNAME: 'آیدی پشتیبانی (بدون @)',
  CHANNEL_ID: 'آیدی کانال (مثل ‎@channel)',
  ADMIN_GROUP_ID: 'آیدی عددی گروه ادمین (مقصد سفارش‌ها)',
  PRODUCT_CATEGORY_TITLE: 'عنوان دسته‌بندی محصول (در فروشگاه)',
  PRODUCT_SELECT_TEXT: 'متن پیام «انتخاب دسته‌بندی» (بالای دکمه‌ها)',
  WELCOME_EXTRA_TEXT: 'متن تبلیغاتی خوش‌آمدگویی (زیر پیام /start)',
  BTN_SHOP_LABEL: 'متن دکمه «خرید اشتراک»',
  BTN_MYORDERS_LABEL: 'متن دکمه «اشتراک من»',
  BTN_RENEW_LABEL: 'متن دکمه «تمدید اشتراک»',
  BTN_STATUS_LABEL: 'متن دکمه «وضعیت اشتراک»',
  BTN_WALLET_LABEL: 'متن دکمه «کیف پول»',
  BTN_SUPPORT_LABEL: 'متن دکمه «پشتیبانی»',
  BTN_CHANNEL_LABEL: 'متن دکمه «کانال»',
  BTN_TESTCONFIG_LABEL: 'متن دکمه «تست کانفیگ»',
  BTN_INVITE_LABEL: 'متن دکمه «دعوت دوستان»',
  INVITE_TEXT: 'متن دعوت دوستان (متغیرها: {link} و {shop})',
  LOW_VOLUME_ALERT_TEXT: 'متن هشدار کم‌شدن حجم (متغیرها: {plan} {total} {used} {remaining})',
  AD_DEFAULT_BUTTON_TEXT: 'متن پیش‌فرض دکمه تبلیغ کانال',
  AD_DEFAULT_BUTTON_URL: 'لینک پیش‌فرض دکمه تبلیغ کانال (shop = باز شدن خودکار خرید اشتراک، یا یک لینک کامل)',
};

// رنگ دکمه‌های صفحه وضعیت (/) — این‌ها از داخل ربات تلگرام قابل تغییر
// نیستند (فقط کدهای HEX هستند)؛ برای آن‌ها یک صفحه وب اختصاصی با
// Color Picker به آدرس /theme ساخته شده که فقط با کلید مدیریتی
// (همان WEBHOOK_SECRET) باز می‌شود. مقدار همیشه در DB.settings ذخیره
// می‌شود، یعنی دقیقاً همان سیستم ذخیره‌سازی موجود در پروژه.
export const THEME_COLOR_FIELDS = {
  THEME_COLOR_GREEN: 'رنگ دکمه‌های سبز',
  THEME_COLOR_BLUE: 'رنگ دکمه‌های آبی',
  THEME_COLOR_RED: 'رنگ دکمه‌های قرمز/مرجانی',
  THEME_COLOR_BG: 'رنگ پس‌زمینه کلی',
};

// نگاشت رنگ واقعی دکمه‌های منوی اصلی ربات تلگرام (Reply Keyboard) — هر
// دکمه یکی از سه رنگ ثابت تلگرام (primary/success/danger) یا حالت
// پیش‌فرض کلاینت («» یعنی بدون استایل خاص) را می‌گیرد. از پنل ادمین
// (⚙️ تنظیمات فروشگاه → 🎨 رنگ دکمه‌های منو) قابل تغییر است.
export const BTN_STYLE_TARGETS = {
  BTN_STYLE_SHOP: { labelKey: 'BTN_SHOP_LABEL', title: 'خرید اشتراک' },
  BTN_STYLE_MYORDERS: { labelKey: 'BTN_MYORDERS_LABEL', title: 'اشتراک من' },
  BTN_STYLE_RENEW: { labelKey: 'BTN_RENEW_LABEL', title: 'تمدید اشتراک' },
  BTN_STYLE_STATUS: { labelKey: 'BTN_STATUS_LABEL', title: 'وضعیت اشتراک' },
  BTN_STYLE_WALLET: { labelKey: 'BTN_WALLET_LABEL', title: 'کیف پول' },
  BTN_STYLE_TESTCONFIG: { labelKey: 'BTN_TESTCONFIG_LABEL', title: 'تست کانفیگ رایگان' },
  BTN_STYLE_INVITE: { labelKey: 'BTN_INVITE_LABEL', title: 'دعوت دوستان' },
  BTN_STYLE_SUPPORT: { labelKey: 'BTN_SUPPORT_LABEL', title: 'پشتیبانی' },
  BTN_STYLE_CHANNEL: { labelKey: 'BTN_CHANNEL_LABEL', title: 'کانال' },
};

export const BTN_STYLE_CHOICES = [
  { value: '', emoji: '⚪', label: 'پیش‌فرض' },
  { value: 'primary', emoji: '🔵', label: 'آبی' },
  { value: 'success', emoji: '🟢', label: 'سبز' },
  { value: 'danger', emoji: '🔴', label: 'قرمز' },
];

// فیلد style را فقط وقتی به آبجکت دکمه اضافه می‌کند که مقدار معتبر باشد
export function withButtonStyle(button, style) {
  return style && ['primary', 'success', 'danger'].includes(style)
    ? { ...button, style }
    : button;
}

// ============================================================
// ۱.۰ب دکمه «بازگشت به منوی قبلی» — استاندارد برای همه بخش‌ها
// ============================================================
// این دکمه در انتهای همه کیبوردهای اینلاین (شیشه‌ای) اضافه می‌شود.
// callback_data آن با پیشوند «navback:» است تا در همه‌جا یکسان مدیریت شود:
//   navback:admin → بازگشت به منوی اصلی ادمین (Reply Keyboard ادمین)
//   navback:main  → بازگشت به منوی اصلی مشتری (Reply Keyboard اصلی)
// برای بخش‌هایی که خودشان قبلاً یک دکمه بازگشت اختصاصی و دقیق‌تر دارند
// (مثلاً «بازگشت به لیست بسته‌ها»)، همان دکمه اختصاصی حفظ شده است.
export const BACK_BUTTON_TEXT = '🔙 بازگشت به منوی قبلی';

export function backNavRow(target) {
  return [{ text: BACK_BUTTON_TEXT, callback_data: `navback:${target}` }];
}

// برای رنگ‌آمیزی سراسری دکمه‌های شیشه‌ای (اینلاین) از پنل ادمین استفاده می‌شود.
// همان سه مقدار مجاز تلگرام (Bot API 9.4 به بعد): primary/success/danger
export const GLASS_BTN_STYLE_CHOICES = [
  { value: '', emoji: '⚪', label: 'پیش‌فرض' },
  { value: 'primary', emoji: '🔵', label: 'آبی' },
  { value: 'success', emoji: '🟢', label: 'سبز' },
  { value: 'danger', emoji: '🔴', label: 'قرمز' },
];

// دو نوع دکمه شیشه‌ای در کل ربات وجود دارد که هرکدام رنگ جدا می‌گیرند:
//   INLINE_BTN_STYLE      → همه دکمه‌های اصلی/عملیاتی (مثل «📦 بسته‌های اینترنت»)
//   INLINE_BACK_BTN_STYLE → فقط دکمه «🔙 بازگشت به منوی قبلی» (navback:*)
// مقدار پیش‌فرض کارخانه‌ای: اصلی‌ها سبز، بازگشت آبی — تا در نگاه اول
// دکمه بازگشت از بقیه دکمه‌ها متمایز باشد.
export const GLASS_STYLE_TARGETS = {
  INLINE_BTN_STYLE: { title: 'دکمه‌های اصلی (شیشه‌ای)', default: 'success' },
  INLINE_BACK_BTN_STYLE: { title: 'دکمه «بازگشت به منوی قبلی»', default: 'danger' },
  INLINE_CATEGORY_BTN_STYLE: { title: 'دکمه «دسته‌بندی محصولات»', default: 'success' },
  INLINE_PLAN_RIGHT_BTN_STYLE: { title: 'بسته‌ها — ستون راست', default: 'success' },
  INLINE_PLAN_LEFT_BTN_STYLE: { title: 'بسته‌ها — ستون چپ', default: 'primary' },
  INLINE_PLAN_LAST_BTN_STYLE: { title: 'بسته‌ها — دکمه آخر (تک‌ستونی)', default: 'danger' },
};

export const DB = {
  sessions: new Map(), // chatId -> { step, data } — روی KV هم پایدار می‌شود (پایین را ببینید)
  orders: new Map(), // orderId -> order
  users: new Map(), // userId -> user info (شامل walletBalance)
  cards: new Map(), // cardId -> card info
  admins: new Set(), // آیدی ادمین‌های اضافه‌شده (به‌جز ادمین اصلی)
  settings: {}, // تنظیمات قابل‌تغییر از پنل ادمین
  plans: [], // بسته‌های اینترنتی قابل‌تغییر از پنل ادمین (همیشه آرایه است)
  plansLoaded: false, // آیا لیست بسته‌ها از KV خوانده شده؟ اگر نه، DEFAULT_PLANS پر می‌شود
  testConfigs: [], // استخر کانفیگ‌های تست (حداکثر MAX_TEST_CONFIGS عدد) - هر کدام فقط یک‌بار به یک مشتری تعلق می‌گیرد
  walletRequests: new Map(), // requestId -> درخواست شارژ کیف پول
  referralRewards: new Map(), // rewardId -> درخواست جایزه دعوت دوست (به ازای هر دعوت تایید‌شده)
  channelAds: new Map(), // adId -> پیام تبلیغاتی ارسال‌شده در کانال (با دکمه شیشه‌ای، کاملاً قابل‌ویرایش)
  subscriptions: new Map(), // subId -> اشتراک ساخته‌شده روی پاسارگارد
  tutorials: new Map(), // tutorialId -> {id, title, url} — لینک‌های آموزش، قابل افزودن/ویرایش/حذف از پنل ادمین
  payments: new Map(), // paymentId -> رکورد پرداخت
  notifiedOrders: new Set(), // شماره سفارش‌هایی که اعلانشان به ادمین رفته (ضد تکرار)
  forceJoinEnabled: true, // کلید کلی فعال/غیرفعال کردن عضویت اجباری در کانال
};

// این تابع رنگ سراسری انتخاب‌شده توسط ادمین را روی تک‌تک دکمه‌های شیشه‌ای
// (inline_keyboard) یک reply_markup اعمال می‌کند — مگر اینکه آن دکمه از قبل
// رنگ اختصاصی خودش را داشته باشد (مثل دکمه‌های تبلیغ کانال با style: 'success').
// دکمه‌های «بازگشت به منوی قبلی» (navback:*) رنگ جدا و مستقل از بقیه می‌گیرند.
export function applyGlassStyle(replyMarkup) {
  if (!replyMarkup || !Array.isArray(replyMarkup.inline_keyboard)) return replyMarkup;
  const overrides = (DB && DB.settings) || {};
  const styleFor = (key) =>
    Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : GLASS_STYLE_TARGETS[key].default;
  const actionStyle = styleFor('INLINE_BTN_STYLE');
  const backStyle = styleFor('INLINE_BACK_BTN_STYLE');
  return {
    ...replyMarkup,
    inline_keyboard: replyMarkup.inline_keyboard.map((row) =>
      row.map((btn) => {
        if (!btn || btn.style) return btn; // دکمه‌ای که رنگ اختصاصی خودش را دارد دست‌نخورده می‌ماند
        const isBack =
          btn.text === BACK_BUTTON_TEXT ||
          (typeof btn.callback_data === 'string' && btn.callback_data.startsWith('navback:'));
        const style = isBack ? backStyle : actionStyle;
        return style && ['primary', 'success', 'danger'].includes(style) ? { ...btn, style } : btn;
      })
    ),
  };
}

export function stripTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

/**
 * آدرس پایه پنل را تمیز می‌کند.
 *
 * کاربر معمولاً آدرسی را کپی می‌کند که در مرورگر باز است، مثل
 * «https://panel.example.com/dashboard/». اما API پنل روی ریشه دامنه است و
 * اگر «/dashboard» بماند، درخواست‌ها به فایل‌های داشبورد می‌خورند و پنل
 * جواب 404/405 می‌دهد (چون آن مسیر فقط GET است). پس این پسوندها را حذف می‌کنیم.
 */
export function normalizePanelBaseUrl(value) {
  let url = stripTrailingSlash(value);
  // ممکن است چند لایه باشد: /dashboard/ یا /api/ یا /docs
  for (let i = 0; i < 3; i += 1) {
    const trimmed = url.replace(/\/(dashboard|api|docs|redoc|openapi\.json)$/i, '');
    if (trimmed === url) break;
    url = stripTrailingSlash(trimmed);
  }
  return url;
}

/**
 * مقدار ورودی آیدی کانال را برای استفاده در Bot API نرمال‌سازی می‌کند.
 *
 * تلگرام برای sendMessage/sendPhoto فقط دو نوع chat_id قبول می‌کند:
 *   ۱) آیدی عددی (برای کانال‌های خصوصی همیشه با -100 شروع می‌شود)
 *   ۲) نام کاربری عمومی به‌صورت «@username»
 * لینک‌های دعوت خصوصی (t.me/+... یا t.me/joinchat/...) هیچ‌کدام از این دو
 * نیستند و اگر مستقیماً به‌عنوان chat_id فرستاده شوند، تلگرام خطای
 * «Bad Request: chat not found» می‌دهد. برای کانال خصوصی باید آیدی عددی را
 * از طریق فوروارد یک پست از کانال به ربات به دست آورد (در حین ویرایش این
 * تنظیم، ربات این کار را خودکار انجام می‌دهد).
 *
 * خروجی: { value, invitelink } — اگر invitelink=true یعنی ورودی یک لینک
 * دعوت خصوصی بوده و قابل استفاده مستقیم نیست.
 */
export function normalizeChannelIdInput(raw) {
  const value = String(raw || '').trim();
  if (!value) return { value: '', invitelink: false };
  // آیدی عددی (کانال‌های خصوصی: -100xxxxxxxxxx)
  if (/^-?\d{3,20}$/.test(value)) return { value, invitelink: false };
  // لینک دعوت خصوصی: t.me/+xxxx یا t.me/joinchat/xxxx → قابل تبدیل به chat_id نیست
  if (/t\.me\/(\+|joinchat\/)/i.test(value)) return { value, invitelink: true };
  // لینک عمومی: https://t.me/username یا t.me/username → به @username تبدیل می‌شود
  const publicLinkMatch = value.match(/t\.me\/([A-Za-z0-9_]{5,32})\/?$/i);
  if (publicLinkMatch) return { value: `@${publicLinkMatch[1]}`, invitelink: false };
  // نام کاربری با یا بدون @
  const username = value.replace(/^@/, '');
  if (/^[A-Za-z0-9_]{5,32}$/.test(username)) return { value: `@${username}`, invitelink: false };
  return { value, invitelink: false };
}

// آیدی ادمین‌ها از ADMIN_IDS (چندتایی، با کاما) یا ADMIN_USER_ID قدیمی
export function parseAdminIds(env) {
  const raw = String(env.ADMIN_IDS || env.ADMIN_USER_ID || '');
  const ids = [];
  for (const piece of raw.split(/[,\s;]+/)) {
    const id = piece.trim();
    if (/^\d{3,20}$/.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// نام کاربری پاسارگارد فقط [a-zA-Z0-9-_@.] می‌پذیرد و کاراکتر ویژه تکراری ممنوع است،
// پس پیشوند را به حروف و رقم محدود می‌کنیم.
export function sanitizePgPrefix(value) {
  const clean = String(value || 'bot').replace(/[^a-zA-Z0-9]/g, '11').slice(0, 16);
  return clean || 'pv';
}

export function getConfig(env) {
  const adminIds = parseAdminIds(env);
  const base = {
    // ---------- تلگرام ----------
    BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN || '',
    WEBHOOK_SECRET: String(env.WEBHOOK_SECRET || '__SET_WEBHOOK_SECRET_AS_ENV_VARIABLE__'),
    ADMIN_IDS: adminIds,
    ADMIN_USER_ID: adminIds[0] || 'YOUR_ADMIN_NUMERIC_ID',
    ADMIN_GROUP_ID: env.ADMIN_GROUP_ID || DEFAULTS.ADMIN_GROUP_ID,
    // مقصد اختصاصی اعلان‌های ادمین. اگر خالی باشد، اول گروه ادمین و بعد
    // چت خصوصی اولین ادمین امتحان می‌شود تا اعلان سفارش هیچ‌وقت گم نشود.
    ADMIN_CHAT_ID: String(env.ADMIN_CHAT_ID || 'YOUR_ADMIN_NUMERIC_ID').trim(),
    SUPPORT_USERNAME: env.SUPPORT_USERNAME || DEFAULTS.SUPPORT_USERNAME,
    CHANNEL_ID: env.CHANNEL_ID || DEFAULTS.CHANNEL_ID,
    SHOP_NAME: env.SHOP_NAME || DEFAULTS.SHOP_NAME,
    BTN_SHOP_LABEL: DEFAULTS.BTN_SHOP_LABEL,
    BTN_MYORDERS_LABEL: DEFAULTS.BTN_MYORDERS_LABEL,
    BTN_RENEW_LABEL: DEFAULTS.BTN_RENEW_LABEL,
    BTN_STATUS_LABEL: DEFAULTS.BTN_STATUS_LABEL,
    BTN_WALLET_LABEL: DEFAULTS.BTN_WALLET_LABEL,
    BTN_SUPPORT_LABEL: DEFAULTS.BTN_SUPPORT_LABEL,
    BTN_CHANNEL_LABEL: DEFAULTS.BTN_CHANNEL_LABEL,
    BTN_TESTCONFIG_LABEL: DEFAULTS.BTN_TESTCONFIG_LABEL,
    BTN_INVITE_LABEL: DEFAULTS.BTN_INVITE_LABEL,
    INVITE_TEXT: DEFAULTS.INVITE_TEXT,
    LOW_VOLUME_ALERT_TEXT: DEFAULTS.LOW_VOLUME_ALERT_TEXT,
    REFERRAL_ENABLED: DB.settings.REFERRAL_ENABLED !== false,
    // پورسانت دعوت دوست: به‌ازای هر خریدی که دوست دعوت‌شده انجام دهد، درصدی
    // از مبلغ آن خرید به‌صورت خودکار به کیف پول دعوت‌کننده واریز می‌شود.
    REFERRAL_COMMISSION_ENABLED: DB.settings.REFERRAL_COMMISSION_ENABLED !== false,
    REFERRAL_COMMISSION_PERCENT:
      Number(DB.settings.REFERRAL_COMMISSION_PERCENT) > 0 ? Number(DB.settings.REFERRAL_COMMISSION_PERCENT) : 10,
    WALLET_MIN_TOPUP: getWalletMinTopup(),
    PRODUCT_CATEGORY_TITLE: DEFAULTS.PRODUCT_CATEGORY_TITLE,
    PRODUCT_SELECT_TEXT: DEFAULTS.PRODUCT_SELECT_TEXT,
    WELCOME_EXTRA_TEXT: DEFAULTS.WELCOME_EXTRA_TEXT,
    AD_DEFAULT_BUTTON_TEXT: DEFAULTS.AD_DEFAULT_BUTTON_TEXT,
    AD_DEFAULT_BUTTON_URL: DEFAULTS.AD_DEFAULT_BUTTON_URL,
    // ---------- رنگ‌بندی صفحه وضعیت ----------
    THEME_COLOR_GREEN: DEFAULTS.THEME_COLOR_GREEN,
    THEME_COLOR_BLUE: DEFAULTS.THEME_COLOR_BLUE,
    THEME_COLOR_RED: DEFAULTS.THEME_COLOR_RED,
    THEME_COLOR_BG: DEFAULTS.THEME_COLOR_BG,
    // ---------- رنگ دکمه‌های واقعی ربات تلگرام ----------
    BTN_STYLE_SHOP: DEFAULTS.BTN_STYLE_SHOP,
    BTN_STYLE_MYORDERS: DEFAULTS.BTN_STYLE_MYORDERS,
    BTN_STYLE_RENEW: DEFAULTS.BTN_STYLE_RENEW,
    BTN_STYLE_STATUS: DEFAULTS.BTN_STYLE_STATUS,
    BTN_STYLE_WALLET: DEFAULTS.BTN_STYLE_WALLET,
    BTN_STYLE_TESTCONFIG: DEFAULTS.BTN_STYLE_TESTCONFIG,
    BTN_STYLE_INVITE: DEFAULTS.BTN_STYLE_INVITE,
    BTN_STYLE_SUPPORT: DEFAULTS.BTN_STYLE_SUPPORT,
    BTN_STYLE_CHANNEL: DEFAULTS.BTN_STYLE_CHANNEL,
    // ---------- پاسارگارد (PasarGuard panel API) ----------
    // آدرس پایه پنل. اگر اشتباهاً «/dashboard» یا «/api» هم کپی شده باشد،
    // خودش پاک می‌شود — چون API پنل روی ریشه دامنه است.
    PG_BASE_URL: normalizePanelBaseUrl(env.PASARGUARD_BASE_URL),
    // روش ۱: API Key پنل (همیشه با pg_key_ شروع می‌شود) — با هدر X-Api-Key فرستاده می‌شود
    PG_API_TOKEN: String(env.PASARGUARD_API_TOKEN || '').trim(),
    // روش ۲: نام کاربری/رمز ادمین پنل — از POST /api/admin/token توکن JWT گرفته می‌شود
    PG_USERNAME: String(env.PASARGUARD_USERNAME || '').trim(),
    PG_PASSWORD: String(env.PASARGUARD_PASSWORD || ''),
    // آدرس پایه لینک اشتراک؛ اگر تنظیم نشود از خود آدرس پنل استفاده می‌شود
    PG_SUB_BASE_URL: normalizePanelBaseUrl(env.PASARGUARD_SUB_BASE_URL || env.PASARGUARD_BASE_URL),
    PG_USERNAME_PREFIX: sanitizePgPrefix(env.PG_USERNAME_PREFIX),
    // ---------- درگاه پرداخت ----------
    PAYMENT_CALLBACK_SECRET: String(env.PAYMENT_CALLBACK_SECRET || ''),
    // ---------- درگاه اطلس‌پی (AtlasPay) ----------
    // با ست‌شدن ATLASPAY_API_KEY دکمه «پرداخت آنلاین (اطلس‌پی)» در ربات فعال می‌شود
    ATLASPAY_API_KEY: String(env.ATLASPAY_API_KEY || '').trim(),
    ATLASPAY_WEBHOOK_SECRET: String(env.ATLASPAY_WEBHOOK_SECRET || '').trim(),
    ATLASPAY_BASE_URL: stripTrailingSlash(env.ATLASPAY_BASE_URL) || 'https://api.atlaspay.space/api/v1',
  };
  // تنظیماتی که ادمین از داخل ربات تغییر داده (در KV ذخیره شده) اولویت دارند
  const overrides = DB.settings || {};
  const merged = { ...base };
  for (const key of Object.keys(SETTINGS_FIELDS)) {
    if (overrides[key]) merged[key] = overrides[key];
  }
  // رنگ‌های تم که از صفحه وب /theme ذخیره شده‌اند نیز اولویت دارند
  for (const key of Object.keys(THEME_COLOR_FIELDS)) {
    if (overrides[key]) merged[key] = overrides[key];
  }
  // رنگ دکمه‌های منوی تلگرام؛ چون مقدار «پیش‌فرض» یک رشته خالی معتبر است
  // (نه «تنظیم نشده»)، اینجا باید صریحاً بررسی شود که آیا ادمین اصلاً این
  // مقدار را ذخیره کرده یا نه، نه فقط اینکه مقدار «راست» است یا نه.
  for (const key of Object.keys(BTN_STYLE_TARGETS)) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) merged[key] = overrides[key];
  }
  // رنگ سراسری دکمه‌های شیشه‌ای (اینلاین)؛ مثل بالا، رشته خالی هم مقدار معتبری است
  for (const key of Object.keys(GLASS_STYLE_TARGETS)) {
    merged[key] = Object.prototype.hasOwnProperty.call(overrides, key)
      ? overrides[key]
      : GLASS_STYLE_TARGETS[key].default;
  }
  return merged;
}

// بسته‌های اینترنتی پیش‌فرض (فقط برای اولین اجرا؛ پس از آن لیست واقعی از
// DB.plans خوانده می‌شود که کاملاً از پنل ادمین قابل مدیریت است)
//   gb         = حجم بسته به گیگابایت (۰ = نامحدود)
//   days       = مدت اعتبار به روز — در این نسخه همیشه ۰ است، یعنی
//                کانفیگ‌ها تاریخ انقضا ندارند و فقط با حجم محدود می‌شوند.
//                (فیلد در ساختار داده باقی مانده تا اگر روزی مدت‌دار خواستی
//                 بدون تغییر ساختار قابل استفاده باشد)
//   price      = قیمت به تومان
//   groupIds   = آرایه شناسه گروه‌های پاسارگارد که کاربر باید عضوشان شود
//                (بدون گروه، کاربر ساخته می‌شود ولی هیچ اینباند/کانفیگی ندارد)
//   templateId = اگر پر باشد، کاربر با POST /api/user/from_template ساخته می‌شود
//                و حجم/مدت از همان قالب پنل خوانده می‌شود
//   onHold     = true یعنی شمارش اعتبار از اولین اتصال کاربر شروع شود
// شناسه گروه‌های پاسارگارد برای بسته‌ها (حالت پیش‌فرض) — قالب کاربری پیش‌فرض ندارد
export const DEFAULT_PLAN_GROUP_IDS = [24, 25];

export const DEFAULT_PLANS = [
  { id: 'g5', title: 'گیگ 5', gb: 5, days: 0, price: 20000, groupIds: [...DEFAULT_PLAN_GROUP_IDS], templateId: null, onHold: false },
  { id: 'g10', title: 'گیگ 10', gb: 10, days: 0, price: 40000, groupIds: [...DEFAULT_PLAN_GROUP_IDS], templateId: null, onHold: false },
  { id: 'g15', title: 'گیگ 15', gb: 15, days: 0, price: 60000, groupIds: [...DEFAULT_PLAN_GROUP_IDS], templateId: null, onHold: false },
  { id: 'g20', title: 'گیگ 20', gb: 20, days: 0, price: 80000, groupIds: [...DEFAULT_PLAN_GROUP_IDS], templateId: null, onHold: false },
  { id: 'g25', title: 'گیگ 25', gb: 25, days: 0, price: 100000, groupIds: [...DEFAULT_PLAN_GROUP_IDS], templateId: null, onHold: false },
  { id: 'g30', title: 'گیگ 30', gb: 30, days: 0, price: 120000, groupIds: [...DEFAULT_PLAN_GROUP_IDS], templateId: null, onHold: false },
  { id: 'g35', title: 'گیگ 35', gb: 35, days: 0, price: 140000, groupIds: [...DEFAULT_PLAN_GROUP_IDS], templateId: null, onHold: false },
  { id: 'g40', title: 'گیگ 40', gb: 40, days: 0, price: 160000, groupIds: [...DEFAULT_PLAN_GROUP_IDS], templateId: null, onHold: false },
  { id: 'g45', title: 'گیگ 45', gb: 45, days: 0, price: 180000, groupIds: [...DEFAULT_PLAN_GROUP_IDS], templateId: null, onHold: false },
  { id: 'g50', title: 'گیگ 50', gb: 50, days: 0, price: 200000, groupIds: [...DEFAULT_PLAN_GROUP_IDS], templateId: null, onHold: false },
  { id: 'g60', title: 'گیگ 60', gb: 60, days: 0, price: 240000, groupIds: [...DEFAULT_PLAN_GROUP_IDS], templateId: null, onHold: false },
  { id: 'g70', title: 'گیگ 70', gb: 70, days: 0, price: 280000, groupIds: [...DEFAULT_PLAN_GROUP_IDS], templateId: null, onHold: false },
  { id: 'g80', title: 'گیگ 80', gb: 80, days: 0, price: 320000, groupIds: [...DEFAULT_PLAN_GROUP_IDS], templateId: null, onHold: false },
  { id: 'g90', title: 'گیگ 90', gb: 90, days: 0, price: 360000, groupIds: [...DEFAULT_PLAN_GROUP_IDS], templateId: null, onHold: false },
  { id: 'g100', title: 'گیگ 100', gb: 100, days: 0, price: 400000, groupIds: [...DEFAULT_PLAN_GROUP_IDS], templateId: null, onHold: false },
];

export const PRODUCT_CATEGORY_ID = 'cat_internet';

export const GIGABYTE = 1024 * 1024 * 1024;

// ---------- هشدار خودکار «کم‌شدن حجم اشتراک» ----------
// وقتی حجم باقی‌مانده یک اشتراک به این مقدار (یک گیگ) یا کمتر برسد، یک پیام
// «تمدید حجم» برای خود مشتری فرستاده می‌شود (برای هر اشتراک فقط یک‌بار).
export const LOW_VOLUME_ALERT_BYTES = GIGABYTE;

export const LOW_VOLUME_SCAN_BATCH = 30;

export const LOW_VOLUME_SCAN_INTERVAL_MS = 30 * 60 * 1000;

export const FINISHED_SUB_DELETE_AFTER_MS = 24 * 60 * 60 * 1000;

export const FINISHED_SUB_SCAN_BATCH = 20;

export const LOW_VOLUME_KV_KEY = 'low_volume_alerts_v1';

export const SHARED = {
  lastLowVolumeScanAt: 0,
  lowVolumeAlertsMemo: {}, // اگر KV نبود، فقط در حافظه نگه داشته می‌شود
  orderSeq: 1,
  cardSeq: 1,
  planSeq: 1,
  testConfigSeq: 1,
  walletReqSeq: 1,
  tutorialSeq: 1,
  kvLoadedOnce: false,
  kvBaseRaw: null, // متن دقیق state در KV، همان‌طور که آخرین بار خواندیم/نوشتیم (نسخه پایه ادغام)
  inFlightRequests: 0, // تعداد درخواست‌های در حال پردازش در این instance
  saveQueue: Promise.resolve(true),
  d1RestoreTried: false,
  pgTokenMemo: { token: '', expiresAt: 0 },
  lastAtlasPollAt: 0,
  cachedBotUsername: null,
};

// کلید کش توکن JWT پنل در KV (فقط وقتی از username/password استفاده شود)
export const PG_TOKEN_KV_KEY = 'pg_token_v1';

// نوع سفارش
export const ORDER_KIND = {
  NEW: 'new',
  RENEW: 'renew',
};

// وضعیت اشتراک در دیتابیس ربات
export const SUB_STATUS = {
  ACTIVE: 'active',
  EXPIRED: 'expired',
  LIMITED: 'limited',
  DISABLED: 'disabled',
  ON_HOLD: 'on_hold',
  REVOKED: 'revoked',
};

// برچسب فارسی وضعیت‌هایی که پنل پاسارگارد برمی‌گرداند
export const PG_STATUS_LABEL = {
  active: '✅ فعال',
  on_hold: '⏸ در انتظار اولین اتصال',
  disabled: '🚫 غیرفعال',
  limited: '📉 حجم تمام شده',
  expired: '⌛ منقضی شده',
};

// وضعیت پرداخت
export const PAYMENT_STATUS = {
  PENDING: 'pending',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
  FAILED: 'failed',
};

// حداکثر تعداد کانفیگ تستی که ادمین می‌تواند در استخر تست کانفیگ نگه دارد
export const MAX_TEST_CONFIGS = 50;

export const ORDER_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
  SENT: 'sent',
};

export const STATUS_LABEL = {
  [ORDER_STATUS.PENDING]: '⏳ در انتظار بررسی',
  [ORDER_STATUS.CONFIRMED]: '✅ تایید شده',
  [ORDER_STATUS.REJECTED]: '❌ رد شده',
  [ORDER_STATUS.SENT]: '📨 اشتراک تحویل شد',
};

// وضعیت درخواست‌های شارژ کیف پول
export const WALLET_REQUEST_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
};

export const WALLET_STATUS_LABEL = {
  [WALLET_REQUEST_STATUS.PENDING]: '⏳ در انتظار بررسی',
  [WALLET_REQUEST_STATUS.APPROVED]: '✅ تایید و شارژ شد',
  [WALLET_REQUEST_STATUS.REJECTED]: '❌ رد شده',
};

// حداقل مبلغ شارژ کیف پول (تومان). پیش‌فرض ۵۰٬۰۰۰ تومان؛ ادمین از
// «مدیریت کیف پول ← حداقل مبلغ شارژ» می‌تواند تغییرش دهد (در DB.settings ذخیره می‌شود).
export const DEFAULT_WALLET_MIN_TOPUP = 50000;

export function getWalletMinTopup() {
  const value = Math.round(Number(DB.settings && DB.settings.WALLET_MIN_TOPUP));
  return value > 0 ? value : DEFAULT_WALLET_MIN_TOPUP;
}

export function memGet(map, key) {
  return map.get(key);
}

export function memSet(map, key, value) {
  map.set(key, value);
  return value;
}

export function memDelete(map, key) {
  return map.delete(key);
}

export const STATE_KEY = 'shop_state_v1';

export function releaseInFlight() {
  SHARED.inFlightRequests = Math.max(0, SHARED.inFlightRequests - 1);
}

export function beginRequest() {
  SHARED.inFlightRequests += 1;
}

// خواندن کامل وضعیت از KV (در صورت وجود binding) و پر کردن Mapهای حافظه
export async function loadState(env) {
  if (!env.SHOP_KV) return false;
  try {
    const raw = await env.SHOP_KV.get(STATE_KEY);
    // درخواست دیگری همین الان در این instance در حال کار با حافظه است؛ جایگزین‌کردن حافظه
    // تغییرات ذخیره‌نشده‌ی او را گم می‌کرد. تفاوت با KV هنگام ذخیره ادغام می‌شود.
    if (raw && SHARED.kvLoadedOnce && SHARED.inFlightRequests > 1) return true;
    if (raw) {
      const state = JSON.parse(raw);
      DB.orders = new Map(state.orders || []);
      DB.users = new Map(state.users || []);
      DB.cards = new Map(state.cards || []);
      DB.admins = new Set(state.admins || []);
      DB.settings = state.settings || {};
      DB.plans = Array.isArray(state.plans) ? state.plans : [];
      DB.plansLoaded = Array.isArray(state.plans);
      DB.testConfigs = state.testConfigs || [];
      DB.walletRequests = new Map(state.walletRequests || []);
      DB.referralRewards = new Map(state.referralRewards || []);
      DB.channelAds = new Map(state.channelAds || []);
      DB.subscriptions = new Map(state.subscriptions || []);
      DB.tutorials = new Map(state.tutorials || []);
      DB.payments = new Map(state.payments || []);
      DB.notifiedOrders = new Set(state.notifiedOrders || []);
      DB.forceJoinEnabled = state.forceJoinEnabled !== undefined ? state.forceJoinEnabled : true;
      // ✅ سشن‌های فعال کاربران (مثلاً «awaiting_receipt») هم از KV بازیابی می‌شوند.
      // قبلاً این‌ها فقط در حافظه (RAM) نگه‌داری می‌شدند و چون ربات روی محیط
      // serverless اجرا می‌شود، هر ریکوئست می‌توانست به یک instance جدید برسد
      // و سشن قبلی را نبیند — نتیجه‌اش این بود که مثلاً مشتری بعد از انتخاب کارت،
      // عکس رسید را می‌فرستاد ولی چون سشن گم شده بود، ربات هیچ پاسخی نمی‌داد.
      DB.sessions = new Map(state.sessions || []);
      SHARED.orderSeq = state.orderSeq || 1;
      SHARED.cardSeq = state.cardSeq || 1;
      SHARED.planSeq = state.planSeq || 1;
      SHARED.testConfigSeq = state.testConfigSeq || 1;
      SHARED.walletReqSeq = state.walletReqSeq || 1;
      SHARED.tutorialSeq = state.tutorialSeq || 1;
      SHARED.kvBaseRaw = raw;
    } else {
      SHARED.kvBaseRaw = null;
    }
    SHARED.kvLoadedOnce = true;
    return true;
  } catch (err) {
    console.error('loadState error:', err);
    return false;
  }
}

// حداکثر تعداد شماره سفارشی که برای جلوگیری از اعلان تکراری نگه داشته می‌شود
export const NOTIFIED_ORDERS_LIMIT = 2000;

// عکس کامل state فعلی حافظه (آنچه می‌خواهیم در KV ذخیره شود)
export function buildStateObject() {
  return {
    orders: [...DB.orders.entries()],
    users: [...DB.users.entries()],
    cards: [...DB.cards.entries()],
    admins: [...DB.admins],
    settings: DB.settings,
    plans: DB.plans || [],
    testConfigs: DB.testConfigs || [],
    walletRequests: [...DB.walletRequests.entries()],
    referralRewards: [...DB.referralRewards.entries()],
    channelAds: [...DB.channelAds.entries()],
    subscriptions: [...DB.subscriptions.entries()],
    tutorials: [...DB.tutorials.entries()],
    // فقط آخرین پرداخت‌ها در KV می‌مانند تا حجم state کنترل‌شده بماند؛
    // تاریخچه کامل پرداخت‌ها در D1 نگه داشته می‌شود.
    payments: [...DB.payments.entries()].slice(-1000),
    notifiedOrders: [...DB.notifiedOrders].slice(-NOTIFIED_ORDERS_LIMIT),
    forceJoinEnabled: DB.forceJoinEnabled,
    // فقط سشن‌های «فعال» (غیر idle) ذخیره می‌شوند تا حجم KV با انباشته‌شدن
    // یک رکورد idle به‌ازای هر کاربری که تا حالا پیام داده، بی‌رویه زیاد نشود.
    // سشن‌های idle مهم نیستند چون getSession در صورت نبودشان دوباره می‌سازدشان.
    sessions: [...DB.sessions.entries()].filter(([, s]) => s && s.step && s.step !== 'idle'),
    orderSeq: SHARED.orderSeq,
    cardSeq: SHARED.cardSeq,
    planSeq: SHARED.planSeq,
    testConfigSeq: SHARED.testConfigSeq,
    walletReqSeq: SHARED.walletReqSeq,
    tutorialSeq: SHARED.tutorialSeq,
  };
}

// ---------- ادغام سه‌طرفه‌ی state ----------
export function stateJsonEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// یک مقدار (یک رکورد): base = نسخه پایه، mine = نسخه ما، theirs = نسخه فعلی KV. undefined یعنی «وجود ندارد».
export function mergeStateValue(base, mine, theirs) {
  if (stateJsonEq(mine, base)) return theirs; // ما دست نزده‌ایم → تغییر دیگران
  if (stateJsonEq(theirs, base)) return mine; // دیگران دست نزده‌اند → تغییر ما
  if (isPlainObject(mine) && isPlainObject(theirs)) {
    // هر دو طرف تغییر داده‌اند: فیلد‌به‌فیلد ادغام می‌شود
    const b = isPlainObject(base) ? base : {};
    const out = {};
    const fields = new Set([...Object.keys(b), ...Object.keys(mine), ...Object.keys(theirs)]);
    for (const f of fields) {
      let v;
      if (stateJsonEq(mine[f], b[f])) v = theirs[f];
      else if (stateJsonEq(theirs[f], b[f])) v = mine[f];
      else if (f === 'walletBalance' && typeof mine[f] === 'number' && typeof theirs[f] === 'number') {
        // موجودی کیف پول: تغییر هر دو طرف با هم جمع می‌شود (نه اینکه یکی روی دیگری بنشیند)
        v = theirs[f] + (mine[f] - (Number(b[f]) || 0));
      } else v = mine[f];
      if (v !== undefined) out[f] = v;
    }
    return out;
  }
  return mine; // تعارض روی مقدار ساده: نسخه ما
}

export function mergeEntryLists(baseList, mineList, theirList) {
  const b = new Map(baseList || []);
  const m = new Map(mineList || []);
  const t = new Map(theirList || []);
  const keys = new Set([...b.keys(), ...m.keys(), ...t.keys()]);
  const out = [];
  for (const key of keys) {
    const v = mergeStateValue(b.get(key), m.get(key), t.get(key));
    if (v !== undefined) out.push([key, v]);
  }
  return out;
}

export function mergeValueLists(baseList, mineList, theirList) {
  const b = new Set(baseList || []);
  const m = new Set(mineList || []);
  const t = new Set(theirList || []);
  const out = [];
  for (const v of new Set([...b, ...m, ...t])) {
    const inB = b.has(v);
    const inM = m.has(v);
    const keep = inM === inB ? t.has(v) : inM;
    if (keep) out.push(v);
  }
  return out;
}

export const STATE_ENTRY_KEYS = [
  'orders', 'users', 'cards', 'walletRequests', 'referralRewards',
  'channelAds', 'subscriptions', 'tutorials', 'payments', 'sessions',
];

export const STATE_SEQ_KEYS = ['orderSeq', 'cardSeq', 'planSeq', 'testConfigSeq', 'walletReqSeq', 'tutorialSeq'];

export function mergeStates(base, mine, theirs) {
  const out = {};
  for (const key of STATE_ENTRY_KEYS) out[key] = mergeEntryLists(base[key], mine[key], theirs[key]);
  out.payments = out.payments.slice(-1000);
  out.admins = mergeValueLists(base.admins, mine.admins, theirs.admins);
  out.notifiedOrders = mergeValueLists(base.notifiedOrders, mine.notifiedOrders, theirs.notifiedOrders).slice(
    -NOTIFIED_ORDERS_LIMIT
  );
  out.settings = mergeStateValue(base.settings || {}, mine.settings || {}, theirs.settings || {}) || {};
  for (const key of ['plans', 'testConfigs']) {
    const baseValue = base[key] || [];
    const mineValue = mine[key] || [];
    const theirValue = theirs[key] || [];
    out[key] = stateJsonEq(mineValue, baseValue) ? theirValue : mineValue;
  }
  out.forceJoinEnabled = mergeStateValue(base.forceJoinEnabled, mine.forceJoinEnabled, theirs.forceJoinEnabled);
  if (out.forceJoinEnabled === undefined) out.forceJoinEnabled = true;
  for (const key of STATE_SEQ_KEYS) out[key] = Math.max(Number(mine[key]) || 1, Number(theirs[key]) || 1);
  return out;
}

// نتیجه‌ی ادغام را «درجا» روی حافظه اعمال می‌کند (هویت آبجکت‌هایی که هندلرها در دست دارند حفظ می‌شود)
export function patchMapFromEntries(map, entries, shouldPrune) {
  const seen = new Set();
  for (const [key, value] of entries) {
    seen.add(key);
    const current = map.get(key);
    if (current === value) continue;
    if (isPlainObject(current) && isPlainObject(value)) {
      for (const f of Object.keys(current)) {
        if (!(f in value)) delete current[f];
      }
      Object.assign(current, value);
    } else {
      map.set(key, value);
    }
  }
  for (const key of [...map.keys()]) {
    if (!seen.has(key) && (!shouldPrune || shouldPrune(map.get(key)))) map.delete(key);
  }
}

export function applyMergedToDB(merged) {
  patchMapFromEntries(DB.orders, merged.orders);
  patchMapFromEntries(DB.users, merged.users);
  patchMapFromEntries(DB.cards, merged.cards);
  patchMapFromEntries(DB.walletRequests, merged.walletRequests);
  patchMapFromEntries(DB.referralRewards, merged.referralRewards);
  patchMapFromEntries(DB.channelAds, merged.channelAds);
  patchMapFromEntries(DB.subscriptions, merged.subscriptions);
  patchMapFromEntries(DB.tutorials, merged.tutorials);
  patchMapFromEntries(DB.payments, merged.payments, () => false); // پرداخت‌های قدیمی‌تر در حافظه می‌مانند
  // سشن‌های idle فقط در حافظه‌اند و ذخیره نمی‌شوند؛ پس فقط سشن‌های فعالِ حذف‌شده پاک می‌شوند
  patchMapFromEntries(DB.sessions, merged.sessions, (s) => Boolean(s && s.step && s.step !== 'idle'));
  DB.admins.clear();
  for (const v of merged.admins) DB.admins.add(v);
  DB.notifiedOrders.clear();
  for (const v of merged.notifiedOrders) DB.notifiedOrders.add(v);
  if (merged.settings !== DB.settings) {
    for (const k of Object.keys(DB.settings)) {
      if (!(k in merged.settings)) delete DB.settings[k];
    }
    Object.assign(DB.settings, merged.settings);
  }
  for (const key of ['plans', 'testConfigs']) {
    if (merged[key] !== DB[key]) DB[key].splice(0, DB[key].length, ...merged[key]);
  }
  DB.forceJoinEnabled = merged.forceJoinEnabled;
  SHARED.orderSeq = Math.max(SHARED.orderSeq, merged.orderSeq);
  SHARED.cardSeq = Math.max(SHARED.cardSeq, merged.cardSeq);
  SHARED.planSeq = Math.max(SHARED.planSeq, merged.planSeq);
  SHARED.testConfigSeq = Math.max(SHARED.testConfigSeq, merged.testConfigSeq);
  SHARED.walletReqSeq = Math.max(SHARED.walletReqSeq, merged.walletReqSeq);
  SHARED.tutorialSeq = Math.max(SHARED.tutorialSeq, merged.tutorialSeq);
}

export async function saveStateNow(env) {
  if (!env.SHOP_KV) return false;
  // ⚠️ محافظ داده: اگر خواندن state از KV در این instance موفق نبوده (مثلاً خطای
  // موقت)، حافظه خالی است و نوشتن آن روی KV تمام اطلاعات کاربران را پاک می‌کرد.
  if (!SHARED.kvLoadedOnce) {
    console.error('saveState skipped: KV state was never loaded successfully (protecting stored data)');
    return false;
  }
  try {
    const mine = buildStateObject();
    let toWrite = mine;
    let merged = false;
    // اگر در این فاصله درخواست/instance دیگری KV را عوض کرده باشد، تغییرات او نباید گم شود
    const rawNow = await env.SHOP_KV.get(STATE_KEY).catch(() => null);
    if (rawNow && rawNow !== SHARED.kvBaseRaw) {
      try {
        const base = SHARED.kvBaseRaw ? JSON.parse(SHARED.kvBaseRaw) : {};
        toWrite = mergeStates(base, mine, JSON.parse(rawNow));
        merged = true;
      } catch (mergeErr) {
        console.error('state merge failed, writing local state:', mergeErr);
        toWrite = mine;
      }
    }
    const body = JSON.stringify(toWrite);
    await env.SHOP_KV.put(STATE_KEY, body);
    SHARED.kvBaseRaw = body;
    if (merged) applyMergedToDB(toWrite);
    return true;
  } catch (err) {
    console.error('saveState error:', err);
    return false;
  }
}

export function saveState(env) {
  const run = () => saveStateNow(env);
  const result = SHARED.saveQueue.then(run, run);
  SHARED.saveQueue = result.catch(() => false);
  return result;
}

export async function restoreFromD1IfEmpty(env) {
  if (SHARED.d1RestoreTried || !hasD1(env)) return false;
  SHARED.d1RestoreTried = true;
  if (DB.users.size > 0 || DB.subscriptions.size > 0) return false;
  try {
    const userRows = await d1All(
      env,
      `SELECT telegram_id, username, first_name, last_name, wallet_balance, test_claimed FROM users`
    );
    const subRows = await d1All(
      env,
      `SELECT id, telegram_id, order_id, plan_id, plan_title, pg_username, pg_user_id, data_limit_bytes,
              used_traffic_bytes, start_at, expire_at, subscription_url, status, previous_id,
              last_synced_at, created_at FROM subscriptions`
    );
    if (userRows.length === 0 && subRows.length === 0) return false;

    for (const row of userRows) {
      const id = String(row.telegram_id);
      DB.users.set(id, {
        id,
        orders: [],
        walletBalance: Number(row.wallet_balance) || 0,
        username: row.username || null,
        firstName: row.first_name || '',
        lastName: row.last_name || '',
        testConfigClaimed: Boolean(row.test_claimed),
      });
    }
    const ms = (sec) => (sec ? Number(sec) * 1000 : null);
    for (const row of subRows) {
      const userId = String(row.telegram_id);
      if (!DB.users.has(userId)) DB.users.set(userId, { id: userId, orders: [], walletBalance: 0 });
      DB.subscriptions.set(String(row.id), {
        id: String(row.id),
        userId,
        chatId: userId,
        orderId: row.order_id || null,
        planId: row.plan_id || null,
        planTitle: row.plan_title || '',
        pgUsername: row.pg_username,
        pgUserId: row.pg_user_id === undefined ? null : row.pg_user_id,
        dataLimitBytes: Number(row.data_limit_bytes) || 0,
        usedTrafficBytes: Number(row.used_traffic_bytes) || 0,
        startAt: ms(row.start_at),
        expireAt: ms(row.expire_at),
        subscriptionUrl: row.subscription_url || '',
        status: row.status || 'active',
        previousId: row.previous_id || null,
        lastSyncedAt: ms(row.last_synced_at),
        createdAt: ms(row.created_at) || Date.now(),
      });
    }
    console.log(`[RESTORE] restored from D1: ${userRows.length} users, ${subRows.length} subscriptions`);
    await saveState(env); // اگر KV وصل باشد، همین‌جا دوباره پایدار می‌شود
    return true;
  } catch (err) {
    console.error('restoreFromD1IfEmpty error:', err);
    return false;
  }
}

export function isPersistenceEnabled(env) {
  return Boolean(env.SHOP_KV);
}

// اطمینان از اینکه لیست بسته‌ها همیشه مقداردهی شده باشد (اولین اجرا / بدون KV)
export function ensurePlansLoaded() {
  // اگر لیست بسته‌ها هرگز در KV ذخیره نشده باشد، با بسته‌های پیش‌فرض پر می‌شود.
  // توجه: لیست خالیِ ذخیره‌شده (یعنی ادمین همه را حذف کرده) دست‌نخورده می‌ماند.
  if (!DB.plansLoaded) {
    DB.plans = DEFAULT_PLANS.map((p) => ({ ...p, groupIds: [...p.groupIds] }));
    DB.plansLoaded = true;
  }
  // مهاجرت نرم: بسته‌های ساخته‌شده با نسخه قبلی ربات فیلدهای جدید را ندارند
  // (کانفیگ‌ها تاریخ انقضا ندارند، پس مدت همیشه صفر می‌ماند)
  for (const plan of DB.plans) {
    if (plan.days === undefined || plan.days === null) plan.days = 0;
    if (!Array.isArray(plan.groupIds)) plan.groupIds = [];
    if (plan.templateId === undefined) plan.templateId = null;
    if (plan.onHold === undefined) plan.onHold = false;
  }
}

export const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

// مراحلی که مهلت اختصاصی خودشان را دارند (مثلاً 30 دقیقه برای ارسال رسید)
// و نباید با تایم‌اوت عمومی 10 دقیقه‌ای session زودتر از موعد ریست شوند.
export const SESSION_TIMEOUT_EXEMPT_STEPS = new Set(['awaiting_receipt', 'awaiting_wallet_receipt']);

export function getSession(chatId) {
  if (!DB.sessions.has(chatId)) {
    memSet(DB.sessions, chatId, { step: 'idle', data: {}, updatedAt: Date.now() });
  }
  const s = memGet(DB.sessions, chatId);
  // اگر سشن بیش از 10 دقیقه نیست آپدیت نشده باشد و فعال باشد، ریست کن
  // (به‌جز مراحلی که مهلت اختصاصی طولانی‌تر خودشان مثل receiptDeadline را دارند)
  if (
    s.step !== 'idle' &&
    !SESSION_TIMEOUT_EXEMPT_STEPS.has(s.step) &&
    s.updatedAt &&
    Date.now() - s.updatedAt > SESSION_TIMEOUT_MS
  ) {
    const fresh = { step: 'idle', data: {}, updatedAt: Date.now(), _timedOut: true };
    memSet(DB.sessions, chatId, fresh);
    return fresh;
  }
  return s;
}

export function setSession(chatId, session) {
  session.updatedAt = Date.now();
  return memSet(DB.sessions, chatId, session);
}

export function resetSession(chatId) {
  return memSet(DB.sessions, chatId, { step: 'idle', data: {}, updatedAt: Date.now() });
}

export function isAdmin(userId, config) {
  const idStr = String(userId);
  // ADMIN_IDS می‌تواند چند ادمین (با کاما) داشته باشد
  if (Array.isArray(config.ADMIN_IDS) && config.ADMIN_IDS.includes(idStr)) return true;
  if (config.ADMIN_USER_ID && idStr === config.ADMIN_USER_ID) return true;
  return DB.admins.has(idStr);
}

export function getWallet(userId) {
  const user = memGet(DB.users, String(userId));
  return user && user.walletBalance ? user.walletBalance : 0;
}

export function addWalletBalance(userId, amount) {
  const idStr = String(userId);
  const user = memGet(DB.users, idStr) || { id: idStr, orders: [], walletBalance: 0 };
  user.walletBalance = (user.walletBalance || 0) + amount;
  memSet(DB.users, idStr, user);
  return user.walletBalance;
}

// در صورت کافی بودن موجودی، مبلغ را کسر می‌کند و true برمی‌گرداند؛ در غیر این صورت false
export function deductWalletBalance(userId, amount) {
  const idStr = String(userId);
  const user = memGet(DB.users, idStr) || { id: idStr, orders: [], walletBalance: 0 };
  const current = user.walletBalance || 0;
  if (current < amount) return false;
  user.walletBalance = current - amount;
  memSet(DB.users, idStr, user);
  return true;
}

export function hasD1(env) {
  return Boolean(env && env.DB && typeof env.DB.prepare === 'function');
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function newId(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

// کلیدهایی که هرگز نباید در لاگ یا ستون raw ذخیره شوند
export const SENSITIVE_KEYS = [
  'token',
  'password',
  'secret',
  'authorization',
  'api_key',
  'apikey',
  'access_token',
  'bot_token',
  'signature',
  'sign',
];

// حذف مقادیر حساس از آبجکت قبل از لاگ/ذخیره
export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 25).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (SENSITIVE_KEYS.some((s) => lower.includes(s))) {
        out[key] = '[redacted]';
      } else {
        out[key] = redact(val, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 400) return `${value.slice(0, 400)}…`;
  return value;
}

export async function d1Run(env, sql, params = []) {
  if (!hasD1(env)) return null;
  try {
    return await env.DB.prepare(sql)
      .bind(...params)
      .run();
  } catch (err) {
    console.error('D1 run error:', err && err.message ? err.message : err);
    return null;
  }
}

export async function d1All(env, sql, params = []) {
  if (!hasD1(env)) return [];
  try {
    const res = await env.DB.prepare(sql)
      .bind(...params)
      .all();
    return (res && res.results) || [];
  } catch (err) {
    console.error('D1 all error:', err && err.message ? err.message : err);
    return [];
  }
}

export async function d1First(env, sql, params = []) {
  if (!hasD1(env)) return null;
  try {
    return await env.DB.prepare(sql)
      .bind(...params)
      .first();
  } catch (err) {
    console.error('D1 first error:', err && err.message ? err.message : err);
    return null;
  }
}

export async function dbLog(env, level, scope, message, meta = {}, ids = {}) {
  const safeMeta = JSON.stringify(redact(meta) || {}).slice(0, 2000);
  console.log(`[${level}][${scope}] ${message}`);
  await d1Run(
    env,
    `INSERT INTO logs (level, scope, telegram_id, order_id, message, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      level,
      scope,
      ids.telegramId ? String(ids.telegramId) : null,
      ids.orderId ? String(ids.orderId) : null,
      String(message).slice(0, 500),
      safeMeta,
      nowSec(),
    ]
  );
}

export async function dbUpsertUser(env, from) {
  if (!hasD1(env) || !from) return;
  const ts = nowSec();
  await d1Run(
    env,
    `INSERT INTO users (telegram_id, username, first_name, last_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username   = excluded.username,
       first_name = excluded.first_name,
       last_name  = excluded.last_name,
       updated_at = excluded.updated_at`,
    [String(from.id), from.username || null, from.first_name || null, from.last_name || null, ts, ts]
  );
}

export async function dbSyncUserWallet(env, telegramId, balance) {
  await d1Run(env, `UPDATE users SET wallet_balance = ?, updated_at = ? WHERE telegram_id = ?`, [
    Math.round(Number(balance) || 0),
    nowSec(),
    String(telegramId),
  ]);
}

export async function dbSyncPlan(env, plan) {
  if (!hasD1(env) || !plan) return;
  const ts = nowSec();
  await d1Run(
    env,
    `INSERT INTO plans (id, title, data_limit_gb, duration_days, price, group_ids, template_id, on_hold, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       title         = excluded.title,
       data_limit_gb = excluded.data_limit_gb,
       duration_days = excluded.duration_days,
       price         = excluded.price,
       group_ids     = excluded.group_ids,
       template_id   = excluded.template_id,
       on_hold       = excluded.on_hold,
       is_active     = 1,
       updated_at    = excluded.updated_at`,
    [
      String(plan.id),
      String(plan.title || ''),
      Number(plan.gb) || 0,
      Number(plan.days) || 0,
      Number(plan.price) || 0,
      JSON.stringify(Array.isArray(plan.groupIds) ? plan.groupIds : []),
      plan.templateId === null || plan.templateId === undefined ? null : Number(plan.templateId),
      plan.onHold ? 1 : 0,
      ts,
      ts,
    ]
  );
}

export async function dbDeactivatePlan(env, planId) {
  await d1Run(env, `UPDATE plans SET is_active = 0, updated_at = ? WHERE id = ?`, [nowSec(), String(planId)]);
}

export async function dbSaveOrder(env, order) {
  if (!hasD1(env) || !order) return;
  const ts = nowSec();
  await d1Run(
    env,
    `INSERT INTO orders (id, telegram_id, plan_id, plan_title, kind, renew_of, amount, status, payment_provider, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       status           = excluded.status,
       payment_provider = excluded.payment_provider,
       note             = excluded.note,
       updated_at       = excluded.updated_at`,
    [
      String(order.id),
      String(order.userId),
      order.planId ? String(order.planId) : null,
      order.planTitle || null,
      order.kind || ORDER_KIND.NEW,
      order.renewOf ? String(order.renewOf) : null,
      Math.round(Number(order.price) || 0),
      order.status || ORDER_STATUS.PENDING,
      order.paidVia || null,
      order.note || null,
      Math.floor((order.createdAt || Date.now()) / 1000),
      ts,
    ]
  );
}

export async function dbSavePayment(env, payment) {
  if (!hasD1(env) || !payment) return;
  const ts = nowSec();
  await d1Run(
    env,
    `INSERT INTO payments (id, order_id, telegram_id, provider, amount, currency, status, reference, raw, verified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       status      = excluded.status,
       reference   = excluded.reference,
       raw         = excluded.raw,
       verified_at = excluded.verified_at,
       updated_at  = excluded.updated_at`,
    [
      String(payment.id),
      payment.orderId ? String(payment.orderId) : null,
      String(payment.userId),
      payment.provider,
      Math.round(Number(payment.amount) || 0),
      payment.currency || 'IRT',
      payment.status || PAYMENT_STATUS.PENDING,
      payment.reference || null,
      JSON.stringify(redact(payment.raw || {})).slice(0, 2000),
      payment.verifiedAt ? Math.floor(payment.verifiedAt / 1000) : null,
      Math.floor((payment.createdAt || Date.now()) / 1000),
      ts,
    ]
  );
}

export async function dbSaveSubscription(env, sub) {
  if (!hasD1(env) || !sub) return;
  const ts = nowSec();
  await d1Run(
    env,
    `INSERT INTO subscriptions (id, telegram_id, order_id, plan_id, plan_title, pg_username, pg_user_id,
        data_limit_bytes, used_traffic_bytes, start_at, expire_at, subscription_url, status,
        previous_id, last_synced_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       pg_user_id         = excluded.pg_user_id,
       data_limit_bytes   = excluded.data_limit_bytes,
       used_traffic_bytes = excluded.used_traffic_bytes,
       expire_at          = excluded.expire_at,
       subscription_url   = excluded.subscription_url,
       status             = excluded.status,
       last_synced_at     = excluded.last_synced_at,
       updated_at         = excluded.updated_at`,
    [
      String(sub.id),
      String(sub.userId),
      sub.orderId ? String(sub.orderId) : null,
      sub.planId ? String(sub.planId) : null,
      sub.planTitle || null,
      String(sub.pgUsername),
      sub.pgUserId === null || sub.pgUserId === undefined ? null : Number(sub.pgUserId),
      Math.round(Number(sub.dataLimitBytes) || 0),
      Math.round(Number(sub.usedTrafficBytes) || 0),
      sub.startAt ? Math.floor(sub.startAt / 1000) : null,
      sub.expireAt ? Math.floor(sub.expireAt / 1000) : null,
      sub.subscriptionUrl || null,
      sub.status || SUB_STATUS.ACTIVE,
      sub.previousId ? String(sub.previousId) : null,
      sub.lastSyncedAt ? Math.floor(sub.lastSyncedAt / 1000) : null,
      Math.floor((sub.createdAt || Date.now()) / 1000),
      ts,
    ]
  );
}

// آمار سریع برای پنل ادمین (فقط وقتی D1 وصل باشد)
export async function dbStats(env) {
  if (!hasD1(env)) return null;
  const row = await d1First(
    env,
    `SELECT
       (SELECT COUNT(*) FROM subscriptions)                          AS subs_total,
       (SELECT COUNT(*) FROM subscriptions WHERE status = 'active')   AS subs_active,
       (SELECT COUNT(*) FROM payments WHERE status = 'verified')      AS pay_verified,
       (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'verified') AS pay_sum,
       (SELECT COUNT(*) FROM logs WHERE level = 'error')              AS log_errors`
  );
  return row || null;
}

export async function callTelegram(token, method, payload) {
  // token is ignored: Telegram Serverless calls the Bot API for this bot directly.
  // Global glass-button style chosen by the admin is applied to every inline keyboard.
  const finalPayload =
    payload && payload.reply_markup
      ? { ...payload, reply_markup: applyGlassStyle(payload.reply_markup) }
      : payload;
  try {
    const result = await api[method](finalPayload || {});
    return { ok: true, result };
  } catch (err) {
    if (err instanceof BotApiError) {
      console.error(`Telegram API error [${method}]:`, err.code, err.description);
      return { ok: false, error_code: err.code, description: err.description, parameters: err.parameters };
    }
    console.error(`Telegram API exception [${method}]:`, err);
    return { ok: false, error: String(err) };
  }
}

export function sendMessage(token, chatId, text, options = {}) {
  return callTelegram(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...options,
  });
}

export function editMessageText(token, chatId, messageId, text, options = {}) {
  return callTelegram(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...options,
  });
}

export function answerCallbackQuery(token, callbackQueryId, text = '', showAlert = false) {
  return callTelegram(token, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  });
}

export function sendPhoto(token, chatId, fileId, caption = '', options = {}) {
  return callTelegram(token, 'sendPhoto', {
    chat_id: chatId,
    photo: fileId,
    caption,
    parse_mode: 'HTML',
    ...options,
  });
}

export function editMessageCaption(token, chatId, messageId, caption, options = {}) {
  return callTelegram(token, 'editMessageCaption', {
    chat_id: chatId,
    message_id: messageId,
    caption,
    parse_mode: 'HTML',
    ...options,
  });
}

export function editMessageMedia(token, chatId, messageId, media, options = {}) {
  return callTelegram(token, 'editMessageMedia', {
    chat_id: chatId,
    message_id: messageId,
    media,
    ...options,
  });
}

export function editMessageReplyMarkup(token, chatId, messageId, replyMarkup) {
  return callTelegram(token, 'editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup || { inline_keyboard: [] },
  });
}

export function deleteMessage(token, chatId, messageId) {
  return callTelegram(token, 'deleteMessage', { chat_id: chatId, message_id: messageId });
}

export function getMe(token) {
  return callTelegram(token, 'getMe', {});
}

export function getChatMember(token, chatId, userId) {
  return callTelegram(token, 'getChatMember', { chat_id: chatId, user_id: userId });
}

// بررسی می‌کند آیا کاربر عضو کانال تنظیم‌شده (config.CHANNEL_ID) هست یا نه.
// اگر ربات ادمین کانال نباشد یا خطایی رخ دهد، برای جلوگیری از قفل‌شدن کامل
// ربات، به‌صورت fail-open عمل می‌شود (یعنی کاربر مسدود نمی‌شود).
export async function isChannelMember(config, userId) {
  if (!config.CHANNEL_ID) return true;
  try {
    const res = await getChatMember(config.BOT_TOKEN, config.CHANNEL_ID, userId);
    if (!res.ok) {
      console.error('isChannelMember error:', JSON.stringify(res));
      return true;
    }
    const status = res.result.status;
    return ['creator', 'administrator', 'member'].includes(status);
  } catch (err) {
    console.error('isChannelMember exception:', err);
    return true;
  }
}

// منوی دستورات ربات برای همه کاربران
export function setMyCommands(token) {
  return callTelegram(token, 'setMyCommands', {
    commands: [
      { command: 'start', description: '🏠 شروع / منوی اصلی' },
      { command: 'invite', description: '👥 دعوت دوستان' },
      { command: 'buy', description: '🛒 خرید اشتراک' },
      { command: 'mysubs', description: '📦 اشتراک‌های من' },
      { command: 'renew', description: '🔄 تمدید اشتراک' },
      { command: 'wallet', description: '💰 کیف پول من' },
      { command: 'testconfig', description: '🎁 تست کانفیگ رایگان' },
      { command: 'orders', description: '🧾 تاریخچه سفارش‌ها' },
      { command: 'support', description: '🎫 پشتیبانی' },
      { command: 'cancel', description: '❌ لغو عملیات جاری' },
    ],
  });
}

// منوی دستورات مخصوص ادمین (شامل /admin و /sub) — فقط برای چت ادمین‌ها تنظیم
// می‌شود تا این دستورها در منوی دستورات مشتری‌ها دیده نشوند.
export function setAdminCommands(token, adminUserId) {
  return callTelegram(token, 'setMyCommands', {
    scope: { type: 'chat', chat_id: Number(adminUserId) },
    commands: [
      { command: 'start', description: '🏠 شروع / منوی اصلی' },
      { command: 'invite', description: '👥 دعوت دوستان' },
      { command: 'admin', description: '🛠 پنل مدیریت' },
      { command: 'sub', description: '🛰 مدیریت یک اشتراک (نام کاربری پنل)' },
      { command: 'buy', description: '🛒 خرید اشتراک' },
      { command: 'mysubs', description: '📦 اشتراک‌های من' },
      { command: 'renew', description: '🔄 تمدید اشتراک' },
      { command: 'wallet', description: '💰 کیف پول من' },
      { command: 'support', description: '🎫 پشتیبانی' },
      { command: 'cancel', description: '❌ لغو عملیات جاری' },
    ],
  });
}

// تبدیل متن HTML به متن ساده — برای آخرین تلاش ارسال وقتی تلگرام
// به هر دلیلی parse_mode=HTML را رد می‌کند (مثلاً کاراکتر عجیب در نام مشتری)
export function stripHtmlTags(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * تحویل پیام به یک چت با سه تلاش پشت‌سرهم، تا اعلان به هیچ دلیلی گم نشود:
 *   ۱) عکس رسید با کپشن  ۲) پیام متنی HTML  ۳) متن ساده بدون HTML و بدون دکمه
 * هیچ‌وقت throw نمی‌کند (callTelegram خطا را به {ok:false} تبدیل می‌کند).
 */
export async function deliverAdminMessage(config, chatId, text, photoFileId, replyMarkup) {
  const extra = replyMarkup ? { reply_markup: replyMarkup } : {};
  const errors = [];

  if (photoFileId) {
    const photo = await sendPhoto(config.BOT_TOKEN, chatId, photoFileId, text, extra);
    if (photo && photo.ok) return { ok: true, via: 'photo', errors };
    errors.push(`photo: ${(photo && photo.description) || 'ارسال ناموفق'}`);
  }

  const html = await sendMessage(config.BOT_TOKEN, chatId, text, extra);
  if (html && html.ok) return { ok: true, via: 'text', errors };
  errors.push(`text: ${(html && html.description) || 'ارسال ناموفق'}`);

  // آخرین تلاش: بدون parse_mode و بدون reply_markup تا مشکل‌های قالب‌بندی
  // یا دکمه نتوانند جلوی رسیدن خودِ اعلان را بگیرند
  const plain = await sendMessage(config.BOT_TOKEN, chatId, stripHtmlTags(text), { parse_mode: undefined });
  if (plain && plain.ok) return { ok: true, via: 'plain', errors };
  errors.push(`plain: ${(plain && plain.description) || 'ارسال ناموفق'}`);

  return { ok: false, via: null, errors };
}

// فهرست مقصدهای اعلان، به‌ترتیب اولویت و بدون تکرار
export function adminNotifyTargets(config) {
  const targets = [];
  const add = (value) => {
    const id = String(value || '').trim();
    if (id && !targets.includes(id)) targets.push(id);
  };

  add(config.ADMIN_CHAT_ID);
  add(config.ADMIN_GROUP_ID);
  for (const adminId of config.ADMIN_IDS || []) add(adminId);
  return targets;
}

/**
 * ارسال اعلان به ادمین.
 * @returns {Promise<{ok: boolean, chatId: string|null, via: string|null, skipped: boolean, errors: string[]}>}
 */
export async function notifyAdmins(env, config, options = {}) {
  const { text, photoFileId = null, replyMarkup = null, orderId = null, once = true } = options;

  const dedupeKey = orderId === null || orderId === undefined ? '' : String(orderId);
  if (once && dedupeKey && DB.notifiedOrders.has(dedupeKey)) {
    return { ok: true, chatId: null, via: null, skipped: true, errors: [] };
  }

  const targets = adminNotifyTargets(config);
  const errors = [];

  for (const chatId of targets) {
    const delivered = await deliverAdminMessage(config, chatId, text, photoFileId, replyMarkup);
    if (delivered.ok) {
      if (dedupeKey) rememberNotifiedOrder(dedupeKey);
      return { ok: true, chatId, via: delivered.via, skipped: false, errors };
    }
    for (const err of delivered.errors) errors.push(`${chatId}: ${err}`);
  }

  // لاگ هم اگر ممکن نبود، پردازش سفارش نباید متوقف شود
  try {
    await dbLog(env, 'error', 'telegram', 'admin notification failed', { targets, errors }, { orderId });
  } catch (err) {
    console.error('admin notification log failed:', err);
  }
  return { ok: false, chatId: null, via: null, skipped: false, errors };
}

export function rememberNotifiedOrder(key) {
  DB.notifiedOrders.add(String(key));
  // مجموعه را کوتاه نگه می‌داریم تا حجم state در KV کنترل‌شده بماند
  if (DB.notifiedOrders.size > NOTIFIED_ORDERS_LIMIT) {
    const keys = [...DB.notifiedOrders];
    DB.notifiedOrders = new Set(keys.slice(keys.length - NOTIFIED_ORDERS_LIMIT));
  }
}
