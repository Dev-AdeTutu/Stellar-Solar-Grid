export const NOMINAL_FREQUENCY_HZ = 50;
export const DEFAULT_DEVIATION_THRESHOLD_HZ = 0.2;
export type FrequencyReading = { meterId: string; frequencyHz: number; loadKw: number; recordedAt: string; deviationHz: number; responseKw: number };
export type GridServiceProvided = { id: string; meterId: string; frequencyHz: number; responseKw: number; durationSeconds: number; contributionKwh: number; revenueXlm: number; recordedAt: string };
const readings = new Map<string, FrequencyReading>();
const contributions: GridServiceProvided[] = [];
let relaySender: ((meterId: string, command: "ON" | "OFF", source: string) => boolean) | undefined;
let eventSeq = 1;
export function setFrequencyRelaySender(sender: (meterId: string, command: "ON" | "OFF", source: string) => boolean) { relaySender = sender; }
function round(value: number, places = 4) { return Number(value.toFixed(places)); }
function assertFinite(value: number, name: string) { if (!Number.isFinite(value) || value < 0) throw Object.assign(new Error(`${name} must be a non-negative number`), { code: "VALIDATION_ERROR" }); }
export function recordFrequencyReading(input: { meterId: string; frequencyHz: number; loadKw: number; thresholdHz?: number; recordedAt?: Date; responseRatio?: number }): FrequencyReading {
  if (!input.meterId?.trim()) throw Object.assign(new Error("meterId is required"), { code: "VALIDATION_ERROR" });
  if (!Number.isFinite(input.frequencyHz) || input.frequencyHz < 45 || input.frequencyHz > 55) throw Object.assign(new Error("frequencyHz must be between 45 and 55"), { code: "VALIDATION_ERROR" });
  assertFinite(input.loadKw, "loadKw");
  const threshold = input.thresholdHz ?? DEFAULT_DEVIATION_THRESHOLD_HZ;
  const ratio = input.responseRatio ?? 0.25;
  if (threshold <= 0 || ratio <= 0 || ratio > 1) throw Object.assign(new Error("thresholdHz and responseRatio are invalid"), { code: "VALIDATION_ERROR" });
  const deviationHz = round(input.frequencyHz - NOMINAL_FREQUENCY_HZ);
  const responseKw = Math.abs(deviationHz) >= threshold ? round(input.loadKw * ratio) : 0;
  const reading: FrequencyReading = { meterId: input.meterId, frequencyHz: input.frequencyHz, loadKw: input.loadKw, recordedAt: (input.recordedAt ?? new Date()).toISOString(), deviationHz, responseKw };
  readings.set(input.meterId, reading);
  if (responseKw > 0) relaySender?.(input.meterId, deviationHz < 0 ? "OFF" : "ON", "frequency-regulation");
  return reading;
}
export function recordGridServiceProvided(input: { meterId: string; durationSeconds: number; priceXlmPerKwh?: number; recordedAt?: Date }): GridServiceProvided {
  const reading = readings.get(input.meterId);
  if (!reading) throw Object.assign(new Error("No frequency reading for meter"), { code: "NOT_FOUND" });
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) throw Object.assign(new Error("durationSeconds must be positive"), { code: "VALIDATION_ERROR" });
  const contributionKwh = round(reading.responseKw * input.durationSeconds / 3600);
  const revenueXlm = round(contributionKwh * (input.priceXlmPerKwh ?? 0.2));
  const event: GridServiceProvided = { id: `GSP-${Date.now()}-${eventSeq++}`, meterId: input.meterId, frequencyHz: reading.frequencyHz, responseKw: reading.responseKw, durationSeconds: input.durationSeconds, contributionKwh, revenueXlm, recordedAt: (input.recordedAt ?? new Date()).toISOString() };
  contributions.push(event);
  return event;
}
export function getFrequencyReading(meterId: string) { return readings.get(meterId); }
export function listGridServiceContributions(meterId?: string) { return contributions.filter((event) => !meterId || event.meterId === meterId); }
export function getMeterGridServiceSummary(meterId: string) { const events = listGridServiceContributions(meterId); return { meterId, contributionKwh: round(events.reduce((sum, e) => sum + e.contributionKwh, 0)), revenueXlm: round(events.reduce((sum, e) => sum + e.revenueXlm, 0)), events }; }
export function resetFrequencyRegulationForTests() { readings.clear(); contributions.length = 0; eventSeq = 1; }
