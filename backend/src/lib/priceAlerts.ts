/**
 * Price alerts for the mobile wallet widget (#938). Persisted to a small JSON
 * file so alerts survive restarts; evaluated against the current price when
 * the widget summary is built.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type PriceAlert = { id: string; meterId: string; direction: "above" | "below"; price: number };

const FILE = process.env.PRICE_ALERTS_PATH ?? path.resolve(process.cwd(), "data", "price-alerts.json");

function load(): PriceAlert[] {
  try {
    return existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as PriceAlert[]) : [];
  } catch {
    return [];
  }
}

function save(alerts: PriceAlert[]) {
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(alerts));
}

export const listPriceAlerts = (meterId: string) => load().filter((a) => a.meterId === meterId);

export function addPriceAlert(meterId: string, direction: "above" | "below", price: number): PriceAlert {
  const alert = { id: crypto.randomUUID(), meterId, direction, price };
  save([...load(), alert]);
  return alert;
}

export function deletePriceAlert(meterId: string, id: string): boolean {
  const all = load();
  const next = all.filter((a) => !(a.id === id && a.meterId === meterId));
  if (next.length === all.length) return false;
  save(next);
  return true;
}

export const isTriggered = (a: PriceAlert, price: number) =>
  a.direction === "above" ? price >= a.price : price <= a.price;
