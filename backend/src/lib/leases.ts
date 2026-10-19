import { randomUUID } from "node:crypto";

export type LeaseStatus = "active" | "completed" | "bought_out" | "cancelled";
export type LeaseAgreement = {
  id: string;
  meterId: string;
  ownerId: string;
  lesseeId: string;
  monthlyPayment: number;
  totalPayments: number;
  paymentsMade: number;
  buyoutAmount: number;
  status: LeaseStatus;
  startedAt: string;
  completedAt: string | null;
  nextPaymentDue: string;
};
export type LeaseEvent = { type: "LeasePaymentMade" | "LeaseCompleted"; leaseId: string; at: string; paymentsMade: number };

const leases = new Map<string, LeaseAgreement>();
const events: LeaseEvent[] = [];
function nextMonth(from = new Date()): string { const d = new Date(from); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString(); }
export function startLease(input: { meterId: string; ownerId: string; lesseeId: string; monthlyPayment: number; totalPayments: number; buyoutAmount?: number }): LeaseAgreement {
  if (!input.meterId || !input.ownerId || !input.lesseeId) throw new Error("meterId, ownerId and lesseeId are required");
  if (input.monthlyPayment <= 0 || !Number.isInteger(input.totalPayments) || input.totalPayments < 1 || input.totalPayments > 120) throw new Error("invalid lease terms");
  const lease: LeaseAgreement = { id: `lease_${randomUUID()}`, meterId: input.meterId, ownerId: input.ownerId, lesseeId: input.lesseeId, monthlyPayment: input.monthlyPayment, totalPayments: input.totalPayments, paymentsMade: 0, buyoutAmount: input.buyoutAmount ?? input.monthlyPayment * Math.max(1, input.totalPayments), status: "active", startedAt: new Date().toISOString(), completedAt: null, nextPaymentDue: nextMonth() };
  leases.set(lease.id, lease); return lease;
}
export function makeLeasePayment(id: string, payerId: string, amount: number): LeaseAgreement {
  const lease = leases.get(id); if (!lease) throw new Error("lease not found");
  if (lease.status !== "active") throw new Error("lease is not active");
  if (payerId !== lease.lesseeId) throw new Error("only the lessee can pay");
  if (amount < lease.monthlyPayment) throw new Error(`payment must be at least ${lease.monthlyPayment}`);
  lease.paymentsMade += 1; lease.nextPaymentDue = nextMonth(new Date(lease.nextPaymentDue));
  const at = new Date().toISOString(); events.push({ type: "LeasePaymentMade", leaseId: id, at, paymentsMade: lease.paymentsMade });
  if (lease.paymentsMade >= lease.totalPayments) { lease.status = "completed"; lease.completedAt = at; lease.ownerId = lease.lesseeId; events.push({ type: "LeaseCompleted", leaseId: id, at, paymentsMade: lease.paymentsMade }); }
  return lease;
}
export function buyoutLease(id: string, payerId: string): LeaseAgreement {
  const lease = leases.get(id); if (!lease) throw new Error("lease not found");
  if (lease.status !== "active") throw new Error("lease is not active");
  if (payerId !== lease.lesseeId) throw new Error("only the lessee can buy out");
  lease.status = "bought_out"; lease.completedAt = new Date().toISOString(); lease.ownerId = lease.lesseeId;
  events.push({ type: "LeaseCompleted", leaseId: id, at: lease.completedAt, paymentsMade: lease.paymentsMade }); return lease;
}
export function getLease(id: string) { return leases.get(id); }
export function listLeases(ownerId?: string) { return [...leases.values()].filter((l) => !ownerId || l.ownerId === ownerId || l.lesseeId === ownerId); }
export function listLeaseEvents(id?: string) { return events.filter((e) => !id || e.leaseId === id); }
export function resetLeasesForTests() { leases.clear(); events.length = 0; }
