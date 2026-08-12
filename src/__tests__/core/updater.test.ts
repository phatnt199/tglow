import { test, expect } from 'bun:test';

import {
  ASSET_HOST,
  CHECK_INTERVAL_MILLISECONDS,
  buildAssetUrl,
  describeUpdate,
  isNewer,
  isTrustedAssetUrl,
  parseChecksums,
  parseRelease,
  parseVersion,
  resolveAssetName,
  resolveAvailableUpdate,
  shouldCheck,
  type IRelease,
} from '../../core/updater.ts';

const release = (opts: Partial<IRelease> = {}): IRelease => ({
  version: '0.7.0',
  assets: [{
    name: 'tglow-linux-x64',
    url: `https://${ASSET_HOST}/phatnt199/tglow/releases/download/v0.7.0/tglow-linux-x64`,
    size: 130_000_000,
  }],
  ...opts,
});

// ── reading a version ─────────────────────────────────────────────────────

test('a semantic version parses, with or without its leading v', () => {
  expect(parseVersion({ value: '1.2.3' })).toEqual([1, 2, 3]);
  expect(parseVersion({ value: 'v0.6.1' })).toEqual([0, 6, 1]);
  expect(parseVersion({ value: '  v10.20.30  ' })).toEqual([10, 20, 30]);
});

// Refused rather than guessed at: a version that does not parse must never
// compare as newer, or tglow offers to install something nothing can order.
test('anything that is not a plain semantic version is refused', () => {
  for (const value of ['', 'latest', '1.2', '1.2.3.4', '1.2.3-rc1', 'v1.2.3+build', 'x.y.z']) {
    expect(parseVersion({ value })).toBeNull();
  }
});

test('a later version is newer, an earlier or equal one is not', () => {
  expect(isNewer({ current: '0.6.1', candidate: '0.6.2' })).toBe(true);
  expect(isNewer({ current: '0.6.1', candidate: '0.7.0' })).toBe(true);
  expect(isNewer({ current: '0.6.1', candidate: '1.0.0' })).toBe(true);
  expect(isNewer({ current: '0.6.1', candidate: '0.6.1' })).toBe(false);
  expect(isNewer({ current: '0.6.1', candidate: '0.6.0' })).toBe(false);
  expect(isNewer({ current: '1.0.0', candidate: '0.9.9' })).toBe(false);
});

// String comparison gets this wrong -- '0.10.0' < '0.9.0' as text -- and it is
// exactly the case a project reaches on its tenth minor release.
test('versions compare as numbers, not as text', () => {
  expect(isNewer({ current: '0.9.0', candidate: '0.10.0' })).toBe(true);
  expect(isNewer({ current: '0.10.0', candidate: '0.9.0' })).toBe(false);
  expect(isNewer({ current: '1.2.9', candidate: '1.2.10' })).toBe(true);
});

test('an unparseable version on either side never counts as newer', () => {
  expect(isNewer({ current: '0.6.1', candidate: 'nightly' })).toBe(false);
  expect(isNewer({ current: 'unknown', candidate: '9.9.9' })).toBe(false);
});

// ── which build belongs to this machine ───────────────────────────────────

test('each published platform resolves to its own asset', () => {
  expect(resolveAssetName({ platform: 'linux', architecture: 'x64' })).toBe('tglow-linux-x64');
  expect(resolveAssetName({ platform: 'darwin', architecture: 'arm64' })).toBe('tglow-macos-arm64');
  expect(resolveAssetName({ platform: 'darwin', architecture: 'x64' })).toBe('tglow-macos-x64');
  expect(resolveAssetName({ platform: 'win32', architecture: 'x64' })).toBe('tglow-windows-x64.exe');
});

// Null is a real answer. A Linux arm64 machine runs tglow perfectly well from
// source, and handing it the x64 binary would be worse than saying nothing.
test('a platform with no published build resolves to nothing', () => {
  expect(resolveAssetName({ platform: 'linux', architecture: 'arm64' })).toBeNull();
  expect(resolveAssetName({ platform: 'win32', architecture: 'arm64' })).toBeNull();
  expect(resolveAssetName({ platform: 'freebsd', architecture: 'x64' })).toBeNull();
});

// ── reading the release payload ───────────────────────────────────────────

