import { Router, Request, Response } from "express";
import {
  exportTransactionsToCsv,
  getTransactionsForAddress,
  indexContractTransaction,
  TransactionCategory,
} from "../lib/transactionExplorer.js";

export const transactionsRouter = Router();

const VALID_CATEGORIES: TransactionCategory[] = [
  "payments",
  "registrations",
  "transfers",
  "admin_actions",
];

transactionsRouter.get("/:address", (req: Request, res: Response) => {
  const { address } = req.params;
  const typeParam = req.query.type as TransactionCategory | undefined;
  const meterId = req.query.meter_id as string | undefined;
  const startDate = req.query.start_date as string | undefined;
  const endDate = req.query.end_date as string | undefined;
  const format = req.query.format as string | undefined;

  if (typeParam && !VALID_CATEGORIES.includes(typeParam)) {
    res.status(400).json({ error: "Invalid transaction type filter" });
    return;
  }

  const transactions = getTransactionsForAddress(address, {
    category: typeParam,
    meterId,
    startDate,
    endDate,
  });

  if (format === "csv") {
    const csv = exportTransactionsToCsv(transactions);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="transactions-${address}.csv"`);
    res.send(csv);
    return;
  }

  res.json({
    address,
    count: transactions.length,
    transactions,
  });
});

transactionsRouter.post("/", (req: Request, res: Response) => {
  const {
    txHash,
    address,
    category,
    meterId,
    amountStroops,
    assetCode,
    status,
    ledger,
    timestamp,
    description,
  } = req.body ?? {};

  if (!txHash || !address || !VALID_CATEGORIES.includes(category)) {
    res.status(400).json({ error: "Invalid transaction payload" });
    return;
  }

  const indexed = indexContractTransaction({
    txHash: String(txHash),
    address: String(address),
    category,
    meterId: meterId ? String(meterId) : null,
    amountStroops: amountStroops !== undefined ? Number(amountStroops) : null,
    assetCode: assetCode ? String(assetCode) : "XLM",
    status: status === "failed" ? "failed" : "success",
    ledger: Number(ledger || 0),
    timestamp: timestamp || new Date().toISOString(),
    description: description || `${category} transaction`,
  });

  res.status(201).json(indexed);
});
