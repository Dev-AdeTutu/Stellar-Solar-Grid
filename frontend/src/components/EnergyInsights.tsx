"use client";

import { useEffect, useState, useCallback } from "react";
import { env } from "@/lib/env";

const API = env.NEXT_PUBLIC_BACKEND_URL;

// ── Types ─────────────────────────────────────────────────────────────────────

interface HourlyBucket {
    hour: number;
    units: number;
}

interface Badge {
    id: string;
    label: string;
    description: string;
    earned: boolean;
}

interface MeterInsights {
    meterId: string;
    generatedAt: string;
    weekOverWeekChangePct: number | null;
    peakHour: number | null;
    hourlyProfile: HourlyBucket[];
    peerAvgWeeklyKwh: number | null;
    thisWeekKwh: number;
    lastWeekKwh: number;
    recommendations: string[];
    badges: Badge[];
}

interface Props {
    meterId: string;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function InsightsSkeleton() {
    return (
        <div className="animate-pulse space-y-3">
            <div className="h-4 w-48 rounded bg-white/10" />
            <div className="grid grid-cols-3 gap-2">
                {[0, 1, 2].map((i) => (
                    <div key={i} className="h-16 rounded-lg bg-white/10" />
                ))}
            </div>
            <div className="h-24 rounded-lg bg-white/10" />
        </div>
    );
}

/** Compact horizontal bar chart for the 24-hour usage profile. */
function HourlyProfileChart({ profile }: { profile: HourlyBucket[] }) {
    const max = Math.max(...profile.map((b) => b.units), 0.001);
    return (
        <div
            className="flex items-end gap-px h-16"
            role="img"
            aria-label="Hourly usage profile"
            title="Hourly energy usage profile (UTC)"
        >
            {profile.map((bucket) => {
                const heightPct = Math.round((bucket.units / max) * 100);
                // Highlight peak hour (tallest bar)
                const isPeak = bucket.units === max && max > 0;
                return (
                    <div
                        key={bucket.hour}
                        className="flex-1 flex flex-col items-center justify-end"
                        title={`${bucket.hour.toString().padStart(2, "0")}:00 — ${bucket.units.toFixed(2)} kWh`}
                    >
                        <div
                            className={`w-full rounded-sm transition-all ${isPeak ? "bg-solar-yellow" : "bg-white/20 hover:bg-white/30"
                                }`}
                            style={{ height: `${Math.max(heightPct, 4)}%` }}
                        />
                    </div>
                );
            })}
        </div>
    );
}

/** Week-over-week change indicator. */
function ChangeIndicator({ pct }: { pct: number | null }) {
    if (pct === null) return <span className="text-gray-400 text-xs">No prior data</span>;

    const positive = pct > 0;
    const zero = pct === 0;
    const arrow = zero ? "→" : positive ? "↑" : "↓";
    const color = zero
        ? "text-gray-400"
        : positive
            ? "text-red-400"
            : "text-green-400";

    return (
        <span className={`text-sm font-semibold ${color}`} aria-label={`${Math.abs(pct)}% ${positive ? "increase" : "decrease"} vs last week`}>
            {arrow} {Math.abs(pct).toFixed(1)}%
        </span>
    );
}

/** Single stat tile. */
function StatTile({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
    return (
        <div className="rounded-lg bg-white/5 border border-white/10 p-3 space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-gray-500">{label}</p>
            <div className="text-sm font-semibold text-white">{value}</div>
            {sub && <p className="text-[10px] text-gray-500">{sub}</p>}
        </div>
    );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function EnergyInsights({ meterId }: Props) {
    const [insights, setInsights] = useState<MeterInsights | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState(false);

    const load = useCallback(
        async (refresh = false) => {
            setLoading(true);
            setError(null);
            try {
                const url = `${API}/api/meters/${encodeURIComponent(meterId)}/insights${refresh ? "?refresh=true" : ""}`;
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data: MeterInsights = await res.json();
                setInsights(data);
            } catch (err: unknown) {
                setError(err instanceof Error ? err.message : "Failed to load insights");
            } finally {
                setLoading(false);
            }
        },
        [meterId]
    );

    useEffect(() => {
        load();
    }, [load]);

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <section
            aria-labelledby={`insights-heading-${meterId}`}
            className="rounded-xl border border-white/10 bg-solar-accent p-4 sm:p-5 space-y-4"
        >
            {/* Header */}
            <div className="flex items-center justify-between gap-2">
                <h3
                    id={`insights-heading-${meterId}`}
                    className="text-sm font-semibold text-solar-yellow flex items-center gap-1.5"
                >
                    <span aria-hidden="true">💡</span> Energy Insights
                </h3>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => load(true)}
                        disabled={loading}
                        aria-label="Refresh insights"
                        className="rounded px-2 py-1 text-[10px] text-gray-400 hover:text-white border border-white/10 hover:border-white/20 transition disabled:opacity-40"
                    >
                        {loading ? "…" : "Refresh"}
                    </button>
                    <button
                        onClick={() => setExpanded((v) => !v)}
                        aria-expanded={expanded}
                        aria-controls={`insights-body-${meterId}`}
                        className="rounded px-2 py-1 text-[10px] text-gray-400 hover:text-white border border-white/10 hover:border-white/20 transition"
                    >
                        {expanded ? "Collapse" : "Expand"}
                    </button>
                </div>
            </div>

            {/* Body */}
            <div id={`insights-body-${meterId}`}>
                {loading && <InsightsSkeleton />}

                {!loading && error && (
                    <p className="text-xs text-red-400" role="alert">
                        {error}
                    </p>
                )}

                {!loading && !error && insights && (
                    <div className="space-y-4">
                        {/* ── Key Stats ── */}
                        <div className="grid grid-cols-3 gap-2">
                            <StatTile
                                label="This Week"
                                value={`${insights.thisWeekKwh.toFixed(2)} kWh`}
                            />
                            <StatTile
                                label="vs Last Week"
                                value={<ChangeIndicator pct={insights.weekOverWeekChangePct} />}
                                sub={insights.lastWeekKwh > 0 ? `Last: ${insights.lastWeekKwh.toFixed(2)} kWh` : undefined}
                            />
                            <StatTile
                                label="Peers (avg)"
                                value={
                                    insights.peerAvgWeeklyKwh !== null
                                        ? `${insights.peerAvgWeeklyKwh.toFixed(2)} kWh`
                                        : "—"
                                }
                                sub="weekly avg"
                            />
                        </div>

                        {/* ── Recommendation banner ── */}
                        {insights.recommendations.length > 0 && (
                            <div className="rounded-lg border border-solar-yellow/20 bg-solar-yellow/5 p-3 space-y-1.5">
                                {insights.recommendations.map((tip, i) => (
                                    <p key={i} className="text-xs text-gray-300 flex gap-2">
                                        <span className="text-solar-yellow flex-shrink-0" aria-hidden="true">→</span>
                                        {tip}
                                    </p>
                                ))}
                            </div>
                        )}

                        {/* ── Expanded content ── */}
                        {expanded && (
                            <div className="space-y-4 pt-2 border-t border-white/10">
                                {/* Hourly profile */}
                                <div className="space-y-1.5">
                                    <p className="text-[10px] uppercase tracking-wider text-gray-500">
                                        24-Hour Usage Profile (last 30 days, UTC)
                                        {insights.peakHour !== null && (
                                            <span className="ml-2 text-solar-yellow">
                                                Peak: {insights.peakHour.toString().padStart(2, "0")}:00
                                            </span>
                                        )}
                                    </p>
                                    <HourlyProfileChart profile={insights.hourlyProfile} />
                                    <div className="flex justify-between text-[9px] text-gray-600">
                                        <span>00:00</span><span>06:00</span>
                                        <span>12:00</span><span>18:00</span>
                                        <span>23:00</span>
                                    </div>
                                </div>

                                {/* Badges */}
                                <div className="space-y-1.5">
                                    <p className="text-[10px] uppercase tracking-wider text-gray-500">Achievements</p>
                                    <div className="flex flex-wrap gap-2">
                                        {insights.badges.map((badge) => (
                                            <div
                                                key={badge.id}
                                                title={badge.description}
                                                aria-label={`${badge.label}${badge.earned ? " — earned" : " — not yet earned"}`}
                                                className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${badge.earned
                                                        ? "border-solar-yellow/40 bg-solar-yellow/10 text-solar-yellow"
                                                        : "border-white/10 bg-white/5 text-gray-600 opacity-50"
                                                    }`}
                                            >
                                                {badge.label}
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                {/* Generated at */}
                                <p className="text-[9px] text-gray-600">
                                    Last computed: {new Date(insights.generatedAt).toLocaleString()}
                                </p>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </section>
    );
}
