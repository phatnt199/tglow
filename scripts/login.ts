import { readLine, runInteractiveLogin } from '../src/cli/index.ts';
import {
  AuthenticationService,
  ConfigurationService,
  SessionStoreService,
  TelegramAuthenticationGateway,
  TelegramClientService,
  installFileLogger,
} from '../src/core/index.ts';

// tglow logs in on its own now; this stays for re-authenticating without
// starting the interface, and runs exactly the code path tglow runs.

// Raw mode needs a terminal, and so does a login that waits on a code someone
// has to read off their phone.
if (!process.stdin.isTTY) {
  process.stderr.write('scripts/login.ts needs an interactive terminal.\n');
  process.exit(1);
}

const configuration = new ConfigurationService().load();

// Not optional here either. Without a provider registered, LoggerFactory does
// not quietly fall back -- winston is not a dependency, so the first log call
// inside a catch block *throws*, and its message replaces the real reason a
// login failed. A wrong code reported "could not load winston".
installFileLogger({ filePath: configuration.logPath });

const clientService = new TelegramClientService(new SessionStoreService());
const client = clientService.build({ configuration });

await client.connect();

if (await client.isUserAuthorized()) {
  console.log('Already logged in. Session at', configuration.sessionPath);
} else {
  await runInteractiveLogin({
    service: new AuthenticationService(new TelegramAuthenticationGateway(client)),
    readLine,
    write: (text: string): void => {
      process.stdout.write(text);
    },
  });
  clientService.persistSession({ client, configuration });
  console.log('Logged in. Session saved to', configuration.sessionPath);
}

await client.destroy();
