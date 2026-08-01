import 'reflect-metadata';

import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Container, BindingScopes, getError, inject } from '@venizia/ignis-inversion';
import { ApplicationLogger, LoggerFactory } from '@venizia/ignis-helpers';

class BindingKeysProbe {
  static readonly GREETER = '@tglow/probe/greeter';
  static readonly CALLER = '@tglow/probe/caller';
}

interface IGreeter {
  greet: (opts: { name: string }) => string;
}


class Greeter implements IGreeter {
  greet = (opts: { name: string }): string => `hello ${opts.name}`;
}


class Caller {
  constructor(@inject({ key: BindingKeysProbe.GREETER }) private readonly greeter: IGreeter) {}
  run = (opts: { name: string }): string => {
    if (opts.name === '') {
      throw getError({ message: '[Caller][run] Empty name provided' });
    }
    return this.greeter.greet(opts);
  };
}

test('prerelease inversion still does constructor injection', () => {
  const container = new Container({ scope: 'ProbeContainer' });
  container.bind({ key: BindingKeysProbe.GREETER }).toClass(Greeter).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeysProbe.CALLER }).toClass(Caller).setScope(BindingScopes.SINGLETON);

  const caller = container.get<Caller>({ key: BindingKeysProbe.CALLER });
  expect(caller.run({ name: 'Alice' })).toBe('hello Alice');
  expect(() => caller.run({ name: '' })).toThrow(/\[Caller\]\[run\]/);
});

// ApplicationLogger.get takes a bare string. Passing an options object yields a
// scope of "[object Object]" with no error, which is how the wrong call survives.
test('ApplicationLogger.get takes a plain string scope', () => {
  const logger = ApplicationLogger.get('ProbeService');
  expect(typeof logger.for).toBe('function');
  expect(typeof logger.error).toBe('function');
});

// A TUI owns the alternate screen. Any logger writing to stdout corrupts the
// frame, so the app must register a file-writing provider before first use.
test('a custom provider can divert every log away from stdout', () => {
  const logPath = join(mkdtempSync(join(tmpdir(), 'tglow-log-')), 'tglow.log');
  const written: string[] = [];

  const makeLogger = (scope: string): Record<string, unknown> => {
    const write = (level: string) => (message: string, ...args: unknown[]) => {
      const line = `[${scope}] ${level}: ${message} ${args.join(' ')}`.trim();
      written.push(line);
      Bun.write(logPath, `${written.join('\n')}\n`);
    };
    return {
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
      emerg: write('emerg'),
      log: (level: string, message: string, ...args: unknown[]) => write(level)(message, ...args),
      for: (methodName: string) => makeLogger(`${scope}.${methodName}`),
    };
  };

  LoggerFactory.use({
    provider: { get: (scope: string) => makeLogger(scope) } as never,
  });

  const logger = ApplicationLogger.get('TelegramClient');
  logger.for('connect').error('Could not connect | Reason: %s', 'network down');

  expect(written.some(line => line.includes('Could not connect'))).toBe(true);
  expect(existsSync(logPath)).toBe(true);
  expect(readFileSync(logPath, 'utf8')).toContain('TelegramClient');
});
