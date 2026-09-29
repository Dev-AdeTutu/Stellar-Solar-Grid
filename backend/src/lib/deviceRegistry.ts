/**
 * Energy device registry (#897).
 *
 * Tracks every solar panel, inverter and meter in the grid together with its
 * specifications, certifications, maintenance schedule and performance
 * readings. Backed by SQLite (same pattern as apiKeys.ts).
 *
 * The IoT bridge feeds performance readings in via
 * `solargrid/devices/{deviceId}/telemetry`; meters can additionally be linked
 * to an on-chain meter id so meter heartbeats show up against the device.
 */
import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { registerDatabase } from "./databaseLifecycle.js";
import { logger } from "./logger.js";
import { fireWebhook, getWebhookUrls } from "./webhookRegistry.js";

const DB_PATH =
  process.env.DEVICE_REGISTRY_DB_PATH ??
  path.resolve(process.cwd(), "data", "device-registry.sqlite");

export const DEVICE_TYPES = ["solar_panel", "inverter", "meter", "battery"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

export const DEVICE_STATUSES = ["active", "inactive", "maintenance", "decommissioned"] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/** Free-form spec sheet; common keys per type are documented in backend/API.md. */
export type DeviceSpecs = Record<string, string | number | boolean | null>;

export type Device = {
  id: string;
  type: DeviceType;
  owner: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  meterId: string | null;
  location: string | null;
  installedAt: string | null;
  status: DeviceStatus;
  specs: DeviceSpecs;
  createdAt: string;
  updatedAt: string;
};

export type Certification = {
  id: string;
  deviceId: string;
  standard: string;
  issuer: string;
  certificateNumber: string | null;
  issuedAt: string;
  expiresAt: string | null;
  documentUrl: string | null;
  valid: boolean;
};

export type MaintenanceSchedule = {
  id: string;
  deviceId: string;
  task: string;
  intervalDays: number;
  lastPerformedAt: string | null;
  nextDueAt: string;
  lastReminderAt: string | null;
  notes: string | null;
};

export type PerformanceReading = {
  deviceId: string;
  recordedAt: string;
  powerW: number | null;
  energyKwh: number | null;
  voltageV: number | null;
  temperatureC: number | null;
  efficiency: number | null;
  stateOfCharge: number | null;
  chargedEnergyKwh: number | null;
  dischargedEnergyKwh: number | null;
};

export type PerformanceSummary = {
  deviceId: string;
  readings: number;
  from: string | null;
  to: string | null;
  totalEnergyKwh: number;
  avgPowerW: number | null;
  peakPowerW: number | null;
  avgEfficiency: number | null;
  avgTemperatureC: number | null;
  /** Actual energy vs. rated capacity over the window (0–1), when rated power is known. */
  capacityFactor: number | null;
  latestStateOfCharge: number | null;
  storageCapacityKwh: number | null;
  availableStorageKwh: number | null;
  totalChargedEnergyKwh: number;
  totalDischargedEnergyKwh: number;
  roundTripEfficiency: number | null;
};

let _db: Database.Database | undefined;

function db(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("foreign_keys = ON");
    _db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        owner TEXT NOT NULL,
        manufacturer TEXT NOT NULL,
        model TEXT NOT NULL,
        serial_number TEXT NOT NULL,
        meter_id TEXT,
        location TEXT,
        installed_at TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        specs TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (manufacturer, serial_number)
      );
      CREATE INDEX IF NOT EXISTS idx_devices_owner ON devices (owner);
      CREATE INDEX IF NOT EXISTS idx_devices_meter ON devices (meter_id);

      CREATE TABLE IF NOT EXISTS device_certifications (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
        standard TEXT NOT NULL,
        issuer TEXT NOT NULL,
        certificate_number TEXT,
        issued_at TEXT NOT NULL,
        expires_at TEXT,
        document_url TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_device_certs_device ON device_certifications (device_id);

      CREATE TABLE IF NOT EXISTS device_maintenance (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
        task TEXT NOT NULL,
        interval_days INTEGER NOT NULL,
        last_performed_at TEXT,
        next_due_at TEXT NOT NULL,
        last_reminder_at TEXT,
        notes TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_device_maint_due ON device_maintenance (next_due_at);

      CREATE TABLE IF NOT EXISTS device_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
        recorded_at TEXT NOT NULL,
        power_w REAL,
        energy_kwh REAL,
        voltage_v REAL,
        temperature_c REAL,
        efficiency REAL,
        state_of_charge REAL,
        charged_energy_kwh REAL,
        discharged_energy_kwh REAL
      );
      CREATE INDEX IF NOT EXISTS idx_device_perf ON device_performance (device_id, recorded_at);
    `);
    const performanceColumns = new Set(
      (_db.pragma("table_info(device_performance)") as Array<{ name: string }>).map((column) => column.name),
    );
    for (const [name, type] of [
      ["state_of_charge", "REAL"],
      ["charged_energy_kwh", "REAL"],
      ["discharged_energy_kwh", "REAL"],
    ] as const) {
      if (!performanceColumns.has(name)) {
        _db.exec(`ALTER TABLE device_performance ADD COLUMN ${name} ${type}`);
      }
    }
  }
  return _db;
}

registerDatabase("device-registry", () => {
  _db?.close();
  _db = undefined;
});

// ── Row mapping ─────────────────────────────────────────────────────────────

type DeviceRow = {
  id: string;
  type: DeviceType;
  owner: string;
  manufacturer: string;
  model: string;
  serial_number: string;
  meter_id: string | null;
  location: string | null;
  installed_at: string | null;
  status: DeviceStatus;
  specs: string;
  created_at: string;
  updated_at: string;
};

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    type: row.type,
    owner: row.owner,
    manufacturer: row.manufacturer,
    model: row.model,
    serialNumber: row.serial_number,
    meterId: row.meter_id,
    location: row.location,
    installedAt: row.installed_at,
    status: row.status,
    specs: JSON.parse(row.specs),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type CertRow = {
  id: string;
  device_id: string;
  standard: string;
  issuer: string;
  certificate_number: string | null;
  issued_at: string;
  expires_at: string | null;
  document_url: string | null;
};

function toCert(row: CertRow, now = new Date()): Certification {
  return {
    id: row.id,
    deviceId: row.device_id,
    standard: row.standard,
    issuer: row.issuer,
    certificateNumber: row.certificate_number,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    documentUrl: row.document_url,
    valid: !row.expires_at || new Date(row.expires_at) > now,
  };
}

type MaintRow = {
  id: string;
  device_id: string;
  task: string;
  interval_days: number;
  last_performed_at: string | null;
  next_due_at: string;
  last_reminder_at: string | null;
  notes: string | null;
};

function toSchedule(row: MaintRow): MaintenanceSchedule {
  return {
    id: row.id,
    deviceId: row.device_id,
    task: row.task,
    intervalDays: row.interval_days,
    lastPerformedAt: row.last_performed_at,
    nextDueAt: row.next_due_at,
    lastReminderAt: row.last_reminder_at,
    notes: row.notes,
  };
}

// ── Devices ─────────────────────────────────────────────────────────────────

export type RegisterDeviceInput = {
  type: DeviceType;
  owner: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  meterId?: string | null;
  location?: string | null;
  installedAt?: string | null;
  specs?: DeviceSpecs;
};

export class DeviceConflictError extends Error {}

export function registerDevice(input: RegisterDeviceInput): Device {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    db()
      .prepare(
        `INSERT INTO devices (id, type, owner, manufacturer, model, serial_number, meter_id,
                              location, installed_at, status, specs, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        id,
        input.type,
        input.owner,
        input.manufacturer,
        input.model,
        input.serialNumber,
        input.meterId ?? null,
        input.location ?? null,
        input.installedAt ?? null,
        JSON.stringify(input.specs ?? {}),
        now,
        now,
      );
  } catch (err) {
    if (err instanceof Error && /UNIQUE/.test(err.message)) {
      throw new DeviceConflictError(
        `Device ${input.manufacturer}/${input.serialNumber} is already registered`,
      );
    }
    throw err;
  }
  return getDevice(id)!;
}

