export type TransactionCategory = "payments" | "registrations" | "transfers" | "admin_actions";

export interface IndexedTransaction {
  txHash: string;
  address: string;
  category: TransactionCategory;
  meterId: string | null;
  amountStroops: number | null;
  assetCode: string;
  status: "success" | "failed";
  ledger: number;
  timestamp: string;
  description: string;
  explorerUrl: string;
}

export interface TransactionFilterOptions {
  category?: TransactionCategory;
  meterId?: string;
  startDate?: string;
  endDate?: string;
}

const STELLAR_EXPLORER_BASE =
  process.env.STELLAR_EXPLORER_URL || "https://stellar.expert/explorer/testnet/tx";

const indexedTransactions = new Map<string, IndexedTransaction>();

export function buildStellarExplorerLink(txHash: string): string {
  return `${STELLAR_EXPLORER_BASE}/${txHash}`;
}

export function categorizeContractEvent(fnName: string): TransactionCategory {
  const lower = fnName.toLowerCase();
  if (lower.includes("pay") || lower.includes("topup") || lower.includes("refund")) {
    return "payments";
  }
  if (lower.includes("register") || lower.includes("deregister")) {
    return "registrations";
  }
  if (lower.includes("transfer") || lower.includes("trade") || lower.includes("send")) {
    return "transfers";
  }
  return "admin_actions";
}

function seedDefaultTransactions(): void {
  if (indexedTransactions.size > 0) return;

  const sampleAddress = "GABC1234567890SOLARUSER";
  const samples: Omit<IndexedTransaction, "explorerUrl">[] = [
    {
      txHash: "a1b2c3d4e5f601",
      address: sampleAddress,
      category: "registrations",
      meterId: "meter-101",
      amountStroops: null,
      assetCode: "XLM",
      status: "success",
      ledger: 501200,
      timestamp: "2026-10-10T09:00:00.000Z",
      description: "Registered smart meter #101 on-chain",
    },
    {
      txHash: "a1b2c3d4e5f602",
      address: sampleAddress,
      category: "payments",
      meterId: "meter-101",
      amountStroops: 250000000,
      assetCode: "XLM",
      status: "success",
      ledger: 501245,
      timestamp: "2026-10-12T14:30:00.000Z",
      description: "Meter balance top-up payment (25 XLM)",
    },
    {
      txHash: "a1b2c3d4e5f603",
      address: sampleAddress,
      category: "transfers",
      meterId: "meter-102",
      amountStroops: 50000000,
      assetCode: "USDC",
      status: "success",
      ledger: 501310,
      timestamp: "2026-10-14T11:15:00.000Z",
      description: "Transferred energy credit units to meter-102",
    },
    {
      txHash: "a1b2c3d4e5f604",
      address: sampleAddress,
      category: "admin_actions",
      meterId: "meter-101",
      amountStroops: null,
      assetCode: "XLM",
      status: "success",
      ledger: 501400,
      timestamp: "2026-10-15T18:45:00.000Z",
      description: "Admin tariff parameter update approved",
    },
  ];

  for (const s of samples) {
    indexedTransactions.set(s.txHash, {
      ...s,
      explorerUrl: buildStellarExplorerLink(s.txHash),
    });
  }
}

export function resetTransactionIndex(): void {
  indexedTransactions.clear();
  seedDefaultTransactions();
}

export function indexContractTransaction(
  tx: Omit<IndexedTransaction, "explorerUrl">
): IndexedTransaction {
  seedDefaultTransactions();
  const full: IndexedTransaction = {
    ...tx,
    explorerUrl: buildStellarExplorerLink(tx.txHash),
  };
  indexedTransactions.set(full.txHash, full);
  return full;
}

export function getTransactionsForAddress(
  address: string,
  filters: TransactionFilterOptions = {}
): IndexedTransaction[] {
  seedDefaultTransactions();
  const normalizedAddr = address.trim();
  let list = Array.from(indexedTransactions.values()).filter(
    (tx) => tx.address === normalizedAddr || normalizedAddr === "all"
  );

  if (filters.category) {
    list = list.filter((tx) => tx.category === filters.category);
  }
  if (filters.meterId) {
    list = list.filter((tx) => tx.meterId === filters.meterId);
  }
  if (filters.startDate) {
    const startMs = Date.parse(filters.startDate);
    if (!Number.isNaN(startMs)) {
      list = list.filter((tx) => Date.parse(tx.timestamp) >= startMs);
    }
  }
  if (filters.endDate) {
    const endMs = Date.parse(filters.endDate);
    if (!Number.isNaN(endMs)) {
      list = list.filter((tx) => Date.parse(tx.timestamp) <= endMs);
    }
  }

  return list.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

export function exportTransactionsToCsv(transactions: IndexedTransaction[]): string {
  const headers = [
    "txHash",
    "timestamp",
    "category",
    "meterId",
    "amountStroops",
    "assetCode",
    "status",
    "ledger",
    "description",
    "explorerUrl",
  ];
  const escapeCsv = (val: unknown) => {
    if (val === null || val === undefined) return "";
    const str = String(val);
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = transactions.map((tx) =>
    [
      tx.txHash,
      tx.timestamp,
      tx.category,
      tx.meterId,
      tx.amountStroops,
      tx.assetCode,
      tx.status,
      tx.ledger,
      tx.description,
      tx.explorerUrl,
    ]
      .map(escapeCsv)
      .join(",")
  );

  return [headers.join(","), ...rows].join("\n");
}
