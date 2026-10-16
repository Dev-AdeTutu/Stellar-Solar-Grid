/**
 * Meter lifespan & depreciation tracking for asset management (#998).
 *
 * A meter's installation date and expected lifespan (default 15 years) are
 * recorded once; age, remaining lifespan and straight-line depreciation are
 * then derived on read. Meters within ASSET_END_OF_LIFE_WARNING_YEARS of the
 * end of their expected life are flagged so a provider can plan replacements.
 */
import path from "node:path";
import Database from "better-sqlite3";
import { registerDatabase } from "./databaseLifecycle.js";
import { logger } from "./logger.js";

const DB_PATH = process.env.METER_DEPRECIATION_DB_PATH ?? path.resolve(process.cwd(), "data", "meter-depreciation.sqlite");
const DEFAULT_LIFESPAN_YEARS = Number(process.env.METER_DEFAULT_LIFESPAN_YEARS ?? 15);
const END_OF_LIFE_WARNING_YEARS = Number(process.env.METER_END_OF_LIFE_WARNING_YEARS ?? 1);
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

export type MeterAsset = {
  meterId: string;
  installedAt: string;
  expectedLifespanYears: number;
  /** Original cost in stroops, used to compute the depreciated book value; null when unknown. */
  purchaseCostStroops: number | null;
  createdAt: string;
  updatedAt: string;
};

export type AssetInfo = MeterAsset & {
  ageYears: number;
  remainingYears: number;
  depreciationPercent: number;
  bookValueStroops: number | null;
  endOfLifeAt: string;
  nearEndOfLife: boolean;
};

type Db = InstanceType<typeof Database>;
let database: Db | undefined;

function db(): Db {
  if (!database) {
    database = new Database(DB_PATH);
    database.pragma("journal_mode = WAL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS meter_assets (
        meter_id TEXT PRIMARY KEY,
        installed_at TEXT NOT NULL,
        expected_lifespan_years REAL NOT NULL,
        purchase_cost_stroops INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }
  return database;
}

registerDatabase("meter-depreciation", () => {
  database?.close();
  database = undefined;
});

type AssetRow = {
  meter_id: string; installed_at: string; expected_lifespan_years: number;
  purchase_cost_stroops: number | null; created_at: string; updated_at: string;
};

const toAsset = (r: AssetRow): MeterAsset => ({
  meterId: r.meter_id,
  installedAt: r.installed_at,
  expectedLifespanYears: r.expected_lifespan_years,
  purchaseCostStroops: r.purchase_cost_stroops,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Register (or update) a meter's installation date, expected lifespan and optional purchase cost. */
export function registerMeterAsset(input: {
  meterId: string;
  installedAt?: string;
  expectedLifespanYears?: number;
  purchaseCostStroops?: number | null;
}): MeterAsset {
  const existing = getMeterAsset(input.meterId);
  const now = new Date().toISOString();
  const next = {
    meterId: input.meterId,
    installedAt: input.installedAt ?? existing?.installedAt ?? now,
    expectedLifespanYears: input.expectedLifespanYears ?? existing?.expectedLifespanYears ?? DEFAULT_LIFESPAN_YEARS,
    purchaseCostStroops: input.purchaseCostStroops !== undefined ? input.purchaseCostStroops : existing?.purchaseCostStroops ?? null,
  };
  db().prepare(
    `INSERT INTO meter_assets (meter_id, installed_at, expected_lifespan_years, purchase_cost_stroops, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(meter_id) DO UPDATE SET installed_at = excluded.installed_at,
       expected_lifespan_years = excluded.expected_lifespan_years,
       purchase_cost_stroops = excluded.purchase_cost_stroops, updated_at = excluded.updated_at`,
  ).run(next.meterId, next.installedAt, next.expectedLifespanYears, next.purchaseCostStroops, existing?.createdAt ?? now, now);
  return getMeterAsset(next.meterId)!;
}

export function getMeterAsset(meterId: string): MeterAsset | undefined {
  const row = db().prepare("SELECT * FROM meter_assets WHERE meter_id = ?").get(meterId) as AssetRow | undefined;
  return row ? toAsset(row) : undefined;
}

export function listMeterAssets(): MeterAsset[] {
  return (db().prepare("SELECT * FROM meter_assets").all() as AssetRow[]).map(toAsset);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function toAssetInfo(asset: MeterAsset, now: Date): AssetInfo {
  const ageYears = (now.getTime() - new Date(asset.installedAt).getTime()) / MS_PER_YEAR;
  const remainingYears = asset.expectedLifespanYears - ageYears;
  const depreciationPercent = Math.min(100, Math.max(0, (ageYears / asset.expectedLifespanYears) * 100));
  const bookValueStroops = asset.purchaseCostStroops !== null
    ? Math.max(0, Math.round(asset.purchaseCostStroops * (1 - depreciationPercent / 100)))
    : null;
  return {
    ...asset,
    ageYears: round2(ageYears),
    remainingYears: round2(remainingYears),
    depreciationPercent: round2(depreciationPercent),
    bookValueStroops,
    endOfLifeAt: new Date(new Date(asset.installedAt).getTime() + asset.expectedLifespanYears * MS_PER_YEAR).toISOString(),
    nearEndOfLife: remainingYears <= END_OF_LIFE_WARNING_YEARS,
  };
}

/** Depreciation/lifespan data for one meter, or undefined if it hasn't been registered. */
export function getAssetInfo(meterId: string, now = new Date()): AssetInfo | undefined {
  const asset = getMeterAsset(meterId);
  return asset ? toAssetInfo(asset, now) : undefined;
}

export type AssetReport = {
  meters: number;
  avgAgeYears: number;
  avgDepreciationPercent: number;
  nearEndOfLife: AssetInfo[];
  totalBookValueStroops: number | null;
};

/** Provider-wide asset depreciation report, used for replacement planning and budgeting. */
export function getAssetReport(now = new Date()): AssetReport {
  const infos = listMeterAssets().map((a) => toAssetInfo(a, now));
  const knownCost = infos.filter((i) => i.bookValueStroops !== null);
  return {
    meters: infos.length,
    avgAgeYears: infos.length ? round2(infos.reduce((s, i) => s + i.ageYears, 0) / infos.length) : 0,
    avgDepreciationPercent: infos.length ? round2(infos.reduce((s, i) => s + i.depreciationPercent, 0) / infos.length) : 0,
    nearEndOfLife: infos.filter((i) => i.nearEndOfLife).sort((a, b) => a.remainingYears - b.remainingYears),
    totalBookValueStroops: knownCost.length ? knownCost.reduce((s, i) => s + (i.bookValueStroops ?? 0), 0) : null,
  };
}

/** Log a warning for every meter that has crossed into its end-of-life warning window. Returns their IDs. */
export function checkEndOfLifeMeters(now = new Date()): string[] {
  const flagged = listMeterAssets()
    .map((a) => toAssetInfo(a, now))
    .filter((i) => i.nearEndOfLife);
  for (const info of flagged) {
    logger.warn({ meterId: info.meterId, remainingYears: info.remainingYears }, "Meter approaching end of expected lifespan");
  }
  return flagged.map((i) => i.meterId);
}

let timer: NodeJS.Timeout | undefined;
export function startDepreciationMonitor(intervalMs = 24 * 60 * 60 * 1000): void {
  if (timer) return;
  timer = setInterval(() => checkEndOfLifeMeters(), intervalMs);
  timer.unref?.();
}
