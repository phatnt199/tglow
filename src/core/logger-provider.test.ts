import { test, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApplicationLogger } from '@venizia/ignis-helpers';

import { buildFileLoggerProvider, installFileLogger } from './logger-provider.ts';

const buildLogPath = (): string => join(mkdtempSync(join(tmpdir(), 'tglow-log-')), 'tglow.log');

test('the provider exposes the ILoggerProvider contract', () => {
  const provider = buildFileLoggerProvider({ filePath: buildLogPath() });
  expect(typeof provider.get).toBe('function');
  expect(typeof provider.get('Probe').error).toBe('function');
  expect(typeof provider.get('Probe').for).toBe('function');
});

test('log lines are written to the file, never to stdout', () => {
  const filePath = buildLogPath();
  const provider = buildFileLoggerProvider({ filePath });
  provider.get('TelegramClientService').for('connect').error('Could not connect | Reason: %s', 'network down');

  expect(existsSync(filePath)).toBe(true);
  const contents = readFileSync(filePath, 'utf8');
  expect(contents).toContain('TelegramClientService');
  expect(contents).toContain('connect');
  expect(contents).toContain('Could not connect');
  expect(contents).toContain('network down');
});

test('for() nests the method onto the scope', () => {
  const filePath = buildLogPath();
  buildFileLoggerProvider({ filePath }).get('DialogService').for('sync').info('Refreshed');
  expect(readFileSync(filePath, 'utf8')).toContain('DialogService.sync');
});

test('every level writes', () => {
  const filePath = buildLogPath();
  const logger = buildFileLoggerProvider({ filePath }).get('Probe');
  logger.debug('a-debug');
  logger.info('a-info');
  logger.warn('a-warn');
  logger.error('a-error');
  const contents = readFileSync(filePath, 'utf8');
  for (const marker of ['a-debug', 'a-info', 'a-warn', 'a-error']) {
    expect(contents).toContain(marker);
  }
});

test('installFileLogger routes ApplicationLogger through the file', () => {
  const filePath = buildLogPath();
  installFileLogger({ filePath });
  ApplicationLogger.get('InstalledProbe').for('run').warn('routed through file');
  expect(readFileSync(filePath, 'utf8')).toContain('routed through file');
});
