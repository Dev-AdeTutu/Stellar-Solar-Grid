/**
 * Automated monthly bill generation (#902).
 *
 * On the 1st of every month (UTC) a bill is generated for every meter that
 * either has a billing account or recorded usage during the previous month.
 * Each bill is rendered to PDF, stored on disk, and emailed (with a payment
 * link) to the address on the meter's billing account.
 *
 * Charge calculation, all in integer stroops:
 *   energy   = Σ recorded usage cost for the period
 *              (or units × BILLING_UNIT_PRICE_STROOPS when that is set)
 *   service  = BILLING_SERVICE_CHARGE_STROOPS (fixed monthly charge, default 0)
 *   tax      = round((energy + service) × BILLING_TAX_RATE)   (default 0)
 *   total    = energy + service + tax
 *
 * Generation is idempotent: (meter_id, period) is unique, so re-running the
 * job for a period never produces duplicate bills.
 */
import crypto from "node:crypto";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { registerDatabase } from "./databaseLifecycle.js";
import { db as usageDb } from "./usageEvents.js";
import { createTextPdf } from "./pdf.js";
import { sendNotificationEmail } from "./emailNotifications.js";
import { logger } from "./logger.js";
import { getMemberDiscountPercent } from "./communities.js";

const DB_PATH = process.env.BILLING_DB_PATH ?? path.resolve(process.cwd(), "data", "billing.sqlite");
const PDF_DIR = process.env.BILLING_PDF_DIR ?? path.resolve(process.cwd(), "data", "bills");
const SCHEDULER_INTERVAL_MS = Number(process.env.BILLING_SCHEDULER_INTERVAL_MS ?? 60 * 60 * 1000);

export const STROOPS_PER_XLM = 10_000_000;

export type BillStatus = "issued" | "paid" | "void";

export type BillingAccount = {
  meter_id: string;
  email: string | null;
  name: string | null;
  stellar_address: string | null;
  created_at: string;
  updated_at: string;
};

export type Bill = {
  id: string;
  bill_number: string;
  meter_id: string;
  period: string; // YYYY-MM
  period_start: string;
  period_end: string;
  units: number;
  energy_charge: number;
  discount_percent: number;
  discount_amount: number;
  service_charge: number;
  tax: number;
  total: number;
  status: BillStatus;
  issued_at: string;
  due_at: string;
  paid_at: string | null;
  payment_tx_hash: string | null;
  payment_link: string;
  emailed_at: string | null;
  email_error: string | null;
};

export type BillingConfig = {
  unitPriceStroops: number | null;
  serviceChargeStroops: number;
  taxRate: number;
  dueDays: number;
};

export function billingConfig(): BillingConfig {
  const unit = process.env.BILLING_UNIT_PRICE_STROOPS;
  return {
    unitPriceStroops: unit ? Number(unit) : null,
    serviceChargeStroops: Number(process.env.BILLING_SERVICE_CHARGE_STROOPS ?? 0),
    taxRate: Number(process.env.BILLING_TAX_RATE ?? 0),
    dueDays: Number(process.env.BILLING_DUE_DAYS ?? 14),
  };
}

let _db: Database.Database | undefined;

