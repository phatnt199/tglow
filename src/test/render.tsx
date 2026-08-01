import { act, type ReactNode } from 'react';

import { AppContext, createRoot } from '@opentui/react';
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';

/**
 * Render a component tree for testing, with the AppContext wiring made explicit.
 *
 * `testRender` from `@opentui/react/test-utils` also works: `createRoot().render()`
 * self-wraps the tree in an AppContext provider. This helper does not depend on
 * that internal, and it mirrors how `main.ts` wires the real renderer, so tests
 * and production share one shape.
 *
 * Callers MUST wrap key presses in React's `act()`. Without it the state update
 * does not flush and the next assertion reads a stale frame — the failure mode
 * is a passing test that checked nothing.
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
