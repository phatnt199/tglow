import { test, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UpdaterService } from '../../core/updater-service.ts';
import { ASSET_HOST, type IAvailableUpdate } from '../../core/updater.ts';

/** Big enough to pass the "too small to be tglow" floor. */
const BODY = new Uint8Array(1_200_000).fill(7);
const DIGEST = new Bun.CryptoHasher('sha256').update(BODY).digest('hex');

const UPDATE: IAvailableUpdate = { version: '9.9.9', assetName: 'tglow-linux-x64', size: BODY.length };
const ASSET_URL = `https://${ASSET_HOST}/phatnt199/tglow/releases/download/v9.9.9/tglow-linux-x64`;

/**
 * A fetch that answers from a table, and records what was asked for. Nothing
 * in these tests reaches the network -- the point is the decisions around it.
 */
const stubFetch = (opts: {
  checksumBody?: string;
  checksumStatus?: number;
  assetBody?: Uint8Array;
  assetStatus?: number;
}): { request: typeof fetch; asked: string[] } => {
  const asked: string[] = [];
  const request = (async (url: string | URL | Request): Promise<Response> => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    asked.push(href);
    if (href.endsWith('tglow.sha256')) {
      return new Response(opts.checksumBody ?? `${DIGEST}  tglow-linux-x64\n`,
        { status: opts.checksumStatus ?? 200 });
    }
    return new Response(opts.assetBody ?? BODY, { status: opts.assetStatus ?? 200 });
  }) as unknown as typeof fetch;
  return { request, asked };
};

/** A directory with a stand-in for the running binary in it. */
const workspace = (): { executablePath: string } => {
  const directory = mkdtempSync(join(tmpdir(), 'tglow-update-'));
  const executablePath = join(directory, 'tglow');
  writeFileSync(executablePath, 'the running binary');
  return { executablePath };
};

// ── the happy path ────────────────────────────────────────────────────────

test('a verified download replaces the running binary', async () => {
  const { executablePath } = workspace();
  const { request } = stubFetch({});

  const result = await new UpdaterService().install({
    update: UPDATE, executablePath, assetUrl: ASSET_URL, platform: 'linux', fetchImplementation: request, delay: async () => {},
  });

  expect(result.installed).toBe(true);
  expect(result.message).toContain('9.9.9');
  expect(readFileSync(executablePath).length).toBe(BODY.length);
});

// The checksum is fetched before the binary, so there is something to check
// against before there is anything to check.
test('the checksum is fetched before the binary', async () => {
  const { executablePath } = workspace();
  const { request, asked } = stubFetch({});

  await new UpdaterService().install({
    update: UPDATE, executablePath, assetUrl: ASSET_URL, platform: 'linux', fetchImplementation: request, delay: async () => {},
  });

  expect(asked[0]).toContain('tglow.sha256');
  expect(asked[1]).toBe(ASSET_URL);
});

// ── the refusals, which are the point ─────────────────────────────────────

// The one that matters most: bytes that do not match their published digest
// are never made executable.
test('a download that does not match its checksum is refused and deleted', async () => {
  const { executablePath } = workspace();
  const before = readFileSync(executablePath, 'utf8');
  const { request } = stubFetch({ assetBody: new Uint8Array(1_200_000).fill(9) });

  const result = await new UpdaterService().install({
    update: UPDATE, executablePath, assetUrl: ASSET_URL, platform: 'linux', fetchImplementation: request, delay: async () => {},
  });

  expect(result.installed).toBe(false);
  expect(result.message).toContain('checksum');
  // The running binary is untouched, and no download is left lying about.
  expect(readFileSync(executablePath, 'utf8')).toBe(before);
  expect(existsSync(join(executablePath, '..', '.tglow-9.9.9.download'))).toBe(false);
});

// The URL comes out of a response, and a response is data.
test('an asset hosted anywhere else is refused before anything is fetched', async () => {
  const { executablePath } = workspace();
  const before = readFileSync(executablePath, 'utf8');
  const { request, asked } = stubFetch({});

  const result = await new UpdaterService().install({
    update: UPDATE, executablePath, assetUrl: 'https://example.com/tglow-linux-x64',
    platform: 'linux', fetchImplementation: request, delay: async () => {},
  });

  expect(result.installed).toBe(false);
  expect(result.message).toContain('release host');
  expect(asked).toEqual([]);
  expect(readFileSync(executablePath, 'utf8')).toBe(before);
});

test('no published checksum means nothing is installed', async () => {
  const { executablePath } = workspace();
  const before = readFileSync(executablePath, 'utf8');
  const { request } = stubFetch({ checksumStatus: 404 });

  const result = await new UpdaterService().install({
    update: UPDATE, executablePath, assetUrl: ASSET_URL, platform: 'linux', fetchImplementation: request, delay: async () => {},
  });

  expect(result.installed).toBe(false);
  expect(readFileSync(executablePath, 'utf8')).toBe(before);
});

