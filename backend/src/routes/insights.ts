/**
 * GET /api/meters/:id/insights
 *
 * Returns personalised energy insights for a meter:
 *  - Peak usage hours (24-slot histogram)
 *  - Week-over-week change percentage
 *  - Anonymised peer comparison (avg kWh across all meters)
 *  - Actionable saving recommendations
 *  - Gamification badges earned
 *
 * All queries run against the local SQLite usage-events store.
 * Results are cached for 10 minutes per meter to avoid repeated aggregations.
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { initUsageEventStore } from "../lib/usageEvents.js";

export const insightsRouter = Router();

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const cache = new Map<string, { data: MeterInsights; expiresAt: number }>();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HourlyBucket {
    hour: number;        // 0-23 (UTC)
    units: number;       // kWh (milli-kWh / 1000)
}

export interface Badge {
    id: string;
    label: string;
    description: string;
    earned: boolean;
}

export interface MeterInsights {
    meterId: string;
    generatedAt: string;                   // ISO 8601
    weekOverWeekChangePct: number | null;  // positive = increase, negative = decrease
    peakHour: number | null;              // 0-23 UTC, null if no data
    hourlyProfile: HourlyBucket[];        // 24 buckets, last 30 days
    peerAvgWeeklyKwh: number | null;      // anonymous avg across all meters
    thisWeekKwh: number;
    lastWeekKwh: number;
    recommendations: string[];
    badges: Badge[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function db() {
    return initUsageEventStore();
}

/** Aggregate hourly usage for a meter over the last N days. */
function getHourlyProfile(meterId: string, days = 30): HourlyBucket[] {
    const rows = db()
        .prepare(
            `SELECT strftime('%H', received_at) AS hour,
              SUM(CAST(units AS REAL)) AS total_units
       FROM usage_events
       WHERE meter_id = ?
         AND status IN ('submitted', 'pending')
         AND received_at >= datetime('now', '-' || ? || ' days')
       GROUP BY hour`
        )
        .all(meterId, days) as Array<{ hour: string; total_units: number }>;

    const buckets: HourlyBucket[] = Array.from({ length: 24 }, (_, h) => ({
        hour: h,
        units: 0,
    }));

    for (const row of rows) {
        const h = parseInt(row.hour, 10);
        if (h >= 0 && h < 24) {
            buckets[h].units = Math.round((Number(row.total_units ?? 0) / 1000) * 100) / 100;
        }
    }

    return buckets;
}

/** Sum units (kWh) for a meter in a given UTC time window. */
function getKwhInWindow(meterId: string, start: string, end: string): number {
    const row = db()
        .prepare(
            `SELECT COALESCE(SUM(CAST(units AS REAL)), 0) AS total
       FROM usage_events
       WHERE meter_id = ?
         AND status IN ('submitted', 'pending')
         AND received_at >= ?
         AND received_at < ?`
        )
        .get(meterId, start, end) as { total: number };

    return Math.round((Number(row.total ?? 0) / 1000) * 100) / 100;
}

/** Average weekly kWh across ALL meters (anonymised peer comparison). */
function getPeerAvgWeeklyKwh(): number | null {
    const row = db()
        .prepare(
            `SELECT
         COUNT(DISTINCT meter_id) AS meter_count,
         COALESCE(SUM(CAST(units AS REAL)), 0) AS total_units
       FROM usage_events
       WHERE status IN ('submitted', 'pending')
         AND received_at >= datetime('now', '-7 days')`
        )
        .get() as { meter_count: number; total_units: number };

    if (!row || row.meter_count === 0) return null;
    return (
        Math.round((Number(row.total_units) / 1000 / row.meter_count) * 100) / 100
    );
}

/** Build recommendation strings based on computed metrics. */
function buildRecommendations(
    weekChangePct: number | null,
    peakHour: number | null,
    thisWeekKwh: number,
    peerAvg: number | null,
): string[] {
    const tips: string[] = [];

    if (weekChangePct !== null && weekChangePct > 15) {
        tips.push(
            `Your usage increased ${weekChangePct.toFixed(0)}% last week. Review high-draw appliances.`
        );
    }

    if (peakHour !== null) {
        const nextHour = (peakHour + 1) % 24;
        const label = `${peakHour.toString().padStart(2, "0")}:00–${nextHour.toString().padStart(2, "0")}:00 UTC`;
        tips.push(
            `Peak usage is at ${label}. Shifting laundry or cooking to off-peak hours can lower costs.`
        );
        // Evening peak (18-21 UTC)
        if (peakHour >= 18 && peakHour <= 20) {
            tips.push("Evening peaks are common — consider pre-cooling or pre-heating earlier in the day.");
        }
    }

    if (peerAvg !== null && thisWeekKwh > peerAvg * 1.3) {
        const overPct = Math.round(((thisWeekKwh - peerAvg) / peerAvg) * 100);
        tips.push(
            `You used ${overPct}% more than similar households this week (${thisWeekKwh.toFixed(2)} kWh vs avg ${peerAvg.toFixed(2)} kWh).`
        );
    }

    if (tips.length === 0 && thisWeekKwh > 0) {
        tips.push("Great job! Your usage looks steady. Keep monitoring your peak hours.");
    }

    if (tips.length === 0) {
        tips.push("No usage data yet. Insights will appear once your meter starts recording.");
    }

    return tips;
}

