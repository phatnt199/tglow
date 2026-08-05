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
  logPath: string;
  /**
   * Where `palette` is looked up before the twelve built-ins, so a theme
   * dropped in here shadows a compiled one of the same name. Alongside the
   * config file rather than under the data directory: it is something you
   * edit, like config.toml, not something tglow writes.
   */
  themeDirectory: string;
}
