/**
 * Knowing when a newer tglow exists, and installing it when asked.
 *
 * Everything in this half is pure: comparing versions, choosing which asset
 * belongs to this machine, reading a checksum file, deciding whether enough
 * time has passed to look again. The network and the filesystem live in
 * updater-service.ts, so all the decisions here can be checked without either.
 *
 * ## What it will and will not do
 *
 * It checks. It does not install unless the user types `:update`. That line is
 * deliberate: tglow replaces its own executable, and a program that does so
 * unattended is a program that can hand you a broken build overnight. The
 * check is one request a day and can be turned off entirely -- it is the only
 * request tglow makes to anything other than Telegram, which is why it is
 * documented in the README's own security section rather than buried here.
 *
 * ## What it verifies before touching anything
 *
 * The published `tglow.sha256` is downloaded alongside the binary and the
 * binary's digest must match the line naming it. A downloaded executable that
 * does not match is deleted and reported, never installed. This is not
 * ceremony: the whole point of a self-updater is that it writes something that
 * will later be run as the user, so the one thing it must never do is install
 * bytes it cannot account for.
 */

/** Where releases come from. Fixed, never taken from a response. */
export const RELEASE_HOST = 'api.github.com';
export const RELEASE_ENDPOINT = 'https://api.github.com/repos/phatnt199/tglow/releases/latest';
/** Assets must come from here; anything else is refused. See isTrustedAssetUrl. */
export const ASSET_HOST = 'github.com';

/** How long a check is good for. One a day is enough to hear about a release without being a heartbeat. */
export const CHECK_INTERVAL_MILLISECONDS = 24 * 60 * 60 * 1000;

/** The sync_state key the last check's time is kept under. */
export const LAST_CHECK_KEY = 'update_checked_at';

/** The checksum file published beside the binaries. */
export const CHECKSUM_ASSET = 'tglow.sha256';

export interface IReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface IRelease {
  version: string;
  assets: IReleaseAsset[];
}

export interface IAvailableUpdate {
  version: string;
  /** The asset built for this machine. */
  assetName: string;
  size: number;
}

/**
 * A semantic version as numbers, or null when it is not one.
 *
 * Tolerates a leading `v`, because that is how the tags are written and how
 * the API reports them, and refuses everything else -- a version that does not
 * parse must not silently compare as older or newer than the running one.
 */
export const parseVersion = (opts: { value: string }): number[] | null => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(opts.value.trim());
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

/**
 * Whether `candidate` is a later version than `current`.
 *
 * False when either fails to parse, which is the safe direction: an
 * unrecognisable version never triggers an update, where the other default
 * would offer to install something nobody can order against.
 */
export const isNewer = (opts: { current: string; candidate: string }): boolean => {
  const current = parseVersion({ value: opts.current });
  const candidate = parseVersion({ value: opts.candidate });
  if (current === null || candidate === null) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (candidate[index]! !== current[index]!) {
      return candidate[index]! > current[index]!;
    }
  }
  return false;
};

/**
 * The asset name built for this platform, or null where tglow publishes none.
 *
 * Null is a real answer: a Linux arm64 machine can run tglow perfectly well
 * from source, and offering it the x64 binary would be worse than saying
 * nothing.
 */
export const resolveAssetName = (opts: { platform: string; architecture: string }): string | null => {
  const { platform, architecture } = opts;
  if (platform === 'linux' && architecture === 'x64') {
    return 'tglow-linux-x64';
  }
  if (platform === 'darwin') {
    return architecture === 'arm64' ? 'tglow-macos-arm64' : architecture === 'x64' ? 'tglow-macos-x64' : null;
  }
  if (platform === 'win32' && architecture === 'x64') {
    return 'tglow-windows-x64.exe';
  }
  return null;
};

/** The GitHub releases payload, as much of it as tglow uses. */
export const parseRelease = (opts: { payload: unknown }): IRelease | null => {
  const payload = opts.payload as {
    tag_name?: unknown;
    draft?: unknown;
    prerelease?: unknown;
    assets?: unknown;
  } | null;
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  // A draft or a pre-release is not something to offer anyone: the endpoint
  // used excludes them, but the payload is the only thing that actually says
  // so, and trusting the endpoint's promise rather than the field is how a
  // release candidate reaches everybody.
  if (payload.draft === true || payload.prerelease === true) {
    return null;
  }
  if (typeof payload.tag_name !== 'string' || parseVersion({ value: payload.tag_name }) === null) {
    return null;
  }

  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  return {
    version: payload.tag_name.replace(/^v/, ''),
    assets: assets.flatMap((entry: unknown) => {
      const asset = entry as { name?: unknown; browser_download_url?: unknown; size?: unknown };
      if (typeof asset?.name !== 'string' || typeof asset.browser_download_url !== 'string') {
        return [];
      }
      return [{
        name: asset.name,
        url: asset.browser_download_url,
        size: typeof asset.size === 'number' ? asset.size : 0,
      }];
    }),
  };
};

