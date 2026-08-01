import { act, type ReactNode } from 'react';

import { AppContext, createRoot } from '@opentui/react';
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';

/**
 * Render a component tree for testing with keyboard input actually connected.
 *
 * Do not replace this with `testRender` from `@opentui/react/test-utils`: that
 * helper renders without an AppContext provider, so `useAppContext().keyHandler`
 * is null and `useKeyboard` no-ops behind its optional-chaining guard. Tests
 * then pass while asserting on a UI that never received a key.
 *
 * Driving `createTestRenderer` directly means the renderer exists before the
 * first render, so `renderer.keyInput` can be supplied as the key handler.
 */
export const renderWithKeys = async (
  node: ReactNode,
  opts: { width: number; height: number },
): Promise<TestRendererSetup> => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  const setup = await createTestRenderer(opts);
  const root = createRoot(setup.renderer);

  act(() => {
    root.render(
      <AppContext.Provider
        value={{ keyHandler: setup.renderer.keyInput, renderer: setup.renderer }}
      >
        {node}
      </AppContext.Provider>,
    );
  });

  return setup;
};
