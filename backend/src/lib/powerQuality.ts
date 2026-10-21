import { db, SqlitePool } from './usageEvents';
import { sendPushToOwner } from './pushNotifications';
import { sendNotificationEmail } from './emailNotifications';

export interface PowerQualitySample {
  meterId: string;
  voltage: number;
  frequency: number;
  thd: number;
  timestamp: string;
}

export type PowerQualityIssueType = 'sag' | 'swell' | 'harmonic';

export interface PowerQualityIssue {
  type: PowerQualityIssueType;
  severity: 'low' | 'medium' | 'high';
  value: number;
  threshold: number;
  detectedAt: string;
}

export interface PowerQualitySummary {
  meterId: string;
  current: PowerQualitySample | null;
  issues: PowerQualityIssue[];
  trend: PowerQualitySample[];
}

export interface RecordPowerQualityInput {
  meterId: string;
  voltage: number;
  frequency: number;
  thd: number;
  timestamp?: string;
}

const VOLTAGE_MIN = parseFloat(process.env.POWER_QUALITY_VOLTAGE_MIN ?? '207');
const VOLTAGE_MAX = parseFloat(process.env.POWER_QUALITY_VOLTAGE_MAX ?? '253');
const THD_MAX = parseFloat(process.env.POWER_QUALITY_THD_MAX ?? '8');
const FREQUENCY_MIN = parseFloat(process.env.POWER_QUALITY_FREQUENCY_MIN ?? '49.5');
const FREQUENCY_MAX = parseFloat(process.env.POWER_QUALITY_FREQUENCY_MAX ?? '50.5');

const ALERT_DEBOUNCE_MS = 5 * 60 * 1000;

let schemaInitialized = false;
const lastAlertAt = new Map<string, number>();

function ensureSchema(): void {
  if (schemaInitialized) {
    return;
  }
  const pool: SqlitePool = db();
  pool.run(`
    CREATE TABLE IF NOT EXISTS power_quality_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meter_id TEXT NOT NULL,
      voltage REAL NOT NULL,
      frequency REAL NOT NULL,
      thd REAL NOT NULL,
      received_at TEXT NOT NULL
    )
  `);
  pool.run(
    `CREATE INDEX IF NOT EXISTS idx_power_quality_meter_time ON power_quality_samples (meter_id, received_at)`
  );
  schemaInitialized = true;
}

export function recordPowerQualitySample(input: RecordPowerQualityInput): PowerQualitySample {
  ensureSchema();
  const timestamp = input.timestamp ?? new Date().toISOString();
  const pool: SqlitePool = db();
  pool.run(
    `INSERT INTO power_quality_samples (meter_id, voltage, frequency, thd, received_at) VALUES (?, ?, ?, ?, ?)`,
    [input.meterId, input.voltage, input.frequency, input.thd, timestamp]
  );
  return {
    meterId: input.meterId,
    voltage: input.voltage,
    frequency: input.frequency,
    thd: input.thd,
    timestamp,
  };
}

export function getPowerQualityHistory(meterId: string, days = 7): PowerQualitySample[] {
  ensureSchema();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const pool: SqlitePool = db();
  const rows = pool.all(
    `SELECT meter_id, voltage, frequency, thd, received_at FROM power_quality_samples
     WHERE meter_id = ? AND received_at >= ? ORDER BY received_at ASC`,
    [meterId, since]
  ) as Array<{
    meter_id: string;
    voltage: number;
    frequency: number;
    thd: number;
    received_at: string;
  }>;

  return rows.map((row) => ({
    meterId: row.meter_id,
    voltage: row.voltage,
    frequency: row.frequency,
    thd: row.thd,
    timestamp: row.received_at,
  }));
}

function severityFor(value: number, threshold: number): 'low' | 'medium' | 'high' {
  const deviation = Math.abs(value - threshold);
  const relative = threshold !== 0 ? deviation / Math.abs(threshold) : deviation;
  if (relative >= 0.1) {
    return 'high';
  }
  if (relative >= 0.05) {
    return 'medium';
  }
  return 'low';
}

