import { runUpdate } from '../lib/runtime.js';

// دکمه‌های شیشه‌ای (inline)
export default async function (callbackQuery, ctx) {
  const update = { update_id: ctx && ctx.update ? ctx.update.update_id : undefined, callback_query: callbackQuery };
  await runUpdate(update);
}
