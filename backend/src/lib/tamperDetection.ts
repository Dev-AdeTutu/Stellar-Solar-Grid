import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { adminInvoke } from "./stellar.js";
import { fireWebhook, getWebhookUrls } from "./webhookRegistry.js";
import { logger } from "./logger.js";
import { getMqttClient } from "../iot/mqttClient.js";
import * as StellarSdk from "@stellar/stellar-sdk";

export type TamperEvent = {
  id: number;
  meter_id: string;
  detected_at: string;
  reason: string | null;
  sensor_state: string;
  source_topic: string;
  disabled: boolean;
};

const DEFAULT_DB_PATH = path.resolve(process.cwd(), "data", "tamper-events.sqlite");
let database: Database.Database | undefined;

function db(): Database.Database {
  if (!database) {
    // Resolve this lazily so test fixtures and runtime bootstrap can configure
    // TAMPER_DB_PATH before the first event opens the persistent store.
    const dbPath = process.env.TAMPER_DB_PATH ?? DEFAULT_DB_PATH;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    database = new Database(dbPath);
    database.pragma("journal_mode = WAL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS meter_tamper_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        meter_id TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        reason TEXT,
        sensor_state TEXT NOT NULL,
        source_topic TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tamper_events_meter_time ON meter_tamper_events (meter_id, detected_at DESC);
    `);
  }
  return database;
}

export function closeTamperStore(): void {
  if (database?.open) database.close();
  database = undefined;
}

function parseTimestamp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

function isTamperSignal(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true" || value === "detected" || value === "tamper";
}

export async function processTamperEvent(
  meterId: string,
  payload: Buffer | string | Record<string, unknown>,
  sourceTopic = `solargrid/meters/${meterId}/tamper`,
): Promise<TamperEvent | null> {
  let raw: unknown = payload;
  if (Buffer.isBuffer(payload) || typeof payload === "string") {
    try { raw = JSON.parse(payload.toString()); } catch { throw new Error("Tamper payload must be valid JSON"); }
  }
  if (!raw || typeof raw !== "object") throw new Error("Tamper payload must be an object");
  const data = raw as Record<string, unknown>;
  const signal = data.tamper ?? data.tampered ?? data.detected ?? data.status;
  if (!isTamperSignal(signal)) {
    logger.info("Meter tamper sensor reported clear", { event: "meter_tamper_clear", meterId });
    return null;
  }
  if (!meterId || meterId.length > 200) throw new Error("Invalid meter id");
  const detectedAt = parseTimestamp(data.timestamp ?? data.detected_at ?? data.detectedAt);
  const reason = typeof data.reason === "string" ? data.reason.slice(0, 500) : null;
  const sensorState = typeof data.sensor_state === "string" ? data.sensor_state.slice(0, 100) : String(signal);
  const eventKey = crypto.createHash("sha256").update(`${meterId}|${detectedAt}|${reason ?? ""}|${sensorState}`).digest("hex");
  const inserted = db().prepare(`INSERT OR IGNORE INTO meter_tamper_events
    (event_key, meter_id, detected_at, reason, sensor_state, source_topic, disabled)
    VALUES (?, ?, ?, ?, ?, ?, 0)`).run(eventKey, meterId, detectedAt, reason, sensorState, sourceTopic);
  if (!inserted.changes) return db().prepare("SELECT * FROM meter_tamper_events WHERE event_key = ?").get(eventKey) as TamperEvent;

  let disabled = false;
  try {
    await adminInvoke("set_active", [
      StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
      StellarSdk.nativeToScVal(false, { type: "bool" }),
    ]);
    disabled = true;
  } catch (error) {
    logger.error("Failed to disable tampered meter on-chain", { event: "meter_tamper_disable_failed", meterId, error });
  }
  try {
    getMqttClient().publish(`solargrid/meters/${meterId}/control`, JSON.stringify({ cmd: "OFF", reason: "tamper", timestamp: detectedAt }), { qos: 1 });
  } catch (error) {
    logger.error("Failed to publish tamper shutdown command", { meterId, error });
  }
  db().prepare("UPDATE meter_tamper_events SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, inserted.lastInsertRowid);
  const event = db().prepare("SELECT * FROM meter_tamper_events WHERE id = ?").get(inserted.lastInsertRowid) as TamperEvent;
  const body = JSON.stringify({ event: "meter_tamper_detected", meter_id: meterId, detected_at: detectedAt, reason, sensor_state: sensorState, disabled });
  await Promise.all([...getWebhookUrls().values()].map((url) => fireWebhook(url, body).catch((error) => logger.warn("Tamper webhook delivery failed", { meterId, url, error }))));
  const providerUrl = process.env.PROVIDER_WEBHOOK_URL;
  if (providerUrl) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const secret = process.env.PROVIDER_WEBHOOK_SECRET;
    if (secret) headers["X-SolarGrid-Signature"] = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
    try { await fetch(providerUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) }); }
    catch (error) { logger.warn("Provider tamper webhook delivery failed", { meterId, error }); }
  }
  logger.warn("Meter tamper detected and meter disabled", { event: "meter_tamper_detected", meterId, detectedAt, disabled });
  return event;
}

export function getTamperHistory(meterId: string, limit = 100): TamperEvent[] {
  const safeLimit = Math.min(500, Math.max(1, Math.trunc(limit)));
  return db().prepare("SELECT * FROM meter_tamper_events WHERE meter_id = ? ORDER BY detected_at DESC LIMIT ?").all(meterId, safeLimit) as TamperEvent[];
}
