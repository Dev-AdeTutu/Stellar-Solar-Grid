/**
 * Meter configuration backup & restore (#1055).
 *
 * Meters push their configuration periodically; each distinct config becomes a
 * new immutable version (identical pushes are deduplicated by content hash).
 * Any version — or a named template — can be restored onto a replacement meter.
 */
import { createHash } from "node:crypto";

export type MeterConfig = Record<string, unknown>;
export type ConfigVersion = {
  meterId: string;
  version: number;
  hash: string;
  config: MeterConfig;
  source: "backup" | "restore" | "template";
  note?: string;
  createdAt: string;
};
export type ConfigTemplate = { name: string; description?: string; config: MeterConfig; createdAt: string };

const MAX_VERSIONS = Number(process.env.METER_CONFIG_MAX_VERSIONS ?? 50);
const versions = new Map<string, ConfigVersion[]>();
const templates = new Map<string, ConfigTemplate>();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const configHash = (config: MeterConfig) => createHash("sha256").update(canonical(config)).digest("hex");

function append(meterId: string, config: MeterConfig, source: ConfigVersion["source"], note?: string): ConfigVersion {
  const list = versions.get(meterId) ?? [];
  const hash = configHash(config);
  const latest = list[list.length - 1];
  if (latest && latest.hash === hash && source === "backup") return latest;
  const entry: ConfigVersion = {
    meterId,
    version: (latest?.version ?? 0) + 1,
    hash,
    config: structuredClone(config),
    source,
    note,
    createdAt: new Date().toISOString(),
  };
  list.push(entry);
  if (list.length > MAX_VERSIONS) list.shift();
  versions.set(meterId, list);
  return entry;
}

export const backupConfig = (meterId: string, config: MeterConfig, note?: string) => append(meterId, config, "backup", note);

export const listVersions = (meterId: string) => versions.get(meterId) ?? [];

export function getVersion(meterId: string, version?: number): ConfigVersion | undefined {
  const list = listVersions(meterId);
  return version === undefined ? list[list.length - 1] : list.find((v) => v.version === version);
}

/** Copy a source meter's config (latest or given version) onto a target meter. */
export function restoreConfig(targetMeterId: string, sourceMeterId: string, version?: number): ConfigVersion {
  const src = getVersion(sourceMeterId, version);
  if (!src) throw new Error("Source config version not found");
  return append(targetMeterId, src.config, "restore", `restored from ${sourceMeterId}@v${src.version}`);
}

export function saveTemplate(name: string, config: MeterConfig, description?: string): ConfigTemplate {
  const t = { name, description, config: structuredClone(config), createdAt: new Date().toISOString() };
  templates.set(name, t);
  return t;
}

export const listTemplates = () => [...templates.values()];

/** Apply a template, with optional per-meter overrides (e.g. location, tariff zone). */
export function applyTemplate(meterId: string, name: string, overrides: MeterConfig = {}): ConfigVersion {
  const t = templates.get(name);
  if (!t) throw new Error("Template not found");
  return append(meterId, { ...t.config, ...overrides }, "template", `template ${name}`);
}

/** Test helper. */
export function resetConfigBackups(): void {
  versions.clear();
  templates.clear();
}
