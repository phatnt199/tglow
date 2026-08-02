import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SESSION_FILE_MODE = 0o600;
const SESSION_DIRECTORY_MODE = 0o700;

/**
 * The GramJS session string is equivalent to a logged-in device: whoever reads
 * it controls the account. Written 0600, git-ignored, and never logged or
 * included in an error message.
 */
export class SessionStoreService {
  load = (opts: { filePath: string }): string => {
    if (!existsSync(opts.filePath)) {
      return '';
    }
    return readFileSync(opts.filePath, 'utf8').trim();
  };

  save = (opts: { filePath: string; value: string }): void => {
    mkdirSync(dirname(opts.filePath), { recursive: true, mode: SESSION_DIRECTORY_MODE });
    writeFileSync(opts.filePath, opts.value, { mode: SESSION_FILE_MODE });
    // writeFileSync's mode applies only when it creates the inode, so an
    // existing file keeps whatever permissions it already had. Tighten
    // unconditionally: this file is equivalent to a logged-in device.
    chmodSync(opts.filePath, SESSION_FILE_MODE);
  };

  clear = (opts: { filePath: string }): void => {
    if (!existsSync(opts.filePath)) {
      return;
    }
    rmSync(opts.filePath);
  };
}
