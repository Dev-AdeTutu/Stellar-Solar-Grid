import { registerDatabase } from './database';
import { sendNotificationEmail } from './notifications';

export interface BatteryReadingInput {
  voltageV: number;
  currentA: number;
  stateOfCharge: number;
  temperatureC?: number;
  cycleCount?: number;
  recordedAt?: string;
}

export interface BatteryHealth {
  meterId: string;
  healthPercent: number;
  cycleCount: number;
  voltageV: number;
  stateOfCharge: number;
  updatedAt: string;
}

export interface BatteryStats {
  meterId: string;
  voltageV: number | null;
  currentA: number | null;
  stateOfCharge: number | null;
  temperatureC: number | null;
  cycleCount: number;
  healthPercent: number | null;
  predictedReplacementDate: string | null;
  recordedAt: string | null;
}

const LOW_HEALTH_THRESHOLD = 80;
const NOMINAL_VOLTAGE = 12;
const MAX_EXPECTED_CYCLES = 2000;

let initialized = false;

function initTables(): void {
  if (initialized) return;
  const db = registerDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS battery_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meter_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      voltage_v REAL NOT NULL,
      current_a REAL NOT NULL,
      state_of_charge REAL NOT NULL,
      temperature_c REAL,
      cycle_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_battery_stats_meter
      ON battery_stats (meter_id, recorded_at);

    CREATE TABLE IF NOT EXISTS battery_health (
      meter_id TEXT PRIMARY KEY,
      health_percent REAL NOT NULL,
      cycle_count INTEGER NOT NULL DEFAULT 0,
      voltage_v REAL NOT NULL,
      state_of_charge REAL NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS battery_alerts (
      meter_id TEXT PRIMARY KEY,
      last_health_percent REAL NOT NULL,
      alerted_at TEXT NOT NULL
    );
  `);
  initialized = true;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeBatteryHealth(meterId: string): BatteryHealth | null {
  initTables();
  const db = registerDatabase();

  const latest = db
    .prepare(
      `SELECT voltage_v, state_of_charge, cycle_count, recorded_at
       FROM battery_stats
       WHERE meter_id = ?
       ORDER BY recorded_at DESC, id DESC
       LIMIT 1`
    )
    .get(meterId) as
    | {
        voltage_v: number;
        state_of_charge: number;
        cycle_count: number;
        recorded_at: string;
      }
    | undefined;

  if (!latest) return null;

  const cycleCount = latest.cycle_count ?? 0;
  const cyclePenalty = (cycleCount / MAX_EXPECTED_CYCLES) * 100;

  const voltageDeviation =
    Math.abs(latest.voltage_v - NOMINAL_VOLTAGE) / NOMINAL_VOLTAGE;
  const voltageDeviationPenalty = voltageDeviation * 100;

  const socPenalty = clamp(100 - latest.state_of_charge, 0, 100) * 0.2;

  const healthPercent = clamp(
    100 - cyclePenalty - voltageDeviationPenalty - socPenalty,
    0,
    100
  );

  const updatedAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO battery_health
       (meter_id, health_percent, cycle_count, voltage_v, state_of_charge, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(meter_id) DO UPDATE SET
       health_percent = excluded.health_percent,
       cycle_count = excluded.cycle_count,
       voltage_v = excluded.voltage_v,
       state_of_charge = excluded.state_of_charge,
       updated_at = excluded.updated_at`
  ).run(
    meterId,
    healthPercent,
    cycleCount,
    latest.voltage_v,
    latest.state_of_charge,
    updatedAt
  );

  return {
    meterId,
    healthPercent,
    cycleCount,
    voltageV: latest.voltage_v,
    stateOfCharge: latest.state_of_charge,
    updatedAt,
  };
}

function maybeAlertLowHealth(health: BatteryHealth): void {
  const db = registerDatabase();

  if (health.healthPercent >= LOW_HEALTH_THRESHOLD) {
    // Reset the alert record so a future crossing fires again.
    db.prepare(`DELETE FROM battery_alerts WHERE meter_id = ?`).run(
      health.meterId
    );
    return;
  }

  const existing = db
    .prepare(`SELECT meter_id FROM battery_alerts WHERE meter_id = ?`)
    .get(health.meterId) as { meter_id: string } | undefined;

  if (existing) return;

  try {
    sendNotificationEmail({
      event: 'battery',
      meterId: health.meterId,
      subject: `Battery health degraded for meter ${health.meterId}`,
      message: `Battery health for meter ${health.meterId} has dropped to ${health.healthPercent.toFixed(
        1
      )}%, below the ${LOW_HEALTH_THRESHOLD}% threshold.`,
    });
  } catch {
    // Notification failures must not break telemetry ingestion.
  }

  db.prepare(
    `INSERT INTO battery_alerts (meter_id, last_health_percent, alerted_at)
     VALUES (?, ?, ?)
     ON CONFLICT(meter_id) DO UPDATE SET
       last_health_percent = excluded.last_health_percent,
       alerted_at = excluded.alerted_at`
  ).run(health.meterId, health.healthPercent, new Date().toISOString());
}

