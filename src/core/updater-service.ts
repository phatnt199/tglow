import { chmodSync, existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ApplicationLogger, toError, type ILogger } from '@venizia/ignis-helpers';

import { APPLICATION_VERSION } from '../common/index.ts';
import {
  CHECKSUM_ASSET,
  RELEASE_ENDPOINT,
  isTrustedAssetUrl,
  parseChecksums,
  parseRelease,
  resolveAvailableUpdate,
  type IAvailableUpdate,
  type TCheckOutcome,
} from './updater.ts';

/**
 * The half of the updater that touches the network and the disk.
 *
 * Split from updater.ts so every decision -- is this newer, is this asset
 * mine, is this URL somewhere I will download from, does this digest match --
 * is checkable without either. What is left here is the doing.
 *
 * Nothing here runs on its own. `check` is called once a day at most and only
 * when `update_check` is on; `install` is called only by `:update`. tglow
 * replaces its own executable, and a program that does so unattended is one
 * that can hand you a broken build overnight.
 */

/** Long enough for a slow connection, short enough not to hang a launch. */
const CHECK_TIMEOUT_MILLISECONDS = 8_000;
/** The binaries are over a hundred megabytes; this is a download, not a ping. */
const DOWNLOAD_TIMEOUT_MILLISECONDS = 10 * 60 * 1000;
/** Owner-executable, like anything else tglow writes for itself. */
const EXECUTABLE_MODE = 0o755;

export interface IInstallResult {
  installed: boolean;
  message: string;
}

export class UpdaterService {
  private readonly _logger: ILogger = ApplicationLogger.get(UpdaterService.name);

