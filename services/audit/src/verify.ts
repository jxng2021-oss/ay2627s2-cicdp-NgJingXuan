import { PLATFORM_CHAIN } from "./actions.js";
import { connectDatabase } from "./db/client.js";
import { listChains, verifyChain } from "./models/event.model.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const target = process.argv[2] ?? "";
if (
  target !== "--all" &&
  target !== PLATFORM_CHAIN &&
  !UUID_PATTERN.test(target)
) {
  console.error("Usage: node dist/verify.js <platform | tenant-id | --all>");
  process.exit(2);
}
const databaseUrl = process.env.DATABASE_URL;
const hmacKey = process.env.AUDIT_HMAC_KEY ?? "";
if (!databaseUrl || hmacKey.length < 32) {
  console.error("DATABASE_URL and AUDIT_HMAC_KEY must be set");
  process.exit(2);
}

const { db, close } = connectDatabase(databaseUrl);
let allOk = true;
try {
  const chains = target === "--all" ? await listChains(db) : [target];
  for (const chain of chains) {
    const result = await verifyChain(db, hmacKey, chain);
    if (result.ok) {
      console.log(`OK      ${chain}: ${result.checked} entries intact`);
    } else {
      allOk = false;
      const broken = result.firstBroken!;
      console.log(
        `BROKEN  ${chain}: first broken entry is #${broken.seq} (id ${broken.id ?? "?"}): ${broken.reason}. ${result.checked} entries before it are intact.`,
      );
    }
  }
  if (chains.length === 0) console.log("No audit entries yet.");
} finally {
  await close();
}
process.exit(allOk ? 0 : 1);
