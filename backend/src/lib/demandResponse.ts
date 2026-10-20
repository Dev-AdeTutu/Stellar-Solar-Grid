/**
 * Demand Response Program
 * Rewards users for reducing consumption during peak periods
 */

import Database from 'better-sqlite3';
import { logger } from './logger.js';
import { sendPushNotification } from './pushNotifications.js';

export interface PeakEvent {
  id: string;
  startTime: Date;
  endTime: Date;
  predictedDemand: number;
  threshold: number;
  status: 'scheduled' | 'active' | 'completed' | 'cancelled';
  notificationsSent: boolean;
  createdAt: Date;
}

export interface ParticipantData {
  meterId: string;
  peakEventId: string;
  baselineConsumption: number;
  actualConsumption: number;
  reduction: number;
  rewardAmount: number;
  participatedAt: Date;
}

export interface ProgramStats {
  totalEvents: number;
  activeParticipants: number;
  totalReduction: number;
  totalRewardsDistributed: number;
  averageParticipationRate: number;
  roi: number;
}

/**
 * Grid operator dispatch signal (VPP)
 */
export interface DispatchSignal {
  id: string;
  /** Direction of the requested grid service */
  direction: 'charge' | 'discharge' | 'curtail';
  /** Total power requested across the fleet, in kW */
  requestedPowerKw: number;
  /** Duration of the dispatch window, in minutes */
  durationMinutes: number;
  /** When the dispatch window begins */
  startTime: Date;
  /** Optional grid operator reference / market event id */
  gridOperatorRef?: string;
  /** Priority hint for allocation (higher = served first) */
  priority?: number;
}

/**
 * Meter-level dispatch command derived from a grid operator signal
 */
export interface MeterDispatchCommand {
  signalId: string;
  meterId: string;
  owner: string;
  action: 'charge' | 'discharge' | 'curtail';
  /** Power allocated to this meter, in kW */
  powerKw: number;
  startTime: Date;
  endTime: Date;
  createdAt: Date;
}

/**
 * Aggregated fleet response to a dispatch signal
 */
export interface DispatchAggregate {
  signalId: string;
  direction: DispatchSignal['direction'];
  requestedPowerKw: number;
  allocatedPowerKw: number;
  /** Fraction of requested power that could be allocated (0..1) */
  fulfillmentRatio: number;
  commandCount: number;
  meterCount: number;
  startTime: Date;
  endTime: Date;
  commands: MeterDispatchCommand[];
}

/**
 * Per-meter capability used when allocating dispatch commands
 */
interface MeterCapability {
  meterId: string;
  owner: string;
  /** Available flexible power in kW (positive magnitude) */
  availableKw: number;
  /** Current state of charge (0..1) when known, for storage meters */
  stateOfCharge?: number;
}

const DEFAULT_METER_FLEX_KW = 5; // fallback flexible capacity per meter
const MIN_ALLOCATION_KW = 0.1; // ignore allocations below this
=======

const PEAK_DEMAND_THRESHOLD = 0.85; // 85% of grid capacity
const NOTIFICATION_ADVANCE_HOURS = 1;
const REWARD_RATE_PER_KWH = 0.5; // $0.50 per kWh reduced
const MIN_REDUCTION_PERCENTAGE = 10; // Minimum 10% reduction to qualify

let db: Database.Database;
let peakDetectionInterval: NodeJS.Timeout | null = null;

/**
 * Initialize demand response system
 */
