import { test, expect } from 'bun:test';

import type { IDialogRow, IFolderRow } from '../../core/cache/index.ts';
import { ALL_CHATS_FOLDER_ID, resolveFolderMembership } from '../../core/folder-service.ts';

const buildFolder = (overrides: Partial<IFolderRow> = {}): IFolderRow => ({
  id: 2, title: 'Work', emoticon: null, ord: 0,
  pinnedPeers: [], includePeers: [], excludePeers: [],
  contacts: false, nonContacts: false, groups: false, broadcasts: false, bots: false,
  excludeMuted: false, excludeRead: false, excludeArchived: false,
  ...overrides,
});

const buildDialog = (peerId: string, overrides: Partial<IDialogRow> = {}): IDialogRow => ({
  peerId, title: peerId, pinned: 0, unreadCount: 0, lastMessageAt: 100, topMessageId: 1,
  readOutboxMaxId: 0, preview: null, ...overrides,
});

const dialogs: IDialogRow[] = [
  buildDialog('u1', { unreadCount: 3 }),
  buildDialog('u2'),
  buildDialog('bot1'),
  buildDialog('g1'),
  buildDialog('c1'),
];

const peerKinds = new Map([
  ['u1', { type: 'user', isBot: false }],
  ['u2', { type: 'user', isBot: false }],
  ['bot1', { type: 'user', isBot: true }],
  ['g1', { type: 'chat', isBot: false }],
  ['c1', { type: 'channel', isBot: false }],
]);

const membersOf = (folder: IFolderRow): string[] =>
  resolveFolderMembership({ folder, dialogs, peerKinds }).map(dialog => dialog.peerId);

// Telegram never sends this one -- it is the absence of a filter -- so it is
// synthesised, and it must never filter anything.
test('the All folder passes every chat through untouched', () => {
  const all = buildFolder({ id: ALL_CHATS_FOLDER_ID });
  expect(membersOf(all)).toEqual(['u1', 'u2', 'bot1', 'g1', 'c1']);
});

test('an explicitly included chat is in the folder', () => {
  expect(membersOf(buildFolder({ includePeers: ['u2'] }))).toEqual(['u2']);
});

// Exclusion wins over both the explicit list and the categories, which is how
// Telegram's own folders behave: exclude is the last word.
test('an excluded chat stays out even when it is also included', () => {
  expect(membersOf(buildFolder({ includePeers: ['u1', 'u2'], excludePeers: ['u1'] }))).toEqual(['u2']);
});

test('an excluded chat stays out even when its category is enabled', () => {
  expect(membersOf(buildFolder({ groups: true, excludePeers: ['g1'] }))).toEqual([]);
});

test('the groups flag takes basic groups, and nothing else', () => {
  expect(membersOf(buildFolder({ groups: true }))).toEqual(['g1']);
});

test('the broadcasts flag takes channels', () => {
  expect(membersOf(buildFolder({ broadcasts: true }))).toEqual(['c1']);
});

// isBot has been on the peers table since M1a and never read. A bot is also a
// `user`, so this has to be checked before the type, or `bots` would be
// indistinguishable from "every private chat".
test('the bots flag takes bots without taking every private chat', () => {
  expect(membersOf(buildFolder({ bots: true }))).toEqual(['bot1']);
});

test('flags combine rather than override one another', () => {
  expect(membersOf(buildFolder({ groups: true, broadcasts: true }))).toEqual(['g1', 'c1']);
});

test('excludeRead narrows a category to what is actually unread', () => {
  expect(membersOf(buildFolder({ bots: true, groups: true, broadcasts: true, excludeRead: true }))).toEqual([]);
});

// The narrowing applies to categories, not to the explicit list: a chat you
// named yourself belongs in the folder whether or not you have read it.
test('excludeRead does not evict an explicitly included chat', () => {
  expect(membersOf(buildFolder({ includePeers: ['u2'], excludeRead: true }))).toEqual(['u2']);
});

// The order is the user's own arrangement, and re-sorting by recency would
// throw it away.
test('pinned peers come first, in the folder own order', () => {
  const folder = buildFolder({ pinnedPeers: ['c1', 'u2'], includePeers: ['u1'] });
  expect(membersOf(folder)).toEqual(['c1', 'u2', 'u1']);
});

// A folder can name a chat the cache has never seen -- a peer whose dialog was
// not in the first page of getDialogs. It must not appear as a blank row.
test('a folder naming a chat the cache does not have yields nothing for it', () => {
  expect(membersOf(buildFolder({ includePeers: ['nobody'] }))).toEqual([]);
});

// Contact, mute and archive state are not cached, so those flags are
// deliberately inert rather than guessed at. A folder relying on one shows
// fewer chats here than in the official client -- which is the honest failure,
// where inventing membership would be the dishonest one.
test('flags tglow cannot evaluate select nothing rather than guessing', () => {
  expect(membersOf(buildFolder({ contacts: true }))).toEqual([]);
  expect(membersOf(buildFolder({ nonContacts: true }))).toEqual([]);
  expect(membersOf(buildFolder({ excludeMuted: true }))).toEqual([]);
  expect(membersOf(buildFolder({ excludeArchived: true }))).toEqual([]);
});
