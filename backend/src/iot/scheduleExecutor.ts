/**
 * Scheduled energy usage executor (Issue #1001).
 *
 * Mirrors limitWatcher.ts's polling pattern: on a timer, evaluate every
 * registered circuit's on-chain `Schedule` (and any active emergency
 * `CircuitOverride`, which always wins) and relay the resulting ON/OFF state
 * to the device.
 *
 * A "circuit" here is any device in the device registry that is linked to a
 * meter (`device.meterId`) — the same id space the frontend schedules page
 * uses as `circuit_id` when calling `set_circuit_schedule`. Devices with no
 * schedule configured simply have nothing to evaluate and are skipped.
 *
 * The relay command itself is sent at the meter's MQTT control topic (the
 * same topic contract-driven activate/deactivate events use) tagged with the
 * device id, since the physical bridge in this repo addresses relays per
 * meter rather than per sub-circuit.
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import { StellarService } from "../lib/stellar.js";
import { logger } from "../lib/logger.js";
import { listDevices } from "../lib/deviceRegistry.js";
import { sendRelayCommand } from "./bridge.js";

// Executor initialization guard to prevent duplicate startup (same pattern
// as limitWatcher.ts / bridge.ts).
let executorStarted = false;

// Last relay state we observed/sent per circuit, so we only act (and only
// ask the contract to emit ScheduledActionExecuted) on an actual transition.
const lastCircuitState = new Map<string, boolean>();

function circuitKey(meterId: string, circuitId: string): string {
  return `${meterId}:${circuitId}`;
}

/**
 * Evaluate the due schedule/override for one circuit and relay a command if
 * its desired state changed since the last check.
 */
export async function evaluateCircuit(
  stellar: StellarService,
  meterId: string,
  circuitId: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<boolean | null> {
  let desired: boolean;
  try {
    const raw = await stellar.query("circuit_should_be_on", [
      StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
      StellarSdk.nativeToScVal(circuitId, { type: "symbol" }),
      StellarSdk.nativeToScVal(now, { type: "u64" }),
    ]);
    desired = Boolean(StellarSdk.scValToNative(raw));
  } catch {
    // No schedule and no override configured for this circuit — nothing to do.
    return null;
  }

  const key = circuitKey(meterId, circuitId);
  const lastState = lastCircuitState.get(key) ?? false;
  if (desired === lastState) {
    return desired;
  }

  try {
    // Submitted (not simulated) so the contract's ScheduledActionExecuted
    // event actually lands on-chain for the event listener to pick up.
    await stellar.invoke("execute_scheduled_action", [
      StellarSdk.nativeToScVal(meterId, { type: "symbol" }),
      StellarSdk.nativeToScVal(circuitId, { type: "symbol" }),
      StellarSdk.nativeToScVal(now, { type: "u64" }),
      StellarSdk.nativeToScVal(lastState, { type: "bool" }),
    ]);
  } catch (err) {
    logger.error({ meterId, circuitId, err }, "Failed to record scheduled action on-chain");
  }

  const sent = sendRelayCommand(meterId, desired ? "ON" : "OFF", `schedule:${circuitId}`);
  logger.info(
    { meterId, circuitId, desired, sent },
    "Scheduled action executed",
  );
  lastCircuitState.set(key, desired);
  return desired;
}

/** One sweep over every meter-linked device, evaluating its circuit schedule. */
export async function runScheduleSweep(stellar: StellarService): Promise<void> {
  try {
    const devices = listDevices({ limit: 1000 }).filter((d) => d.meterId);
    for (const device of devices) {
      if (!device.meterId) continue;
      await evaluateCircuit(stellar, device.meterId, device.id).catch((err) => {
        logger.error({ deviceId: device.id, err }, "Schedule evaluation failed");
      });
    }
  } catch (err) {
    logger.error("Schedule sweep error", { err });
  }
}

export function startScheduleExecutor(stellar: StellarService) {
  if (executorStarted) {
    logger.warn("Schedule executor already started, skipping duplicate initialization");
    return;
  }
  executorStarted = true;
  const intervalMs = Number(process.env.SCHEDULE_EXECUTOR_INTERVAL_MS ?? 60 * 1000);
  setInterval(() => runScheduleSweep(stellar), intervalMs);
}