export function initDemandResponse(database: Database.Database): void {
  db = database;
  
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS peak_events (
      id TEXT PRIMARY KEY,
      start_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL,
      predicted_demand REAL NOT NULL,
      threshold REAL NOT NULL,
      status TEXT NOT NULL,
      notifications_sent INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS demand_response_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meter_id TEXT NOT NULL,
      peak_event_id TEXT NOT NULL,
      baseline_consumption REAL NOT NULL,
      actual_consumption REAL NOT NULL,
      reduction REAL NOT NULL,
      reward_amount REAL NOT NULL,
      participated_at INTEGER NOT NULL,
      FOREIGN KEY (peak_event_id) REFERENCES peak_events(id),
      UNIQUE(meter_id, peak_event_id)
    );

    CREATE TABLE IF NOT EXISTS demand_response_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meter_id TEXT NOT NULL,
      peak_event_id TEXT NOT NULL,
      notification_type TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      FOREIGN KEY (peak_event_id) REFERENCES peak_events(id)
    );

    CREATE INDEX IF NOT EXISTS idx_peak_events_status 
      ON peak_events(status);
    CREATE INDEX IF NOT EXISTS idx_peak_events_start_time 
      ON peak_events(start_time);
    CREATE INDEX IF NOT EXISTS idx_participants_meter 
      ON demand_response_participants(meter_id);
    CREATE INDEX IF NOT EXISTS idx_participants_event 
      ON demand_response_participants(peak_event_id);
  `);

  logger.info('Demand response system initialized');
}

/**
 * Detect peak demand conditions
 */
export function detectPeakDemand(): PeakEvent | null {
  try {
    // Get current grid load from all meters
    const result = db.prepare(`
      SELECT 
        SUM(current_power) as total_demand,
        COUNT(*) as meter_count
      FROM meter_metadata
      WHERE last_seen > ?
    `).get(Date.now() - 5 * 60 * 1000) as { total_demand: number; meter_count: number };

    if (!result || !result.total_demand) {
      return null;
    }

    // Estimate grid capacity (this should come from grid operator in production)
    const estimatedCapacity = result.meter_count * 5000; // 5kW average per meter
    const demandRatio = result.total_demand / estimatedCapacity;

    logger.info('Peak demand check', {
      totalDemand: result.total_demand,
      capacity: estimatedCapacity,
      ratio: demandRatio,
      threshold: PEAK_DEMAND_THRESHOLD
    });

    // Check if we're approaching peak
    if (demandRatio >= PEAK_DEMAND_THRESHOLD) {
      const now = Date.now();
      const startTime = now + NOTIFICATION_ADVANCE_HOURS * 60 * 60 * 1000;
      const endTime = startTime + 2 * 60 * 60 * 1000; // 2-hour event

      const peakEvent: PeakEvent = {
        id: `peak_${now}`,
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        predictedDemand: result.total_demand,
        threshold: estimatedCapacity * PEAK_DEMAND_THRESHOLD,
        status: 'scheduled',
        notificationsSent: false,
        createdAt: new Date(now)
      };

      // Save to database
      db.prepare(`
        INSERT INTO peak_events (
          id, start_time, end_time, predicted_demand, 
          threshold, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        peakEvent.id,
        peakEvent.startTime.getTime(),
        peakEvent.endTime.getTime(),
        peakEvent.predictedDemand,
        peakEvent.threshold,
        peakEvent.status,
        peakEvent.createdAt.getTime()
      );

      logger.info('Peak demand event created', { peakEvent });
      return peakEvent;
    }

    return null;
  } catch (error) {
    logger.error('Error detecting peak demand', { error });
    return null;
  }
}

/**
 * Send notifications to all eligible users
 */
export async function notifyUsers(peakEventId: string): Promise<number> {
  try {
    // Get all active meters with push subscriptions
    const meters = db.prepare(`
      SELECT DISTINCT m.meter_id, m.owner
      FROM meter_metadata m
      INNER JOIN push_subscriptions ps ON ps.user_id = m.owner
      WHERE m.last_seen > ?
      AND ps.endpoint IS NOT NULL
    `).all(Date.now() - 24 * 60 * 60 * 1000) as Array<{ meter_id: string; owner: string }>;

    const event = getPeakEvent(peakEventId);
    if (!event) {
      logger.error('Peak event not found', { peakEventId });
      return 0;
    }

    let sentCount = 0;

    for (const meter of meters) {
      try {
        const message = {
          title: '⚡ Peak Demand Alert',
          body: `Peak demand period starting in ${NOTIFICATION_ADVANCE_HOURS} hour. Reduce usage to earn rewards!`,
          data: {
            type: 'demand_response',
            peakEventId: event.id,
            startTime: event.startTime.toISOString(),
            endTime: event.endTime.toISOString()
          }
        };

        await sendPushNotification(meter.owner, message);

        // Record notification
        db.prepare(`
          INSERT INTO demand_response_notifications 
          (meter_id, peak_event_id, notification_type, sent_at)
          VALUES (?, ?, ?, ?)
        `).run(meter.meter_id, peakEventId, 'advance_alert', Date.now());

        sentCount++;
      } catch (error) {
        logger.error('Failed to send notification', { 
          meterId: meter.meter_id, 
          error 
        });
      }
    }

    // Mark notifications as sent
    db.prepare(`
      UPDATE peak_events 
      SET notifications_sent = 1 
      WHERE id = ?
    `).run(peakEventId);

    logger.info('Demand response notifications sent', { 
      peakEventId, 
      sentCount 
    });

    return sentCount;
  } catch (error) {
    logger.error('Error sending notifications', { peakEventId, error });
    return 0;
  }
}

