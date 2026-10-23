// tgcloud/lib/pasarguard.js — ported from the Cloudflare Worker version of the bot.
import { fetch } from 'sdk';
import { GIGABYTE, PG_TOKEN_KV_KEY, SHARED, SUB_STATUS, stripTrailingSlash } from './core.js';

// خطای استاندارد سمت پنل — پیام آن برای نمایش به کاربر امن است (بدون توکن)
export class PgError extends Error {
  constructor(message, status = 0, detail = null) {
    super(message);
    this.name = 'PgError';
    this.status = status;
    this.detail = detail;
  }
}

export function pgConfigured(config) {
  return Boolean(config.PG_BASE_URL && (config.PG_API_TOKEN || (config.PG_USERNAME && config.PG_PASSWORD)));
}

// کدام متغیرها ست نشده‌اند؟ (برای پیام خطای دقیق به‌جای «تنظیم نشده»)
export function pgMissingConfig(config) {
  const missing = [];
  if (!config.PG_BASE_URL) missing.push('PASARGUARD_BASE_URL');
  if (!config.PG_API_TOKEN && !(config.PG_USERNAME && config.PG_PASSWORD)) {
    missing.push('PASARGUARD_API_TOKEN (یا PASARGUARD_USERNAME و PASARGUARD_PASSWORD)');
  }
  return missing;
}

// هشدارهای پیکربندی که باعث خطای ۴۰۱ بی‌دلیل می‌شوند
export function pgConfigWarnings(config) {
  const warnings = [];
  if (config.PG_API_TOKEN && !config.PG_API_TOKEN.startsWith('pg_key_')) {
    warnings.push('کلید API با «pg_key_» شروع نمی‌شود؛ پنل چنین کلیدی را نمی‌پذیرد و خطای احراز هویت می‌دهد.');
  }
  if (/\/api\/?$/.test(config.PG_BASE_URL)) {
    warnings.push('آدرس پنل نباید به «/api» ختم شود؛ ربات خودش مسیرها را اضافه می‌کند.');
  }
  if (/\/dashboard\/?$/.test(config.PG_BASE_URL)) {
    warnings.push('آدرس پنل نباید به «/dashboard» ختم شود؛ فقط دامنه (و پورت) کافی است.');
  }
  if (config.PG_BASE_URL && !/^https:\/\//i.test(config.PG_BASE_URL)) {
    warnings.push('آدرس پنل باید با https:// شروع شود؛ هاست Serverless تلگرام احتمالاً به http یا گواهی self-signed وصل نمی‌شود.');
  }
  return warnings;
}

