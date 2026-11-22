/**
 * Phone numbers registered for SMS configuration (#1152).
 *
 * A Set gives an upsert on phone identity: posting the same number twice can
 * never append a duplicate, so a recipient receives one copy of each message.
 * This mirrors the module-level configuration store used by smsProviders.
 */
const PHONE_RE = /^\+[1-9]\d{6,14}$/;

const registeredPhones = new Set<string>();

export function isValidSmsPhone(phone: unknown): phone is string {
  return typeof phone === "string" && PHONE_RE.test(phone);
}

/** Adds a phone number if absent. Returns true only when it was newly added. */
export function upsertSmsPhone(phone: string): boolean {
  if (registeredPhones.has(phone)) return false;
  registeredPhones.add(phone);
  return true;
}

export function listSmsPhones(): string[] {
  return [...registeredPhones];
}

/** Test-only helper for isolating cases between suites. */
export function resetSmsConfigForTests(): void {
  registeredPhones.clear();
}
