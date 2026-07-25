import * as StellarSdk from '@stellar/stellar-sdk';
import { StellarService } from '../lib/stellar.js';
import { getMqttClient } from './mqttClient.js';
import { logger } from '../lib/logger.js';

const THRESHOLD = 0.8;
const warnedToday = new Set<string>();

function scheduleWarnedReset() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  setTimeout(() => {
    warnedToday.clear();
    scheduleWarnedReset();
  }, midnight.getTime() - now.getTime());
}

export async function checkDailyLimits(stellar: StellarService) {
  try {
    const raw = await stellar.query('get_all_meters', []);
    const meters = (StellarSdk.scValToNative(raw) as any[]) ?? [];
    for (const meter of meters) {
      if (Number(meter.daily_limit) > 0) {
        const ratio = Number(meter.day_spent) / Number(meter.daily_limit);
        if (ratio >= THRESHOLD && !warnedToday.has(meter.id)) {
          getMqttClient().publish(
            `meters/${meter.id}/warnings`,
            JSON.stringify({ type: 'DAILY_LIMIT_WARNING', ratio, meterId: meter.id }),
            { qos: 1 },
          );
          warnedToday.add(meter.id);
          logger.info('Daily limit warning published', { meterId: meter.id, ratio });
        }
      }
    }
  } catch (err) {
    logger.error('checkDailyLimits error', { err });
  }
}

export function startLimitWatcher(stellar: StellarService) {
  scheduleWarnedReset();
  const intervalMs = Number(process.env.LIMIT_WATCH_INTERVAL_MS ?? 5 * 60 * 1000);
  setInterval(() => checkDailyLimits(stellar), intervalMs);
}