export function analyzePowerQuality(sample: PowerQualitySample): PowerQualityIssue[] {
  const issues: PowerQualityIssue[] = [];
  const detectedAt = sample.timestamp;

  if (sample.voltage < VOLTAGE_MIN) {
    issues.push({
      type: 'sag',
      severity: severityFor(sample.voltage, VOLTAGE_MIN),
      value: sample.voltage,
      threshold: VOLTAGE_MIN,
      detectedAt,
    });
  } else if (sample.voltage > VOLTAGE_MAX) {
    issues.push({
      type: 'swell',
      severity: severityFor(sample.voltage, VOLTAGE_MAX),
      value: sample.voltage,
      threshold: VOLTAGE_MAX,
      detectedAt,
    });
  }

  if (sample.thd > THD_MAX) {
    issues.push({
      type: 'harmonic',
      severity: severityFor(sample.thd, THD_MAX),
      value: sample.thd,
      threshold: THD_MAX,
      detectedAt,
    });
  }

  if (sample.frequency < FREQUENCY_MIN) {
    issues.push({
      type: 'sag',
      severity: severityFor(sample.frequency, FREQUENCY_MIN),
      value: sample.frequency,
      threshold: FREQUENCY_MIN,
      detectedAt,
    });
  } else if (sample.frequency > FREQUENCY_MAX) {
    issues.push({
      type: 'swell',
      severity: severityFor(sample.frequency, FREQUENCY_MAX),
      value: sample.frequency,
      threshold: FREQUENCY_MAX,
      detectedAt,
    });
  }

  return issues;
}

function buildAlertMessage(meterId: string, issues: PowerQualityIssue[]): string {
  const parts = issues.map((issue) => {
    switch (issue.type) {
      case 'sag':
        return `voltage/frequency sag (${issue.value} below ${issue.threshold})`;
      case 'swell':
        return `voltage/frequency swell (${issue.value} above ${issue.threshold})`;
      case 'harmonic':
        return `harmonic distortion (THD ${issue.value}% above ${issue.threshold}%)`;
      default:
        return `${issue.type} issue`;
    }
  });
  return `Power quality alert for meter ${meterId}: ${parts.join('; ')}`;
}

async function dispatchAlerts(meterId: string, issues: PowerQualityIssue[]): Promise<void> {
  if (issues.length === 0) {
    return;
  }
  const now = Date.now();
  const last = lastAlertAt.get(meterId) ?? 0;
  if (now - last < ALERT_DEBOUNCE_MS) {
    return;
  }
  lastAlertAt.set(meterId, now);

  const message = buildAlertMessage(meterId, issues);
  const subject = `Power quality alert for meter ${meterId}`;

  try {
    await sendPushToOwner(meterId, {
      title: 'Power Quality Alert',
      body: message,
    });
  } catch (err) {
    // Swallow notification errors so monitoring never breaks ingestion.
  }

  try {
    await sendNotificationEmail(meterId, {
      subject,
      text: message,
    });
  } catch (err) {
    // Swallow notification errors so monitoring never breaks ingestion.
  }
}

export async function processPowerQualitySample(
  input: RecordPowerQualityInput
): Promise<{ sample: PowerQualitySample; issues: PowerQualityIssue[] }> {
  const sample = recordPowerQualitySample(input);
  const issues = analyzePowerQuality(sample);
  await dispatchAlerts(sample.meterId, issues);
  return { sample, issues };
}

export function getPowerQualitySummary(meterId: string, days = 7): PowerQualitySummary {
  const trend = getPowerQualityHistory(meterId, days);
  const current = trend.length > 0 ? trend[trend.length - 1] : null;
  const issues = current ? analyzePowerQuality(current) : [];
  return {
    meterId,
    current,
    issues,
    trend,
  };
}

export function _resetPowerQuality(): void {
  lastAlertAt.clear();
  schemaInitialized = false;
}