export function getDevice(id: string): Device | undefined {
  const row = db().prepare("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow | undefined;
  return row ? toDevice(row) : undefined;
}

export type DeviceFilter = {
  owner?: string;
  type?: DeviceType;
  status?: DeviceStatus;
  meterId?: string;
  limit?: number;
  offset?: number;
};

export function listDevices(filter: DeviceFilter = {}): Device[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.owner) (where.push("owner = ?"), args.push(filter.owner));
  if (filter.type) (where.push("type = ?"), args.push(filter.type));
  if (filter.status) (where.push("status = ?"), args.push(filter.status));
  if (filter.meterId) (where.push("meter_id = ?"), args.push(filter.meterId));
  const limit = Math.min(500, Math.max(1, filter.limit ?? 100));
  const offset = Math.max(0, filter.offset ?? 0);
  const sql = `SELECT * FROM devices ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  const rows = db().prepare(sql).all(...args, limit, offset) as DeviceRow[];
  return rows.map(toDevice);
}

export type UpdateDeviceInput = Partial<
  Pick<RegisterDeviceInput, "meterId" | "location" | "installedAt" | "specs">
> & { status?: DeviceStatus };

export function updateDevice(id: string, patch: UpdateDeviceInput): Device | undefined {
  const existing = getDevice(id);
  if (!existing) return undefined;
  const next = {
    meterId: patch.meterId !== undefined ? patch.meterId : existing.meterId,
    location: patch.location !== undefined ? patch.location : existing.location,
    installedAt: patch.installedAt !== undefined ? patch.installedAt : existing.installedAt,
    status: patch.status ?? existing.status,
    // Specs are merged so callers can patch a single field.
    specs: patch.specs ? { ...existing.specs, ...patch.specs } : existing.specs,
  };
  db()
    .prepare(
      `UPDATE devices SET meter_id = ?, location = ?, installed_at = ?, status = ?, specs = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      next.meterId,
      next.location,
      next.installedAt,
      next.status,
      JSON.stringify(next.specs),
      new Date().toISOString(),
      id,
    );
  return getDevice(id);
}