/**
 * Calculate baseline consumption for a meter
 */
export function calculateBaseline(meterId: string, peakEvent: PeakEvent): number {
  try {
    // Get average consumption for same hours on previous 5 days
    const startHour = peakEvent.startTime.getHours();
    const duration = (peakEvent.endTime.getTime() - peakEvent.startTime.getTime()) / (1000 * 60 * 60);
    
    const result = db.prepare(`
      SELECT AVG(energy_kwh) as avg_consumption
      FROM usage_events
      WHERE meter_id = ?
      AND timestamp >= ?
      AND timestamp < ?
      AND strftime('%H', datetime(timestamp/1000, 'unixepoch')) >= ?
      AND strftime('%H', datetime(timestamp/1000, 'unixepoch')) < ?
    `).get(
      meterId,
      peakEvent.startTime.getTime() - 7 * 24 * 60 * 60 * 1000,
      peakEvent.startTime.getTime(),
      startHour.toString(),
      (startHour + duration).toString()
    ) as { avg_consumption: number | null };

    return result?.avg_consumption || 0;
  } catch (error) {
    logger.error('Error calculating baseline', { meterId, error });
    return 0;
  }
}

/**
 * Calculate actual consumption during event
 */
export function calculateActualConsumption(
  meterId: string, 
  startTime: Date, 
  endTime: Date
): number {
  try {
    const result = db.prepare(`
      SELECT SUM(energy_kwh) as total_consumption
      FROM usage_events
      WHERE meter_id = ?
      AND timestamp >= ?
      AND timestamp <= ?
    `).get(
      meterId,
      startTime.getTime(),
      endTime.getTime()
    ) as { total_consumption: number | null };

    return result?.total_consumption || 0;
  } catch (error) {
    logger.error('Error calculating actual consumption', { meterId, error });
    return 0;
  }
}

/**
 * Calculate reward for a participant
 */
export function calculateReward(
  baseline: number,
  actual: number
): { reduction: number; rewardAmount: number; qualifies: boolean } {
  const reduction = Math.max(0, baseline - actual);
  const reductionPercentage = baseline > 0 ? (reduction / baseline) * 100 : 0;
  const qualifies = reductionPercentage >= MIN_REDUCTION_PERCENTAGE;
  const rewardAmount = qualifies ? reduction * REWARD_RATE_PER_KWH : 0;

  return {
    reduction,
    rewardAmount: Math.round(rewardAmount * 100) / 100, // Round to 2 decimals
    qualifies
  };
}

/**
 * Process participation for a completed event
 */
