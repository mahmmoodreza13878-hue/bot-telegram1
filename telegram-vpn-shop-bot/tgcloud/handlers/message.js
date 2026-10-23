import { runUpdate } from '../lib/runtime.js';

// همه‌ی پیام‌ها (متن، عکس رسید، دستورها)
export default async function (message, ctx) {
  const update = { update_id: ctx && ctx.update ? ctx.update.update_id : undefined, message };
  await runUpdate(update);
}
