// دیتابیس ربات (SQLite داخلی Telegram Serverless)
//
// ⚠️ بعد از `npx tgcloud push` حتماً `npx tgcloud migrate` را هم اجرا کنید تا جدول‌ها ساخته شوند.
// نکته: Serverless تلگرام Foreign Key را پشتیبانی نمی‌کند، پس ارتباط جدول‌ها فقط با ستون‌های ساده است.
import { table, integer, real, text, index, uniqueIndex, sql } from 'sdk/db';

// ذخیره‌گاه کلید/مقدار؛ جای Cloudflare KV (وضعیت زنده‌ی ربات: سفارش‌ها، کاربران، تنظیمات، سشن‌ها ...)
export const kvStore = table('kv_store', {
  k: text('k').primaryKey(),
  v: text('v').notNull(),
  expiresAt: integer('expires_at'),
});

// ---- جدول‌های گزارش‌گیری (جای Cloudflare D1) ----
export const users = table('users', {
  telegramId: text('telegram_id').primaryKey(),
  username: text('username'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  walletBalance: integer('wallet_balance').notNull().default(0),
  testClaimed: integer('test_claimed').notNull().default(0),
  isBlocked: integer('is_blocked').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => ({
  usernameIdx: index('idx_users_username').on(t.username),
}));

export const plans = table('plans', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  dataLimitGb: real('data_limit_gb').notNull().default(0),
  durationDays: integer('duration_days').notNull().default(0),
  price: integer('price').notNull().default(0),
  groupIds: text('group_ids'),
  templateId: integer('template_id'),
  onHold: integer('on_hold').notNull().default(0),
  isActive: integer('is_active').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const orders = table('orders', {
  id: text('id').primaryKey(),
  telegramId: text('telegram_id').notNull(),
  planId: text('plan_id'),
  planTitle: text('plan_title'),
  kind: text('kind').notNull().default('new'),
  renewOf: text('renew_of'),
  amount: integer('amount').notNull().default(0),
  status: text('status').notNull().default('pending'),
  paymentProvider: text('payment_provider'),
  note: text('note'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => ({
  userIdx: index('idx_orders_user').on(t.telegramId, t.createdAt),
  statusIdx: index('idx_orders_status').on(t.status, t.createdAt),
}));

export const subscriptions = table('subscriptions', {
  id: text('id').primaryKey(),
  telegramId: text('telegram_id').notNull(),
  orderId: text('order_id'),
  planId: text('plan_id'),
  planTitle: text('plan_title'),
  pgUsername: text('pg_username').notNull(),
  pgUserId: integer('pg_user_id'),
  dataLimitBytes: integer('data_limit_bytes').notNull().default(0),
  usedTrafficBytes: integer('used_traffic_bytes').notNull().default(0),
  startAt: integer('start_at'),
  expireAt: integer('expire_at'),
  subscriptionUrl: text('subscription_url'),
  status: text('status').notNull().default('active'),
  previousId: text('previous_id'),
  lastSyncedAt: integer('last_synced_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => ({
  pgUsernameIdx: uniqueIndex('idx_subs_pg_username').on(t.pgUsername),
  userIdx: index('idx_subs_user').on(t.telegramId, t.createdAt),
  expireIdx: index('idx_subs_expire').on(t.expireAt),
}));

export const payments = table('payments', {
  id: text('id').primaryKey(),
  orderId: text('order_id'),
  telegramId: text('telegram_id').notNull(),
  provider: text('provider').notNull(),
  amount: integer('amount').notNull().default(0),
  currency: text('currency').notNull().default('IRT'),
  status: text('status').notNull().default('pending'),
  reference: text('reference'),
  raw: text('raw'),
  verifiedAt: integer('verified_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => ({
  providerRefIdx: uniqueIndex('idx_payments_provider_ref').on(t.provider, t.reference).where(sql`reference IS NOT NULL`),
  orderIdx: index('idx_payments_order').on(t.orderId),
}));

export const logs = table('logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  level: text('level').notNull().default('info'),
  scope: text('scope'),
  telegramId: text('telegram_id'),
  orderId: text('order_id'),
  message: text('message').notNull(),
  meta: text('meta'),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  createdIdx: index('idx_logs_created').on(t.createdAt),
  scopeIdx: index('idx_logs_scope').on(t.scope, t.createdAt),
}));