export function recordBatteryReading(
  meterId: string,
  input: BatteryReadingInput
): BatteryHealth | null {
  initTables();
  const db = registerDatabase();

  const recordedAt = input.recordedAt ?? new Date().toISOString();

  db.prepare(
    `INSERT INTO battery_stats
       (meter_id, recorded_at, voltage_v, current_a, state_of_charge, temperature_c, cycle_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    meterId,
    recordedAt,
    input.voltageV,
    input.currentA,
    input.stateOfCharge,
    input.temperatureC ?? null,
    input.cycleCount ?? 0
  );

  const health = computeBatteryHealth(meterId);
  if (health) {
    maybeAlertLowHealth(health);
  }
  return health;
}

function predictReplacementDate(
  health: BatteryHealth,
  readings: { recorded_at: string; cycle_count: number }[]
): string | null {
  if (health.healthPercent <= LOW_HEALTH_THRESHOLD) {
    return new Date().toISOString();
  }

  if (readings.length < 2) {
    // Fall back to cycle-based projection.
    const remainingCycles = MAX_EXPECTED_CYCLES - health.cycleCount;
    if (remainingCycles <= 0) return new Date().toISOString();
    const daysRemaining = remainingCycles / 1; // assume ~1 cycle/day
    return new Date(Date.now() + daysRemaining * 86400000).toISOString();
  }

  const oldest = readings[0];
  const newest = readings[readings.length - 1];
  const elapsedMs =
    new Date(newest.recorded_at).getTime() -
    new Date(oldest.recorded_at).getTime();
  const cycleDelta = newest.cycle_count - oldest.cycle_count;

  if (elapsedMs <= 0 || cycleDelta <= 0) {
    const remainingCycles = MAX_EXPECTED_CYCLES - health.cycleCount;
    if (remainingCycles <= 0) return new Date().toISOString();
    return new Date(Date.now() + remainingCycles * 86400000).toISOString();
  }

  const cyclesPerMs = cycleDelta / elapsedMs;
  const remainingCycles = MAX_EXPECTED_CYCLES - health.cycleCount;
  if (remainingCycles <= 0) return new Date().toISOString();

  const remainingMs = remainingCycles / cyclesPerMs;
  return new Date(Date.now() + remainingMs).toISOString();
}

export function getBatteryStats(meterId: string): BatteryStats | null {
  initTables();
  const db = registerDatabase();

  const latest = db
    .prepare(
      `SELECT voltage_v, current_a, state_of_charge, temperature_c, cycle_count, recorded_at
       FROM battery_stats
       WHERE meter_id = ?
       ORDER BY recorded_at DESC, id DESC
       LIMIT 1`
    )
    .get(meterId) as
    | {
        voltage_v: number;
        current_a: number;
        state_of_charge: number;
        temperature_c: number | null;
        cycle_count: number;
        recorded_at: string;
      }
    | undefined;

  if (!latest) return null;

  const health = computeBatteryHealth(meterId);

  const readings = db
    .prepare(
      `SELECT recorded_at, cycle_count
       FROM battery_stats
       WHERE meter_id = ?
       ORDER BY recorded_at ASC, id ASC`
    )
    .all(meterId) as { recorded_at: string; cycle_count: number }[];

  const predictedReplacementDate = health
    ? predictReplacementDate(health, readings)
    : null;

  return {
    meterId,
    voltageV: latest.voltage_v,
    currentA: latest.current_a,
    stateOfCharge: latest.state_of_charge,
    temperatureC: latest.temperature_c,
    cycleCount: latest.cycle_count,
    healthPercent: health ? health.healthPercent : null,
    predictedReplacementDate,
    recordedAt: latest.recorded_at,
  };
}

export function handleBatteryTelemetry(
  meterId: string,
  payload: string | Record<string, unknown>
): BatteryHealth | null {
  let parsed: Record<string, unknown>;

  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else {
    parsed = payload;
  }

  const voltage = parsed.voltage ?? parsed.voltageV;
  const current = parsed.current ?? parsed.currentA;
  const stateOfCharge = parsed.stateOfCharge ?? parsed.soc;

  if (
    typeof voltage !== 'number' ||
    typeof current !== 'number' ||
    typeof stateOfCharge !== 'number'
  ) {
    return null;
  }

  const temperature =
    typeof parsed.temperature === 'number'
      ? parsed.temperature
      : typeof parsed.temperatureC === 'number'
        ? parsed.temperatureC
        : undefined;

  const cycleCount =
    typeof parsed.cycleCount === 'number' ? parsed.cycleCount : undefined;

  return recordBatteryReading(meterId, {
    voltageV: voltage,
    currentA: current,
    stateOfCharge,
    temperatureC: temperature,
    cycleCount,
  });
}