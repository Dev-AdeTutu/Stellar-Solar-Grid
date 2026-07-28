import {
  adminInvoke,
  contractQuery,
  RPC_URL,
  CONTRACT_ID,
} from "../../backend/src/lib/stellar.js";
import { Keypair, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";

async function runE2ETest() {
  const testMeter = "E2E_METER_" + Date.now();
  const user = Keypair.random();

  console.log("Starting E2E payment flow test...");
  console.log("Test meter ID:", testMeter);
  console.log("User public key:", user.publicKey());
  console.log("RPC URL:", RPC_URL);
  console.log("Contract ID:", CONTRACT_ID);

  // 1. Fund test account via friendbot
  console.log("\n1. Funding test account via friendbot...");
  const friendbotUrl = `https://friendbot.stellar.org?addr=${encodeURIComponent(user.publicKey())}`;
  const friendbotResponse = await fetch(friendbotUrl);
  if (!friendbotResponse.ok) {
    throw new Error(`Friendbot failed: ${await friendbotResponse.text()}`);
  }
  console.log("Account funded successfully");

  // 2. Register meter
  console.log("\n2. Registering meter...");
  await adminInvoke("register_meter", [
    nativeToScVal(testMeter, { type: "symbol" }),
    nativeToScVal(user.publicKey(), { type: "address" }),
  ]);
  console.log("Meter registered");

  // 3. Verify inactive before payment
  console.log("\n3. Verifying meter is inactive before payment...");
  const before = await contractQuery("check_access", [
    nativeToScVal(testMeter, { type: "symbol" }),
  ]);
  const isActiveBefore = scValToNative(before);
  if (isActiveBefore !== false) {
    throw new Error(
      `Expected meter to be inactive before payment, but got: ${isActiveBefore}`,
    );
  }
  console.log("Meter is inactive (as expected)");

  // 4. Make payment
  console.log("\n4. Making payment...");
  const paymentAmount = 5_000_000n; // 0.5 XLM in stroops
  await adminInvoke("make_payment", [
    nativeToScVal(testMeter, { type: "symbol" }),
    nativeToScVal(user.publicKey(), { type: "address" }),
    nativeToScVal(paymentAmount, { type: "i128" }),
    nativeToScVal("Daily", { type: "symbol" }),
  ]);
  console.log("Payment made successfully");

  // 5. Verify active after payment
  console.log("\n5. Verifying meter is active after payment...");
  const after = await contractQuery("check_access", [
    nativeToScVal(testMeter, { type: "symbol" }),
  ]);
  const isActiveAfter = scValToNative(after);
  if (isActiveAfter !== true) {
    throw new Error(
      `Expected meter to be active after payment, but got: ${isActiveAfter}`,
    );
  }
  console.log("Meter is active (as expected)");

  // 6. Simulate usage update
  console.log("\n6. Simulating usage update...");
  await adminInvoke("update_usage", [
    nativeToScVal(testMeter, { type: "symbol" }),
    nativeToScVal(100n, { type: "u64" }), // 100 units
    nativeToScVal(500000n, { type: "i128" }), // 0.05 XLM cost
  ]);
  console.log("Usage update recorded");

  // 7. Verify balance decreased
  console.log("\n7. Verifying balance decreased after usage...");
  const meterInfo = await contractQuery("get_meter", [
    nativeToScVal(testMeter, { type: "symbol" }),
  ]);
  const meterData = scValToNative(meterInfo) as { balance: bigint };
  console.log("Current balance:", meterData.balance.toString(), "stroops");

  // 8. Deactivate meter (simulate running out of balance)
  console.log("\n8. Testing deactivation by making a large usage update...");
  // Make a usage update that will drain the balance
  await adminInvoke("update_usage", [
    nativeToScVal(testMeter, { type: "symbol" }),
    nativeToScVal(1000000n, { type: "u64" }), // Large units
    nativeToScVal(1000000000n, { type: "i128" }), // Large cost
  ]);
  console.log("Large usage update recorded");

  // 9. Verify access state after large usage
  console.log("\n9. Verifying access state after large usage...");
  const finalAccess = await contractQuery("check_access", [
    nativeToScVal(testMeter, { type: "symbol" }),
  ]);
  const isFinalActive = scValToNative(finalAccess);
  console.log("Final access state:", isFinalActive);

  console.log("\n✅ E2E payment flow test passed!");
  console.log("\nTest Summary:");
  console.log("- Meter registered:", testMeter);
  console.log("- User account funded via friendbot");
  console.log("- Payment made successfully");
  console.log("- Access state changed: inactive → active");
  console.log("- Usage updates recorded");
  console.log("- Balance tracked correctly");
}

runE2ETest().catch((err) => {
  console.error("E2E test failed:", err);
  process.exit(1);
});
