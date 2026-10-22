"use client";

/**
 * Emergency contact management (#1000): register people to notify in a
 * critical event (suspected tampering/theft, or an extended meter outage)
 * and choose which event types notify each contact.
 *
 * Not to be confused with the "emergency energy sharing" pool feature
 * (#893) — these are a user's own personal emergency contacts.
 */
import { FormEvent, useCallback, useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import { useWalletStore } from "@/store/walletStore";
import { useToast } from "@/components/ToastProvider";
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;

type EmergencyContact = {
  id: number;
  userAddress: string;
  name: string;
  phone: string | null;
  email: string | null;
  relationship: string | null;
  notifyOnTamper: boolean;
  notifyOnOutage: boolean;
  createdAt: string;
};

const INPUT = "rounded border border-white/20 bg-transparent px-3 py-2 text-sm";
const BTN = "rounded-lg border border-white/20 px-3 py-1.5 text-sm hover:bg-white/5 disabled:opacity-40";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

function AddContactForm({ onAdded }: { onAdded: (body: unknown) => Promise<void> }) {
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const phone = String(form.get("phone") ?? "").trim();
    const email = String(form.get("email") ?? "").trim();
    const relationship = String(form.get("relationship") ?? "").trim();

    setSubmitting(true);
    try {
      await onAdded({
        name: String(form.get("name") ?? "").trim(),
        phone: phone || undefined,
        email: email || undefined,
        relationship: relationship || undefined,
        notify_on_tamper: form.get("notify_on_tamper") === "on",
        notify_on_outage: form.get("notify_on_outage") === "on",
      });
      (e.target as HTMLFormElement).reset();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="rounded-lg border border-white/10 p-4 space-y-3">
      <h3 className="font-semibold">Add an emergency contact</h3>
      <div className="flex flex-wrap gap-2">
        <input name="name" required placeholder="Name" aria-label="Name" className={`${INPUT} flex-1 min-w-[10rem]`} maxLength={120} />
        <input name="relationship" placeholder="Relationship (e.g. Spouse)" aria-label="Relationship" className={`${INPUT} flex-1 min-w-[10rem]`} maxLength={60} />
      </div>
      <div className="flex flex-wrap gap-2">
        <input name="phone" type="tel" placeholder="Phone (e.g. +15551234567)" aria-label="Phone" className={`${INPUT} flex-1 min-w-[10rem]`} />
        <input name="email" type="email" placeholder="Email" aria-label="Email" className={`${INPUT} flex-1 min-w-[10rem]`} />
      </div>
      <p className="text-xs opacity-60">Provide at least a phone number or an email.</p>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="notify_on_tamper" defaultChecked />
          Notify on suspected tampering / theft
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="notify_on_outage" defaultChecked />
          Notify on extended power outage
        </label>
      </div>
      <button type="submit" className={BTN} disabled={submitting}>
        {submitting ? "Adding…" : "Add contact"}
      </button>
    </form>
  );
}

export default function EmergencyContactsPage() {
  const { address, connect } = useWalletStore();
  const { showToast } = useToast();
  const [contacts, setContacts] = useState<EmergencyContact[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!address) return;
    try {
      const { contacts: list } = await api<{ contacts: EmergencyContact[] }>(
        `/api/users/emergency-contacts?user_address=${encodeURIComponent(address)}`,
      );
      setContacts(list);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [address]);

  useEffect(() => {
    void load();
  }, [load]);

  const addContact = async (body: unknown) => {
    if (!address) return;
    try {
      await api("/api/users/emergency-contacts", {
        method: "POST",
        body: JSON.stringify({ user_address: address, ...(body as Record<string, unknown>) }),
      });
      showToast({ title: "Emergency contact added" });
      await load();
    } catch (e) {
      showToast({ title: (e as Error).message, variant: "error" });
    }
  };

  return (
    <>
      <Navbar />
      <main className="p-6 max-w-3xl mx-auto space-y-8">
        <header>
          <h1 className="text-2xl font-bold mb-1">Emergency Contacts</h1>
          <p className="text-sm opacity-70">
            Choose who gets notified if we detect suspected tampering/theft on your meter, or an
            extended power outage. You can turn either kind of alert off per contact.
          </p>
        </header>

        {!address ? (
          <button className="rounded bg-sky-600 px-4 py-2 text-white" onClick={() => connect()}>
            Connect wallet
          </button>
        ) : (
          <>
            {error && <p className="text-red-500 text-sm">{error}</p>}

            <section>
              <h2 className="text-lg font-semibold mb-2">Your contacts</h2>
              {contacts.length === 0 ? (
                <p className="text-sm opacity-70">No emergency contacts added yet.</p>
              ) : (
                <ul className="space-y-2">
                  {contacts.map((c) => (
                    <li key={c.id} className="rounded-lg border border-white/10 p-3">
                      <div className="font-medium">
                        {c.name}
                        {c.relationship && <span className="opacity-60 text-sm"> · {c.relationship}</span>}
                      </div>
                      <div className="text-xs opacity-70">
                        {[c.phone, c.email].filter(Boolean).join(" · ") || "No contact details on file"}
                      </div>
                      <div className="text-xs mt-1 flex gap-3">
                        <span className={c.notifyOnTamper ? "opacity-100" : "opacity-40"}>
                          {c.notifyOnTamper ? "✓" : "✗"} Tamper/theft alerts
                        </span>
                        <span className={c.notifyOnOutage ? "opacity-100" : "opacity-40"}>
                          {c.notifyOnOutage ? "✓" : "✗"} Outage alerts
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <AddContactForm onAdded={addContact} />
          </>
        )}
      </main>
    </>
  );
}
