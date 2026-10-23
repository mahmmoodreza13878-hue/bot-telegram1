# ربات فروش اشتراک VPN (PasarGuard) — نسخه Telegram Serverless

ربات تلگرامی فروش اشتراک با اتصال به پنل **PasarGuard**، که بدون سرور و روی هاست رایگان
[Telegram Serverless](https://core.telegram.org/bots/serverless) اجرا می‌شود.

> **English summary:** A Telegram shop bot for selling VPN subscriptions through a PasarGuard panel,
> running entirely on Telegram Serverless (no VPS needed). Wallet, orders, card-to-card top-ups,
> AtlasPay online payments, referral commissions, admin panel and test configs are included.
> Copy `tgcloud/lib/secrets.example.js` to `secrets.js`, fill it in, then `npx tgcloud push` and `npx tgcloud migrate`.

## امکانات

- خرید اشتراک، تمدید، لیست اشتراک‌های من و نمایش مصرف/تاریخ انقضا
- کیف پول، شارژ کارت‌به‌کارت با تایید ادمین، و پرداخت آنلاین اطلس‌پی
- ساخت خودکار کاربر در PasarGuard و تحویل لینک اشتراک
- کانفیگ تست، کمیسیون دعوت (رفرال)، پیام همگانی، دکمه‌های تبلیغاتی
- پنل ادمین کامل داخل خود ربات (`/admin`): بسته‌ها، کارت‌ها، کاربران، سفارش‌ها، گزارش‌ها
- هشدار کم‌شدن حجم برای کاربران

## ساختار پروژه

```
tgcloud/
├── schema.js                 تعریف جدول‌های SQLite (kv_store, users, orders, ...)
├── handlers/
│   ├── message.js            همه‌ی پیام‌ها (متن، دستورها، عکس رسید)
│   └── callback_query.js     دکمه‌های شیشه‌ای
└── lib/
    ├── secrets.example.js    نمونه‌ی تنظیمات محرمانه (در گیت)
    ├── secrets.js            تنظیمات واقعی شما (در .gitignore، خودتان می‌سازید)
    ├── runtime.js            لایه‌ی سازگاری KV/D1 روی SQLite + نقطه ورود
    ├── core.js               تنظیمات، ذخیره‌ی وضعیت، API تلگرام، اعلان‌ها
    ├── pasarguard.js         ارتباط با پنل PasarGuard
    ├── payments.js / atlaspay.js / atlaspay2.js   پرداخت
    ├── keyboards.js / format.js / delivery.js     رابط کاربری و تحویل سفارش
    └── handlers.js / subs.js / pgadmin.js / suba.js / router.js   منطق ربات
```

## پیش‌نیازها

- [Node.js](https://nodejs.org) نسخه ۲۰ یا بالاتر
- یک ربات در [@BotFather](https://t.me/BotFather) با قابلیت **Serverless** فعال
  (BotFather ← Mini App ← ربات شما ← Serverless ← روشن)
- یک پنل PasarGuard با آدرس **https** و یک API Key (`pg_key_...`)
- آیدی عددی خودتان (از [@userinfobot](https://t.me/userinfobot))

## راه‌اندازی

### ۱. ساخت پروژه‌ی tgcloud

```bash
npm create @tgcloud/bot mybot
cd mybot
```

> دستور باید اسم پوشه داشته باشد (مثلاً `mybot`) و بهتر است در پوشه‌ای مثل Desktop اجرا شود، نه `System32`.

وقتی پرسید «Link your bot now?» می‌توانید `n` بزنید و در مرحله ۳ وصل کنید.

### ۲. کپی کد این مخزن

```bash
git clone https://github.com/YOUR_USERNAME/telegram-vpn-shop-bot.git
```

پوشه‌ی `tgcloud/` این مخزن را روی پوشه‌ی `tgcloud/` پروژه‌ی `mybot` کپی کنید
(و `handlers/message.js` پیش‌فرض را جایگزین کنید).

### ۳. اتصال به ربات

توکن را از BotFather بگیرید: ربات ← Serverless ← **CLI Access** ← Access token (شروع با `app...`).

```bash
npx tgcloud login
```

توکن را paste کنید (در ویندوز: راست‌کلیک). ورودی مخفی است و چیزی نشان داده نمی‌شود.

### ۴. تنظیمات محرمانه

```bash
cd tgcloud/lib
copy secrets.example.js secrets.js      # لینوکس/مک: cp secrets.example.js secrets.js
```

فایل `secrets.js` را باز و پر کنید:

| کلید | توضیح |
|---|---|
| `ADMIN_IDS` | آیدی عددی ادمین‌ها با کاما (اجباری) |
| `PASARGUARD_BASE_URL` | آدرس پنل، مثل `https://panel.example.com:8000` (اجباری) |
| `PASARGUARD_API_TOKEN` | کلید API پنل (توصیه‌شده) |
| `PASARGUARD_USERNAME` / `PASARGUARD_PASSWORD` | جایگزین API Key |
| `PASARGUARD_SUB_BASE_URL` | فقط اگر آدرس لینک اشتراک با آدرس پنل فرق دارد |
| `ATLASPAY_API_KEY` | اختیاری؛ با پر کردن، پرداخت آنلاین فعال می‌شود |
| `ADMIN_CHAT_ID` | مقصد اعلان سفارش‌ها (گروه یا آیدی شما؛ خالی = اولین ادمین) |
| `CHANNEL_ID` | کانال جوین اجباری، مثل `@mychannel` |
| `SUPPORT_USERNAME`, `SHOP_NAME` | پشتیبانی و اسم فروشگاه |

### ۵. آپلود و ساخت دیتابیس

```bash
cd ../..            # برگشت به ریشه‌ی پروژه (جایی که tgcloud.jsonc هست)
npx tgcloud push
npx tgcloud migrate
```

### ۶. تست

در تلگرام به ربات `/start` بزنید. برای تنظیم بسته‌ها و کارت‌ها: `/admin`.

## اگر در ایران هستید (فیلتر `cloud.telegram.org`)

ابزار `tgcloud` برای `push` و `login` به `cloud.telegram.org` وصل می‌شود. ترمینال باید از VPN رد شود:

- ساده‌ترین راه: VPN را روی حالت کل سیستم (TUN) روشن کنید؛ یا
- با v2rayN (پورت HTTP پیش‌فرض 10809):

```bat
npm install undici
echo const {setGlobalDispatcher,ProxyAgent}=require("undici");setGlobalDispatcher(new ProxyAgent("http://127.0.0.1:10809")); > proxy.js
set NODE_OPTIONS=--require %CD%\proxy.js
npx tgcloud push
```

(`set` فقط برای همان پنجره‌ی ترمینال معتبر است.)

## محدودیت‌های Telegram Serverless

- **Cron مستند نشده:** هشدار کم‌شدن حجم (حداکثر هر ۳۰ دقیقه) و بررسی پرداخت اطلس‌پی فقط وقتی اجرا می‌شوند که یک پیام یا دکمه به ربات برسد.
- **بدون آدرس عمومی:** صفحه‌ی وضعیت، صفحه‌ی تم، و webhook/callback درگاه‌های پرداخت وجود ندارد. اطلس‌پی با polling کار می‌کند.
- **درگاه پرداخت آنلاین عمومی (`gateway`) غیرفعال است.**
- **Secrets جدا ندارد:** مقدارهای حساس داخل `secrets.js` روی ابر تلگرام آپلود می‌شوند.

## امنیت

- **هرگز `secrets.js` را commit نکنید** (در `.gitignore` هست). قبل از push به گیت‌هاب با `git status` چک کنید.
- توکن CLI Access مثل رمز ربات است. اگر لو رفت، در همان صفحه **Revoke** بزنید و دوباره `npx tgcloud login` کنید.
- اگر کلیدی (PasarGuard، اطلس‌پی) اشتباهی در گیت رفت، آن را در پنل مربوطه عوض کنید؛ پاک‌کردن commit کافی نیست.

## رفع اشکال

| خطا | راه‌حل |
|---|---|
| `Usage: npm create @tgcloud/bot <directory>` | بعد از دستور یک اسم پوشه بنویسید |
| `No CLI access token found` | `npx tgcloud login` |
| `Could not reach the tgcloud server` | VPN/پروکسی (بخش بالا) |
| `401 Unauthorized` موقع ارسال پیام | در BotFather سوییچ Serverless را خاموش/روشن کنید، بعد `npx tgcloud push` |
| `TypeError ... snapshot.js` بعد از push | معمولاً بی‌ضرر است؛ `npx tgcloud status` را بزنید، یا `npm i @tgcloud/cli@latest` |
| ربات جواب نمی‌دهد | `npx tgcloud run handlers/message '{...}'` برای دیدن خطای واقعی (`npx tgcloud run --help`) |
| «ADMIN_IDS تنظیم نشده» یا پنل کار نمی‌کند | `secrets.js` را چک کنید و دوباره `push` بزنید |

## درباره‌ی کد

این پروژه از نسخه‌ی Cloudflare Workers ربات منتقل شده است. منطق ربات تغییر نکرده؛
KV و D1 با لایه‌ی `lib/runtime.js` روی SQLite تلگرام شبیه‌سازی شده‌اند و Bot API از
طریق `api.*` تلگرام صدا زده می‌شود. روی یک SDK شبیه‌سازی‌شده با SQLite واقعی تست شده
(تمام دکمه‌ها و یک جریان خرید کامل)، نه روی سرور رسمی تلگرام.

## مجوز

یک مجوز انتخاب کنید و فایل `LICENSE` اضافه کنید (مثلاً MIT).