test('a checksum file that names no such asset installs nothing', async () => {
  const { executablePath } = workspace();
  const { request } = stubFetch({ checksumBody: `${DIGEST}  tglow-macos-arm64\n` });

  const result = await new UpdaterService().install({
    update: UPDATE, executablePath, assetUrl: ASSET_URL, platform: 'linux', fetchImplementation: request, delay: async () => {},
  });

  expect(result.installed).toBe(false);
});

test('a failed download installs nothing', async () => {
  const { executablePath } = workspace();
  const before = readFileSync(executablePath, 'utf8');
  const { request } = stubFetch({ assetStatus: 503 });

  const result = await new UpdaterService().install({
    update: UPDATE, executablePath, assetUrl: ASSET_URL, platform: 'linux', fetchImplementation: request, delay: async () => {},
  });

  expect(result.installed).toBe(false);
  expect(result.message).toContain('503');
  expect(readFileSync(executablePath, 'utf8')).toBe(before);
});

// An error page that happens to hash is not a binary. The floor is cheap, and
// the failure it prevents is an unusable tglow.
test('something far too small to be tglow is refused even if it matches', async () => {
  const { executablePath } = workspace();
  const tiny = new Uint8Array(16).fill(1);
  const tinyDigest = new Bun.CryptoHasher('sha256').update(tiny).digest('hex');
  const { request } = stubFetch({ assetBody: tiny, checksumBody: `${tinyDigest}  tglow-linux-x64\n` });

  const result = await new UpdaterService().install({
    update: UPDATE, executablePath, assetUrl: ASSET_URL, platform: 'linux', fetchImplementation: request, delay: async () => {},
  });

  expect(result.installed).toBe(false);
  expect(result.message).toContain('too small');
});

// ── Windows ───────────────────────────────────────────────────────────────

// Windows will not rename over a locked image, so the running one is moved
// aside first. Checked here because this machine is not Windows and the branch
// would otherwise never run.
test('on Windows the running image is moved aside rather than overwritten', async () => {
  const { executablePath } = workspace();
  const { request } = stubFetch({});

  const result = await new UpdaterService().install({
    update: UPDATE, executablePath, assetUrl: ASSET_URL, platform: 'win32', fetchImplementation: request,
  });

  expect(result.installed).toBe(true);
  expect(readFileSync(executablePath).length).toBe(BODY.length);
  expect(readFileSync(`${executablePath}.old`, 'utf8')).toBe('the running binary');
});

test('the moved-aside image is cleaned up afterwards, and absence is not an error', () => {
  const { executablePath } = workspace();
  writeFileSync(`${executablePath}.old`, 'previous');
  const service = new UpdaterService();

  service.cleanUpAfterUpdate({ executablePath });
  expect(existsSync(`${executablePath}.old`)).toBe(false);

  expect(() => { service.cleanUpAfterUpdate({ executablePath }); }).not.toThrow();
});

// ── checking ──────────────────────────────────────────────────────────────

test('a newer release is reported as available', async () => {
  const request = (async () => new Response(JSON.stringify({
    tag_name: 'v9.9.9',
    assets: [{ name: 'tglow-linux-x64', browser_download_url: ASSET_URL, size: BODY.length }],
  }), { status: 200 })) as unknown as typeof fetch;

  expect(await new UpdaterService().check({
    platform: 'linux', architecture: 'x64', currentVersion: '0.6.1', fetchImplementation: request, delay: async () => {},
  })).toEqual({ kind: 'update', update: { version: '9.9.9', assetName: 'tglow-linux-x64', size: BODY.length } });
});

