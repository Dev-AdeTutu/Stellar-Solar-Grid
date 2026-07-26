import React from "react";
import { MeterStatusBadge } from "./MeterStatusBadge";

export interface MeterCardProps {
  meterId: string;
  owner: string;
  active: boolean;
  balance: bigint;
  expiresAt: bigint;
  plan: "Daily" | "Weekly" | "Usage";
  onDeactivate?: () => void;
  isDeactivating?: boolean;
}

export function MeterCard({
  meterId,
  owner,
  active,
  balance,
  expiresAt,
  plan,
  onDeactivate,
  isDeactivating = false,
}: MeterCardProps) {
  const expiresAtNum = Number(expiresAt);
  const balanceNum = Number(balance);

  // Calculate days left
  const daysLeft = Math.max(0, Math.ceil((expiresAtNum * 1000 - Date.now()) / 86_400_000));

  // Convert stroops to XLM (1 XLM = 10,000,000 stroops)
  const balanceXlm = (balanceNum / 1e7).toFixed(2);

  const isExpired =
    expiresAtNum !== Number.MAX_SAFE_INTEGER &&
    expiresAtNum > 0 &&
    Date.now() / 1000 >= expiresAtNum;
  const statusActive = active && !isExpired;

  return (
    <div
      className="rounded-xl border border-white/10 bg-solar-accent p-5 transition hover:border-white/20"
      aria-label={`Meter ${meterId} (${owner.slice(0, 8)}...${owner.slice(-8)})`}
    >
      {/* Header: Meter ID and Status Badge */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex-1 min-w-0">
          <h3 className="font-mono text-sm font-semibold text-white truncate">{meterId}</h3>
          <p className="text-xs text-gray-500 truncate mt-1">
            {owner.slice(0, 8)}...{owner.slice(-8)}
          </p>
        </div>
        <MeterStatusBadge active={active} expiresAt={expiresAtNum} />
      </div>

      {/* Balance */}
      <div className="mb-4">
        <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Balance</p>
        <p className="text-lg font-bold text-white">
          {balanceXlm} <span className="text-sm text-gray-400">XLM</span>
        </p>
      </div>

      {/* Plan and Expiry */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Plan</p>
          <p className="text-sm font-medium text-white">{plan}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Expiry</p>
          <p
            className={`text-sm font-medium ${
              daysLeft === 0 ? "text-red-400" : daysLeft <= 7 ? "text-yellow-400" : "text-green-400"
            }`}
          >
            {expiresAtNum === Number.MAX_SAFE_INTEGER ? "Never" : `${daysLeft}d left`}
          </p>
        </div>
      </div>

      {/* Deactivate Button */}
      {active && !isExpired && onDeactivate && (
        <button
          onClick={onDeactivate}
          disabled={isDeactivating}
          className="w-full rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-400 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          {isDeactivating ? "Deactivating…" : "Deactivate Meter"}
        </button>
      )}
    </div>
  );
}
