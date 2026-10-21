/**
 * Weather alert watcher (#900).
 *
 * Periodically checks the forecast for every active solar panel in the device
 * registry that has `specs.latitude` / `specs.longitude`, and notifies the
 * owner's registered webhooks about weather that will affect production.
 * Devices are grouped by (rounded) location so each site costs one API call,
 * and each (owner, location, date, alert type) is only sent once.
 */
import { listDevices } from "./deviceRegistry.js";
import { logger } from "./logger.js";
import { fireWebhook, getWebhookUrls } from "./webhookRegistry.js";
import { deriveAlerts, getWeather, locationKey, recordObservation } from "./weather.js";

const sent = new Set<string>();
const MAX_SENT_KEYS = 10_000;

export async function checkWeatherAlerts(): Promise<number> {
  if (!process.env.OPENWEATHERMAP_API_KEY) return 0;

  const sites = new Map<string, { lat: number; lon: number; owners: Map<string, string[]> }>();
  for (const device of listDevices({ type: "solar_panel", status: "active", limit: 500 })) {
    const lat = Number(device.specs.latitude);
    const lon = Number(device.specs.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = locationKey(lat, lon);
    let site = sites.get(key);
    if (!site) sites.set(key, (site = { lat, lon, owners: new Map() }));
    const ids = site.owners.get(device.owner) ?? [];
    ids.push(device.id);
    site.owners.set(device.owner, ids);
  }

  let notified = 0;
  for (const [key, site] of sites) {
    try {
      const report = await getWeather(site.lat, site.lon);
      recordObservation(report);
      const alerts = deriveAlerts(report).filter((a) => a.severity !== "info");
      for (const [owner, deviceIds] of site.owners) {
        const fresh = alerts.filter((a) => !sent.has(`${owner}|${key}|${a.date}|${a.type}`));
        if (fresh.length === 0) continue;
        fresh.forEach((a) => sent.add(`${owner}|${key}|${a.date}|${a.type}`));
        const payload = JSON.stringify({
          event: "weather.production_alert",
          location: report.location,
          deviceIds,
          alerts: fresh,
          sentAt: new Date().toISOString(),
        });
        logger.info({ owner, location: key, alerts: fresh.length }, "Weather production alert");
        for (const url of getWebhookUrls(owner)) {
          fireWebhook(url, payload).catch((err) =>
            logger.warn({ err, url }, "Weather alert webhook failed"),
          );
        }
        notified += 1;
      }
    } catch (err) {
      logger.warn({ err, location: key }, "Weather alert check failed for site");
    }
  }
  if (sent.size > MAX_SENT_KEYS) sent.clear();
  return notified;
}

let timer: NodeJS.Timeout | undefined;

/** Check every WEATHER_ALERT_INTERVAL_MS (default 3h). No-op without an API key. */
export function startWeatherAlertWatcher(
  intervalMs = Number(process.env.WEATHER_ALERT_INTERVAL_MS ?? 3 * 60 * 60 * 1000),
): void {
  if (timer || !process.env.OPENWEATHERMAP_API_KEY) return;
  timer = setInterval(() => {
    checkWeatherAlerts().catch((err) => logger.error({ err }, "Weather alert run failed"));
  }, intervalMs);
  timer.unref?.();
}
