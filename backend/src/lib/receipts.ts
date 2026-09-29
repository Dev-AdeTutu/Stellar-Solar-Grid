import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createTextPdf } from "./pdf.js";

export interface ReceiptRecord {
  paymentId: string;
  amount: number;
  meterId: string;
  date: string;
  transactionHash: string;
  invoiceNumber: string;
  filePath: string;
}

const storageRoot = process.env.RECEIPTS_STORAGE_PATH ?? join(process.cwd(), "data", "receipts");
const indexPath = join(storageRoot, "index.json");
const records = new Map<string, ReceiptRecord>();
let loaded = false;

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  if (!existsSync(indexPath)) return;
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as ReceiptRecord[];
    for (const record of parsed) records.set(record.paymentId, record);
  } catch {
    // A corrupt index should not prevent payments from being processed.
  }
}

function persist() {
  mkdirSync(storageRoot, { recursive: true });
  writeFileSync(indexPath, JSON.stringify([...records.values()], null, 2));
}

/** Create a small, dependency-free PDF receipt with a standards-compliant xref table. */
export function createReceiptPdf(record: Omit<ReceiptRecord, "filePath">): Buffer {
  return createTextPdf([
    "SolarGrid Payment Receipt",
    `Invoice number: ${record.invoiceNumber}`,
    `Payment amount: ${record.amount} stroops`,
    `Meter ID: ${record.meterId}`,
    `Date: ${record.date}`,
    `Transaction hash: ${record.transactionHash}`,
  ]);
}

export function saveReceipt(input: Omit<ReceiptRecord, "invoiceNumber" | "filePath">): ReceiptRecord {
  ensureLoaded();
  const existing = records.get(input.paymentId);
  if (existing) return existing;
  const invoiceNumber = `INV-${Date.parse(input.date) || Date.now()}-${input.transactionHash.slice(0, 8).toUpperCase()}`;
  const record = { ...input, invoiceNumber, filePath: join(storageRoot, `${input.paymentId}.pdf`) };
  mkdirSync(dirname(record.filePath), { recursive: true });
  writeFileSync(record.filePath, createReceiptPdf(record));
  records.set(input.paymentId, record);
  persist();
  return record;
}

export function getReceipt(paymentId: string): ReceiptRecord | undefined {
  ensureLoaded();
  return records.get(paymentId);
}

export function readReceiptPdf(paymentId: string): Buffer | undefined {
  const receipt = getReceipt(paymentId);
  if (!receipt || !existsSync(receipt.filePath)) return undefined;
  return readFileSync(receipt.filePath);
}

export function resetReceiptsForTests() {
  records.clear();
  loaded = true;
}
