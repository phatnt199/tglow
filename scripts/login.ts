import { ConfigurationService, SessionStoreService, TelegramClientService } from '../src/core/index.ts';

const CTRL_C = '\u0003';
const BACKSPACE = '\u007f';
const INTERRUPTED_EXIT_CODE = 130;

/**
 * Reads one line, echoing it only when it is not a secret.
 *
 * `prompt()` always echoes, and the echo is the terminal's rather than the
 * program's, so raw mode is the only thing that stops it. Without this the
 * two-factor password and the login code were left sitting in the terminal's
 * scrollback in cleartext -- the one place in tglow where a secret was ever
 * exposed.
 */
const readLine = (opts: { label: string; secret: boolean }): Promise<string> => {
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

// Raw mode needs a terminal, and so does a login that waits on a code someone
// has to read off their phone.
if (!process.stdin.isTTY) {
  process.stderr.write('scripts/login.ts needs an interactive terminal.\n');
  process.exit(1);
}

const configuration = new ConfigurationService().load();
const clientService = new TelegramClientService(new SessionStoreService());
const client = clientService.build({ configuration });

await client.start({
  phoneNumber: async () => readLine({ label: 'Phone number (with country code): ', secret: false }),
  password: async () => readLine({ label: 'Two-factor password: ', secret: true }),
  phoneCode: async () => readLine({ label: 'Code you just received: ', secret: true }),
  onError: error => {
    console.error(error.message);
  },
});

clientService.persistSession({ client, configuration });
console.log('Logged in. Session saved to', configuration.sessionPath);
await client.destroy();
