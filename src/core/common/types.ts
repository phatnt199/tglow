export interface IApplicationConfiguration {
  apiId: number;
  apiHash: string;
  palette: string;
  /**
   * How long App waits, once vim-engine.ts reports an `ambiguous` key
   * sequence, before giving up on a completing key and resolving the
   * shorter binding on its own -- vim's own `timeoutlen`. Configurable so it
   * can be tuned without a rebuild; see src/tui/app.tsx, which owns the timer.
   */
  timeoutMilliseconds: number;
  sessionPath: string;
  cachePath: string;
  /** Where downloaded photo thumbnails are kept, so the same picture is fetched once rather than once per launch. */
  thumbnailDirectory: string;
  logPath: string;
  /**
   * Where `palette` is looked up before the twelve built-ins, so a theme
   * dropped in here shadows a compiled one of the same name. Alongside the
   * config file rather than under the data directory: it is something you
   * edit, like config.toml, not something tglow writes.
   */
  themeDirectory: string;
  /**
   * Whether tglow holds the mouse. Default true, which is what already happens:
   * OpenTUI resolves `useMouse ?? true`, so reporting has been on since M1a
   * while nothing handled an event -- the terminal's own click-drag selection
   * was already being intercepted with nothing offered in exchange.
   *
   * `mouse = false` hands it back completely, for anyone who would rather keep
   * their terminal's selection unconditionally than click anything in tglow.
   * Shift+drag already falls through to the terminal either way; that is the
   * terminal's own behaviour, not something tglow implements.
   */
  mouse: boolean;
  /**
   * Whether tglow may ask GitHub, once a day, whether a newer release exists.
   *
   * `update_check = false` stops it entirely -- and that matters enough to be
   * a documented key rather than a hidden default, because it is the only
   * request tglow makes to anything other than Telegram. Nothing is ever
   * downloaded by the check itself; installing happens only on `:update`.
   */
  updateCheck: boolean;
}
