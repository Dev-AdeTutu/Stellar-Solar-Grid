import { logger } from '../lib/logger.js';
import { notifyEmergencyContacts } from '../lib/emergencyContacts.js';

export interface GridReading {
  meterId: string;
  voltage: number; // Volts (nominal 120V / 230V; < 50V indicates no power)
  frequency: number; // Hz (nominal 50Hz / 60Hz; 0 indicates grid collapse)
  timestamp?: number;
  region?: string;
  userAddress?: string;
}

export interface OutageRecord {
  id: string;
  region: string;
  affectedMeters: string[];
  affectedUsers: string[];
  startedAt: string;
  status: 'active' | 'resolved';
  estimatedRestorationAt: string;
  cause: string;
  severity: 'minor' | 'moderate' | 'major' | 'critical';
  resolvedAt?: string;
  notificationsSent: number;
}

export interface CreateOutageInput {
  region: string;
  affectedMeters: string[];
  affectedUsers?: string[];
  estimatedRestorationAt?: string;
  cause?: string;
  severity?: 'minor' | 'moderate' | 'major' | 'critical';
}

export class OutageService {
  private outages: Map<string, OutageRecord> = new Map();
  private recentReadings: Map<string, GridReading> = new Map();
  private idCounter = 1;

  /**
   * Ingest a real-time IoT voltage/frequency telemetry reading.
   */
  public recordReading(reading: GridReading): void {
    const timestamp = reading.timestamp ?? Date.now();
    this.recentReadings.set(reading.meterId, { ...reading, timestamp });
  }

  /**
   * Evaluate recent readings and automatically detect outages.
   * An outage is flagged when >= 2 meters in a region report zero/low power (voltage < 50V or frequency 0).
   */
  public evaluateGridReadings(): OutageRecord[] {
    const lowPowerByRegion = new Map<string, { meters: string[]; users: string[] }>();

    for (const reading of Array.from(this.recentReadings.values())) {
      const isOutage = reading.voltage < 50 || reading.frequency <= 0;
      if (isOutage) {
        const region = reading.region ?? 'default-grid';
        const entry = lowPowerByRegion.get(region) ?? { meters: [], users: [] };
        if (!entry.meters.includes(reading.meterId)) {
          entry.meters.push(reading.meterId);
        }
        if (reading.userAddress && !entry.users.includes(reading.userAddress)) {
          entry.users.push(reading.userAddress);
        }
        lowPowerByRegion.set(region, entry);
      }
    }

    const createdOutages: OutageRecord[] = [];

    for (const [region, { meters, users }] of Array.from(lowPowerByRegion.entries())) {
      // Outage detected when multiple (>= 2) meters in the same grid/region report failure
      if (meters.length >= 2) {
        // Check if there is already an active outage in this region
        const existing = this.getActiveOutages().find((o) => o.region === region);
        if (!existing) {
          const estimatedRestoration = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2 hours
          const outage = this.createOutage({
            region,
            affectedMeters: meters,
            affectedUsers: users,
            estimatedRestorationAt: estimatedRestoration,
            cause: 'Grid voltage collapse detected from multiple IoT meters',
            severity: meters.length > 5 ? 'major' : 'moderate',
          });
          createdOutages.push(outage);
        }
      }
    }

    return createdOutages;
  }

  /**
   * Create an outage record.
   */
  public createOutage(input: CreateOutageInput): OutageRecord {
    const id = `outage-${Date.now()}-${this.idCounter++}`;
    const startedAt = new Date().toISOString();
    const estimatedRestorationAt =
      input.estimatedRestorationAt ?? new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    const record: OutageRecord = {
      id,
      region: input.region,
      affectedMeters: [...input.affectedMeters],
      affectedUsers: input.affectedUsers ? [...input.affectedUsers] : [],
      startedAt,
      status: 'active',
      estimatedRestorationAt,
      cause: input.cause ?? 'Unscheduled power interruption',
      severity: input.severity ?? 'moderate',
      notificationsSent: 0,
    };

    this.outages.set(id, record);
    logger.warn('Grid outage record created', { outageId: id, region: input.region });

    // Send notifications to affected users
    this.notifyAffectedUsers(record);

    return record;
  }

  /**
   * Return all currently active outages.
   */
  public getActiveOutages(): OutageRecord[] {
    return Array.from(this.outages.values()).filter((o) => o.status === 'active');
  }

  /**
   * Return outage record by ID.
   */
  public getOutageById(id: string): OutageRecord | undefined {
    return this.outages.get(id);
  }

  /**
   * Mark an outage as resolved.
   */
  public resolveOutage(id: string): OutageRecord | undefined {
    const outage = this.outages.get(id);
    if (!outage) return undefined;

    outage.status = 'resolved';
    outage.resolvedAt = new Date().toISOString();
    this.outages.set(id, outage);
    logger.info('Grid outage resolved', { outageId: id, region: outage.region });
    return outage;
  }

  /**
   * Dispatch push and emergency contact notifications to all affected users.
   */
  public async notifyAffectedUsers(outage: OutageRecord): Promise<number> {
    let sent = 0;
    for (const userAddress of outage.affectedUsers) {
      try {
        const meterId = outage.affectedMeters[0] ?? 'GRID';
        await notifyEmergencyContacts(userAddress, 'outage', meterId);
        sent++;
      } catch (err) {
        logger.warn('Failed to notify user for outage', { userAddress, outageId: outage.id, err });
      }
    }
    outage.notificationsSent += sent;
    return sent;
  }

  /**
   * Clear all records (useful for test isolation).
   */
  public reset(): void {
    this.outages.clear();
    this.recentReadings.clear();
    this.idCounter = 1;
  }
}

export const outageService = new OutageService();
