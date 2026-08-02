import { test, expect } from 'bun:test';

import { VimModes, VimContexts, ActionTypes, isVimMode } from '../../../keys/common/constants.ts';

test('VimModes exposes every supported mode', () => {
  expect(VimModes.NORMAL).toBe('normal');
  expect(VimModes.INSERT).toBe('insert');
  expect(VimModes.VISUAL).toBe('visual');
  expect(VimModes.COMMAND).toBe('command');
  expect(VimModes.SEARCH).toBe('search');
});

test('VimContexts exposes every pane', () => {
  expect(VimContexts.CHAT_LIST).toBe('chatlist');
  expect(VimContexts.MESSAGES).toBe('messages');
  expect(VimContexts.COMPOSER).toBe('composer');
});

test('ActionTypes values are unique', () => {
  const values = Object.values(ActionTypes) as string[];
  expect(new Set(values).size).toBe(values.length);
});

test('isVimMode accepts supported modes and rejects others', () => {
  expect(isVimMode('normal')).toBe(true);
  expect(isVimMode('visual')).toBe(true);
  expect(isVimMode('replace')).toBe(false);
  expect(isVimMode('')).toBe(false);
});
