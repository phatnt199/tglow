import { ConfigurationService, SessionStoreService, TelegramClientService } from '../src/core/index.ts';

const configuration = new ConfigurationService().load();
const clientService = new TelegramClientService(new SessionStoreService());
const client = clientService.build({ configuration });

await client.start({
  phoneNumber: async () => prompt('Phone number (with country code): ') ?? '',
  password: async () => prompt('Two-factor password: ') ?? '',
  phoneCode: async () => prompt('Code you just received: ') ?? '',
  onError: error => {
    console.error(error.message);
  },
});

clientService.persistSession({ client, configuration });
console.log('Logged in. Session saved to', configuration.sessionPath);
await client.destroy();
