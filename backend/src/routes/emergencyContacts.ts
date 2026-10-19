/**
 * Emergency contact management (#1000).
 *
 * Lets a user register people to notify in a critical event (name, phone
 * and/or email, relationship) and choose which event types notify each
 * contact. Not to be confused with routes/emergency.ts (#893), which is an
 * unrelated "emergency energy sharing" pool feature for outages — this
 * route is about a user's personal emergency contacts.
 *
 *   POST /api/users/emergency-contacts — add a contact
 *   GET  /api/users/emergency-contacts — list a user's contacts
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { validateRequest, AddEmergencyContactSchema, ListEmergencyContactsQuerySchema } from "../lib/validation.js";
import { addEmergencyContact, listEmergencyContacts } from "../lib/emergencyContacts.js";
import { logger } from "../lib/logger.js";

export const emergencyContactsRouter = Router();

/**
 * POST /api/users/emergency-contacts
 *
 * Body:
 * ```json
 * {
 *   "user_address": "G...",
 *   "name": "Jane Doe",
 *   "phone": "+15551234567",
 *   "email": "jane@example.com",
 *   "relationship": "Spouse",
 *   "notify_on_tamper": true,
 *   "notify_on_outage": true
 * }
 * ```
 * At least one of `phone` / `email` is required. `notify_on_tamper` and
 * `notify_on_outage` default to `true` when omitted.
 *
 * Response (201): the created contact.
 */
emergencyContactsRouter.post(
  "/",
  validateRequest({ body: AddEmergencyContactSchema }),
  asyncHandler(async (req, res) => {
    const { user_address, name, phone, email, relationship, notify_on_tamper, notify_on_outage } = req.body;
    const contact = addEmergencyContact({
      userAddress: user_address,
      name,
      phone,
      email,
      relationship,
      notifyOnTamper: notify_on_tamper,
      notifyOnOutage: notify_on_outage,
    });
    logger.info({ userAddress: user_address, contactId: contact.id }, "Emergency contact added");
    return res.status(201).json({ contact });
  }),
);

/**
 * GET /api/users/emergency-contacts?user_address=G...
 *
 * Response (200):
 * ```json
 * { "contacts": [ { "id": 1, "userAddress": "G...", "name": "Jane Doe", ... } ] }
 * ```
 */
emergencyContactsRouter.get(
  "/",
  validateRequest({ query: ListEmergencyContactsQuerySchema }),
  asyncHandler(async (req, res) => {
    const { user_address } = req.query as { user_address: string };
    const contacts = listEmergencyContacts(user_address);
    return res.json({ contacts });
  }),
);
