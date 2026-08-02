import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Side-effect only: GramJS's telegramBaseClient.js computes a module-scope
// `useWSS: platform.isBrowser ? window.location.protocol == "https:" : false`
// exactly once, the first time anything requires it. `platform.isBrowser` is
// `typeof window !== 'undefined'` -- true, not because a test runs in a
// browser, but because @opentui/core's renderer constructor sets a bare
// `global.window = {}` (for requestAnimationFrame) the first time any tui/
// test builds one, and that global outlives the test. Whichever runs first
// wins: if GramJS loads after that renderer exists, isBrowser is true,
// window.location is undefined, and `.protocol` throws -- observed as an
// "Unhandled error between tests" attributed to whichever spec file happened
// to be the first to import telegram/telegram/events, entirely dependent on
// bun test's file ordering. Importing GramJS here, before any test (renderer
// included) has run, makes the one-time check evaluate while window is still
// genuinely undefined, and the safe result is then cached for the process.
import 'telegram';
import 'telegram/events';

import { installFileLogger } from '../core/logger-provider.ts';

// Registers a logger provider once per test process. Without it, any test whose
// code-under-test logs in a catch block dies -- IGNIS defaults to winston, an
// optional peer this project does not install. Tests must never depend on
// another test file having registered a provider first.
installFileLogger({ filePath: join(tmpdir(), 'tglow-test.log') });
