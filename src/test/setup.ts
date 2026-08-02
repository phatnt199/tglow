import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installFileLogger } from '../core/logger-provider.ts';

// Registers a logger provider once per test process. Without it, any test whose
// code-under-test logs in a catch block dies -- IGNIS defaults to winston, an
// optional peer this project does not install. Tests must never depend on
// another test file having registered a provider first.
installFileLogger({ filePath: join(tmpdir(), 'tglow-test.log') });