/**
 * Whether a URL is somewhere tglow will download from.
 *
 * The URL comes out of a response, and a response is data. Pinning the host
 * means a payload that has been tampered with cannot point the downloader at
 * somewhere else -- which matters more here than almost anywhere, because what
 * is downloaded becomes the executable.
 */
export const isTrustedAssetUrl = (opts: { url: string }): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(opts.url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') {
    return false;
  }
  return parsed.hostname === ASSET_HOST || parsed.hostname.endsWith(`.${ASSET_HOST}`);
};

/**
 * The update worth telling the user about, or null.
 *
 * Null when the release is not newer, when it carries no asset for this
 * machine, or when that asset is not somewhere tglow will download from.
 */
export const resolveAvailableUpdate = (opts: {
  release: IRelease;
  currentVersion: string;
  platform: string;
  architecture: string;
}): IAvailableUpdate | null => {
  if (!isNewer({ current: opts.currentVersion, candidate: opts.release.version })) {
    return null;
  }
  const assetName = resolveAssetName({ platform: opts.platform, architecture: opts.architecture });
  if (assetName === null) {
    return null;
  }
  const asset = opts.release.assets.find(candidate => candidate.name === assetName);
  if (asset === undefined || !isTrustedAssetUrl({ url: asset.url })) {
    return null;
  }
  return { version: opts.release.version, assetName, size: asset.size };
};

/**
 * Whether to ask GitHub again.
 *
 * `enabled` comes from config.toml's `update_check`, and false means tglow
 * never contacts anything but Telegram.
 */
export const shouldCheck = (opts: {
  enabled: boolean;
  lastCheckedAt: number | null;
  now: number;
}): boolean => {
  if (!opts.enabled) {
    return false;
  }
  if (opts.lastCheckedAt === null) {
    return true;
  }
  // A clock that has gone backwards -- a laptop resuming, a timezone fix --
  // must not park a stored future timestamp in the way of every future check.
  if (opts.lastCheckedAt > opts.now) {
    return true;
  }
  return opts.now - opts.lastCheckedAt >= CHECK_INTERVAL_MILLISECONDS;
};

/**
 * The digests in a `sha256sum` file, by file name.
 *
 * The format is `<64 hex> <two spaces or space-star><name>`, one per line.
 * Anything that is not that shape is skipped rather than guessed at: a
 * half-understood checksum file is exactly the situation to refuse.
 *
 * Either case of hex is read and normalised down. `sha256sum` writes lower,
 * but Windows' own `certutil -hashfile` writes upper, and a user who checked
 * their download with the tool their machine ships should not be told the
 * file is corrupt.
 */
export const parseChecksums = (opts: { text: string }): Map<string, string> => {
  const digests = new Map<string, string>();
  for (const line of opts.text.split('\n')) {
    const match = /^([0-9a-fA-F]{64})\s[\s*](.+)$/.exec(line.trim());
    if (match) {
      digests.set(match[2]!.trim(), match[1]!.toLowerCase());
    }
  }
  return digests;
};

/** What the user is told, once a check has happened. */
export const describeUpdate = (opts: { update: IAvailableUpdate | null; currentVersion: string }): string =>
  opts.update === null
    ? `tglow ${opts.currentVersion} is the latest release`
    : `tglow ${opts.update.version} is available — :update to install it`;

/**
 * The download URL for an update's asset.
 *
 * Built from the version and the asset name rather than carried through from
 * the payload, so the URL that is actually fetched is one tglow composed out
 * of a host it hard-codes. `isTrustedAssetUrl` still checks it -- belt and
 * braces on the one path that produces an executable.
 */
export const buildAssetUrl = (opts: { update: IAvailableUpdate }): string =>
  `https://${ASSET_HOST}/phatnt199/tglow/releases/download/v${opts.update.version}/${opts.update.assetName}`;
