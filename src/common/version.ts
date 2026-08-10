/**
 * tglow's version, in one place.
 *
 * Two things carried it before: package.json, and the `appVersion` tglow tells
 * Telegram about itself. They drifted -- three tags shipped as v0.2.0, v0.3.0
 * and v0.4.0 while both still read 0.1.0 -- and the second one matters more
 * than it looks. The device fields are truthful on purpose (see
 * telegram-client.ts): misrepresenting the client is one of the behaviours
 * that attracts account restrictions, and a version frozen at the first
 * release is a small lie told to Telegram on every connection.
 *
 * package.json cannot import this, so the two are kept in step by a test that
 * reads both and refuses to let them disagree, rather than by remembering.
 */
export const APPLICATION_VERSION = '0.6.0';
