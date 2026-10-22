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

export type VoiceIntent = "check_balance" | "check_usage" | "make_payment" | "cancel_payment" | "unknown";

export type VoiceParseResult = {
  intent: VoiceIntent;
  slots: Record<string, string>;
  confidence: number;
  locale: string;
};

export type VoicePaymentConfirmation = {
  hash: string;
  meterId: string;
  amountStroops: string;
};

async function voiceFetch<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}/api/voice${path}`, {
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

export async function parseVoiceCommand(token: string, text: string, locale: string): Promise<VoiceParseResult> {
  return voiceFetch<VoiceParseResult>(token, "/parse", {
    method: "POST",
    body: JSON.stringify({ text, locale }),
  });
}

export async function confirmVoicePayment(
  token: string,
  confirmationToken: string,
  pin: string,
): Promise<VoicePaymentConfirmation> {
  return voiceFetch<VoicePaymentConfirmation>(token, "/payment/confirm", {
    method: "POST",
    body: JSON.stringify({ confirmationToken, pin }),
  });
}

export async function cancelVoicePayment(token: string, confirmationToken: string): Promise<void> {
  return voiceFetch<void>(token, "/payment/cancel", {
    method: "POST",
    body: JSON.stringify({ confirmationToken }),
  });
}

export type DrEventStatus = "scheduled" | "active" | "completed" | "cancelled";

export type DrEvent = {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  curtailmentTargetKw: number;
  incentiveRateStroopsPerKwh: string;
  status: DrEventStatus;
};

export type DrEnrollment = {
  eventId: string;
  address: string;
  optedIn: boolean;
  loadPreferences: Record<string, number>;
};

export type DrPerformance = {
  eventId: string;
  address: string;
  baselineKw: number;
  actualKw: number;
  curtailedKw: number;
  verified: boolean;
};

export type DrIncentive = {
  eventId: string;
  address: string;
  amountStroops: string;
  distributed: boolean;
  txHash?: string;
};

export type CreateDrEventInput = {
  name: string;
  startsAt: string;
  endsAt: string;
  curtailmentTargetKw: number;
  incentiveRateStroopsPerKwh: string;
};

export type OptInDrInput = {
  eventId: string;
  loadPreferences: Record<string, number>;
};

export async function getDrEvents(token: string): Promise<DrEvent[]> {
  return smartHomeFetch<DrEvent[]>(token, "/dr/events");
}

export async function createDrEvent(token: string, input: CreateDrEventInput): Promise<DrEvent> {
  return smartHomeFetch<DrEvent>(token, "/dr/events", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function optInDr(token: string, input: OptInDrInput): Promise<DrEnrollment> {
  return smartHomeFetch<DrEnrollment>(token, "/dr/opt-in", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function optOutDr(token: string, eventId: string): Promise<void> {
  return smartHomeFetch<void>(token, "/dr/opt-out", {
    method: "POST",
    body: JSON.stringify({ eventId }),
  });
}

export async function getDrPerformance(token: string, eventId: string): Promise<DrPerformance[]> {
  return smartHomeFetch<DrPerformance[]>(token, `/dr/events/${encodeURIComponent(eventId)}/performance`);
}

export async function getDrIncentives(token: string, eventId: string): Promise<DrIncentive[]> {
  return smartHomeFetch<DrIncentive[]>(token, `/dr/events/${encodeURIComponent(eventId)}/incentives`);
}

export async function triggerDrCurtailment(token: string, eventId: string): Promise<DrEvent> {
  return smartHomeFetch<DrEvent>(token, `/dr/events/${encodeURIComponent(eventId)}/curtail`, {
    method: "POST",
  });
}
