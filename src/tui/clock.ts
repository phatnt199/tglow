/**
 * The one clock in the interface.
 *
 * Three panes show a time -- the conversation's rail, the chat list, and the
 * status line -- and three copies of two `padStart(2, '0')` calls is how they
 * drift apart. Written here once so that a change to how tglow shows a time is
 * a change in one place.
 *
 * `date` is a Unix timestamp in seconds, which is what telegram-adapter.ts
 * stores and what every row in the cache carries.
 */
export const formatClock = (opts: { date: number }): string => {
  const at = new Date(opts.date * 1000);
  const hours = String(at.getHours()).padStart(2, '0');
  const minutes = String(at.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
};