  /**
   * Ask GitHub what the latest release is.
   *
   * Three outcomes, not two. "Could not ask" is kept apart from "nothing to
   * offer" because collapsing them made `:update` report that you were on the
   * latest release when it had simply failed to reach GitHub -- a lie in the
   * one place a user goes specifically to find out, and one that stops them
   * looking again.
   *
   * The daily background check still treats unreachable as nothing worth
   * saying; it is `:update`, where the user asked, that must be honest.
   */
  check = async (opts: {
    platform?: string;
    architecture?: string;
    currentVersion?: string;
    fetchImplementation?: typeof fetch;
  } = {}): Promise<TCheckOutcome> => {
    const request = opts.fetchImplementation ?? fetch;
    try {
      const response = await request(RELEASE_ENDPOINT, {
        headers: {
          // GitHub asks for both, and a request without a user agent is
          // rejected outright.
          accept: 'application/vnd.github+json',
          'user-agent': `tglow/${APPLICATION_VERSION}`,
        },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MILLISECONDS),
      });
      if (!response.ok) {
        this._logger.for('check').info('The release endpoint answered %s', response.status);
        return { kind: 'unreachable' };
      }

      const release = parseRelease({ payload: await response.json() });
      if (release === null) {
        // Reached, and answered with something unusable. Not "current" -- the
        // honest thing is that the question was not answered.
        return { kind: 'unreachable' };
      }
      const update = resolveAvailableUpdate({
        release,
        currentVersion: opts.currentVersion ?? APPLICATION_VERSION,
        platform: opts.platform ?? process.platform,
        architecture: opts.architecture ?? process.arch,
      });
      return update === null ? { kind: 'current' } : { kind: 'update', update };
    } catch (error) {
      // Includes the timeout, an offline machine, and DNS. None of it is worth
      // a message: tglow's job is Telegram, and this was a courtesy.
      this._logger.for('check').info('Could not check for a release | Reason: %s', toError(error).message);
      return { kind: 'unreachable' };
    }
  };

  /**
   * Download the update, verify it, and put it in place of the running binary.
   *
   * The order matters and is the whole safety argument:
   *
   *  1. the published checksum file is fetched first, so there is something to
   *     check against before there is anything to check;
   *  2. the binary is downloaded to a temporary file *beside* the target, so
   *     the rename at the end is on one filesystem and therefore atomic;
   *  3. its digest is computed and compared, and a mismatch deletes the
   *     download and stops -- nothing that cannot be accounted for is ever
   *     made executable;
   *  4. only then does it replace the running executable.
   *
   * Replacing a running program is fine on Linux and macOS: the rename swaps
   * the directory entry and the running process keeps the old inode until it
   * exits. Windows refuses to touch a locked image, so there the old one is
   * moved aside first and cleaned up on the next launch.
   */
  install = async (opts: {
    update: IAvailableUpdate;
    /** The running executable. process.execPath, in practice. */
    executablePath: string;
    assetUrl: string;
    platform?: string;
    fetchImplementation?: typeof fetch;
  }): Promise<IInstallResult> => {
    const platform = opts.platform ?? process.platform;
    const request = opts.fetchImplementation ?? fetch;

    // Checked again here, not only where the update was resolved: this is the
    // call that writes an executable, and it should not depend on an earlier
    // one having been careful.
    if (!isTrustedAssetUrl({ url: opts.assetUrl })) {
      return { installed: false, message: 'Refused: that download is not on the release host' };
    }

    const directory = dirname(opts.executablePath);
    const downloadPath = join(directory, `.tglow-${opts.update.version}.download`);

    try {
      const expected = await this.fetchChecksum({ request, update: opts.update });
      if (expected === null) {
        return { installed: false, message: 'Could not fetch the published checksum; nothing was installed' };
      }

      const response = await request(opts.assetUrl, {
        headers: { 'user-agent': `tglow/${APPLICATION_VERSION}` },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MILLISECONDS),
      });
      if (!response.ok) {
        return { installed: false, message: `The download answered ${response.status}; nothing was installed` };
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      writeFileSync(downloadPath, bytes, { mode: EXECUTABLE_MODE });

      const actual = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
      if (actual !== expected) {
        rmSync(downloadPath, { force: true });
        this._logger.for('install').error(
          'Checksum mismatch for %s | Expected: %s | Got: %s', opts.update.assetName, expected, actual);
        return { installed: false, message: 'Refused: the download did not match its published checksum' };
      }

      // A download that is implausibly small is a redirect page or an error
      // body that happened to hash, not a binary. Cheap to check, and the
      // failure it prevents is an unusable tglow.
      if (statSync(downloadPath).size < 1_000_000) {
        rmSync(downloadPath, { force: true });
        return { installed: false, message: 'Refused: the download is too small to be tglow' };
      }

      chmodSync(downloadPath, EXECUTABLE_MODE);
      this.swapIntoPlace({ downloadPath, executablePath: opts.executablePath, platform });

      return {
        installed: true,
        message: `tglow ${opts.update.version} installed — restart tglow to run it`,
      };
    } catch (error) {
      rmSync(downloadPath, { force: true });
      const reason = toError(error).message;
      this._logger.for('install').error('Could not install the update | Reason: %s', reason);
      return { installed: false, message: `Could not install the update: ${reason}` };
    }
  };

  /** Anything left behind by a previous Windows install. Safe to call anywhere. */
  cleanUpAfterUpdate = (opts: { executablePath: string }): void => {
    const stale = `${opts.executablePath}.old`;
    if (!existsSync(stale)) {
      return;
    }
    try {
      rmSync(stale, { force: true });
    } catch (error) {
      // The previous image may still be locked by a process that has not
      // exited. It is a stray file, not a problem worth reporting.
      this._logger.for('cleanUpAfterUpdate').info('Could not remove %s | Reason: %s', stale, toError(error).message);
    }
  };

  private fetchChecksum = async (opts: {
    request: typeof fetch;
    update: IAvailableUpdate;
  }): Promise<string | null> => {
    const url = `https://github.com/phatnt199/tglow/releases/download/v${opts.update.version}/${CHECKSUM_ASSET}`;
    const response = await opts.request(url, {
      headers: { 'user-agent': `tglow/${APPLICATION_VERSION}` },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MILLISECONDS),
    });
    if (!response.ok) {
      return null;
    }
    return parseChecksums({ text: await response.text() }).get(opts.update.assetName) ?? null;
  };

  /**
   * Put the verified download where the running binary is.
   *
   * Windows will not rename over a locked image, so the running one is moved
   * aside and removed on the next launch. Everywhere else the rename is enough
   * and the running process simply keeps the inode it already opened.
   */
  private swapIntoPlace = (opts: {
    downloadPath: string;
    executablePath: string;
    platform: string;
  }): void => {
    if (opts.platform === 'win32') {
      const stale = `${opts.executablePath}.old`;
      rmSync(stale, { force: true });
      renameSync(opts.executablePath, stale);
    }
    renameSync(opts.downloadPath, opts.executablePath);
  };
}
