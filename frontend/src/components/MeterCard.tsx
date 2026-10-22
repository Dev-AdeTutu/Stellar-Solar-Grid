import React, { useState, useEffect } from "react";
import Link from "next/link";
import { MeterStatusBadge } from "./MeterStatusBadge";
import { formatXLM } from "@/lib/format";
import {
  getMeterLifecycle,
  getMeterMaterials,
  getMeterLifecycleEvents,
  getRecyclingCertification,
  getMaterialRecovery,
  getCircularEconomyCompliance,
  type MeterLifecycle,
  type MeterMaterial,
  type MeterLifecycleEvent,
  type RecyclingCertification,
  type MaterialRecovery,
  type CircularEconomyCompliance,
} from "@/lib/meterService";

export interface MeterShareholder {
  address: string;
  /** Ownership share in basis points (10_000 = 100%). */
  shareBps: number;
}

export interface MeterCardProps {
  meterId: string;
  owner: string;
  active: boolean;
  balance: bigint;
  expiresAt: bigint;
  plan: "Daily" | "Weekly" | "Monthly" | "Usage";
  graceExpiresAt?: bigint | null;
  onDeactivate?: () => void;
  isDeactivating?: boolean;
  /** Optional pre-fetched shareholders; when omitted they are fetched by meterId. */
  shareholders?: MeterShareholder[];
}

const BPS_DENOMINATOR = 10_000;

