/**
 * Smart Contract Event Replay (#1007)
 *
 * Replays historical contract events across a block (ledger) range,
 * reconstructs contract state at any historical block, and compares
 * current state vs historical state for time-travel debugging and analytics.
 */
import { IndexedEvent, indexManualEvent, queryEventsAsc } from "./eventIndexer.js";

export interface ReplayedMeterState {
  meterId: string;
  owner: string | null;
  active: boolean;
  unitsUsed: number;
  balance: number;
  plan: string;
  lastUpdatedBlock: number;
  lastTxHash: string;
  paymentsCount: number;
  usageEventsCount: number;
  insuranceActive?: boolean;
}

export interface ReplayedContractState {
  atBlock: number;
  fromBlock: number;
  eventsProcessed: number;
  paused: boolean;
  frozen: boolean;
  totalRevenue: number;
  meters: Record<string, ReplayedMeterState>;
  timeline: Array<{
    block: number;
    txHash: string;
    action: string | null;
    subject: string | null;
    summary: string;
  }>;
}

export interface StateDiscrepancy {
  entity: string;
  field: string;
  historicalValue: unknown;
  currentValue: unknown;
  delta?: number;
}

export interface StateComparisonResult {
  historicalBlock: number;
  currentBlock: number;
  historicalState: ReplayedContractState;
  currentState: ReplayedContractState;
  discrepancies: StateDiscrepancy[];
  inSync: boolean;
}

function emptyMeter(meterId: string, block: number, txHash: string): ReplayedMeterState {
  return {
    meterId,
    owner: null,
    active: false,
    unitsUsed: 0,
    balance: 0,
    plan: "Daily",
    lastUpdatedBlock: block,
    lastTxHash: txHash,
    paymentsCount: 0,
    usageEventsCount: 0,
  };
}

