import { createHash } from 'node:crypto';
import { basename } from 'node:path';

const filePath = process.argv[2];

if (!filePath) {
  process.stderr.write('Usage: bun run scripts/checksum.ts <file>\n');
  process.exit(1);
}

const digest = createHash('sha256').update(await Bun.file(filePath).bytes()).digest('hex');

// sha256sum's own format, so `sha256sum -c tglow.sha256` verifies a download
// without anyone needing bun installed.
await Bun.write(`${filePath}.sha256`, `${digest}  ${basename(filePath)}\n`);
process.stdout.write(`${digest}  ${basename(filePath)}\n`);