// Every kind of failure reports 'unreachable', never 'current'. Collapsing
// these made `:update` claim you were on the latest release when it had simply
// failed to ask -- a lie in the one place a user goes to find out.
test('a check that cannot complete reports unreachable, never current', async () => {
  for (const request of [
    (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
    (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch,
    (async () => new Response(JSON.stringify({ tag_name: 'nonsense' }), { status: 200 })) as unknown as typeof fetch,
  ]) {
    expect(await new UpdaterService().check({
      platform: 'linux', architecture: 'x64', currentVersion: '0.6.1', fetchImplementation: request, delay: async () => {},
    })).toEqual({ kind: 'unreachable' });
  }
});

test('a reachable check with nothing newer reports current', async () => {
  const request = (async () => new Response(JSON.stringify({
    tag_name: 'v0.1.0', assets: [],
  }), { status: 200 })) as unknown as typeof fetch;

  expect(await new UpdaterService().check({
    platform: 'linux', architecture: 'x64', currentVersion: '0.6.1', fetchImplementation: request, delay: async () => {},
  })).toEqual({ kind: 'current' });
});

// ── surviving a flaky host ────────────────────────────────────────────────
//
// The reason this exists, measured rather than imagined: a plain fetch to
// github.com/.../releases/download/... drops the connection about half the
// time from a real machine -- "The socket connection was closed unexpectedly",
// inside a tenth of a second, before any bytes move. An install makes two such
// requests, so it used to succeed about a quarter of the time. That is what
// the first person to type `:update` actually saw.

/** Fails the first `failures` attempts on every URL, then answers normally. */
const flakyFetch = (opts: { failures: number }): { request: typeof fetch; attempts: () => number } => {
  const seen = new Map<string, number>();
  let total = 0;
  const request = (async (url: string | URL | Request): Promise<Response> => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    total += 1;
    const attempt = (seen.get(href) ?? 0) + 1;
    seen.set(href, attempt);
    if (attempt <= opts.failures) {
      throw new Error('The socket connection was closed unexpectedly');
    }
    if (href.endsWith('tglow.sha256')) {
      return new Response(`${DIGEST}  tglow-linux-x64\n`, { status: 200 });
    }
    return new Response(BODY, { status: 200 });
  }) as unknown as typeof fetch;
  return { request, attempts: () => total };
};

test('an install survives a connection dropped on the first attempt', async () => {
  const { executablePath } = workspace();
  const { request } = flakyFetch({ failures: 1 });

  const result = await new UpdaterService().install({
    update: UPDATE, executablePath, assetUrl: ASSET_URL, platform: 'linux', fetchImplementation: request, delay: async () => {},
  });

  expect(result.installed).toBe(true);
  expect(readFileSync(executablePath).length).toBe(BODY.length);
});

test('an install survives both requests failing twice each', async () => {
  const { executablePath } = workspace();
  const { request, attempts } = flakyFetch({ failures: 2 });

  const result = await new UpdaterService().install({
    update: UPDATE, executablePath, assetUrl: ASSET_URL, platform: 'linux', fetchImplementation: request, delay: async () => {},
  });

  expect(result.installed).toBe(true);
  // Three attempts each for the checksum and the binary.
  expect(attempts()).toBe(6);
  expect(result.message).toContain('9.9.9');
});

// Retrying is not a promise that the network works. A host that is genuinely
// down must still be reported, not retried forever.
test('a host that never answers is reported rather than retried forever', async () => {
  const { executablePath } = workspace();
  const before = readFileSync(executablePath, 'utf8');
  const { request, attempts } = flakyFetch({ failures: 99 });

  const result = await new UpdaterService().install({
    update: UPDATE, executablePath, assetUrl: ASSET_URL, platform: 'linux', fetchImplementation: request, delay: async () => {},
  });

  expect(result.installed).toBe(false);
  expect(attempts()).toBe(10);
  expect(readFileSync(executablePath, 'utf8')).toBe(before);
  // The raw transport error is developer noise -- "pass `verbose: true` in the
  // second argument to fetch()" is what the user actually saw. Say what
  // happened and where to get it by hand instead.
  expect(result.message).not.toContain('verbose');
  expect(result.message).toContain('connection kept dropping');
  expect(result.message).toContain('releases/tag/v9.9.9');
});

// Only the transport is retried. An HTTP response is an answer, and asking a
// second time because the answer was 404 asks a settled question again.
test('an HTTP error is not retried', async () => {
  const { executablePath } = workspace();
  let calls = 0;
  const request = (async (url: string | URL | Request): Promise<Response> => {
    calls += 1;
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    return new Response('nope', { status: href.endsWith('tglow.sha256') ? 404 : 200 });
  }) as unknown as typeof fetch;

  const result = await new UpdaterService().install({
    update: UPDATE, executablePath, assetUrl: ASSET_URL, platform: 'linux', fetchImplementation: request, delay: async () => {},
  });

  expect(result.installed).toBe(false);
  expect(calls).toBe(1);
});

test('a check survives a dropped connection too', async () => {
  let attempt = 0;
  const request = (async (): Promise<Response> => {
    attempt += 1;
    if (attempt === 1) {
      throw new Error('The socket connection was closed unexpectedly');
    }
    return new Response(JSON.stringify({
      tag_name: 'v9.9.9',
      assets: [{ name: 'tglow-linux-x64', browser_download_url: ASSET_URL, size: BODY.length }],
    }), { status: 200 });
  }) as unknown as typeof fetch;

  expect(await new UpdaterService().check({
    platform: 'linux', architecture: 'x64', currentVersion: '0.6.1', fetchImplementation: request, delay: async () => {},
  })).toEqual({ kind: 'update', update: { version: '9.9.9', assetName: 'tglow-linux-x64', size: BODY.length } });
});
