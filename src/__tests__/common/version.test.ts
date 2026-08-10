import { test, expect } from 'bun:test';

import packageManifest from '../../../package.json' with { type: 'json' };
import { APPLICATION_VERSION } from '../../common/version.ts';

// These drifted once already: three releases shipped as v0.2.0, v0.3.0 and
// v0.4.0 while both package.json and the version tglow reports to Telegram
// still read 0.1.0. package.json cannot import a TypeScript constant, so the
// only thing that can hold them together is a test that reads both.
test('the version tglow reports is the version it was packaged as', () => {
  expect(APPLICATION_VERSION).toBe(packageManifest.version);
});

// Semantic versioning, because the tags are and the release notes read as
// though they are. A version that stops parsing is one nothing downstream can
// compare against.
test('the version is a plain semantic version', () => {
  expect(APPLICATION_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
