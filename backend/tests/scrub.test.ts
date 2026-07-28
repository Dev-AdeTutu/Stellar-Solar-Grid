// Simple test runner: exit 0 on pass, 1 on fail
import * as StellarSdk from "@stellar/stellar-sdk";

// Generate a valid keypair so StellarService can initialize safely during import
const kp = StellarSdk.Keypair.random();
process.env.ADMIN_SECRET_KEY = kp.secret();

(async () => {
  const { scrub } = await import("../src/lib/stellar.js");

  const secret = process.env.ADMIN_SECRET_KEY;
  const pub = kp.publicKey();
  const msg = `error: secret=${secret} pub=${pub} details`;
  const out = scrub(msg);
  if (out.includes(secret)) {
    console.error("FAILED: secret still present in output", out);
    process.exit(1);
  }
  if (!out.includes("[REDACTED]")) {
    console.error("FAILED: redaction token missing", out);
    process.exit(1);
  }
  console.log("OK: scrub redacted secret");
  process.exit(0);
})();
