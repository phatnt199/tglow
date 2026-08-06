import { test, expect } from 'bun:test';
import { act } from 'react';

import { createMockMouse, MouseButtons } from '@opentui/core/testing';

import { renderWithKeys } from '../helpers/render.tsx';

/**
 * M2's foundation, proven before anything is built on it.
 *
 * The React binding has no special handling for onMouse* -- grepping
 * @opentui/react finds zero hits -- so whether a JSX handler ever fires depends
 * on props being passed straight through onto the Renderable, which declares
 * onMouseDown/onMouseDrag/onMouseScroll and the rest. That is an assumption
 * about someone else's internals, and this milestone rests entirely on it.
 * These tests are the check.
 */

test('a click reaches an onMouseDown handler declared in JSX', async () => {
  const clicks: Array<{ x: number; y: number }> = [];
  const renderer = await renderWithKeys(
    <box width={20} height={5} onMouseDown={(event: { x: number; y: number }) => { clicks.push({ x: event.x, y: event.y }); }}>
      <text>click me</text>
    </box>,
    { width: 20, height: 5 },
  );
  await renderer.flush();

  const mouse = createMockMouse(renderer.renderer);
  await act(async () => { await mouse.click(3, 2); });
  await renderer.flush();

  expect(clicks).toHaveLength(1);
  expect(clicks[0]).toEqual({ x: 3, y: 2 });
});

test('the button is reported, so a right click can be told from a left one', async () => {
  const buttons: number[] = [];
  const renderer = await renderWithKeys(
    <box width={20} height={5} onMouseDown={(event: { button: number }) => { buttons.push(event.button); }}>
      <text>click me</text>
    </box>,
    { width: 20, height: 5 },
  );
  await renderer.flush();

  const mouse = createMockMouse(renderer.renderer);
  await act(async () => { await mouse.click(3, 2, MouseButtons.LEFT); });
  await act(async () => { await mouse.click(3, 2, MouseButtons.RIGHT); });
  await renderer.flush();

  expect(buttons).toEqual([0, 2]);
});

// The wheel carries its own direction rather than arriving as a button, which
// is what lets scroll move a viewport instead of a cursor.
test('a scroll reaches onMouseScroll carrying a direction', async () => {
  const directions: Array<string | undefined> = [];
  const renderer = await renderWithKeys(
    <box
      width={20}
      height={5}
      onMouseScroll={(event: { scroll?: { direction: string } }) => { directions.push(event.scroll?.direction); }}
    >
      <text>scroll me</text>
    </box>,
    { width: 20, height: 5 },
  );
  await renderer.flush();

  const mouse = createMockMouse(renderer.renderer);
  await act(async () => { await mouse.scroll(3, 2, 'down'); });
  await act(async () => { await mouse.scroll(3, 2, 'up'); });
  await renderer.flush();

  expect(directions).toEqual(['down', 'up']);
});

// The divider resize, drag-to-scroll and drag-to-pin all rest on this: a press
// that moves must arrive as drag events, not as a click.
test('a drag reaches onMouseDrag, and ends with onMouseDragEnd', async () => {
  const drags: Array<{ x: number; y: number }> = [];
  let ended = 0;
  const renderer = await renderWithKeys(
    <box
      width={20}
      height={5}
      onMouseDrag={(event: { x: number; y: number }) => { drags.push({ x: event.x, y: event.y }); }}
      onMouseDragEnd={() => { ended += 1; }}
    >
      <text>drag me</text>
    </box>,
    { width: 20, height: 5 },
  );
  await renderer.flush();

  const mouse = createMockMouse(renderer.renderer);
  await act(async () => { await mouse.drag(2, 2, 10, 2); });
  await renderer.flush();

  expect(drags.length).toBeGreaterThan(0);
  expect(drags.at(-1)?.x).toBe(10);
  expect(ended).toBe(1);
});

// Shift+drag is how a terminal keeps its own selection while an application
// holds the mouse. tglow does not implement that -- the terminal does -- but if
// the modifier did not survive to the handler, tglow could not tell a
// selection gesture from one of its own and would fight the terminal for it.
test('modifiers survive to the handler, so shift can be recognised', async () => {
  const shifts: boolean[] = [];
  const renderer = await renderWithKeys(
    <box
      width={20}
      height={5}
      onMouseDown={(event: { modifiers: { shift: boolean } }) => { shifts.push(event.modifiers.shift); }}
    >
      <text>click me</text>
    </box>,
    { width: 20, height: 5 },
  );
  await renderer.flush();

  const mouse = createMockMouse(renderer.renderer);
  await act(async () => { await mouse.click(3, 2, MouseButtons.LEFT, { modifiers: { shift: true } }); });
  await act(async () => { await mouse.click(3, 2, MouseButtons.LEFT); });
  await renderer.flush();

  expect(shifts).toEqual([true, false]);
});
