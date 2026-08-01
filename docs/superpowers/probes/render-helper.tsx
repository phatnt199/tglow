import { act, type ReactNode } from "react";
import { AppContext, createRoot } from "@opentui/react";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";

export async function renderWithKeys(
  node: ReactNode,
  opts: { width: number; height: number },
): Promise<TestRendererSetup> {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const setup = await createTestRenderer(opts);
  const root = createRoot(setup.renderer);
  act(() => {
    root.render(
      <AppContext.Provider value={{ keyHandler: setup.renderer.keyInput, renderer: setup.renderer }}>
        {node}
      </AppContext.Provider>,
    );
  });
  return setup;
}
