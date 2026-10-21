/**
 * Transactional email delivery (#902).
 *
 * Uses the provider's HTTP API via fetch so no SMTP dependency is needed.
 * Select a provider with EMAIL_PROVIDER:
 *   - "resend"   — RESEND_API_KEY
 *   - "sendgrid" — SENDGRID_API_KEY
 *   - "log"      — (default) logs the message instead of sending; useful in dev
 * The sender address comes from EMAIL_FROM.
 */
import { logger } from "./logger.js";

export type EmailAttachment = { filename: string; content: Buffer; contentType: string };

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: EmailAttachment[];
};

export type EmailResult = { delivered: boolean; provider: string; id?: string };

const EMAIL_FROM = process.env.EMAIL_FROM ?? "SolarGrid Billing <billing@solargrid.local>";

export function emailProvider(): string {
  return (process.env.EMAIL_PROVIDER ?? "log").toLowerCase();
}

async function sendViaResend(msg: EmailMessage): Promise<EmailResult> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      attachments: msg.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content.toString("base64"),
      })),
    }),
  });
  if (!res.ok) throw new Error(`Resend responded ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { id?: string };
  return { delivered: true, provider: "resend", id: body.id };
}

async function sendViaSendGrid(msg: EmailMessage): Promise<EmailResult> {
  const content = [{ type: "text/plain", value: msg.text }];
  if (msg.html) content.push({ type: "text/html", value: msg.html });
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: msg.to }] }],
      from: { email: EMAIL_FROM.match(/<(.+)>/)?.[1] ?? EMAIL_FROM },
      subject: msg.subject,
      content,
      attachments: msg.attachments?.map((a) => ({
        filename: a.filename,
        type: a.contentType,
        content: a.content.toString("base64"),
        disposition: "attachment",
      })),
    }),
  });
  if (!res.ok) throw new Error(`SendGrid responded ${res.status}`);
  return { delivered: true, provider: "sendgrid", id: res.headers.get("x-message-id") ?? undefined };
}

export async function sendEmail(msg: EmailMessage): Promise<EmailResult> {
  switch (emailProvider()) {
    case "resend":
      return sendViaResend(msg);
    case "sendgrid":
      return sendViaSendGrid(msg);
    default:
      logger.info("Email (log provider) — not delivered", {
        to: msg.to,
        subject: msg.subject,
        attachments: msg.attachments?.map((a) => a.filename),
      });
      return { delivered: false, provider: "log" };
  }
}