function parseNumericAmount(val: unknown): number {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string") {
    const parsed = Number(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (Array.isArray(val)) {
    for (const item of val) {
      if (typeof item === "number" && Number.isFinite(item)) return item;
      if (typeof item === "string" && /^\d+(\.\d+)?$/.test(item)) return Number(item);
    }
  }
  if (val && typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if ("amount" in obj) return parseNumericAmount(obj.amount);
    if ("units" in obj) return parseNumericAmount(obj.units);
    if ("value" in obj) return parseNumericAmount(obj.value);
  }
  return 0;
}

/**
 * Apply a single indexed event to mutate the reconstructed contract state.
 */
export function applyEventToState(state: ReplayedContractState, evt: IndexedEvent): void {
  const action = evt.topic1 ?? evt.topic0 ?? "unknown";
  const subject = evt.subject ?? (typeof evt.value === "string" ? evt.value : null);
  let summary = `Event ${action}`;

  if (action === "pause_on" || action === "Paused") {
    state.paused = true;
    summary = "Contract paused";
  } else if (action === "pause_off" || action === "Unpaused") {
    state.paused = false;
    summary = "Contract unpaused";
  } else if (action === "frz_on") {
    state.frozen = true;
    summary = "Contract frozen";
  } else if (action === "frz_off") {
    state.frozen = false;
    summary = "Contract unfrozen";
  } else if (subject) {
    const meter = state.meters[subject] ?? emptyMeter(subject, evt.ledger, evt.txHash);
    meter.lastUpdatedBlock = evt.ledger;
    meter.lastTxHash = evt.txHash;

    if (action === "mtr_reg" || action === "register") {
      meter.owner = typeof evt.value === "string" ? evt.value : meter.owner ?? "registered_owner";
      summary = `Meter ${subject} registered to ${meter.owner}`;
    } else if (action === "mtr_actv" || action === "activate") {
      meter.active = true;
      summary = `Meter ${subject} activated`;
    } else if (action === "mtr_deact" || action === "deactivate") {
      meter.active = false;
      summary = `Meter ${subject} deactivated`;
    } else if (action === "mtr_xfer" || action === "transfer") {
      if (Array.isArray(evt.value) && evt.value.length >= 2) {
        meter.owner = String(evt.value[1]);
      } else if (typeof evt.value === "string") {
        meter.owner = evt.value;
      }
      summary = `Meter ${subject} transferred to ${meter.owner}`;
    } else if (action === "payment" || action === "AutoTopupTriggered") {
      const amount = parseNumericAmount(evt.value);
      meter.balance += amount;
      meter.active = true;
      meter.paymentsCount += 1;
      state.totalRevenue += amount;
      if (Array.isArray(evt.value) && evt.value.length >= 4 && typeof evt.value[3] === "string") {
        meter.plan = evt.value[3];
      }
      summary = `Payment of ${amount} recorded for meter ${subject}`;
    } else if (action === "usage" || action === "usage_rec" || action === "mtr_usage") {
      const units = parseNumericAmount(evt.value);
      meter.unitsUsed += units;
      meter.balance = Math.max(0, meter.balance - units);
      meter.usageEventsCount += 1;
      summary = `Usage of ${units} units recorded for meter ${subject}`;
    } else if (action === "plan_chg") {
      if (Array.isArray(evt.value) && evt.value.length >= 2) {
        meter.plan = String(evt.value[1]);
      }
      summary = `Plan changed to ${meter.plan} for meter ${subject}`;
    } else if (action === "InsurancePurchased" || action === "ins_buy") {
      meter.insuranceActive = true;
      summary = `Insurance purchased for meter ${subject}`;
    } else if (action === "mtr_dereg") {
      delete state.meters[subject];
      summary = `Meter ${subject} deregistered`;
      state.eventsProcessed += 1;
      state.timeline.push({
        block: evt.ledger,
        txHash: evt.txHash,
        action,
        subject,
        summary,
      });
      return;
    }

    state.meters[subject] = meter;
  }

  state.eventsProcessed += 1;
  state.timeline.push({
    block: evt.ledger,
    txHash: evt.txHash,
    action,
    subject,
    summary,
  });
}

/**
 * Replay events across `[fromBlock, toBlock]` (inclusive) and reconstruct contract state.
 */
export function replayEvents(options: {
  fromBlock?: number;
  toBlock?: number;
  subject?: string;
  action?: string;
}): {
  fromBlock: number;
  toBlock: number;
  events: IndexedEvent[];
  state: ReplayedContractState;
} {
  const fromBlock = options.fromBlock ?? 0;
  const toBlock = options.toBlock ?? Number.MAX_SAFE_INTEGER;
  const events = queryEventsAsc({
    fromLedger: fromBlock,
    toLedger: toBlock,
    subject: options.subject,
    action: options.action,
    limit: 10_000,
  });

  const effectiveToBlock =
    options.toBlock !== undefined
      ? options.toBlock
      : events.length > 0
        ? events[events.length - 1].ledger
        : fromBlock;

  const state: ReplayedContractState = {
    atBlock: effectiveToBlock,
    fromBlock,
    eventsProcessed: 0,
    paused: false,
    frozen: false,
    totalRevenue: 0,
    meters: {},
    timeline: [],
  };

  for (const evt of events) {
    applyEventToState(state, evt);
  }

  return {
    fromBlock,
    toBlock: effectiveToBlock,
    events,
    state,
  };
}

/**
 * Reconstruct the full contract state at a specific block height (replay from genesis block 0).
 */
export function reconstructStateAtBlock(blockNumber: number, subject?: string): ReplayedContractState {
  return replayEvents({ fromBlock: 0, toBlock: blockNumber, subject }).state;
}

/**
 * Compare historical state at `historicalBlock` against `currentBlock` (or latest indexed block)
 * to surface state diffs and discrepancies for debugging.
 */
export function compareContractStates(
  historicalBlock: number,
  currentBlock?: number,
  subject?: string,
): StateComparisonResult {
  const historicalState = reconstructStateAtBlock(historicalBlock, subject);
  const currentReplay = replayEvents({
    fromBlock: 0,
    toBlock: currentBlock,
    subject,
  });
  const currentState = currentReplay.state;
  const discrepancies: StateDiscrepancy[] = [];

  if (historicalState.paused !== currentState.paused) {
    discrepancies.push({
      entity: "contract",
      field: "paused",
      historicalValue: historicalState.paused,
      currentValue: currentState.paused,
    });
  }

  if (historicalState.frozen !== currentState.frozen) {
    discrepancies.push({
      entity: "contract",
      field: "frozen",
      historicalValue: historicalState.frozen,
      currentValue: currentState.frozen,
    });
  }

  if (historicalState.totalRevenue !== currentState.totalRevenue) {
    discrepancies.push({
      entity: "contract",
      field: "totalRevenue",
      historicalValue: historicalState.totalRevenue,
      currentValue: currentState.totalRevenue,
      delta: currentState.totalRevenue - historicalState.totalRevenue,
    });
  }

  const allMeters = new Set([
    ...Object.keys(historicalState.meters),
    ...Object.keys(currentState.meters),
  ]);

  for (const meterId of allMeters) {
    const hMeter = historicalState.meters[meterId];
    const cMeter = currentState.meters[meterId];
    if (!hMeter && cMeter) {
      discrepancies.push({
        entity: `meter:${meterId}`,
        field: "exists",
        historicalValue: false,
        currentValue: true,
      });
      continue;
    }
    if (hMeter && !cMeter) {
      discrepancies.push({
        entity: `meter:${meterId}`,
        field: "exists",
        historicalValue: true,
        currentValue: false,
      });
      continue;
    }
    if (hMeter && cMeter) {
      if (hMeter.active !== cMeter.active) {
        discrepancies.push({
          entity: `meter:${meterId}`,
          field: "active",
          historicalValue: hMeter.active,
          currentValue: cMeter.active,
        });
      }
      if (hMeter.owner !== cMeter.owner) {
        discrepancies.push({
          entity: `meter:${meterId}`,
          field: "owner",
          historicalValue: hMeter.owner,
          currentValue: cMeter.owner,
        });
      }
      if (hMeter.unitsUsed !== cMeter.unitsUsed) {
        discrepancies.push({
          entity: `meter:${meterId}`,
          field: "unitsUsed",
          historicalValue: hMeter.unitsUsed,
          currentValue: cMeter.unitsUsed,
          delta: cMeter.unitsUsed - hMeter.unitsUsed,
        });
      }
      if (hMeter.balance !== cMeter.balance) {
        discrepancies.push({
          entity: `meter:${meterId}`,
          field: "balance",
          historicalValue: hMeter.balance,
          currentValue: cMeter.balance,
          delta: cMeter.balance - hMeter.balance,
        });
      }
      if (hMeter.plan !== cMeter.plan) {
        discrepancies.push({
          entity: `meter:${meterId}`,
          field: "plan",
          historicalValue: hMeter.plan,
          currentValue: cMeter.plan,
        });
      }
    }
  }

  return {
    historicalBlock,
    currentBlock: currentState.atBlock,
    historicalState,
    currentState,
    discrepancies,
    inSync: discrepancies.length === 0,
  };
}

export { indexManualEvent };
