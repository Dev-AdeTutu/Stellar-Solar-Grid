/**
 * Tests for emergency contact management and notification logic (#1000).
 *
 * Uses a dedicated on-disk sqlite file in a temp dir (same approach other
 * pooled stores in this codebase use for isolation) selected via
 * EMERGENCY_CONTACTS_DB_PATH before the module under test is imported, since
 * the module opens its pool at import time.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "emergency-contacts-")), "test.sqlite");
process.env.EMERGENCY_CONTACTS_DB_PATH = tmpDbPath;

vi.mock("./mailer.js", () => ({
  sendEmail: vi.fn(async () => ({ delivered: true, provider: "mock" })),
}));

const {
  addEmergencyContact,
  listEmergencyContacts,
  deleteEmergencyContact,
  getContactsForEvent,
  notifyEmergencyContacts,
  closeEmergencyContactsStore,
} = await import("./emergencyContacts.js");
const { sendEmail } = await import("./mailer.js");

const USER_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF5";
const USER_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB4RSH";

describe("emergencyContacts store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    closeEmergencyContactsStore();
    fs.rmSync(path.dirname(tmpDbPath), { recursive: true, force: true });
  });

  it("adds a contact with defaults applied", () => {
    const contact = addEmergencyContact({
      userAddress: USER_A,
      name: "Jane Doe",
      email: "jane@example.com",
      relationship: "Spouse",
    });

    expect(contact.id).toBeGreaterThan(0);
    expect(contact.userAddress).toBe(USER_A);
    expect(contact.name).toBe("Jane Doe");
    expect(contact.notifyOnTamper).toBe(true);
    expect(contact.notifyOnOutage).toBe(true);
    expect(contact.createdAt).toBeTruthy();
  });

  it("lists only the contacts belonging to the requested user", () => {
    addEmergencyContact({ userAddress: USER_A, name: "Contact A1", email: "a1@example.com" });
    addEmergencyContact({ userAddress: USER_B, name: "Contact B1", email: "b1@example.com" });

    const listA = listEmergencyContacts(USER_A);
    const listB = listEmergencyContacts(USER_B);

    expect(listA.some((c) => c.name === "Contact A1")).toBe(true);
    expect(listA.some((c) => c.name === "Contact B1")).toBe(false);
    expect(listB.some((c) => c.name === "Contact B1")).toBe(true);
    expect(listB.some((c) => c.name === "Contact A1")).toBe(false);
  });

  it("deletes a contact scoped to its owning user", () => {
    const contact = addEmergencyContact({ userAddress: USER_A, name: "Temp", phone: "+15550000000" });

    expect(deleteEmergencyContact(USER_B, contact.id)).toBe(false);
    expect(deleteEmergencyContact(USER_A, contact.id)).toBe(true);
    expect(listEmergencyContacts(USER_A).some((c) => c.id === contact.id)).toBe(false);
  });

  describe("per-event notify flags", () => {
    it("only returns contacts with the matching notify flag enabled", () => {
      const user = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC2OZK";
      const tamperOnly = addEmergencyContact({
        userAddress: user,
        name: "Tamper Only",
        email: "tamper-only@example.com",
        notifyOnTamper: true,
        notifyOnOutage: false,
      });
      const outageOnly = addEmergencyContact({
        userAddress: user,
        name: "Outage Only",
        email: "outage-only@example.com",
        notifyOnTamper: false,
        notifyOnOutage: true,
      });
      const both = addEmergencyContact({
        userAddress: user,
        name: "Both",
        email: "both@example.com",
      });

      const tamperContacts = getContactsForEvent(user, "tamper").map((c) => c.id);
      const outageContacts = getContactsForEvent(user, "outage").map((c) => c.id);

      expect(tamperContacts).toContain(tamperOnly.id);
      expect(tamperContacts).toContain(both.id);
      expect(tamperContacts).not.toContain(outageOnly.id);

      expect(outageContacts).toContain(outageOnly.id);
      expect(outageContacts).toContain(both.id);
      expect(outageContacts).not.toContain(tamperOnly.id);
    });
  });

  describe("notifyEmergencyContacts", () => {
    it("emails contacts that have notify_on_tamper enabled and an email on file", async () => {
      const user = "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD3MDM";
      addEmergencyContact({
        userAddress: user,
        name: "Will Be Emailed",
        email: "emailed@example.com",
        notifyOnTamper: true,
      });
      addEmergencyContact({
        userAddress: user,
        name: "Outage Only, Not Emailed",
        email: "not-emailed@example.com",
        notifyOnTamper: false,
        notifyOnOutage: true,
      });

      const result = await notifyEmergencyContacts(user, "tamper", "METER-1");

      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: "emailed@example.com" }),
      );
      expect(result.notified).toHaveLength(1);
      expect(result.notified[0]).toMatchObject({ channel: "email", delivered: true });
    });

    it("logs phone-only contacts as log-only instead of dropping them", async () => {
      const user = "GEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE7T3I";
      addEmergencyContact({
        userAddress: user,
        name: "Phone Only",
        phone: "+15551234567",
        notifyOnOutage: true,
      });

      const result = await notifyEmergencyContacts(user, "outage", "METER-2");

      expect(sendEmail).not.toHaveBeenCalled();
      expect(result.notified).toEqual([
        expect.objectContaining({ channel: "log-only", delivered: false }),
      ]);
    });

    it("notifies no one when the user has no matching contacts", async () => {
      const user = "GFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF4S6D";
      const result = await notifyEmergencyContacts(user, "tamper", "METER-3");

      expect(sendEmail).not.toHaveBeenCalled();
      expect(result.notified).toEqual([]);
    });
  });
});
