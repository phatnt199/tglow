// Bun-compatibility probe for GramJS (MTProto) — staged, each stage isolated.
const results: string[] = [];
const ok = (s: string) => results.push(`  PASS  ${s}`);
const bad = (s: string, e: unknown) => results.push(`  FAIL  ${s}\n        ${(e as Error)?.message ?? e}`);

// Stage 1: does the module even import under Bun (ESM/CJS interop)?
let telegram: typeof import("telegram");
try {
  telegram = await import("telegram");
  ok(`import "telegram" — version ${(await import("telegram/package.json")).default?.version ?? "?"}`);
} catch (e) {
  bad('import "telegram"', e);
  console.log(results.join("\n"));
  process.exit(1);
}

// Stage 2: MTProto crypto primitives (AES-IGE) — the thing most likely to break
// on a non-Node runtime, since GramJS reaches into node:crypto internals.
try {
  const { IGE } = await import("telegram/crypto/IGE");
  const key = Buffer.alloc(32, 7);
  const iv = Buffer.alloc(32, 9);
  const plain = Buffer.alloc(64, 42);
  const ige = new IGE(key, iv);
  const enc = ige.encryptIge(plain);
  const dec = new IGE(key, iv).decryptIge(Buffer.from(enc));
  if (Buffer.from(dec).equals(plain)) ok("AES-IGE encrypt/decrypt round-trip");
  else bad("AES-IGE round-trip", new Error("decrypted output != plaintext"));
} catch (e) {
  bad("AES-IGE crypto", e);
}

// Stage 3: the real one — open a TCP socket to a Telegram DC and complete the
// Diffie-Hellman auth-key handshake. This exercises sockets + RSA + AES + the
// full MTProto framing. Bogus api_id is fine: it is only validated later, at
// initConnection, so reaching that point already proves the transport works.
try {
  const { TelegramClient, Api } = telegram;
  const { StringSession } = await import("telegram/sessions");
  const { Logger } = await import("telegram/extensions/Logger");

  const client = new TelegramClient(new StringSession(""), 1, "0123456789abcdef0123456789abcdef", {
    connectionRetries: 1,
    baseLogger: new Logger("none" as never),
  });

  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timed out after 25s")), 25_000));
  await Promise.race([client.connect(), timeout]);
  ok("TCP connect + MTProto DH handshake to Telegram DC");

  const session = client.session.save();
  if (typeof session === "string" && session.length > 40) ok(`auth key negotiated + session serialized (${session.length} chars)`);
  else bad("session serialization", new Error(`unexpected session: ${String(session).slice(0, 40)}`));

  // Stage 4: an actual unauthenticated RPC round-trip.
  try {
    const res = await Promise.race([client.invoke(new Api.help.GetNearestDc()), timeout]);
    ok(`live RPC help.getNearestDc → country=${(res as { country: string }).country}`);
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg.includes("API_ID")) ok(`live RPC reached Telegram (rejected bogus api_id as expected: ${msg})`);
    else bad("live RPC help.getNearestDc", e);
  }

  await client.destroy().catch(() => {});
} catch (e) {
  bad("MTProto handshake", e);
}

// Stage 5: OpenTUI core imports (renderer is Zig-backed via FFI).
try {
  const core = await import("@opentui/core");
  ok(`import "@opentui/core" — ${Object.keys(core).length} exports`);
} catch (e) {
  bad('import "@opentui/core"', e);
}
try {
  await import("@opentui/react");
  ok('import "@opentui/react"');
} catch (e) {
  bad('import "@opentui/react"', e);
}

console.log("\n=== Bun + GramJS + OpenTUI probe ===");
console.log(results.join("\n"));
process.exit(0);