test('a release payload yields its version and assets', () => {
  const parsed = parseRelease({
    payload: {
      tag_name: 'v0.7.0',
      assets: [{ name: 'tglow-linux-x64', browser_download_url: 'https://github.com/a', size: 10 }],
    },
  });

  expect(parsed).toEqual({
    version: '0.7.0',
    assets: [{ name: 'tglow-linux-x64', url: 'https://github.com/a', size: 10 }],
  });
});

// The endpoint used excludes these, but the payload is the only thing that
// actually says so -- trusting the endpoint's promise rather than the field is
// how a release candidate reaches everybody.
test('a draft or a pre-release is not offered to anyone', () => {
  const base = { tag_name: 'v0.7.0', assets: [] };
  expect(parseRelease({ payload: { ...base, draft: true } })).toBeNull();
  expect(parseRelease({ payload: { ...base, prerelease: true } })).toBeNull();
});

test('a payload that is not a release is refused rather than half-read', () => {
  for (const payload of [null, undefined, 'nope', 42, {}, { tag_name: 'latest' }, { tag_name: 7 }]) {
    expect(parseRelease({ payload })).toBeNull();
  }
});

test('an asset missing its name or url is dropped, and the rest survive', () => {
  const parsed = parseRelease({
    payload: {
      tag_name: 'v0.7.0',
      assets: [
        { name: 'good', browser_download_url: 'https://github.com/a', size: 1 },
        { name: 'no url' },
        { browser_download_url: 'https://github.com/b' },
      ],
    },
  });

  expect(parsed!.assets.map(asset => asset.name)).toEqual(['good']);
});

// ── where tglow will download from ────────────────────────────────────────

// The URL comes out of a response, and a response is data. Pinning the host is
// what stops a tampered payload from pointing the downloader somewhere else --
// which matters more here than anywhere, because what is downloaded becomes
// the executable.
test('only https on the release host is trusted', () => {
  expect(isTrustedAssetUrl({ url: `https://${ASSET_HOST}/phatnt199/tglow/releases/download/v1/x` })).toBe(true);
  expect(isTrustedAssetUrl({ url: `https://objects.${ASSET_HOST}/x` })).toBe(true);
});

test('anywhere else, or plain http, is refused', () => {
  for (const url of [
    `http://${ASSET_HOST}/x`,
    'https://example.com/x',
    `https://${ASSET_HOST}.example.com/x`,
    `https://evil${ASSET_HOST}/x`,
    'file:///etc/passwd',
    'not a url',
    '',
  ]) {
    expect(isTrustedAssetUrl({ url })).toBe(false);
  }
});

// ── deciding there is an update ───────────────────────────────────────────

test('a newer release with a build for this machine is an update', () => {
  expect(resolveAvailableUpdate({
    release: release(), currentVersion: '0.6.1', platform: 'linux', architecture: 'x64',
  })).toEqual({ version: '0.7.0', assetName: 'tglow-linux-x64', size: 130_000_000 });
});

test('the release you are already running is not an update', () => {
  expect(resolveAvailableUpdate({
    release: release({ version: '0.6.1' }), currentVersion: '0.6.1', platform: 'linux', architecture: 'x64',
  })).toBeNull();
});

test('a newer release with no build for this machine is not an update', () => {
  expect(resolveAvailableUpdate({
    release: release(), currentVersion: '0.6.1', platform: 'linux', architecture: 'arm64',
  })).toBeNull();
});

test('a newer release whose asset is missing is not an update', () => {
  expect(resolveAvailableUpdate({
    release: release({ assets: [] }), currentVersion: '0.6.1', platform: 'linux', architecture: 'x64',
  })).toBeNull();
});

// The security-relevant one: a payload pointing somewhere else offers nothing.
test('an asset hosted somewhere untrusted is not an update', () => {
  expect(resolveAvailableUpdate({
    release: release({
      assets: [{ name: 'tglow-linux-x64', url: 'https://example.com/tglow-linux-x64', size: 1 }],
    }),
    currentVersion: '0.6.1', platform: 'linux', architecture: 'x64',
  })).toBeNull();
});

// ── when to look again ────────────────────────────────────────────────────

test('a check that has never run runs', () => {
  expect(shouldCheck({ enabled: true, lastCheckedAt: null, now: 1_000 })).toBe(true);
});