export function pgApiUrl(config, path) {
  return `${config.PG_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

// تبدیل خطای HTTP پنل به پیام فارسی قابل نمایش (بدون افشای اطلاعات حساس)
export function pgErrorMessage(status, data) {
  let detail = '';

  if (data && typeof data.detail === 'string') {
    detail = data.detail;
  } else if (data && Array.isArray(data.detail)) {
    // شکل استاندارد خطای اعتبارسنجی FastAPI: [{loc, msg, type}]
    detail = data.detail
      .map((item) => {
        if (!item) return '';
        const where = Array.isArray(item.loc)
          ? item.loc.filter((part) => part !== 'body' && part !== 'query').join('.')
          : '';
        const msg = item.msg || item.message || '';
        return where && msg ? `${where}: ${msg}` : msg || where;
      })
      .filter(Boolean)
      .join(' | ');
  } else if (data && data.detail && typeof data.detail === 'object') {
    detail = JSON.stringify(data.detail);
  }

  // اگر پنل چیزی غیرمنتظره برگرداند، خام‌اش را نشان می‌دهیم تا خطا نامرئی نماند
  if (!detail && data) detail = JSON.stringify(data);
  const map = {
    400: 'درخواست نامعتبر بود',
    401: 'احراز هویت پنل ناموفق بود (API Key یا نام کاربری/رمز را بررسی کنید)',
    403: 'دسترسی این ادمین در پنل کافی نیست',
    404: 'مسیر یا کاربر مورد نظر در پنل پیدا نشد — اگر همه درخواست‌ها ۴۰۴ می‌شوند، آدرس پنل (PASARGUARD_BASE_URL) اشتباه است',
    405:
      'پنل این متد را روی آن مسیر قبول نکرد — تقریباً همیشه یعنی PASARGUARD_BASE_URL اشتباه است ' +
      '(مثلاً «/dashboard» یا «/api» انتهای آن مانده). فقط دامنه پنل را بگذارید',
    409: 'این نام کاربری از قبل در پنل وجود دارد',
    422: 'اطلاعات ارسالی با قواعد پنل سازگار نیست',
    429: 'تعداد درخواست‌ها بیش از حد مجاز است',
    500: 'خطای داخلی پنل',
    502: 'پنل در دسترس نیست',
    503: 'پنل موقتاً در دسترس نیست',
  };
  const base = map[status] || `خطای پنل (HTTP ${status})`;
  return detail ? `${base}: ${String(detail).slice(0, 200)}` : base;
}

// راهنمای اضافه برای خطاهایی که علت رایج و مشخصی دارند
export function pgErrorHint(error, plan) {
  if (!(error instanceof PgError)) return '';
  const message = String(error.message || '');
  const noTarget = plan && !plan.templateId && !(Array.isArray(plan.groupIds) && plan.groupIds.length);

  // خطاهایی که خود پنل صریحاً درباره گروه می‌دهد (مثل «Group not found»)
  if (/group/i.test(message) || /گروه/.test(message)) {
    const current =
      plan && Array.isArray(plan.groupIds) && plan.groupIds.length ? plan.groupIds.join('، ') : '— خالی —';
    return (
      `\n\n💡 مشکل از شناسه گروه بسته است (مقدار فعلی: ${current}).\n` +
      'از «🛰 پاسارگارد → 📋 دریافت لیست گروه‌ها» شناسه‌های واقعی پنل را ببینید و در ' +
      '«📦 مدیریت بسته‌ها» همان‌ها را برای بسته ست کنید.\n' +
      'اگر لیست خالی بود، اول در پنل یک Group با اینباندهای دلخواه بسازید.'
    );
  }

  if (error.status === 422 && noTarget) {
    return (
      '\n\n💡 این بسته هیچ گروهی (group_ids) ندارد و پنل کاربر بدون گروه را قبول نمی‌کند.\n' +
      'از «🛰 پاسارگارد → 📋 دریافت لیست گروه‌ها» شناسه بگیرید و در ' +
      '«📦 مدیریت بسته‌ها» برای همان بسته ست کنید.'
    );
  }
  if (error.status === 405 || error.status === 404) {
    return '\n\n💡 معمولاً یعنی PASARGUARD_BASE_URL اشتباه است؛ فقط دامنه پنل را بگذارید.';
  }
  if (error.status === 401) {
    return '\n\n💡 کلید API را دوباره بسازید و مطمئن شوید با «pg_key_» شروع می‌شود.';
  }
  return '';
}

// دریافت توکن JWT پنل (فقط در حالت username/password) و کش آن
export async function pgLogin(env, config) {
  const formBody =
    'grant_type=password' +
    `&username=${encodeURIComponent(config.PG_USERNAME)}` +
    `&password=${encodeURIComponent(config.PG_PASSWORD)}`;

  let res;
  try {
    res = await fetch(pgApiUrl(config, '/api/admin/token'), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: formBody,
    });
  } catch (err) {
    throw new PgError('ارتباط با پنل برای گرفتن توکن برقرار نشد', 0);
  }

  if (!res.ok) throw new PgError(pgErrorMessage(res.status, null), res.status);

  const data = await res.json().catch(() => null);
  if (!data || !data.access_token) throw new PgError('پاسخ توکن پنل معتبر نبود', 500);

  // عمر کش کوتاه‌تر از عمر واقعی توکن پنل نگه داشته می‌شود
  SHARED.pgTokenMemo = { token: data.access_token, expiresAt: Date.now() + 55 * 60 * 1000 };
  if (env.SHOP_KV) {
    try {
      await env.SHOP_KV.put(PG_TOKEN_KV_KEY, data.access_token, { expirationTtl: 3300 });
    } catch (err) {
      console.error('pgLogin: token cache failed');
    }
  }
  return data.access_token;
}

export async function pgGetToken(env, config, forceRefresh = false) {
  if (!forceRefresh) {
    if (SHARED.pgTokenMemo.token && SHARED.pgTokenMemo.expiresAt > Date.now()) return SHARED.pgTokenMemo.token;
    if (env.SHOP_KV) {
      const cached = await env.SHOP_KV.get(PG_TOKEN_KV_KEY).catch(() => null);
      if (cached) {
        SHARED.pgTokenMemo = { token: cached, expiresAt: Date.now() + 5 * 60 * 1000 };
        return cached;
      }
    }
  } else {
    SHARED.pgTokenMemo = { token: '', expiresAt: 0 };
  }
  return pgLogin(env, config);
}

/**
 * تنها نقطه ارسال درخواست به پنل.
 *  - timeout مشخص روی همه درخواست‌ها
 *  - در صورت 401 یک‌بار توکن را تازه می‌کند و دوباره تلاش می‌کند
 *  - هیچ‌وقت هدرهای حساس را لاگ نمی‌کند
 */
export async function pgFetch(env, config, path, options = {}) {
  const { method = 'GET', body, retryOn401 = true } = options;

  if (!pgConfigured(config)) {
    throw new PgError(
      `اتصال پنل پاسارگارد تنظیم نشده — این مقدارها در lib/secrets.js ست نشده‌اند: ${pgMissingConfig(config).join(' و ')}`,
      0
    );
  }

  const headers = { accept: 'application/json' };
  if (config.PG_API_TOKEN) {
    headers['X-Api-Key'] = config.PG_API_TOKEN;
  } else {
    headers.authorization = `Bearer ${await pgGetToken(env, config)}`;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';

  let res;
  try {
    res = await fetch(pgApiUrl(config, path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new PgError(timedOut ? 'پنل در زمان مقرر پاسخ نداد' : 'ارتباط با پنل برقرار نشد', 0);
  }

  // توکن منقضی‌شده: یک‌بار تازه‌سازی و تلاش مجدد
  if (res.status === 401 && retryOn401 && !config.PG_API_TOKEN) {
    await pgGetToken(env, config, true);
    return pgFetch(env, config, path, { method, body, retryOn401: false });
  }

  if (res.status === 204) return null;

  const text = await res.text().catch(() => '');
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = null;
    }
  }

  if (!res.ok) throw new PgError(pgErrorMessage(res.status, data), res.status, data);

  // پاسخ ۲۰۰ ولی غیر-JSON یعنی به API نخورده‌ایم و صفحه داشبورد/پروکسی جواب داده.
  // بدون این بررسی، تست اتصال به‌اشتباه «موفق» گزارش می‌شد.
  if (text && data === null) {
    throw new PgError(
      'پاسخ پنل JSON نبود؛ به‌نظر می‌رسد آدرس پنل به صفحه داشبورد یا یک پروکسی اشاره می‌کند. ' +
        'مقدار PASARGUARD_BASE_URL باید فقط دامنه پنل باشد (بدون /dashboard و بدون /api).',
      res.status
    );
  }

  return data;
}

// حجم بسته به بایت (۰ = نامحدود)
export function planDataLimitBytes(plan) {
  const gb = Number(plan && plan.gb) || 0;
  return gb <= 0 ? 0 : Math.round(gb * GIGABYTE);
}

// تاریخ انقضا به‌صورت UNIX timestamp ثانیه‌ای UTC (۰ = بدون انقضا)
export function planExpireTimestamp(plan, fromMs = Date.now()) {
  const days = Number(plan && plan.days) || 0;
  if (days <= 0) return 0;
  return Math.floor(fromMs / 1000) + days * 86400;
}

export function normalizeGroupIds(groupIds) {
  if (!Array.isArray(groupIds)) return [];
  const out = [];
  for (const raw of groupIds) {
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0 && !out.includes(id)) out.push(id);
  }
  return out;
}

// نام کاربری پنل: pv_<telegramId>_<شماره>  → با قواعد validate_username سازگار است
export function buildPgUsername(config, telegramId, seq, salt = '') {
  const parts = [config.PG_USERNAME_PREFIX, String(telegramId), String(seq)];
  if (salt) parts.push(salt);
  return parts.join('_').slice(0, 128);
}

// همان قاعده‌ای که پنل اعمال می‌کند (app/models/validators.py)
export function isValidPgUsername(username) {
  const value = String(username || '');
  if (value.length < 3 || value.length > 128) return false;
  if (!/^[a-zA-Z0-9\-_@.]+$/.test(value)) return false;
  if (/[-_@.]{2,}/.test(value)) return false;
  return true;
}

// پنل ممکن است لینک اشتراک را نسبی برگرداند (وقتی url_prefix در تنظیماتش خالی است)
export function pgSubscriptionUrl(config, rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  const base = config.PG_SUB_BASE_URL || config.PG_BASE_URL;
  if (!base) return url;
  return `${stripTrailingSlash(base)}/${url.replace(/^\/+/, '')}`;
}

// expire در پاسخ پنل می‌تواند رشته ISO یا عدد ثانیه‌ای باشد
export function parsePgExpire(value) {
  if (value === null || value === undefined || value === 0 || value === '') return null;
  if (typeof value === 'number') return value > 1e11 ? value : value * 1000;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

// بدنه درخواست POST /api/user بر اساس یک بسته
//
// نکته: کل بدنه در یک آبجکت ساخته می‌شود (به‌جای انتساب‌های بعدی) تا
// هم شکل داده روشن بماند و هم ابزارهای type-check روی JS خطا نگیرند.
//   • حالت عادی → status=active و expire (timestamp ثانیه‌ای UTC)
//   • حالت on_hold → status=on_hold و on_hold_expire_duration (ثانیه)
//     و در این حالت expire نباید اصلاً فرستاده شود.
//   • note → نام فارسی مشتری و بسته، تا در پنل قابل شناسایی باشد (حداکثر ۵۰۰ کاراکتر)
export function buildUserCreatePayload(plan, username, note = '') {
  const useHold = Boolean(plan.onHold) && Number(plan.days) > 0;
  return {
    username,
    status: useHold ? 'on_hold' : 'active',
    data_limit: planDataLimitBytes(plan),
    data_limit_reset_strategy: 'no_reset',
    group_ids: normalizeGroupIds(plan.groupIds),
    note: buildPgNote(plan, note),
    ...(useHold
      ? { on_hold_expire_duration: Number(plan.days) * 86400 }
      : { expire: planExpireTimestamp(plan) || null }),
  };
}

// یادداشت پنل: نام مشتری (فارسی) + عنوان بسته. خط جدید و کاراکتر کنترلی حذف می‌شود.
export function buildPgNote(plan, customerName) {
  const clean = (value) =>
    String(value || '')
      .replace(/[\r\n\t]+/g, ' ')
      .trim();
  const parts = [];
  if (clean(customerName)) parts.push(clean(customerName));
  if (clean(plan && plan.title)) parts.push(clean(plan.title));
  parts.push('ربات تلگرام');
  return parts.join(' | ').slice(0, 500);
}

// ۱) ساخت کاربر/کلاینت — با حجم و مدت مشخص
export function pgCreateUser(env, config, payload) {
  return pgFetch(env, config, '/api/user', { method: 'POST', body: payload });
}

// ۱-ب) ساخت کاربر از قالب پنل (حجم و مدت از خود قالب خوانده می‌شود)
export function pgCreateUserFromTemplate(env, config, templateId, username, note = '') {
  return pgFetch(env, config, '/api/user/from_template', {
    method: 'POST',
    body: {
      user_template_id: Number(templateId),
      username,
      note: buildPgNote(null, note),
    },
  });
}

// ۲) دریافت وضعیت اشتراک
export async function pgGetGroups(env, config) {
  const ENDPOINTS = [
    { path: '/api/user_group',    keys: ['user_groups', 'groups', 'items'] },
    { path: '/api/user_template', keys: ['user_templates', 'templates', 'items'] },
    { path: '/api/group',         keys: ['groups', 'items'] },
  ];
  for (const { path, keys } of ENDPOINTS) {
    try {
      const data = await pgFetch(env, config, path);
      const list = Array.isArray(data)
        ? data
        : keys.reduce((acc, k) => acc || (data && data[k]), null) || [];
      const groups = list
        .map(g => ({
          id:   Number(g.id != null ? g.id : (g.group_id != null ? g.group_id : g.template_id)),
          name: String(g.name || g.title || ''),
        }))
        .filter(g => Number.isFinite(g.id) && g.id > 0);
      if (groups.length > 0) {
        console.log('[pgGetGroups] from', path, ':', JSON.stringify(groups));
        return groups;  // [{id, name}]
      }
    } catch (_) {}
  }
  return [];
}

export function pgGetUser(env, config, username) {
  return pgFetch(env, config, `/api/user/by-username/${encodeURIComponent(username)}`);
}

// ۳) ویرایش کاربر (تغییر حجم/مدت/گروه)
export function pgModifyUser(env, config, username, patch) {
  return pgFetch(env, config, `/api/user/by-username/${encodeURIComponent(username)}`, {
    method: 'PUT',
    body: patch,
  });
}

// ۴) غیرفعال/فعال کردن اشتراک
export function pgSetUserDisabled(env, config, username, disabled) {
  return pgFetch(env, config, `/api/user/by-username/${encodeURIComponent(username)}/disabled`, {
    method: 'PUT',
    body: { disabled: Boolean(disabled) },
  });
}

// ۵) حذف کامل اشتراک
export function pgDeleteUser(env, config, username) {
  return pgFetch(env, config, `/api/user/by-username/${encodeURIComponent(username)}`, { method: 'DELETE' });
}

// ۶) ریست حجم مصرفی
export function pgResetUserUsage(env, config, username) {
  return pgFetch(env, config, `/api/user/by-username/${encodeURIComponent(username)}/reset`, { method: 'POST' });
}

// ۷) باطل کردن لینک اشتراک و ساخت لینک تازه
export function pgRevokeUserSub(env, config, username) {
  return pgFetch(env, config, `/api/user/by-username/${encodeURIComponent(username)}/revoke_sub`, { method: 'POST' });
}

// ۸) لیست گروه‌ها — برای اینکه ادمین شناسه گروه‌ها را بدون مراجعه به پنل ببیند
export function pgListGroups(env, config) {
  return pgFetch(env, config, '/api/groups/simple');
}

// ۹) تست سلامت اتصال. اول اطلاعات ادمین جاری، و اگر آن مسیر در نسخه نصب‌شده
//    نبود، به لیست گروه‌ها برمی‌گردد تا صرفاً صحت اتصال و کلید بررسی شود.
export async function pgPing(env, config) {
  try {
    const admin = await pgFetch(env, config, '/api/admin');
    return { ok: true, via: '/api/admin', admin: admin && admin.username ? admin.username : null };
  } catch (err) {
    if (err instanceof PgError && (err.status === 404 || err.status === 405)) {
      const groups = await pgListGroups(env, config);
      const count = groups && Array.isArray(groups.groups) ? groups.groups.length : 0;
      return { ok: true, via: '/api/groups/simple', groups: count };
    }
    throw err;
  }
}

/**
 * یک کاربر تازه روی پنل می‌سازد و اطلاعات نرمال‌شده اشتراک را برمی‌گرداند.
 * اگر نام کاربری تکراری بود (خطای 409) تا سه بار با شماره/نمک تازه تلاش می‌کند.
 */
export async function pgProvision(env, config, { plan, telegramId, seq, note = '' }) {
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const salt = attempt === 0 ? '' : Math.random().toString(36).slice(2, 6);
    const username = buildPgUsername(config, telegramId, Number(seq) + attempt, salt);

    if (!isValidPgUsername(username)) {
      throw new PgError('نام کاربری تولیدشده با قواعد پنل سازگار نیست', 0);
    }

    try {
      const created = plan.templateId
        ? await pgCreateUserFromTemplate(env, config, plan.templateId, username, note)
        : await pgCreateUser(env, config, buildUserCreatePayload(plan, username, note));
      return normalizePgUser(config, created);
    } catch (err) {
      lastError = err;
      if (!(err instanceof PgError) || err.status !== 409) throw err;
    }
  }

  throw lastError || new PgError('ساخت اشتراک روی پنل ناموفق بود', 0);
}

// پاسخ UserResponse پنل را به شکل ثابت و قابل‌استفاده در ربات تبدیل می‌کند
export function normalizePgUser(config, user) {
  const data = user || {};
  return {
    pgUserId: data.id === undefined || data.id === null ? null : Number(data.id),
    pgUsername: String(data.username || ''),
    status: String(data.status || SUB_STATUS.ACTIVE),
    dataLimitBytes: Math.round(Number(data.data_limit) || 0),
    usedTrafficBytes: Math.round(Number(data.used_traffic) || 0),
    expireAt: parsePgExpire(data.expire),
    onHoldSeconds: Number(data.on_hold_expire_duration) || 0,
    subscriptionUrl: pgSubscriptionUrl(config, data.subscription_url),
    createdAt: parsePgExpire(data.created_at) || Date.now(),
    raw: data,
  };
}
