"use client";

import React from "react";
import { TransactionExplorer } from "../../components/TransactionExplorer";

export default function TransactionsPage() {
  return (
    <main className="max-w-7xl mx-auto p-6 space-y-6">
      <TransactionExplorer />
    </main>
  );
}