export function processParticipation(peakEventId: string): ParticipantData[] {
  try {
    const event = getPeakEvent(peakEventId);
    if (!event || event.status !== 'completed') {
      logger.warn('Cannot process participation for non-completed event', { 
        peakEventId, 
        status: event?.status 
      });
      return [];
    }

    // Get all active meters
    const meters = db.prepare(`
      SELECT meter_id, owner
      FROM meter_metadata
      WHERE last_seen > ?
    `).all(event.startTime.getTime() - 24 * 60 * 60 * 1000) as Array<{ 
      meter_id: string; 
      owner: string 
    }>;

    const participants: ParticipantData[] = [];

    for (const meter of meters) {
      const baseline = calculateBaseline(meter.meter_id, event);
      const actual = calculateActualConsumption(
        meter.meter_id,
        event.startTime,
        event.endTime
      );

      const { reduction, rewardAmount, qualifies } = calculateReward(baseline, actual);

      if (qualifies && rewardAmount > 0) {
        const participant: ParticipantData = {
          meterId: meter.meter_id,
          peakEventId,
          baselineConsumption: baseline,
          actualConsumption: actual,
          reduction,
          rewardAmount,
          participatedAt: new Date()
        };

        // Save to database
        db.prepare(`
          INSERT OR REPLACE INTO demand_response_participants (
            meter_id, peak_event_id, baseline_consumption,
            actual_consumption, reduction, reward_amount, participated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          participant.meterId,
          participant.peakEventId,
          participant.baselineConsumption,
          participant.actualConsumption,
          participant.reduction,
          participant.rewardAmount,
          participant.participatedAt.getTime()
        );

        participants.push(participant);

        // Send reward notification
        sendRewardNotification(meter.owner, participant).catch(err => {
          logger.error('Failed to send reward notification', { 
            meterId: meter.meter_id, 
            error: err 
          });
        });
      }
    }

    logger.info('Participation processed', { 
      peakEventId, 
      participantCount: participants.length 
    });

    return participants;
  } catch (error) {
    logger.error('Error processing participation', { peakEventId, error });
    return [];
  }
}

/**
 * Send reward notification to user
 */
async function sendRewardNotification(
  userId: string,
  participant: ParticipantData
): Promise<void> {
  const message = {
    title: '🎉 Demand Response Reward Earned!',
    body: `You earned $${participant.rewardAmount.toFixed(2)} for reducing consumption by ${participant.reduction.toFixed(2)} kWh`,
    data: {
      type: 'demand_response_reward',
      peakEventId: participant.peakEventId,
      rewardAmount: participant.rewardAmount.toString(),
      reduction: participant.reduction.toString()
    }
  };

  await sendPushNotification(userId, message);
}

/**
 * Get peak event by ID
 */
export function getPeakEvent(peakEventId: string): PeakEvent | null {
  try {
    const row = db.prepare(`
      SELECT * FROM peak_events WHERE id = ?
    `).get(peakEventId) as any;

    if (!row) return null;

    return {
      id: row.id,
      startTime: new Date(row.start_time),
      endTime: new Date(row.end_time),
      predictedDemand: row.predicted_demand,
      threshold: row.threshold,
      status: row.status,
      notificationsSent: row.notifications_sent === 1,
      createdAt: new Date(row.created_at)
    };
  } catch (error) {
    logger.error('Error getting peak event', { peakEventId, error });
    return null;
  }
}

/**
 * Get participation history for a meter
 */
export function getParticipationHistory(meterId: string): ParticipantData[] {
  try {
    const rows = db.prepare(`
      SELECT * FROM demand_response_participants
      WHERE meter_id = ?
      ORDER BY participated_at DESC
      LIMIT 50
    `).all(meterId) as any[];

    return rows.map(row => ({
      meterId: row.meter_id,
      peakEventId: row.peak_event_id,
      baselineConsumption: row.baseline_consumption,
      actualConsumption: row.actual_consumption,
      reduction: row.reduction,
      rewardAmount: row.reward_amount,
      participatedAt: new Date(row.participated_at)
    }));
  } catch (error) {
    logger.error('Error getting participation history', { meterId, error });
    return [];
  }
}

/**
 * Get program statistics
 */
export function getProgramStats(): ProgramStats {
  try {
    const totalEvents = db.prepare(`
      SELECT COUNT(*) as count FROM peak_events
    `).get() as { count: number };

    const activeParticipants = db.prepare(`
      SELECT COUNT(DISTINCT meter_id) as count 
      FROM demand_response_participants
    `).get() as { count: number };

    const totals = db.prepare(`
      SELECT 
        SUM(reduction) as total_reduction,
        SUM(reward_amount) as total_rewards
      FROM demand_response_participants
    `).get() as { total_reduction: number; total_rewards: number };

    const participationRate = db.prepare(`
      SELECT 
        COUNT(DISTINCT drp.meter_id) * 100.0 / COUNT(DISTINCT mm.meter_id) as rate
      FROM peak_events pe
      CROSS JOIN meter_metadata mm
      LEFT JOIN demand_response_participants drp 
        ON drp.peak_event_id = pe.id
      WHERE pe.status = 'completed'
    `).get() as { rate: number };

    // Calculate ROI (savings vs rewards paid)
    const gridCostPerKwh = 0.15; // $0.15 per kWh grid cost
    const savings = (totals.total_reduction || 0) * gridCostPerKwh;
    const roi = totals.total_rewards > 0 
      ? ((savings - totals.total_rewards) / totals.total_rewards) * 100 
      : 0;

    return {
      totalEvents: totalEvents.count,
      activeParticipants: activeParticipants.count,
      totalReduction: totals.total_reduction || 0,
      totalRewardsDistributed: totals.total_rewards || 0,
      averageParticipationRate: participationRate.rate || 0,
      roi
    };
  } catch (error) {
    logger.error('Error getting program stats', { error });
    return {
      totalEvents: 0,
      activeParticipants: 0,
      totalReduction: 0,
      totalRewardsDistributed: 0,
      averageParticipationRate: 0,
      roi: 0
    };
  }
}

/**
 * Update event status
 */
export function updateEventStatus(peakEventId: string, status: PeakEvent['status']): void {
  try {
    db.prepare(`
      UPDATE peak_events 
      SET status = ? 
      WHERE id = ?
    `).run(status, peakEventId);

    logger.info('Peak event status updated', { peakEventId, status });
  } catch (error) {
    logger.error('Error updating event status', { peakEventId, status, error });
  }
}

/**
 * Determine flexible capacity available from each active meter.
 * Uses current power readings and metadata when available, falling
 * back to a conservative default per meter.
 */
function getMeterCapabilities(): MeterCapability[] {
  try {
    const rows = db.prepare(`
      SELECT meter_id, owner, current_power
      FROM meter_metadata
      WHERE last_seen > ?
    `).all(Date.now() - 24 * 60 * 60 * 1000) as Array<{
      meter_id: string;
      owner: string;
      current_power: number | null;
    }>;

    return rows.map(row => {
      const current = Math.abs(row.current_power || 0);
      // Flexible headroom: meters already drawing power can shed it,
      // otherwise assume the default flexible capacity.
      const availableKw = current > 0
        ? Math.min(current, DEFAULT_METER_FLEX_KW * 2)
        : DEFAULT_METER_FLEX_KW;

      return {
        meterId: row.meter_id,
        owner: row.owner,
        availableKw
      };
    });
  } catch (error) {
    logger.error('Error getting meter capabilities', { error });
    return [];
  }
}

/**
 * Translate a grid operator dispatch signal into meter-level commands.
 * Allocates the requested power across the fleet proportionally to each
 * meter's available flexible capacity.
 */
export function translateDispatchSignal(signal: DispatchSignal): DispatchAggregate {
  const startTime = signal.startTime;
  const endTime = new Date(startTime.getTime() + signal.durationMinutes * 60 * 1000);

  const emptyAggregate: DispatchAggregate = {
    signalId: signal.id,
    direction: signal.direction,
    requestedPowerKw: signal.requestedPowerKw,
    allocatedPowerKw: 0,
    fulfillmentRatio: 0,
    commandCount: 0,
    meterCount: 0,
    startTime,
    endTime,
    commands: []
  };

  try {
    const capabilities = getMeterCapabilities();
    if (capabilities.length === 0 || signal.requestedPowerKw <= 0) {
      logger.warn('No meters available for dispatch signal', { signalId: signal.id });
      return emptyAggregate;
    }

    const totalAvailable = capabilities.reduce((sum, c) => sum + c.availableKw, 0);
    if (totalAvailable <= 0) {
      return emptyAggregate;
    }

    const commands: MeterDispatchCommand[] = [];
    let allocated = 0;

    for (const cap of capabilities) {
      const share = (cap.availableKw / totalAvailable) * signal.requestedPowerKw;
      const powerKw = Math.min(share, cap.availableKw);

      if (powerKw < MIN_ALLOCATION_KW) {
        continue;
      }

      const roundedPower = Math.round(powerKw * 100) / 100;
      allocated += roundedPower;

      commands.push({
        signalId: signal.id,
        meterId: cap.meterId,
        owner: cap.owner,
        action: signal.direction,
        powerKw: roundedPower,
        startTime,
        endTime,
        createdAt: new Date()
      });
    }

    const allocatedPowerKw = Math.round(allocated * 100) / 100;
    const fulfillmentRatio = signal.requestedPowerKw > 0
      ? Math.min(1, allocatedPowerKw / signal.requestedPowerKw)
      : 0;

    const aggregate: DispatchAggregate = {
      signalId: signal.id,
      direction: signal.direction,
      requestedPowerKw: signal.requestedPowerKw,
      allocatedPowerKw,
      fulfillmentRatio,
      commandCount: commands.length,
      meterCount: new Set(commands.map(c => c.meterId)).size,
      startTime,
      endTime,
      commands
    };

    logger.info('Dispatch signal translated to meter commands', {
      signalId: signal.id,
      direction: signal.direction,
      requestedPowerKw: signal.requestedPowerKw,
      allocatedPowerKw,
      fulfillmentRatio,
      commandCount: commands.length
    });

    return aggregate;
  } catch (error) {
    logger.error('Error translating dispatch signal', { signalId: signal.id, error });
    return emptyAggregate;
  }
}

/**
 * Aggregate meter-level responses back into a fleet-level response.
 * `responses` maps meterId to the actual power delivered (kW, positive magnitude).
 */
export function aggregateDispatchResponses(
  signal: DispatchSignal,
  responses: Record<string, number>
): DispatchAggregate {
  const startTime = signal.startTime;
  const endTime = new Date(startTime.getTime() + signal.durationMinutes * 60 * 1000);

  try {
    const commands: MeterDispatchCommand[] = Object.entries(responses)
      .filter(([, power]) => power >= MIN_ALLOCATION_KW)
      .map(([meterId, power]) => ({
        signalId: signal.id,
        meterId,
        owner: '',
        action: signal.direction,
        powerKw: Math.round(power * 100) / 100,
        startTime,
        endTime,
        createdAt: new Date()
      }));

    const allocatedPowerKw = Math.round(
      commands.reduce((sum, c) => sum + c.powerKw, 0) * 100
    ) / 100;

    const fulfillmentRatio = signal.requestedPowerKw > 0
      ? Math.min(1, allocatedPowerKw / signal.requestedPowerKw)
      : 0;

    return {
      signalId: signal.id,
      direction: signal.direction,
      requestedPowerKw: signal.requestedPowerKw,
      allocatedPowerKw,
      fulfillmentRatio,
      commandCount: commands.length,
      meterCount: commands.length,
      startTime,
      endTime,
      commands
    };
  } catch (error) {
    logger.error('Error aggregating dispatch responses', { signalId: signal.id, error });
    return {
      signalId: signal.id,
      direction: signal.direction,
      requestedPowerKw: signal.requestedPowerKw,
      allocatedPowerKw: 0,
      fulfillmentRatio: 0,
      commandCount: 0,
      meterCount: 0,
      startTime,
      endTime,
      commands: []
    };
  }
}

/**
 * Start peak detection monitoring
 */
export function startPeakDetection(intervalMinutes: number = 15): void {
  if (peakDetectionInterval) {
    logger.warn('Peak detection already running');
    return;
  }

  peakDetectionInterval = setInterval(async () => {
    try {
      const peakEvent = detectPeakDemand();
      
      if (peakEvent) {
        // Send notifications immediately
        await notifyUsers(peakEvent.id);
        
        // Schedule event activation
        setTimeout(() => {
          updateEventStatus(peakEvent.id, 'active');
        }, NOTIFICATION_ADVANCE_HOURS * 60 * 60 * 1000);

        // Schedule event completion and processing
        setTimeout(() => {
          updateEventStatus(peakEvent.id, 'completed');
          processParticipation(peakEvent.id);
        }, peakEvent.endTime.getTime() - Date.now());
      }
    } catch (error) {
      logger.error('Error in peak detection cycle', { error });
    }
  }, intervalMinutes * 60 * 1000);

  logger.info('Peak detection monitoring started', { intervalMinutes });
}

/**
 * Stop peak detection monitoring
 */
export function stopPeakDetection(): void {
  if (peakDetectionInterval) {
    clearInterval(peakDetectionInterval);
    peakDetectionInterval = null;
    logger.info('Peak detection monitoring stopped');
  }
}
