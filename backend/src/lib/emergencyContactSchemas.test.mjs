import test from "node:test";
import assert from "node:assert/strict";
import {
  DeleteEmergencyContactParamsSchema,
  DeleteEmergencyContactQuerySchema,
  AddEmergencyContactSchema,
  ListEmergencyContactsQuerySchema,
} from "./validation.ts";

const VALID_ADDRESS = `G${"A".repeat(55)}`;

test("DELETE params require a positive numeric contact id", () => {
  const ok = DeleteEmergencyContactParamsSchema.safeParse({ id: "42" });
  assert.equal(ok.success, true);
  assert.equal(ok.success && ok.data.id, 42);

  for (const bad of [{ id: "abc" }, { id: "0" }, { id: "-1" }, { id: "1.5" }, {}]) {
    assert.equal(
      DeleteEmergencyContactParamsSchema.safeParse(bad).success,
      false,
      `expected ${JSON.stringify(bad)} to be rejected`
    );
  }
});

test("DELETE query requires a valid Stellar owner address", () => {
  assert.equal(
    DeleteEmergencyContactQuerySchema.safeParse({ user_address: VALID_ADDRESS }).success,
    true
  );
  assert.equal(
    DeleteEmergencyContactQuerySchema.safeParse({ user_address: "not-an-address" }).success,
    false
  );
  assert.equal(DeleteEmergencyContactQuerySchema.safeParse({}).success, false);
});

test("add schema requires an address, name and at least one channel", () => {
  assert.equal(
    AddEmergencyContactSchema.safeParse({
      user_address: VALID_ADDRESS,
      name: "Jane",
      email: "jane@example.com",
    }).success,
    true
  );
  assert.equal(
    AddEmergencyContactSchema.safeParse({
      user_address: VALID_ADDRESS,
      name: "Jane",
    }).success,
    false
  );
  assert.equal(
    AddEmergencyContactSchema.safeParse({
      user_address: "bad",
      name: "Jane",
      phone: "+15551234567",
    }).success,
    false
  );
});

test("list query requires a valid Stellar address", () => {
  assert.equal(
    ListEmergencyContactsQuerySchema.safeParse({ user_address: VALID_ADDRESS }).success,
    true
  );
  assert.equal(
    ListEmergencyContactsQuerySchema.safeParse({ user_address: "bad" }).success,
    false
  );
});
