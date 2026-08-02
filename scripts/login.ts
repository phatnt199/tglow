import { readLine, runInteractiveLogin } from '../src/cli/index.ts';
import {
  AuthenticationService,
  ConfigurationService,
  SessionStoreService,
  TelegramAuthenticationGateway,
  TelegramClientService,
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