/** Determine which gamification badges the meter has earned. */
function buildBadges(
    weekChangePct: number | null,
    thisWeekKwh: number,
    peerAvg: number | null,
    hourlyProfile: HourlyBucket[],
): Badge[] {
    const peakUnits = Math.max(...hourlyProfile.map((b) => b.units));
    const offPeakUnits = hourlyProfile
        .filter((b) => b.hour >= 22 || b.hour <= 6)
        .reduce((s, b) => s + b.units, 0);
    const totalUnits = hourlyProfile.reduce((s, b) => s + b.units, 0);
    const offPeakRatio = totalUnits > 0 ? offPeakUnits / totalUnits : 0;

    return [
        {
            id: "low_consumer",
            label: "🌱 Low Consumer",
            description: "Used less than 5 kWh this week.",
            earned: thisWeekKwh > 0 && thisWeekKwh < 5,
        },
        {
            id: "off_peak_hero",
            label: "🌙 Off-Peak Hero",
            description: "Over 40% of usage is during off-peak hours (22:00–06:00).",
            earned: offPeakRatio > 0.4 && totalUnits > 0,
        },
        {
            id: "improver",
            label: "📉 Improver",
            description: "Reduced usage by 10% or more vs last week.",
            earned: weekChangePct !== null && weekChangePct <= -10,
        },
        {
            id: "below_average",
            label: "⚡ Below Average",
            description: "Using less energy than similar households.",
            earned: peerAvg !== null && thisWeekKwh > 0 && thisWeekKwh < peerAvg,
        },
        {
            id: "consistent",
            label: "📊 Consistent",
            description: "Stable usage across all hours — no extreme peaks.",
            earned: peakUnits > 0 && totalUnits > 0 && peakUnits / totalUnits < 0.25,
        },
    ];
}

// ── Route ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/meters/:id/insights
 *
 * Query params:
 *   - refresh=true  bypass cache
 */
insightsRouter.get(
    "/:id/insights",
    asyncHandler(async (req, res) => {
        const meterId = req.params.id;
        if (!meterId || meterId.trim() === "") {
            return res.status(400).json({ error: "Invalid meter ID", code: "VALIDATION_ERROR" });
        }

        const forceRefresh = req.query.refresh === "true";
        const cached = cache.get(meterId);
        if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
            res.setHeader("X-Cache", "HIT");
            return res.json(cached.data);
        }

        // Time windows (ISO strings for SQLite datetime comparison)
        const now = new Date();
        const thisWeekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const lastWeekStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

        const thisWeekKwh = getKwhInWindow(meterId, thisWeekStart, now.toISOString());
        const lastWeekKwh = getKwhInWindow(meterId, lastWeekStart, thisWeekStart);

        const weekChangePct =
            lastWeekKwh > 0
                ? Math.round(((thisWeekKwh - lastWeekKwh) / lastWeekKwh) * 1000) / 10
                : null;

        const hourlyProfile = getHourlyProfile(meterId, 30);
        const peakBucket = hourlyProfile.reduce(
            (best, b) => (b.units > best.units ? b : best),
            hourlyProfile[0],
        );
        const peakHour = peakBucket.units > 0 ? peakBucket.hour : null;

        const peerAvgWeeklyKwh = getPeerAvgWeeklyKwh();
        const recommendations = buildRecommendations(weekChangePct, peakHour, thisWeekKwh, peerAvgWeeklyKwh);
        const badges = buildBadges(weekChangePct, thisWeekKwh, peerAvgWeeklyKwh, hourlyProfile);

        const result: MeterInsights = {
            meterId,
            generatedAt: now.toISOString(),
            weekOverWeekChangePct: weekChangePct,
            peakHour,
            hourlyProfile,
            peerAvgWeeklyKwh,
            thisWeekKwh,
            lastWeekKwh,
            recommendations,
            badges,
        };

        cache.set(meterId, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
        res.setHeader("X-Cache", "MISS");
        return res.json(result);
    })
);