function formatShare(shareBps: number): string {
  const pct = (shareBps / BPS_DENOMINATOR) * 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}%`;
}

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

const COMMON_EMOJIS = ["☀️", "🏠", "🏬", "⚡", "🔋", "🏭"];

export function MeterCard({
  meterId,
  owner,
  active,
  balance,
  expiresAt,
  plan,
  graceExpiresAt,
  onDeactivate,
  isDeactivating = false,
  shareholders: shareholdersProp,
}: MeterCardProps) {
  const [nickname, setNickname] = useState<string>("");
  const [isEditing, setIsEditing] = useState(false);
  const [tempNickname, setTempNickname] = useState("");
  const [fetchedShareholders, setFetchedShareholders] = useState<MeterShareholder[] | null>(null);
  const [shareholdersLoading, setShareholdersLoading] = useState(false);
  const [shareholdersError, setShareholdersError] = useState(false);

  useEffect(() => {
    if (shareholdersProp) return;

    let cancelled = false;
    const controller = new AbortController();

    async function loadShareholders() {
      setShareholdersLoading(true);
      setShareholdersError(false);
      try {
        const res = await fetch(`/api/meters/${encodeURIComponent(meterId)}/shareholders`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Failed to load shareholders: ${res.status}`);
        const data = await res.json();
        const list: MeterShareholder[] = Array.isArray(data)
          ? data
          : Array.isArray(data?.shareholders)
            ? data.shareholders
            : [];
        if (!cancelled) setFetchedShareholders(list);
      } catch (err) {
        if (!cancelled && (err as Error)?.name !== "AbortError") {
          setShareholdersError(true);
        }
      } finally {
        if (!cancelled) setShareholdersLoading(false);
      }
    }

    loadShareholders();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [meterId, shareholdersProp]);

  const shareholders = shareholdersProp ?? fetchedShareholders ?? [];
  const isCoOwned = shareholders.length > 1;
  const totalShareBps = shareholders.reduce((sum, s) => sum + (s.shareBps || 0), 0);

  // Lifecycle tracking state
  const [lifecycle, setLifecycle] = useState<MeterLifecycle | null>(null);
  const [materials, setMaterials] = useState<MeterMaterial[]>([]);
  const [lifecycleEvents, setLifecycleEvents] = useState<MeterLifecycleEvent[]>([]);
  const [recycling, setRecycling] = useState<RecyclingCertification | null>(null);
  const [recovery, setRecovery] = useState<MaterialRecovery | null>(null);
  const [compliance, setCompliance] = useState<CircularEconomyCompliance | null>(null);
  const [lifecycleLoading, setLifecycleLoading] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [showLifecycle, setShowLifecycle] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(`meter_nickname_${meterId}`);
      if (saved) {
        setNickname(saved);
        setTempNickname(saved);
      }
    } catch {
      // LocalStorage might be unavailable
    }
  }, [meterId]);

  useEffect(() => {
    let cancelled = false;

    async function loadLifecycle() {
      setLifecycleLoading(true);
      setLifecycleError(null);
      try {
        const [lc, mats, events, cert, rec, comp] = await Promise.all([
          getMeterLifecycle(meterId),
          getMeterMaterials(meterId),
          getMeterLifecycleEvents(meterId),
          getRecyclingCertification(meterId),
          getMaterialRecovery(meterId),
          getCircularEconomyCompliance(meterId),
        ]);
        if (cancelled) return;
        setLifecycle(lc);
        setMaterials(mats);
        setLifecycleEvents(events);
        setRecycling(cert);
        setRecovery(rec);
        setCompliance(comp);
      } catch (err) {
        if (cancelled) return;
        setLifecycleError(
          err instanceof Error ? err.message : "Failed to load lifecycle data"
        );
      } finally {
        if (!cancelled) setLifecycleLoading(false);
      }
    }

    loadLifecycle();
    return () => {
      cancelled = true;
    };
  }, [meterId]);

  const handleSaveNickname = () => {
    const trimmed = tempNickname.trim().slice(0, 30);
    setNickname(trimmed);
    setIsEditing(false);
    try {
      if (trimmed) {
        localStorage.setItem(`meter_nickname_${meterId}`, trimmed);
      } else {
        localStorage.removeItem(`meter_nickname_${meterId}`);
      }
    } catch {
      // Ignore storage errors
    }
  };

  const handleCancelNickname = () => {
    setTempNickname(nickname);
    setIsEditing(false);
  };

  const expiresAtNum = Number(expiresAt);

  // Calculate days left
  const daysLeft = Math.max(0, Math.ceil((expiresAtNum * 1000 - Date.now()) / 86_400_000));

  // Convert stroops to XLM (1 XLM = 10,000,000 stroops)
  const balanceXlm = formatXLM(balance);

  const isExpired =
    expiresAtNum !== Number.MAX_SAFE_INTEGER &&
    expiresAtNum > 0 &&
    Date.now() / 1000 >= expiresAtNum;
  const statusActive = active && !isExpired;

  return (
    <div
      className="rounded-xl border border-white/10 bg-solar-accent p-5 transition hover:border-white/20"
      aria-label={`Meter ${nickname || meterId} (${owner.slice(0, 8)}...${owner.slice(-8)})`}
    >
      {/* Header: Nickname / Meter ID and Status Badge */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex-1 min-w-0">
          {nickname ? (
            <>
              <div className="flex items-center gap-1.5 group">
                <h3 className="font-semibold text-white text-base truncate">{nickname}</h3>
                {!isEditing && (
                  <button
                    onClick={() => {
                      setTempNickname(nickname);
                      setIsEditing(true);
                    }}
                    className="text-gray-400 hover:text-solar-yellow text-xs opacity-70 group-hover:opacity-100 transition"
                    title="Edit nickname"
                    aria-label="Edit nickname"
                  >
                    ✏️
                  </button>
                )}
              </div>
              <p className="font-mono text-xs text-gray-400 truncate mt-0.5">{meterId}</p>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <h3 className="font-mono text-sm font-semibold text-white truncate">{meterId}</h3>
              {!isEditing && (
                <button
                  onClick={() => {
                    setTempNickname("");
                    setIsEditing(true);
                  }}
                  className="text-xs text-gray-400 hover:text-solar-yellow underline transition"
                >
                  Set nickname
                </button>
              )}
            </div>
          )}
          <p className="text-xs text-gray-500 truncate mt-1">
            {owner.slice(0, 8)}...{owner.slice(-8)}
          </p>
        </div>
        <MeterStatusBadge
          active={active}
          expiresAt={expiresAtNum}
          graceExpiresAt={graceExpiresAt ? Number(graceExpiresAt) : undefined}
        />
      </div>

      {/* Grace period warning */}
      {graceExpiresAt && Number(graceExpiresAt) * 1000 > Date.now() && (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-950/40 p-3 text-amber-300 text-xs flex items-start gap-2">
          <span className="mt-0.5">⚠️</span>
          <p>
            Meter is in <strong>grace period</strong> until{" "}
            {new Date(Number(graceExpiresAt) * 1000).toLocaleTimeString()}. Top up your balance to avoid disconnection!
          </p>
        </div>
      )}

      {/* Nickname Editor */}
      {isEditing && (
        <div className="mb-4 rounded-lg bg-solar-dark/50 border border-white/10 p-3 space-y-2">
          <label className="text-xs text-gray-400 block">Set nickname (max 30 chars)</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              maxLength={30}
              value={tempNickname}
              onChange={(e) => setTempNickname(e.target.value)}
              placeholder="e.g. Home Solar ☀️"
              className="flex-1 rounded border border-white/20 bg-solar-dark px-2.5 py-1 text-xs text-white placeholder-gray-500 focus:border-solar-yellow focus:outline-none"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveNickname();
                if (e.key === "Escape") handleCancelNickname();
              }}
            />
            <button
              onClick={handleSaveNickname}
              className="rounded bg-solar-yellow px-2.5 py-1 text-xs font-semibold text-solar-dark hover:opacity-90 transition"
            >
              Save
            </button>
            <button
              onClick={handleCancelNickname}
              className="rounded border border-white/20 px-2 py-1 text-xs text-gray-400 hover:text-white transition"
            >
              Cancel
            </button>
          </div>
          {/* Quick Emoji Picker */}
          <div className="flex items-center gap-1.5 pt-1">
            <span className="text-[10px] text-gray-500">Quick emojis:</span>
            {COMMON_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  if (tempNickname.length + emoji.length <= 30) {
                    setTempNickname((prev) => (prev ? `${prev} ${emoji}` : emoji).slice(0, 30));
                  }
                }}
                className="rounded px-1.5 py-0.5 text-xs hover:bg-white/10 transition"
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Balance */}
      <div className="mb-4">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Balance</p>
        <p className="text-lg font-bold text-white">
          {balanceXlm} <span className="text-sm text-gray-400">XLM</span>
        </p>
      </div>

      {/* Co-owners */}
      {shareholdersLoading && !shareholdersProp && (
        <div className="mb-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Co-owners</p>
          <p className="text-xs text-gray-500">Loading shareholders…</p>
        </div>
      )}

      {shareholdersError && !shareholdersProp && (
        <div className="mb-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Co-owners</p>
          <p className="text-xs text-red-400">Unable to load shareholders.</p>
        </div>
      )}

      {isCoOwned && (
        <div className="mb-4 rounded-lg border border-white/10 bg-solar-dark/40 p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Co-owners</p>
            <span className="text-[10px] text-gray-500">
              {shareholders.length} owners · {formatShare(totalShareBps)} allocated
            </span>
          </div>
          <ul className="space-y-1.5">
            {shareholders.map((s) => {
              const isPrimary = s.address === owner;
              return (
                <li
                  key={s.address}
                  className="flex items-center justify-between gap-2 text-xs"
                  title={s.address}
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="font-mono text-gray-300 truncate">{shortenAddress(s.address)}</span>
                    {isPrimary && (
                      <span className="rounded bg-solar-yellow/20 px-1 py-0.5 text-[10px] font-semibold text-solar-yellow">
                        Primary
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-gray-400">{formatShare(s.shareBps)}</span>
                    <span className="h-1.5 w-12 overflow-hidden rounded-full bg-white/10">
                      <span
                        className="block h-full rounded-full bg-solar-yellow"
                        style={{ width: `${Math.min(100, (s.shareBps / BPS_DENOMINATOR) * 100)}%` }}
                      />
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Plan and Expiry */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Plan</p>
          <p className="text-sm font-medium text-white">{plan}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Expiry</p>
          <p
            className={`text-sm font-medium ${
              daysLeft === 0 ? "text-red-400" : daysLeft <= 7 ? "text-yellow-400" : "text-green-400"
            }`}
          >
            {expiresAtNum === Number.MAX_SAFE_INTEGER ? "Never" : `${daysLeft}d left`}
          </p>
        </div>
      </div>

      {/* Deactivate Button */}
      {active && !isExpired && onDeactivate && (
        <button
          onClick={onDeactivate}
          disabled={isDeactivating}
          className="w-full rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-400 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          {isDeactivating ? "Deactivating…" : "Deactivate Meter"}
        </button>
      )}

      {/* Print Report Link */}
      <Link
        href={`/meters/${meterId}/report`}
        className="block w-full rounded-lg border border-solar-yellow/30 bg-solar-yellow/10 px-3 py-2 text-xs font-semibold text-solar-yellow hover:bg-solar-yellow/20 transition text-center mt-2"
      >
        Print Report
      </Link>

      {/* Lifecycle Visualization */}
      <div className="mt-4 border-t border-white/10 pt-3">
        <button
          onClick={() => setShowLifecycle((prev) => !prev)}
          className="flex w-full items-center justify-between text-xs font-semibold text-gray-300 hover:text-white transition"
          aria-expanded={showLifecycle}
          aria-controls={`lifecycle-${meterId}`}
        >
          <span className="flex items-center gap-1.5">
            ♻️ Lifecycle &amp; Circular Economy
            {compliance && (
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  compliance.compliant
                    ? "bg-green-500/15 text-green-400 border border-green-500/30"
                    : "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                }`}
                title={compliance.details}
              >
                {compliance.compliant ? "Compliant" : "Non-compliant"}
              </span>
            )}
          </span>
          <span className="text-gray-500">{showLifecycle ? "▲" : "▼"}</span>
        </button>

        {showLifecycle && (
          <div id={`lifecycle-${meterId}`} className="mt-3 space-y-4">
            {lifecycleLoading && (
              <p className="text-xs text-gray-400">Loading lifecycle data…</p>
            )}

            {lifecycleError && !lifecycleLoading && (
              <p className="text-xs text-red-400">{lifecycleError}</p>
            )}

            {!lifecycleLoading && !lifecycleError && (
              <>
                {/* Manufacturing origin and materials */}
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
                    Manufacturing Origin
                  </p>
                  {lifecycle ? (
                    <div className="rounded-lg bg-solar-dark/50 border border-white/10 p-2.5 text-xs text-gray-300 space-y-1">
                      <p>
                        <span className="text-gray-500">Manufacturer:</span>{" "}
                        {lifecycle.manufacturer}
                      </p>
                      <p>
                        <span className="text-gray-500">Origin:</span>{" "}
                        {lifecycle.origin}
                      </p>
                      <p>
                        <span className="text-gray-500">Manufactured:</span>{" "}
                        {new Date(lifecycle.manufacturedAt * 1000).toLocaleDateString()}
                      </p>
                      {lifecycle.serialNumber && (
                        <p>
                          <span className="text-gray-500">Serial:</span>{" "}
                          <span className="font-mono">{lifecycle.serialNumber}</span>
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-gray-500">No manufacturing data recorded.</p>
                  )}

                  {materials.length > 0 && (
                    <div className="mt-2">
                      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
                        Materials
                      </p>
                      <ul className="space-y-1">
                        {materials.map((m, i) => (
                          <li
                            key={`${m.name}-${i}`}
                            className="flex items-center justify-between rounded bg-solar-dark/50 border border-white/10 px-2.5 py-1 text-xs text-gray-300"
                          >
                            <span>{m.name}</span>
                            <span className="text-gray-400">
                              {m.amount} {m.unit}
                              {m.recyclable && (
                                <span className="ml-1.5 text-green-400" title="Recyclable">
                                  ♻️
                                </span>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {/* Lifecycle event timeline */}
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
                    Lifecycle Timeline
                  </p>
                  {lifecycleEvents.length > 0 ? (
                    <ol className="relative border-l border-white/15 ml-1.5 space-y-2.5">
                      {lifecycleEvents.map((ev, i) => (
                        <li key={`${ev.eventType}-${ev.timestamp}-${i}`} className="ml-3">
                          <span className="absolute -left-[5px] mt-1 h-2 w-2 rounded-full bg-solar-yellow" />
                          <p className="text-xs font-medium text-white capitalize">
                            {ev.eventType}
                          </p>
                          <p className="text-[10px] text-gray-500">
                            {new Date(ev.timestamp * 1000).toLocaleString()}
                          </p>
                          {ev.description && (
                            <p className="text-[10px] text-gray-400">{ev.description}</p>
                          )}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-xs text-gray-500">No lifecycle events recorded.</p>
                  )}
                </div>

                {/* Recycling certification */}
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
                    Recycling Certification
                  </p>
                  {recycling ? (
                    <div className="rounded-lg bg-solar-dark/50 border border-white/10 p-2.5 text-xs text-gray-300 space-y-1">
                      <p className="flex items-center gap-1.5">
                        <span
                          className={
                            recycling.certified ? "text-green-400" : "text-amber-400"
                          }
                        >
                          {recycling.certified ? "✅ Certified" : "⏳ Pending"}
                        </span>
                      </p>
                      {recycling.certifier && (
                        <p>
                          <span className="text-gray-500">Certifier:</span>{" "}
                          {recycling.certifier}
                        </p>
                      )}
                      {recycling.certificateId && (
                        <p>
                          <span className="text-gray-500">Certificate:</span>{" "}
                          <span className="font-mono">{recycling.certificateId}</span>
                        </p>
                      )}
                      {recycling.certifiedAt > 0 && (
                        <p>
                          <span className="text-gray-500">Certified:</span>{" "}
                          {new Date(recycling.certifiedAt * 1000).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-gray-500">Not yet recycled.</p>
                  )}
                </div>

                {/* Material recovery */}
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
                    Material Recovery
                  </p>
                  {recovery && recovery.items.length > 0 ? (
                    <div className="rounded-lg bg-solar-dark/50 border border-white/10 p-2.5 text-xs text-gray-300 space-y-1">
                      {recovery.items.map((item, i) => (
                        <p key={`${item.material}-${i}`} className="flex justify-between">
                          <span>{item.material}</span>
                          <span className="text-gray-400">
                            {item.recovered} / {item.total} {item.unit}
                          </span>
                        </p>
                      ))}
                      <p className="pt-1 border-t border-white/10 text-gray-400">
                        Recovery rate:{" "}
                        <span className="text-green-400 font-semibold">
                          {recovery.recoveryRate}%
                        </span>
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-gray-500">No material recovery recorded.</p>
                  )}
                </div>

                {/* Compliance badge */}
                {compliance && (
                  <div
                    className={`rounded-lg border p-2.5 text-xs ${
                      compliance.compliant
                        ? "border-green-500/30 bg-green-500/10 text-green-300"
                        : "border-amber-500/30 bg-amber-500/10 text-amber-300"
                    }`}
                  >
                    <p className="font-semibold">
                      {compliance.compliant
                        ? "✅ Circular Economy Compliant"
                        : "⚠️ Circular Economy Non-compliant"}
                    </p>
                    {compliance.details && (
                      <p className="mt-0.5 text-[10px] opacity-80">{compliance.details}</p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
