import { Router, type NextFunction, type Request, type Response } from "express";
import { sessionAddress } from "../lib/walletAuth.js";
import { sendEmail } from "../lib/mailer.js";
import {
  createTicket,
  listTicketsForUser,
  getTicket,
  updateTicketStatus,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketPriority,
  type TicketStatus,
} from "../lib/supportTickets.js";
import { logger } from "../lib/logger.js";

export const supportTicketsRouter = Router();
type AuthenticatedRequest = Request & { userAddress?: string };

function bearer(req: Request): string | undefined {
  const value = req.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

function requireSession(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const address = sessionAddress(bearer(req));
  if (!address) return res.status(401).json({ error: "Wallet session required", code: "UNAUTHORIZED" });
  req.userAddress = address;
  next();
}

function isString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.trim().length >= min && value.trim().length <= max;
}

function validEnum<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function notificationRecipient(): string | null {
  const value = process.env.SUPPORT_EMAIL?.trim();
  return value || null;
}

async function notify(to: string | null, subject: string, text: string): Promise<void> {
  if (!to) return;
  try {
    await sendEmail({ to, subject, text });
  } catch (error) {
    // Ticket persistence must not fail because an external mail provider is unavailable.
    logger.error({ err: error, to, subject }, "Support ticket email notification failed");
  }
}

supportTicketsRouter.post("/", requireSession, async (req: AuthenticatedRequest, res: Response) => {
  const { subject, description, priority, email } = req.body ?? {};
  if (!isString(subject, 1, 160) || !isString(description, 1, 10_000)) {
    return res.status(400).json({ error: "subject (1–160 characters) and description (1–10000 characters) are required" });
  }
  if (priority !== undefined && !validEnum(priority, TICKET_PRIORITIES)) {
    return res.status(400).json({ error: `priority must be one of: ${TICKET_PRIORITIES.join(", ")}` });
  }
  if (email !== undefined && (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    return res.status(400).json({ error: "email must be a valid email address" });
  }
  const ticket = createTicket({
    user: req.userAddress!,
    userEmail: email?.trim() || null,
    subject: subject.trim(),
    description: description.trim(),
    priority: priority as TicketPriority | undefined,
  });
  const supportEmail = notificationRecipient();
  const message = `Ticket #${ticket.id}\nFrom: ${ticket.user}\nSubject: ${ticket.subject}\nPriority: ${ticket.priority}\n\n${ticket.description}`;
  await Promise.all([
    notify(ticket.userEmail, `SolarGrid support ticket #${ticket.id} received`, `We received your support request.\n\n${message}`),
    notify(supportEmail, `New SolarGrid support ticket #${ticket.id}: ${ticket.subject}`, message),
  ]);
  return res.status(201).json({ ticket });
});

supportTicketsRouter.get("/", requireSession, (req: AuthenticatedRequest, res: Response) => {
  return res.json({ tickets: listTicketsForUser(req.userAddress!) });
});

supportTicketsRouter.patch("/:id", requireSession, async (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  const { status } = req.body ?? {};
  if (!Number.isSafeInteger(id) || id < 1 || !validEnum(status, TICKET_STATUSES)) {
    return res.status(400).json({ error: `id must be positive and status must be one of: ${TICKET_STATUSES.join(", ")}` });
  }
  const existing = getTicket(id);
  if (!existing || existing.user !== req.userAddress) return res.status(404).json({ error: "Ticket not found" });
  const ticket = updateTicketStatus(id, req.userAddress!, status as TicketStatus);
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });
  const supportEmail = notificationRecipient();
  const text = `Ticket #${ticket.id} status changed to ${ticket.status}.\n\nSubject: ${ticket.subject}\nUser: ${ticket.user}`;
  await Promise.all([
    notify(ticket.userEmail, `SolarGrid support ticket #${ticket.id} updated`, text),
    notify(supportEmail, `Support ticket #${ticket.id} status: ${ticket.status}`, text),
  ]);
  return res.json({ ticket });
});
