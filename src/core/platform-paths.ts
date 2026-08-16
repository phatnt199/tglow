import { join } from 'node:path';

/**
 * Where tglow keeps its config and its state, on each platform it runs on.
 *
 * Pure, and told everything it needs rather than reading `process` itself:
 * every branch here is about a platform the machine running the tests is not,
 * so the only way to check the Windows answer on Linux is to be able to ask
 * for it.
 *
 * ## Linux and macOS: XDG
 *
 * `~/.config/tglow` and `~/.local/share/tglow`, honouring `XDG_CONFIG_HOME`
 * and `XDG_DATA_HOME` when they are set.
 *
 * macOS included, deliberately. The platform convention is
 * `~/Library/Application Support`, and that is right for an application with a
 * window -- but tglow is a terminal program configured by hand-editing a file,
 * and every one of its neighbours (nvim, git, tmux, the shells) puts that file
 * in `~/.config`. Burying it in a directory Finder wants to open, that a
 * terminal reaches only by typing a path with a space in it, would be
 * following a convention from the wrong end of the machine.
 *
 * ## Windows: the standard folders
 *
 * `%APPDATA%\tglow` for the config the user edits, and `%LOCALAPPDATA%\tglow`
 * for state tglow writes -- the session, the cache, the log, the thumbnails.
 * The split is the one Windows actually means by having both: roaming data
 * follows a user between machines, local data does not, and a 130MB thumbnail
 * cache is emphatically not something to synchronise across a domain.
 *
 * A dotfile directory under the profile would work, but nothing else on
 * Windows looks there, and `%APPDATA%` is where a Windows user goes to find an
 * application's settings.
 */

export interface IPlatformDirectories {
  /** Holds `config.toml` and the user's own `themes/`. */
  configDirectory: string;
  /** Holds the session, the cache, the log and the thumbnails. */
  dataDirectory: string;
}

export const APPLICATION_DIRECTORY = 'tglow';

/** Whether a value is a usable path, rather than absent or an empty string. */
const usable = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== '';

export const resolvePlatformDirectories = (opts: {
  platform: string;
  homeDirectory: string;
  environment: Record<string, string | undefined>;
}): IPlatformDirectories => {
  const { platform, homeDirectory, environment } = opts;

  if (platform === 'win32') {
    // Falling back to the profile rather than to XDG: a Windows machine with
    // neither variable set is broken in a way `~/.config` would only hide.
    const roaming = usable(environment.APPDATA)
      ? environment.APPDATA
      : join(homeDirectory, 'AppData', 'Roaming');
    const local = usable(environment.LOCALAPPDATA)
      ? environment.LOCALAPPDATA
      : join(homeDirectory, 'AppData', 'Local');
    return {
      configDirectory: join(roaming, APPLICATION_DIRECTORY),
      dataDirectory: join(local, APPLICATION_DIRECTORY),
    };
  }

  const configHome = usable(environment.XDG_CONFIG_HOME)
    ? environment.XDG_CONFIG_HOME
    : join(homeDirectory, '.config');
  const dataHome = usable(environment.XDG_DATA_HOME)
    ? environment.XDG_DATA_HOME
    : join(homeDirectory, '.local', 'share');

  return {
    configDirectory: join(configHome, APPLICATION_DIRECTORY),
    dataDirectory: join(dataHome, APPLICATION_DIRECTORY),
  };
};
