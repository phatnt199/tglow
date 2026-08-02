const CTRL_C = '\u0003';
const BACKSPACE = '\u007f';
const INTERRUPTED_EXIT_CODE = 130;

export type TReadLine = (opts: { label: string; secret: boolean }) => Promise<string>;

/**
 * Reads one line, echoing it only when it is not a secret.
 *
 * `prompt()` always echoes, and the echo is the terminal's rather than the
 * program's, so raw mode is the only thing that stops it. Without this the
 * two-factor password and the login code were left sitting in the terminal's
 * scrollback in cleartext -- the one place in tglow where a secret was ever
 * exposed.
 */
export const readLine: TReadLine = (opts: { label: string; secret: boolean }): Promise<string> => {
  const { label, secret } = opts;
  const stdin = process.stdin;

  return new Promise<string>(resolve => {
    process.stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';

    const finish = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };

    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') {
          finish();
          resolve(value);
          return;
        }

        // Raw mode hands this process Ctrl-C as an ordinary byte, so without
        // this branch the prompt could not be abandoned at all.
        if (character === CTRL_C) {
          finish();
          process.exit(INTERRUPTED_EXIT_CODE);
        }

        if (character === BACKSPACE) {
          if (value !== '' && !secret) {
            process.stdout.write('\b \b');
          }
          value = value.slice(0, -1);
          continue;
        }

        if (!secret) {
          process.stdout.write(character);
        }
        value += character;
      }
    };

    stdin.on('data', onData);
  });
};