test('a check inside the interval waits, and outside it runs', () => {
  const now = 10 * CHECK_INTERVAL_MILLISECONDS;
  expect(shouldCheck({ enabled: true, lastCheckedAt: now - 1, now })).toBe(false);
  expect(shouldCheck({ enabled: true, lastCheckedAt: now - CHECK_INTERVAL_MILLISECONDS, now })).toBe(true);
});

// `update_check = false` means tglow contacts nothing but Telegram, and that
// has to hold whatever is or is not stored.
test('turning the check off stops it, however long it has been', () => {
  expect(shouldCheck({ enabled: false, lastCheckedAt: null, now: 0 })).toBe(false);
  expect(shouldCheck({ enabled: false, lastCheckedAt: 1, now: Number.MAX_SAFE_INTEGER })).toBe(false);
});

// A laptop resuming, or a timezone correction, can leave a stored timestamp in
// the future -- which must not block every check from then on.
test('a stored time in the future does not block checking forever', () => {
  expect(shouldCheck({ enabled: true, lastCheckedAt: 5_000, now: 1_000 })).toBe(true);
});

// ── the checksum file ─────────────────────────────────────────────────────

const DIGEST = 'a'.repeat(64);

test('a sha256sum file reads back as name to digest', () => {
  const digests = parseChecksums({
    text: `${DIGEST}  tglow-linux-x64\n${'b'.repeat(64)}  tglow-macos-arm64\n`,
  });

  expect(digests.get('tglow-linux-x64')).toBe(DIGEST);
  expect(digests.get('tglow-macos-arm64')).toBe('b'.repeat(64));
});

test('the binary form, with its star, reads the same', () => {
  expect(parseChecksums({ text: `${DIGEST} *tglow-linux-x64` }).get('tglow-linux-x64')).toBe(DIGEST);
});

test('an upper-case digest is normalised', () => {
  expect(parseChecksums({ text: `${'A'.repeat(64)}  tglow-linux-x64` }).get('tglow-linux-x64'))
    .toBe('a'.repeat(64));
});

// A half-understood checksum file is exactly the situation to refuse: anything
// not of the expected shape is skipped rather than guessed at.
test('lines that are not a digest and a name are skipped', () => {
  const digests = parseChecksums({
    text: [
      '# a comment',
      '',
      'not-a-digest  tglow-linux-x64',
      `${'z'.repeat(64)}  bad-hex`,
      `${DIGEST}  tglow-linux-x64`,
    ].join('\n'),
  });

  expect([...digests.keys()]).toEqual(['tglow-linux-x64']);
});

test('an empty file yields nothing rather than throwing', () => {
  expect(parseChecksums({ text: '' }).size).toBe(0);
});

// ── what the user reads ───────────────────────────────────────────────────

test('the message names the version and how to install it', () => {
  expect(describeUpdate({
    update: { version: '0.7.0', assetName: 'tglow-linux-x64', size: 1 }, currentVersion: '0.6.1',
  })).toContain('0.7.0');
  expect(describeUpdate({
    update: { version: '0.7.0', assetName: 'tglow-linux-x64', size: 1 }, currentVersion: '0.6.1',
  })).toContain(':update');
});

test('being up to date says so, with the version you are on', () => {
  expect(describeUpdate({ update: null, currentVersion: '0.6.1' })).toContain('0.6.1');
  expect(describeUpdate({ update: null, currentVersion: '0.6.1' })).toContain('latest');
});

// ── the URL actually fetched ──────────────────────────────────────────────

// Composed from a hard-coded host rather than carried through from the
// payload, so the one path that produces an executable does not depend on a
// response having been honest.
test('the asset url is built on the release host, and passes its own check', () => {
  const url = buildAssetUrl({ update: { version: '0.7.0', assetName: 'tglow-linux-x64', size: 1 } });

  expect(url).toBe(`https://${ASSET_HOST}/phatnt199/tglow/releases/download/v0.7.0/tglow-linux-x64`);
  expect(isTrustedAssetUrl({ url })).toBe(true);
});

test('every published asset name builds a trusted url', () => {
  for (const assetName of ['tglow-linux-x64', 'tglow-macos-arm64', 'tglow-macos-x64', 'tglow-windows-x64.exe']) {
    expect(isTrustedAssetUrl({ url: buildAssetUrl({ update: { version: '1.2.3', assetName, size: 1 } }) })).toBe(true);
  }
});
