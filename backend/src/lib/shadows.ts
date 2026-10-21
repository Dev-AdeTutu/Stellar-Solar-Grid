/**
 * Meter device shadows (#1081). See backend/SHADOWS.md.
 *
 * Each meter keeps a `desired` state (written by the backend/users) and a
 * `reported` state (written by the device). While the device is offline the
 * desired changes accumulate; when it reconnects `syncOnConnect` returns the
 * delta to push. Conflicts are resolved per key using versioned timestamps.
 */

export type ShadowState = Record<string, unknown>;
export type ConflictStrategy = "desired_wins" | "reported_wins" | "latest_wins";

interface KeyMeta {
  updatedAt: number;
}

export interface Shadow {
  meterId: string;
  desired: ShadowState;
  reported: ShadowState;
  desiredMeta: Record<string, KeyMeta>;
  reportedMeta: Record<string, KeyMeta>;
  version: number;
  online: boolean;
  lastSeenAt: string | null;
}

export interface ShadowHistoryEntry {
  version: number;
  at: string;
  source: "desired" | "reported" | "sync" | "conflict";
  changes: ShadowState;
  note?: string;
}

const shadows = new Map<string, Shadow>();
const history = new Map<string, ShadowHistoryEntry[]>();
const MAX_HISTORY = 500;

export function getShadow(meterId: string): Shadow {
  let s = shadows.get(meterId);
  if (!s) {
    s = { meterId, desired: {}, reported: {}, desiredMeta: {}, reportedMeta: {}, version: 0, online: false, lastSeenAt: null };
    shadows.set(meterId, s);
  }
  return s;
}

function log(meterId: string, entry: Omit<ShadowHistoryEntry, "version">): void {
  const s = getShadow(meterId);
  s.version += 1;
  const list = history.get(meterId) ?? [];
  list.push({ version: s.version, ...entry });
  if (list.length > MAX_HISTORY) list.shift();
  history.set(meterId, list);
}

function apply(target: ShadowState, meta: Record<string, KeyMeta>, patch: ShadowState, now: number): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete target[k];
      delete meta[k];
    } else {
      target[k] = v;
      meta[k] = { updatedAt: now };
    }
  }
}

/** Keys where desired differs from reported. */
export function delta(meterId: string): ShadowState {
  const s = getShadow(meterId);
  const out: ShadowState = {};
  for (const [k, v] of Object.entries(s.desired)) {
    if (JSON.stringify(v) !== JSON.stringify(s.reported[k])) out[k] = v;
  }
  return out;
}

export function updateDesired(meterId: string, patch: ShadowState, now = Date.now()) {
  const s = getShadow(meterId);
  apply(s.desired, s.desiredMeta, patch, now);
  log(meterId, { at: new Date(now).toISOString(), source: "desired", changes: patch });
  return { shadow: s, delta: delta(meterId), pending: !s.online };
}

/**
 * Device reports its state. A reported key that differs from a desired key is a
 * conflict; it is resolved using `strategy`:
 *   - desired_wins  — keep desired, device must converge (default)
 *   - reported_wins — adopt the device value into desired (e.g. manual override at the meter)
 *   - latest_wins   — whichever side was written most recently wins
 */
export function updateReported(meterId: string, patch: ShadowState, strategy: ConflictStrategy = "desired_wins", now = Date.now()) {
  const s = getShadow(meterId);
  apply(s.reported, s.reportedMeta, patch, now);
  s.online = true;
  s.lastSeenAt = new Date(now).toISOString();
  log(meterId, { at: s.lastSeenAt, source: "reported", changes: patch });
  const conflicts = resolveConflicts(meterId, Object.keys(patch), strategy, now);
  return { shadow: s, delta: delta(meterId), conflicts };
}

function resolveConflicts(meterId: string, keys: string[], strategy: ConflictStrategy, now: number) {
  const s = getShadow(meterId);
  const resolved: { key: string; desired: unknown; reported: unknown; winner: "desired" | "reported" }[] = [];
  for (const k of keys) {
    if (!(k in s.desired) || JSON.stringify(s.desired[k]) === JSON.stringify(s.reported[k])) continue;
    const reportedNewer = (s.reportedMeta[k]?.updatedAt ?? 0) > (s.desiredMeta[k]?.updatedAt ?? 0);
    const winner = strategy === "reported_wins" || (strategy === "latest_wins" && reportedNewer) ? "reported" : "desired";
    resolved.push({ key: k, desired: s.desired[k], reported: s.reported[k], winner });
    if (winner === "reported") {
      s.desired[k] = s.reported[k];
      s.desiredMeta[k] = { updatedAt: now };
    }
  }
  if (resolved.length) {
    log(meterId, { at: new Date(now).toISOString(), source: "conflict", changes: Object.fromEntries(resolved.map((r) => [r.key, r.winner === "desired" ? r.desired : r.reported])), note: `strategy=${strategy}` });
  }
  return resolved;
}

/** Called when a meter comes online: returns the desired delta to push to the device. */
export function syncOnConnect(meterId: string, now = Date.now()) {
  const s = getShadow(meterId);
  s.online = true;
  s.lastSeenAt = new Date(now).toISOString();
  const d = delta(meterId);
  log(meterId, { at: s.lastSeenAt, source: "sync", changes: d, note: `${Object.keys(d).length} pending key(s) pushed` });
  return { meterId, delta: d, version: s.version };
}

export function markOffline(meterId: string): void {
  getShadow(meterId).online = false;
}

export function getHistory(meterId: string, limit = 100): ShadowHistoryEntry[] {
  return (history.get(meterId) ?? []).slice(-limit).reverse();
}

export function _resetShadows(): void {
  shadows.clear();
  history.clear();
}