function db(): Database.Database {
  if (!_db) {
    mkdirSync(path.dirname(DB_PATH), { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.exec(`
      CREATE TABLE IF NOT EXISTS billing_accounts (
        meter_id TEXT PRIMARY KEY,
        email TEXT,
        name TEXT,
        stellar_address TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bills (
        id TEXT PRIMARY KEY,
        bill_number TEXT NOT NULL UNIQUE,
        meter_id TEXT NOT NULL,
        period TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        units INTEGER NOT NULL,
        energy_charge INTEGER NOT NULL,
        discount_percent REAL NOT NULL DEFAULT 0,
        discount_amount INTEGER NOT NULL DEFAULT 0,
        service_charge INTEGER NOT NULL,
        tax INTEGER NOT NULL,
        total INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'issued',
        issued_at TEXT NOT NULL,
        due_at TEXT NOT NULL,
        paid_at TEXT,
        payment_tx_hash TEXT,
        payment_link TEXT NOT NULL,
        emailed_at TEXT,
        email_error TEXT,
        UNIQUE (meter_id, period)
      );
      CREATE INDEX IF NOT EXISTS idx_bills_meter_period ON bills (meter_id, period DESC);
      CREATE INDEX IF NOT EXISTS idx_bills_period ON bills (period);
    `);
    const billColumns = new Set(
      (_db.pragma("table_info(bills)") as Array<{ name: string }>).map((column) => column.name),
    );
    if (!billColumns.has("discount_percent")) {
      _db.exec("ALTER TABLE bills ADD COLUMN discount_percent REAL NOT NULL DEFAULT 0");
    }
    if (!billColumns.has("discount_amount")) {
      _db.exec("ALTER TABLE bills ADD COLUMN discount_amount INTEGER NOT NULL DEFAULT 0");
    }
  }
  return _db;
}

registerDatabase("billing", () => {
  _db?.close();
  _db = undefined;
});

// ── Periods ──────────────────────────────────────────────────────────────────

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidPeriod(period: string): boolean {
  return PERIOD_RE.test(period);
}

/** UTC [start, end) bounds for a YYYY-MM period. */
export function periodBounds(period: string): { start: Date; end: Date } {
  const [y, m] = period.split("-").map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

/** The calendar month before `now` (UTC), as YYYY-MM. */
export function previousPeriod(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ── Accounts ─────────────────────────────────────────────────────────────────

export function upsertBillingAccount(input: {
  meterId: string;
  email?: string | null;
  name?: string | null;
  stellarAddress?: string | null;
}): BillingAccount {
  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO billing_accounts (meter_id, email, name, stellar_address, created_at, updated_at)
       VALUES (@meterId, @email, @name, @stellarAddress, @now, @now)
       ON CONFLICT (meter_id) DO UPDATE SET
         email = excluded.email, name = excluded.name,
         stellar_address = excluded.stellar_address, updated_at = excluded.updated_at`,
    )
    .run({
      meterId: input.meterId,
      email: input.email ?? null,
      name: input.name ?? null,
      stellarAddress: input.stellarAddress ?? null,
      now,
    });
  return getBillingAccount(input.meterId)!;
}

export function getBillingAccount(meterId: string): BillingAccount | undefined {
  return db().prepare("SELECT * FROM billing_accounts WHERE meter_id = ?").get(meterId) as
    | BillingAccount
    | undefined;
}

// ── Calculation ──────────────────────────────────────────────────────────────

export type UsageTotals = { units: number; cost: number };

/**
 * Total usage for a meter over [start, end). Detailed events are combined
 * with the daily roll-ups in usage_summary; compaction deletes the detail
 * rows it summarises, so the two sources never overlap.
 */
export function getUsageTotals(meterId: string, start: Date, end: Date): UsageTotals {
  const udb = usageDb();
  const detail = udb
    .prepare(
      `SELECT COALESCE(SUM(units), 0) AS units, COALESCE(SUM(CAST(cost AS INTEGER)), 0) AS cost
       FROM usage_events WHERE meter_id = ? AND received_at >= ? AND received_at < ?`,
    )
    .get(meterId, start.toISOString(), end.toISOString()) as UsageTotals;
  const summary = udb
    .prepare(
      `SELECT COALESCE(SUM(total_units), 0) AS units, COALESCE(SUM(total_cost), 0) AS cost
       FROM usage_summary WHERE meter_id = ? AND date >= ? AND date < ?`,
    )
    .get(meterId, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)) as UsageTotals;
  return { units: detail.units + summary.units, cost: detail.cost + summary.cost };
}

export type BillCharges = {
  units: number;
  energyCharge: number;
  discountPercent: number;
  discountAmount: number;
  serviceCharge: number;
  tax: number;
  total: number;
};

/** Pure charge calculation — integer stroops throughout. */
export function calculateCharges(
  usage: UsageTotals,
  config: BillingConfig = billingConfig(),
  requestedDiscountPercent = 0,
): BillCharges {
  const rawEnergyCharge =
    config.unitPriceStroops !== null ? Math.round(usage.units * config.unitPriceStroops) : Math.round(usage.cost);
  const discountPercent = Math.min(100, Math.max(0, requestedDiscountPercent));
  const discountAmount = Math.round(rawEnergyCharge * discountPercent / 100);
  const energyCharge = rawEnergyCharge - discountAmount;
  const serviceCharge = Math.round(config.serviceChargeStroops);
  const tax = Math.round((energyCharge + serviceCharge) * config.taxRate);
  return {
    units: usage.units,
    energyCharge,
    discountPercent,
    discountAmount,
    serviceCharge,
    tax,
    total: energyCharge + serviceCharge + tax,
  };
}

/** Meters to bill for a period: every billing account plus any meter with usage. */
function metersForPeriod(start: Date, end: Date): string[] {
  const ids = new Set<string>(
    (db().prepare("SELECT meter_id FROM billing_accounts").all() as { meter_id: string }[]).map((r) => r.meter_id),
  );
  const udb = usageDb();
  for (const r of udb
    .prepare("SELECT DISTINCT meter_id FROM usage_events WHERE received_at >= ? AND received_at < ?")
    .all(start.toISOString(), end.toISOString()) as { meter_id: string }[]) {
    ids.add(r.meter_id);
  }
  for (const r of udb
    .prepare("SELECT DISTINCT meter_id FROM usage_summary WHERE date >= ? AND date < ?")
    .all(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)) as { meter_id: string }[]) {
    ids.add(r.meter_id);
  }
  return [...ids].sort();
}

// ── Payment link ─────────────────────────────────────────────────────────────

/**
 * Link to the web app's pay page, pre-filled with the meter and amount due.
 * When BILLING_PAYMENT_DESTINATION is set, a SEP-0007 URI for wallets is
 * also included in the email body (see buildSep7Uri).
 */
export function buildPaymentLink(bill: Pick<Bill, "id" | "meter_id" | "total">): string {
  const base = (process.env.BILLING_PAYMENT_BASE_URL ?? process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const params = new URLSearchParams({
    meter: bill.meter_id,
    amount: (bill.total / STROOPS_PER_XLM).toFixed(7),
    bill: bill.id,
  });
  return `${base}/pay?${params.toString()}`;
}

export function buildSep7Uri(bill: Pick<Bill, "bill_number" | "total">): string | null {
  const destination = process.env.BILLING_PAYMENT_DESTINATION;
  if (!destination) return null;
  const params = new URLSearchParams({
    destination,
    amount: (bill.total / STROOPS_PER_XLM).toFixed(7),
    memo: bill.bill_number.slice(0, 28),
    msg: `SolarGrid bill ${bill.bill_number}`,
  });
  return `web+stellar:pay?${params.toString()}`;
}

// ── PDF ──────────────────────────────────────────────────────────────────────

const xlm = (stroops: number) => `${(stroops / STROOPS_PER_XLM).toFixed(7)} XLM`;

export function createBillPdf(bill: Bill, account?: BillingAccount): Buffer {
  return createTextPdf(
    [
      { text: "SolarGrid Energy Bill", size: 20, bold: true },
      "",
      `Bill number: ${bill.bill_number}`,
      `Meter ID: ${bill.meter_id}`,
      ...(account?.name ? [`Customer: ${account.name}`] : []),
      `Billing period: ${bill.period_start.slice(0, 10)} to ${bill.period_end.slice(0, 10)} (exclusive)`,
      `Issued: ${bill.issued_at.slice(0, 10)}    Due: ${bill.due_at.slice(0, 10)}`,
      "",
      { text: "Charges", bold: true },
      `Energy consumed: ${bill.units} units`,
      `Energy charge: ${xlm(bill.energy_charge)}`,
      ...(bill.discount_amount > 0 ? [`Community discount (${bill.discount_percent}%): -${xlm(bill.discount_amount)}`] : []),
      `Service charge: ${xlm(bill.service_charge)}`,
      `Tax: ${xlm(bill.tax)}`,
      { text: `Total due: ${xlm(bill.total)}`, bold: true },
      "",
      `Status: ${bill.status.toUpperCase()}`,
      "Pay online:",
      { text: bill.payment_link, size: 9 },
    ],
    { fontSize: 12, lineHeight: 20 },
  );
}

function pdfPath(bill: Pick<Bill, "id">): string {
  return path.join(PDF_DIR, `${bill.id}.pdf`);
}

function writeBillPdf(bill: Bill): void {
  mkdirSync(PDF_DIR, { recursive: true });
  writeFileSync(pdfPath(bill), createBillPdf(bill, getBillingAccount(bill.meter_id)));
}

/** PDF for a bill, regenerated on demand if the file is missing or the status changed. */
export function readBillPdf(id: string): Buffer | undefined {
  const bill = getBill(id);
  if (!bill) return undefined;
  const file = pdfPath(bill);
  if (!existsSync(file)) writeBillPdf(bill);
  return readFileSync(file);
}

// ── Email ────────────────────────────────────────────────────────────────────

export async function emailBill(bill: Bill): Promise<boolean> {
  const account = getBillingAccount(bill.meter_id);
  if (!account?.email) return false;
  const sep7 = buildSep7Uri(bill);
  const text = [
    `Hello${account.name ? ` ${account.name}` : ""},`,
    "",
    `Your SolarGrid bill for ${bill.period} (meter ${bill.meter_id}) is ready.`,
    "",
    `Energy consumed: ${bill.units} units`,
    ...(bill.discount_amount > 0 ? [`Community discount: -${xlm(bill.discount_amount)}`] : []),
    `Total due: ${xlm(bill.total)} by ${bill.due_at.slice(0, 10)}`,
    "",
    `Pay online: ${bill.payment_link}`,
    ...(sep7 ? [`Pay from a Stellar wallet: ${sep7}`] : []),
    "",
    "Your bill is attached as a PDF. Past bills are available in the app under Bills.",
  ].join("\n");
  const html = `<p>Hello${account.name ? ` ${escapeHtml(account.name)}` : ""},</p>
<p>Your SolarGrid bill for <strong>${bill.period}</strong> (meter ${escapeHtml(bill.meter_id)}) is ready.</p>
<ul><li>Energy consumed: ${bill.units} units</li>${bill.discount_amount > 0 ? `<li>Community discount: -${xlm(bill.discount_amount)}</li>` : ""}<li>Total due: <strong>${xlm(bill.total)}</strong> by ${bill.due_at.slice(0, 10)}</li></ul>
<p><a href="${escapeHtml(bill.payment_link)}">Pay your bill</a>${sep7 ? ` or <a href="${escapeHtml(sep7)}">pay from a Stellar wallet</a>` : ""}</p>
<p>Your bill is attached as a PDF.</p>`;

  try {
    const result = await sendNotificationEmail({
      to: account.email,
      event: "billing",
      subject: `Your SolarGrid bill ${bill.bill_number} — ${xlm(bill.total)} due`,
      text,
      html,
      attachments: [{ filename: `${bill.bill_number}.pdf`, content: readBillPdf(bill.id)!, contentType: "application/pdf" }],
    });
    db()
      .prepare("UPDATE bills SET emailed_at = ?, email_error = NULL WHERE id = ?")
      .run(result.delivered ? new Date().toISOString() : null, bill.id);
    return result.delivered;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db().prepare("UPDATE bills SET email_error = ? WHERE id = ?").run(message, bill.id);
    logger.error("Failed to email bill", { billId: bill.id, error: message });
    return false;
  }
}

export async function emailLowBalance(input: { meterId: string; balance: number; threshold: number }): Promise<void> {
  try {
    const account = getBillingAccount(input.meterId);
    if (!account?.email) return;
    await sendNotificationEmail({
      to: account.email,
      event: "low_balance",
      subject: `Low balance alert for meter ${input.meterId}`,
      text: `Meter ${input.meterId} has a balance of ${input.balance}, below the alert threshold of ${input.threshold}.`,
      html: `<h1>Low balance alert</h1><p>Meter ${escapeHtml(input.meterId)} has a balance of ${input.balance}, below the alert threshold of ${input.threshold}.</p>`,
    });
  } catch (error) {
    logger.warn("Low-balance email delivery failed", { meterId: input.meterId, error });
  }
}

export async function emailTrade(input: { meterId: string; payer: string; amountXlm: number; transactionHash: string }): Promise<void> {
  try {
    const account = getBillingAccount(input.meterId);
    if (!account?.email) return;
    await sendNotificationEmail({
      to: account.email,
      event: "trades",
      subject: `SolarGrid payment recorded for meter ${input.meterId}`,
      text: `A payment of ${input.amountXlm} XLM was recorded for meter ${input.meterId}. Payer: ${input.payer}. Transaction: ${input.transactionHash}`,
      html: `<h1>Payment recorded</h1><p>A payment of ${input.amountXlm} XLM was recorded for meter ${escapeHtml(input.meterId)}.</p><p>Transaction: ${escapeHtml(input.transactionHash)}</p>`,
    });
  } catch (error) {
    logger.warn("Trade email delivery failed", { meterId: input.meterId, error });
  }
}

export async function emailPriceAlert(input: { email: string; title: string; message: string }): Promise<boolean> {
  const result = await sendNotificationEmail({
    to: input.email,
    event: "price_alerts",
    subject: input.title,
    text: input.message,
    html: `<h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.message)}</p>`,
  });
  return result.delivered;
}

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ── Generation ───────────────────────────────────────────────────────────────

export function getBill(id: string): Bill | undefined {
  return db().prepare("SELECT * FROM bills WHERE id = ?").get(id) as Bill | undefined;
}

export function getBillForPeriod(meterId: string, period: string): Bill | undefined {
  return db().prepare("SELECT * FROM bills WHERE meter_id = ? AND period = ?").get(meterId, period) as
    | Bill
    | undefined;
}

export function listBills(meterId: string, limit = 24): Bill[] {
  return db()
    .prepare("SELECT * FROM bills WHERE meter_id = ? ORDER BY period DESC LIMIT ?")
    .all(meterId, limit) as Bill[];
}

export function listBillsForPeriod(period: string): Bill[] {
  return db().prepare("SELECT * FROM bills WHERE period = ? ORDER BY meter_id").all(period) as Bill[];
}

/** Create (or return the existing) bill for one meter and period. */
export function generateBill(meterId: string, period: string, now = new Date()): { bill: Bill; created: boolean } {
  const existing = getBillForPeriod(meterId, period);
  if (existing) return { bill: existing, created: false };

  const { start, end } = periodBounds(period);
  const account = getBillingAccount(meterId);
  const discountPercent = account?.stellar_address ? getMemberDiscountPercent(account.stellar_address) : 0;
  const charges = calculateCharges(getUsageTotals(meterId, start, end), billingConfig(), discountPercent);
  const id = crypto.randomUUID();
  const billNumber = `BILL-${period.replace("-", "")}-${meterId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12).toUpperCase()}-${id.slice(0, 4).toUpperCase()}`;
  const dueAt = new Date(now.getTime() + billingConfig().dueDays * 86_400_000);
  const paymentLink = buildPaymentLink({ id, meter_id: meterId, total: charges.total });

  db()
    .prepare(
      `INSERT INTO bills (id, bill_number, meter_id, period, period_start, period_end, units,
         energy_charge, discount_percent, discount_amount, service_charge, tax, total,
         status, issued_at, due_at, payment_link)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?)`,
    )
    .run(
      id,
      billNumber,
      meterId,
      period,
      start.toISOString(),
      end.toISOString(),
      charges.units,
      charges.energyCharge,
      charges.discountPercent,
      charges.discountAmount,
      charges.serviceCharge,
      charges.tax,
      charges.total,
      now.toISOString(),
      dueAt.toISOString(),
      paymentLink,
    );
  const bill = getBill(id)!;
  writeBillPdf(bill);
  return { bill, created: true };
}

export type BillingRunResult = { period: string; generated: number; skipped: number; emailed: number };

/** Generate and email bills for every billable meter in `period`. */
export async function runBillingCycle(period = previousPeriod(), now = new Date()): Promise<BillingRunResult> {
  const { start, end } = periodBounds(period);
  const result: BillingRunResult = { period, generated: 0, skipped: 0, emailed: 0 };
  for (const meterId of metersForPeriod(start, end)) {
    const { bill, created } = generateBill(meterId, period, now);
    if (!created) {
      result.skipped++;
      continue;
    }
    result.generated++;
    if (bill.total > 0 && (await emailBill(bill))) result.emailed++;
  }
  logger.info("Billing cycle complete", result);
  return result;
}

/** Record payment against a bill. Returns undefined if the bill does not exist. */
export function markBillPaid(id: string, txHash: string | null, now = new Date()): Bill | undefined {
  const bill = getBill(id);
  if (!bill) return undefined;
  if (bill.status !== "paid") {
    db()
      .prepare("UPDATE bills SET status = 'paid', paid_at = ?, payment_tx_hash = ? WHERE id = ?")
      .run(now.toISOString(), txHash, id);
    writeBillPdf(getBill(id)!);
  }
  return getBill(id);
}

// ── Scheduler ────────────────────────────────────────────────────────────────

let schedulerTimer: NodeJS.Timeout | undefined;
let running = false;

/**
 * Checks hourly; on the 1st of the month (UTC) runs the cycle for the
 * previous month. The unique (meter_id, period) constraint makes repeated
 * checks on the same day — or a restart mid-run — safe.
 */
export async function billingTick(now = new Date()): Promise<BillingRunResult | null> {
  if (now.getUTCDate() !== 1 || running) return null;
  running = true;
  try {
    return await runBillingCycle(previousPeriod(now), now);
  } catch (err) {
    logger.error("Billing cycle failed", { error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    running = false;
  }
}

export function startBillingScheduler(): void {
  if (schedulerTimer || process.env.BILLING_ENABLED === "false") return;
  void billingTick();
  schedulerTimer = setInterval(() => void billingTick(), SCHEDULER_INTERVAL_MS);
  schedulerTimer.unref?.();
}

export function stopBillingScheduler(): void {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = undefined;
}
