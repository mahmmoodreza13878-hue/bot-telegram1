// لایه‌ی سازگاری: همان چیزی که قبلاً Cloudflare Workers می‌داد (env, KV, D1) را
// روی SQLite داخلی Telegram Serverless شبیه‌سازی می‌کند تا منطق ربات بدون تغییر کار کند.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { SECRETS } from './secrets.js';
import {
  loadState,
  ensurePlansLoaded,
  restoreFromD1IfEmpty,
  getConfig,
  beginRequest,
  releaseInFlight,
  setMyCommands,
  setAdminCommands,
  LOW_VOLUME_SCAN_INTERVAL_MS,
} from './core.js';
import { maybeScanLowVolume } from './delivery.js';
import { pollAtlaspayOrders } from './atlaspay2.js';
import { processUpdate } from './router.js';

const nowSec = () => Math.floor(Date.now() / 1000);
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

// ---------- ابزار تبدیل «?» به پارامتر نام‌دار / sql tag ----------
function toNamed(text, params) {
  const named = {};
  let i = 0;
  const query = text.replace(/\?/g, () => {
    const key = `:p${i}`;
    named[key] = norm(params[i]);
    i += 1;
    return key;
  });
  return { query, named };
}
function toFragment(text, params) {
  const parts = text.split('?');
  const strings = Object.assign([...parts], { raw: [...parts] });
  return sql(strings, ...params.map(norm));
}

// ---------- جایگزین Cloudflare KV ----------
const kvStore = {
  async get(key) {
    const row = await db.get(sql`SELECT v, expires_at FROM kv_store WHERE k = ${String(key)}`);
    if (!row) return null;
    if (row.expires_at && Number(row.expires_at) < nowSec()) return null;
    return row.v;
  },
  async put(key, value, options = {}) {
    const expiresAt = options && options.expirationTtl ? nowSec() + Number(options.expirationTtl) : null;
    const { query, named } = toNamed(
      `INSERT INTO kv_store (k, v, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (k) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at`,
      [String(key), String(value), expiresAt]
    );
    await db.run(query, named);
  },
};

// ---------- جایگزین Cloudflare D1 (همان API: prepare().bind().run/all/first) ----------
function statement(text, params) {
  return {
    async run() {
      const { query, named } = toNamed(text, params);
      const meta = await db.run(query, named);
      return { success: true, meta, results: [] };
    },
    async all() {
      const rows = await db.all(toFragment(text, params));
      return { success: true, results: rows || [] };
    },
    async first() {
      const row = await db.get(toFragment(text, params));
      return row || null;
    },
  };
}
const d1 = {
  prepare(text) {
    return {
      bind: (...params) => statement(text, params),
      run: () => statement(text, []).run(),
      all: () => statement(text, []).all(),
      first: () => statement(text, []).first(),
    };
  },
};

export function makeEnv() {
  const firstAdmin = String(SECRETS.ADMIN_IDS || '').split(/[,\s;]+/).find(Boolean) || '';
  return {
    TELEGRAM_BOT_TOKEN: 'serverless',
    ...SECRETS,
    // اگر مقصد اعلان‌ها خالی بود، به چت خصوصی اولین ادمین می‌رود
    ADMIN_CHAT_ID: SECRETS.ADMIN_CHAT_ID || firstAdmin,
    SHOP_KV: kvStore,
    DB: d1,
  };
}

// ---------- منوی دستورات ربات (یک‌بار برای همه، یک‌بار برای هر ادمین) ----------
async function syncCommands(env, config, update) {
  const publicKey = 'commands_public_v1';
  if ((await env.SHOP_KV.get(publicKey)) !== '1') {
    const res = await setMyCommands(config.BOT_TOKEN);
    if (res && res.ok) await env.SHOP_KV.put(publicKey, '1');
  }
  const fromId =
    (update.message && update.message.from && update.message.from.id) ||
    (update.callback_query && update.callback_query.from && update.callback_query.from.id);
  if (fromId && config.ADMIN_IDS.includes(String(fromId))) {
    const adminKey = `commands_admin_v1_${fromId}`;
    if ((await env.SHOP_KV.get(adminKey)) !== '1') {
      const res = await setAdminCommands(config.BOT_TOKEN, fromId);
      if (res && res.ok) await env.SHOP_KV.put(adminKey, '1');
    }
  }
}

// ---------- کارهای پس‌زمینه ----------
// Serverless تلگرام Cron ندارد؛ پس این کارها بعد از هر آپدیت (و با throttle ماندگار) اجرا می‌شوند.
async function runBackgroundJobs(env, config) {
  try {
    const key = 'job_low_volume_last_run';
    const last = Number(await env.SHOP_KV.get(key)) || 0;
    if (Date.now() - last >= LOW_VOLUME_SCAN_INTERVAL_MS) {
      await env.SHOP_KV.put(key, String(Date.now()));
      await maybeScanLowVolume(env, config);
    }
  } catch (err) {
    console.error('low-volume job error:', err);
  }
  try {
    await pollAtlaspayOrders(env, config);
  } catch (err) {
    console.error('atlaspay poll error:', err);
  }
}

// ---------- نقطه ورود مشترک همه‌ی هندلرها ----------
export async function runUpdate(update) {
  const env = makeEnv();
  beginRequest();
  try {
    await loadState(env);
    ensurePlansLoaded();
    await restoreFromD1IfEmpty(env);
    const config = getConfig(env);
    await syncCommands(env, config, update).catch((err) => console.error('commands sync failed:', err));
    await processUpdate(update, config, env);
    await runBackgroundJobs(env, config);
  } catch (err) {
    console.error('runUpdate error:', err);
  } finally {
    releaseInFlight();
  }
}
