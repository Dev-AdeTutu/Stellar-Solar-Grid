import * as StellarSdk from "@stellar/stellar-sdk";
import { CONTRACT_ID, server } from "./stellar.js";

export type IndexedContractEvent = {
  type: "payment" | "usage" | "access";
  meterId: string;
  txHash?: string;
  ledger?: number;
  timestamp?: string;
  payload: unknown;
};

const EVENT_SYMBOLS = new Set(["payment", "usage", "access"]);
const eventIndex: IndexedContractEvent[] = [];
let nextLedger = 1;
let pollHandle: NodeJS.Timeout | null = null;

function scValToSymbol(scValB64: string): string | null {
  const scVal = StellarSdk.xdr.ScVal.fromXDR(scValB64, "base64");
  return scVal.switch().name === "scvSymbol" ? scVal.sym().toString() : null;
}

function parseEvent(event: any): IndexedContractEvent | null {
  const topic = event.topic ?? [];
  if (topic.length < 2) {
    return null;
  }

  const eventType = scValToSymbol(topic[0]);
  if (!eventType || !EVENT_SYMBOLS.has(eventType)) {
    return null;
  }

  const meterId = scValToSymbol(topic[1]) ?? "unknown";

  let payload: unknown = null;
  const value = event.value ?? event.data;
  if (value) {
    try {
      payload = StellarSdk.scValToNative(
        StellarSdk.xdr.ScVal.fromXDR(value, "base64"),
      );
    } catch {
      payload = null;
    }
  }

  return {
    type: eventType as IndexedContractEvent["type"],
    meterId,
    txHash: event.txHash,
    ledger: event.ledger,
    timestamp: event.ledgerClosedAt,
    payload,
  };
}

async function pollEvents(): Promise<void> {
  const response = await (server as any).getEvents({
    startLedger: nextLedger,
    filters: [
      {
        type: "contract",
        contractIds: [CONTRACT_ID],
      },
    ],
    limit: 200,
  });

  const events = response?.events ?? [];
  let maxLedger = nextLedger;

  for (const event of events) {
    if (typeof event.ledger === "number" && event.ledger > maxLedger) {
      maxLedger = event.ledger;
    }

    const parsed = parseEvent(event);
    if (parsed) {
      eventIndex.push(parsed);
      console.log("Indexed contract event:", parsed);
    }
  }

  nextLedger = maxLedger + 1;
}

export function startEventIndexer() {
  if (pollHandle) {
    return;
  }

  pollHandle = setInterval(async () => {
    try {
      await pollEvents();
    } catch (err) {
      console.error("Event indexer error:", err);
    }
  }, 8_000);

  pollEvents().catch((err) => {
    console.error("Initial event indexing failed:", err);
  });
}

export function getIndexedEvents(): IndexedContractEvent[] {
  return [...eventIndex];
}
