import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { LoggerFactory, type ILogger, type ILoggerProvider } from '@venizia/ignis-helpers';

type TLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'emerg';

const formatArgument = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  return JSON.stringify(value);
};

/**
 * A TUI owns the alternate screen: anything written to stdout lands in the
 * middle of a frame. IGNIS's default provider is winston-to-stdout, so the
 * application replaces it with this before the first log call.
 */
const buildFileLogger = (opts: { filePath: string; scope: string }): ILogger => {
  const { filePath, scope } = opts;

  const write = (level: TLogLevel): ((message: string, ...args: unknown[]) => void) => {
    return (message: string, ...args: unknown[]): void => {
      const rendered = args.length === 0 ? message : `${message} ${args.map(formatArgument).join(' ')}`;
      const line = `${new Date().toISOString()} [${level}] [${scope}] ${rendered}\n`;
      appendFileSync(filePath, line);
    };
  };

  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    emerg: write('emerg'),
    log: (level: TLogLevel, message: string, ...args: unknown[]): void => {
      write(level)(message, ...args);
    },
    for: (methodName: string): ILogger => {
      return buildFileLogger({ filePath, scope: `${scope}.${methodName}` });
    },
  } as ILogger;
};

export const buildFileLoggerProvider = (opts: { filePath: string }): ILoggerProvider => {
  mkdirSync(dirname(opts.filePath), { recursive: true });
  return { get: (scope: string): ILogger => buildFileLogger({ filePath: opts.filePath, scope }) };
};

/** Must run before anything else can log, or winston claims stdout first. */
export const installFileLogger = (opts: { filePath: string }): void => {
  LoggerFactory.use({ provider: buildFileLoggerProvider({ filePath: opts.filePath }) });
};
