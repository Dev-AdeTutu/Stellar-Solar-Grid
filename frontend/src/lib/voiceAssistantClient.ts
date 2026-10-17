import { env } from "./env";

const API = env.NEXT_PUBLIC_BACKEND_URL;

export async function parseVoiceCommand(command: string, language = "en") {
  const res = await fetch(`${API}/api/voice/parse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, language }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to parse voice command");
  return data;
}

export async function confirmVoicePayment(intentId: string, language = "en") {
  const res = await fetch(`${API}/api/voice/payments/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intentId, language }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to confirm voice payment");
  return data;
}
