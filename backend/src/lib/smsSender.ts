/**
 * SMS delivery for users without a smartphone or reliable data connection (#997).
 *
 * Uses the provider's HTTP API via fetch so no telecom SDK is needed.
 * Select a provider with SMS_PROVIDER:
 *   - "twilio"         — TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   - "africastalking" — AFRICASTALKING_API_KEY, AFRICASTALKING_USERNAME, AFRICASTALKING_FROM?
 *   - "log"            — (default) logs the message instead of sending; useful in dev/tests
 */
import { logger } from "./logger.js";

export type SmsMessage = { to: string; body: string };
export type SmsResult = { delivered: boolean; provider: string; id?: string };

export function smsProvider(): string {
  return (process.env.SMS_PROVIDER ?? "log").toLowerCase();
}

async function sendViaTwilio(msg: SmsMessage): Promise<SmsResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) throw new Error("TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER must be configured");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: msg.to, From: from, Body: msg.body }),
  });
  if (!res.ok) throw new Error(`Twilio responded ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { sid?: string };
  return { delivered: true, provider: "twilio", id: body.sid };
}

async function sendViaAfricasTalking(msg: SmsMessage): Promise<SmsResult> {
  const apiKey = process.env.AFRICASTALKING_API_KEY;
  const username = process.env.AFRICASTALKING_USERNAME;
  if (!apiKey || !username) throw new Error("AFRICASTALKING_API_KEY and AFRICASTALKING_USERNAME must be configured");
  const res = await fetch("https://api.africastalking.com/version1/messaging", {
    method: "POST",
    headers: {
      apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      username,
      to: msg.to,
      message: msg.body,
      ...(process.env.AFRICASTALKING_FROM ? { from: process.env.AFRICASTALKING_FROM } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Africa's Talking responded ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as {
    SMSMessageData?: { Recipients?: { messageId?: string; status?: string }[] };
  };
  const recipient = body.SMSMessageData?.Recipients?.[0];
  if (recipient && recipient.status && !recipient.status.toLowerCase().startsWith("success")) {
    throw new Error(`Africa's Talking rejected the message: ${recipient.status}`);
  }
  return { delivered: true, provider: "africastalking", id: recipient?.messageId };
}

export async function sendSms(msg: SmsMessage): Promise<SmsResult> {
  switch (smsProvider()) {
    case "twilio":
      return sendViaTwilio(msg);
    case "africastalking":
      return sendViaAfricasTalking(msg);
    default:
      logger.info("SMS (log provider) — not delivered", { to: msg.to, body: msg.body });
      return { delivered: false, provider: "log" };
  }
}