export function deleteDevice(id: string): boolean {
  return db().prepare("DELETE FROM devices WHERE id = ?").run(id).changes > 0;
}

// ── Certifications ──────────────────────────────────────────────────────────

export type AddCertificationInput = {
  standard: string;
  issuer: string;
  certificateNumber?: string | null;
  issuedAt: string;
  expiresAt?: string | null;
  documentUrl?: string | null;
};

export function addCertification(deviceId: string, input: AddCertificationInput): Certification {
  const id = crypto.randomUUID();
  db()
    .prepare(
      `INSERT INTO device_certifications (id, device_id, standard, issuer, certificate_number,
                                          issued_at, expires_at, document_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      deviceId,
      input.standard,
      input.issuer,
      input.certificateNumber ?? null,
      input.issuedAt,
      input.expiresAt ?? null,
      input.documentUrl ?? null,
    );
  const row = db().prepare("SELECT * FROM device_certifications WHERE id = ?").get(id) as CertRow;
  return toCert(row);
}

export function listCertifications(deviceId: string): Certification[] {
  const rows = db()
    .prepare("SELECT * FROM device_certifications WHERE device_id = ? ORDER BY issued_at DESC")
    .all(deviceId) as CertRow[];
  return rows.map((r) => toCert(r));
}

/** Certifications expiring within `withinDays` (already-expired ones included). */
export function listExpiringCertifications(withinDays = 30, now = new Date()): Certification[] {
  const deadline = new Date(now.getTime() + withinDays * 86_400_000).toISOString();
  const rows = db()
    .prepare(
      `SELECT * FROM device_certifications
        WHERE expires_at IS NOT NULL AND expires_at <= ?
        ORDER BY expires_at ASC`,
    )
    .all(deadline) as CertRow[];
  return rows.map((r) => toCert(r, now));
}

export function deleteCertification(deviceId: string, certId: string): boolean {
  return (
    db()
      .prepare("DELETE FROM device_certifications WHERE id = ? AND device_id = ?")
      .run(certId, deviceId).changes > 0
  );
}

// ── Maintenance ─────────────────────────────────────────────────────────────

const addDays = (iso: string, days: number) =>
  new Date(new Date(iso).getTime() + days * 86_400_000).toISOString();

export type ScheduleMaintenanceInput = {
  task: string;
  intervalDays: number;
  /** First due date; defaults to now + intervalDays. */
  nextDueAt?: string;
  notes?: string | null;
};

export function scheduleMaintenance(
  deviceId: string,
  input: ScheduleMaintenanceInput,
  now = new Date(),
): MaintenanceSchedule {
  const id = crypto.randomUUID();
  const nextDueAt = input.nextDueAt ?? addDays(now.toISOString(), input.intervalDays);
  db()
    .prepare(
      `INSERT INTO device_maintenance (id, device_id, task, interval_days, next_due_at, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, deviceId, input.task, input.intervalDays, nextDueAt, input.notes ?? null);
  return getSchedule(id)!;
}

function getSchedule(id: string): MaintenanceSchedule | undefined {
  const row = db().prepare("SELECT * FROM device_maintenance WHERE id = ?").get(id) as
    | MaintRow
    | undefined;
  return row ? toSchedule(row) : undefined;
}

export function listMaintenance(deviceId: string): MaintenanceSchedule[] {
  const rows = db()
    .prepare("SELECT * FROM device_maintenance WHERE device_id = ? ORDER BY next_due_at ASC")
    .all(deviceId) as MaintRow[];
  return rows.map(toSchedule);
}

/** Maintenance tasks due within `withinDays` (overdue included), across all devices. */
export function listDueMaintenance(withinDays = 7, now = new Date()): MaintenanceSchedule[] {
  const rows = db()
    .prepare("SELECT * FROM device_maintenance WHERE next_due_at <= ? ORDER BY next_due_at ASC")
    .all(addDays(now.toISOString(), withinDays)) as MaintRow[];
  return rows.map(toSchedule);
}

/** Mark a task done and roll `next_due_at` forward by its interval. */
export function completeMaintenance(
  deviceId: string,
  scheduleId: string,
  performedAt = new Date().toISOString(),
): MaintenanceSchedule | undefined {
  const current = getSchedule(scheduleId);
  if (!current || current.deviceId !== deviceId) return undefined;
  db()
    .prepare(
      `UPDATE device_maintenance
          SET last_performed_at = ?, next_due_at = ?, last_reminder_at = NULL
        WHERE id = ?`,
    )
    .run(performedAt, addDays(performedAt, current.intervalDays), scheduleId);
  return getSchedule(scheduleId);
}

export function deleteMaintenance(deviceId: string, scheduleId: string): boolean {
  return (
    db()
      .prepare("DELETE FROM device_maintenance WHERE id = ? AND device_id = ?")
      .run(scheduleId, deviceId).changes > 0
  );
}

// ── Performance tracking ────────────────────────────────────────────────────

export type PerformanceInput = Partial<Omit<PerformanceReading, "deviceId">>;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const nonNegativeNum = (v: unknown) => {
  const value = num(v);
  return value !== null && value >= 0 ? value : null;
};

export function recordPerformance(deviceId: string, input: PerformanceInput): void {
  db()
    .prepare(
      `INSERT INTO device_performance (device_id, recorded_at, power_w, energy_kwh, voltage_v,
                                       temperature_c, efficiency, state_of_charge,
                                       charged_energy_kwh, discharged_energy_kwh)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      deviceId,
      input.recordedAt ?? new Date().toISOString(),
      num(input.powerW),
      num(input.energyKwh),
      num(input.voltageV),
      num(input.temperatureC),
      num(input.efficiency),
      num(input.stateOfCharge),
      num(input.chargedEnergyKwh),
      num(input.dischargedEnergyKwh),
    );
}

export function listPerformance(deviceId: string, sinceDays = 7, now = new Date()): PerformanceReading[] {
  const rows = db()
    .prepare(
            `SELECT device_id, recorded_at, power_w, energy_kwh, voltage_v, temperature_c, efficiency,
              state_of_charge, charged_energy_kwh, discharged_energy_kwh
         FROM device_performance
        WHERE device_id = ? AND recorded_at >= ?
        ORDER BY recorded_at ASC LIMIT 5000`,
    )
    .all(deviceId, addDays(now.toISOString(), -sinceDays)) as Array<Record<string, any>>;
  return rows.map((r) => ({
    deviceId: r.device_id,
    recordedAt: r.recorded_at,
    powerW: r.power_w,
    energyKwh: r.energy_kwh,
    voltageV: r.voltage_v,
    temperatureC: r.temperature_c,
    efficiency: r.efficiency,
    stateOfCharge: r.state_of_charge,
    chargedEnergyKwh: r.charged_energy_kwh,
    dischargedEnergyKwh: r.discharged_energy_kwh,
  }));
}

export function getPerformanceSummary(
  deviceId: string,
  sinceDays = 7,
  now = new Date(),
): PerformanceSummary {
  const row = db()
    .prepare(
      SELECT COUNT(*) AS n, MIN(recorded_at) AS first, MAX(recorded_at) AS last,
              COALESCE(SUM(energy_kwh), 0) AS energy, AVG(power_w) AS avg_power,
              MAX(power_w) AS peak_power, AVG(efficiency) AS avg_eff, AVG(temperature_c) AS avg_temp,
              (SELECT state_of_charge FROM device_performance
                WHERE device_id = ? AND recorded_at >= ?
                ORDER BY recorded_at DESC, id DESC LIMIT 1) AS latest_soc,
              COALESCE(SUM(charged_energy_kwh), 0) AS charged_energy,
              COALESCE(SUM(discharged_energy_kwh), 0) AS discharged_energy
         FROM device_performance
        WHERE device_id = ? AND recorded_at >= ?`,
    )
    .get(
      deviceId,
      addDays(now.toISOString(), -sinceDays),
      deviceId,
      addDays(now.toISOString(), -sinceDays),
    ) as Record<string, any>;

  const device = getDevice(deviceId);
  const ratedW = Number(device?.specs.ratedPowerW);
  const storageCapacityKwh = Number(device?.specs.capacityKwh);
  const capacityFactor =
    Number.isFinite(ratedW) && ratedW > 0
      ? Math.min(1, row.energy / ((ratedW / 1000) * sinceDays * 24))
      : null;

  return {
    deviceId,
    readings: row.n,
    from: row.first,
    to: row.last,
    totalEnergyKwh: row.energy,
    avgPowerW: row.avg_power,
    peakPowerW: row.peak_power,
    avgEfficiency: row.avg_eff,
    avgTemperatureC: row.avg_temp,
    capacityFactor,
    latestStateOfCharge: row.latest_soc,
    storageCapacityKwh: Number.isFinite(storageCapacityKwh) && storageCapacityKwh > 0 ? storageCapacityKwh : null,
    availableStorageKwh:
      Number.isFinite(storageCapacityKwh) && storageCapacityKwh > 0 && row.latest_soc !== null
        ? storageCapacityKwh * row.latest_soc
        : null,
    totalChargedEnergyKwh: row.charged_energy,
    totalDischargedEnergyKwh: row.discharged_energy,
    roundTripEfficiency: row.charged_energy > 0 ? row.discharged_energy / row.charged_energy : null,
  };
}

/** Drop readings older than `retentionDays` so the table doesn't grow forever. */
export function prunePerformance(retentionDays = 90, now = new Date()): number {
  return db()
    .prepare("DELETE FROM device_performance WHERE recorded_at < ?")
    .run(addDays(now.toISOString(), -retentionDays)).changes;
}

/**
 * Handle an MQTT telemetry message on `solargrid/devices/{deviceId}/telemetry`.
 * Payload supports generation telemetry and storage fields (`stateOfCharge` in
 * 0–1, interval `chargedEnergyKwh`/`dischargedEnergyKwh`).
 * Unknown devices are ignored so stray publishers can't fill the table.
 */
export function handleDeviceTelemetry(deviceId: string | undefined, payload: Buffer): void {
  if (!deviceId || !getDevice(deviceId)) {
    logger.warn({ deviceId }, "Telemetry for unregistered device ignored");
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(payload.toString());
  } catch {
    logger.warn({ deviceId }, "Malformed device telemetry payload");
    return;
  }
  recordPerformance(deviceId, {
    recordedAt: typeof body.timestamp === "string" ? body.timestamp : undefined,
    powerW: num(body.powerW) ?? undefined,
    energyKwh: num(body.energyKwh) ?? undefined,
    voltageV: num(body.voltageV) ?? undefined,
    temperatureC: num(body.temperatureC) ?? undefined,
    efficiency: num(body.efficiency) ?? undefined,
    stateOfCharge:
      typeof body.stateOfCharge === "number" && body.stateOfCharge >= 0 && body.stateOfCharge <= 1
        ? body.stateOfCharge
        : undefined,
    chargedEnergyKwh: nonNegativeNum(body.chargedEnergyKwh) ?? undefined,
    dischargedEnergyKwh: nonNegativeNum(body.dischargedEnergyKwh) ?? undefined,
  });
}

// ── Reminders ───────────────────────────────────────────────────────────────

const REMINDER_LEAD_DAYS = Number(process.env.MAINTENANCE_REMINDER_LEAD_DAYS ?? 3);
/** Minimum gap between repeated reminders for the same (still-due) task. */
const REMINDER_REPEAT_MS = 24 * 60 * 60 * 1000;

/**
 * Send reminders for maintenance due within REMINDER_LEAD_DAYS and for
 * certifications expiring within 30 days. Reminders go to every webhook
 * registered for the device owner (provider id) and are logged. Each task is
 * reminded at most once per day. Returns the schedule ids reminded.
 */
export async function sendMaintenanceReminders(now = new Date()): Promise<string[]> {
  const due = listDueMaintenance(REMINDER_LEAD_DAYS, now).filter(
    (s) => !s.lastReminderAt || now.getTime() - new Date(s.lastReminderAt).getTime() >= REMINDER_REPEAT_MS,
  );
  const reminded: string[] = [];
  const markStmt = db().prepare("UPDATE device_maintenance SET last_reminder_at = ? WHERE id = ?");

  for (const schedule of due) {
    const device = getDevice(schedule.deviceId);
    if (!device || device.status === "decommissioned") continue;
    const overdue = new Date(schedule.nextDueAt) < now;
    const payload = JSON.stringify({
      event: "device.maintenance_due",
      overdue,
      device: { id: device.id, type: device.type, model: device.model, serialNumber: device.serialNumber },
      maintenance: schedule,
      sentAt: now.toISOString(),
    });
    logger.info(
      { deviceId: device.id, task: schedule.task, nextDueAt: schedule.nextDueAt, overdue },
      "Maintenance reminder",
    );
    for (const url of getWebhookUrls(device.owner)) {
      fireWebhook(url, payload).catch((err) =>
        logger.warn({ err, url, deviceId: device.id }, "Maintenance reminder webhook failed"),
      );
    }
    markStmt.run(now.toISOString(), schedule.id);
    reminded.push(schedule.id);
  }

  for (const cert of listExpiringCertifications(30, now)) {
    logger.warn(
      { deviceId: cert.deviceId, standard: cert.standard, expiresAt: cert.expiresAt },
      cert.valid ? "Device certification expiring soon" : "Device certification expired",
    );
  }
  return reminded;
}

let reminderTimer: NodeJS.Timeout | undefined;

/** Start the hourly reminder + telemetry-retention worker. Idempotent. */
export function startMaintenanceReminderWorker(intervalMs = 60 * 60 * 1000): void {
  if (reminderTimer) return;
  const tick = () => {
    sendMaintenanceReminders().catch((err) => logger.error({ err }, "Maintenance reminder run failed"));
    try {
      prunePerformance(Number(process.env.DEVICE_PERFORMANCE_RETENTION_DAYS ?? 90));
    } catch (err) {
      logger.error({ err }, "Device performance pruning failed");
    }
  };
  reminderTimer = setInterval(tick, intervalMs);
  reminderTimer.unref?.();
}

export function stopMaintenanceReminderWorker(): void {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = undefined;
}
