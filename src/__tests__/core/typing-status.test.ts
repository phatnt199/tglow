import { test, expect } from 'bun:test';

import { Api } from 'teleproto';

import { readTypingStatus, resolveTypingPhrase, TYPING_STATUS_TTL_MS } from '../../core/typing-status.ts';

// Driven off the constructors teleproto actually ships rather than a list
// typed out here, so an action tglow has no phrase for is caught as a gap
// instead of silently resolving to the generic fallback forever.
const ACTION_CLASS_NAMES = Object.keys(Api)
  .filter(name => name.startsWith('SendMessage') && name.endsWith('Action'));

test('every action teleproto ships resolves to something drawable', () => {
  expect(ACTION_CLASS_NAMES.length).toBeGreaterThan(10);
  for (const className of ACTION_CLASS_NAMES) {
    const phrase = resolveTypingPhrase({ className });
    expect({ className, ok: phrase === null || phrase.length > 0 }).toEqual({ className, ok: true });
  }
});

test('the common actions read as a continuation of the name', () => {
  expect(resolveTypingPhrase({ className: 'SendMessageTypingAction' })).toBe('typing…');
  expect(resolveTypingPhrase({ className: 'SendMessageChooseStickerAction' })).toBe('choosing a sticker');
  expect(resolveTypingPhrase({ className: 'SendMessageRecordAudioAction' })).toBe('recording a voice message');
  expect(resolveTypingPhrase({ className: 'SendMessageUploadPhotoAction' })).toBe('sending a photo');
});

// The stop signal, not an activity: "Alice is cancelling" would be nonsense.
test('cancel resolves to nothing rather than a phrase', () => {
  expect(resolveTypingPhrase({ className: 'SendMessageCancelAction' })).toBeNull();
});

// These fire while someone types into a draft they may never send. Announcing
// one would report on a message that does not exist.
test('the draft actions say nothing', () => {
  expect(resolveTypingPhrase({ className: 'SendMessageTextDraftAction' })).toBeNull();
  expect(resolveTypingPhrase({ className: 'SendMessageRichMessageDraftAction' })).toBeNull();
});

// Telegram adds action types. Falling silent or throwing on a new one would be
// worse than saying something vague.
test('an action tglow has never seen still says something', () => {
  expect(resolveTypingPhrase({ className: 'SendMessageFutureThingAction' })).toBe('…');
});

test('a live status is shown, and a stale one is not', () => {
  const typing = new Map([['u1', { actorId: 'u1', phrase: 'typing…', expiresAt: 1_000 }]]);
  expect(readTypingStatus({ typing, peerId: 'u1', now: 999 })?.phrase).toBe('typing…');
  expect(readTypingStatus({ typing, peerId: 'u1', now: 1_000 })).toBeNull();
  expect(readTypingStatus({ typing, peerId: 'u1', now: 5_000 })).toBeNull();
});

// Expiry is checked on read as well as cleared on a timer, so a suspended
// laptop -- where the timeout fires late or never -- cannot leave "typing…"
// on screen for a person who stopped hours ago.
test('a status outlives its timer without outliving its expiry', () => {
  const typing = new Map([['u1', { actorId: 'u1', phrase: 'typing…', expiresAt: 1_000 }]]);
  expect(readTypingStatus({ typing, peerId: 'u1', now: 1_000 + TYPING_STATUS_TTL_MS })).toBeNull();
});

test('a chat nobody is typing in has no status', () => {
  expect(readTypingStatus({ typing: new Map(), peerId: 'u1', now: 0 })).toBeNull();
});
