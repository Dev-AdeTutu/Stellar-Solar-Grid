/**
 * Client for the smart home API (#904). Owner calls are authenticated with a
 * short-lived session obtained by signing a challenge transaction with the
 * connected wallet (never submitted to the network).
 */
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;
const STORAGE_KEY = "smartHomeSession";

type StoredSession = { address: string; token: string; expiresAt: string };

function readStored(address: string): string | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredSession;
    if (s.address !== address || new Date(s.expiresAt).getTime() - Date.now() < 60_000) return null;
    return s.token;
  } catch {
    return null;
  }
}

export async function getSmartHomeSession(address: string, signTransaction: (xdr: string) => Promise<string>): Promise<string> {
  const cached = readStored(address);
  if (cached) return cached;

  const challengeRes = await fetch(`${API}/api/smart-home/auth/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });
  if (!challengeRes.ok) throw new Error("Could not start sign-in");
  const { transaction } = (await challengeRes.json()) as { transaction: string };

  const signed = await signTransaction(transaction);
  const sessionRes = await fetch(`${API}/api/smart-home/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, transaction: signed }),
  });
  if (!sessionRes.ok) throw new Error("Signature was not accepted");
  const session = (await sessionRes.json()) as { token: string; expiresAt: string };
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ address, ...session }));
  } catch {
    // Private browsing — the session just won't survive a reload.
  }
  return session.token;
}

export function clearSmartHomeSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export async function smartHomeFetch<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}/api/smart-home${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (res.status === 401) clearSmartHomeSession();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
