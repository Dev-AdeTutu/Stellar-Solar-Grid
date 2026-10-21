import { Router } from "express";
import { z } from "zod";
import { buyoutLease, getLease, listLeaseEvents, listLeases, makeLeasePayment, startLease } from "../lib/leases.js";
export const leasesRouter = Router();
const startSchema = z.object({ meterId: z.string().min(1), ownerId: z.string().min(1), lesseeId: z.string().min(1), monthlyPayment: z.number().positive(), totalPayments: z.number().int().min(1).max(120), buyoutAmount: z.number().positive().optional() });
const paymentSchema = z.object({ payerId: z.string().min(1), amount: z.number().positive() });
function domain(res: any, err: unknown) { return res.status(400).json({ error: err instanceof Error ? err.message : "invalid lease request" }); }
leasesRouter.get("/", (req, res) => res.json({ leases: listLeases(typeof req.query.ownerId === "string" ? req.query.ownerId : undefined) }));
leasesRouter.post("/", (req, res) => { const parsed = startSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() }); try { return res.status(201).json(startLease(parsed.data)); } catch (e) { return domain(res, e); } });
leasesRouter.get("/:id", (req, res) => { const lease = getLease(req.params.id); return lease ? res.json({ lease, events: listLeaseEvents(lease.id) }) : res.status(404).json({ error: "lease not found" }); });
leasesRouter.post("/:id/payments", (req, res) => { const parsed = paymentSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() }); try { return res.json(makeLeasePayment(req.params.id, parsed.data.payerId, parsed.data.amount)); } catch (e) { return domain(res, e); } });
leasesRouter.post("/:id/buyout", (req, res) => { const payerId = z.object({ payerId: z.string().min(1) }).safeParse(req.body); if (!payerId.success) return res.status(400).json({ error: payerId.error.flatten() }); try { return res.json(buyoutLease(req.params.id, payerId.data.payerId)); } catch (e) { return domain(res, e); } });
