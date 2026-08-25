import React, { useState, useEffect } from "react";
import Link from "next/link";
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

const COMMON_EMOJIS = ["☀️", "🏠", "🏬", "⚡", "🔋", "🏭"];

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
  const [nickname, setNickname] = useState<string>("");
  const [isEditing, setIsEditing] = useState(false);
  const [tempNickname, setTempNickname] = useState("");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(`meter_nickname_${meterId}`);
      if (saved) {
        setNickname(saved);
        setTempNickname(saved);
      }
    } catch {
      // LocalStorage might be unavailable
    }
  }, [meterId]);

  const handleSaveNickname = () => {
    const trimmed = tempNickname.trim().slice(0, 30);
    setNickname(trimmed);
    setIsEditing(false);
    try {
      if (trimmed) {
        localStorage.setItem(`meter_nickname_${meterId}`, trimmed);
      } else {
        localStorage.removeItem(`meter_nickname_${meterId}`);
      }
    } catch {
      // Ignore storage errors
    }
  };

  const handleCancelNickname = () => {
    setTempNickname(nickname);
    setIsEditing(false);
  };

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
      aria-label={`Meter ${nickname || meterId} (${owner.slice(0, 8)}...${owner.slice(-8)})`}
    >
      {/* Header: Nickname / Meter ID and Status Badge */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex-1 min-w-0">
          {nickname ? (
            <>
              <div className="flex items-center gap-1.5 group">
                <h3 className="font-semibold text-white text-base truncate">{nickname}</h3>
                {!isEditing && (
                  <button
                    onClick={() => {
                      setTempNickname(nickname);
                      setIsEditing(true);
                    }}
                    className="text-gray-400 hover:text-solar-yellow text-xs opacity-70 group-hover:opacity-100 transition"
                    title="Edit nickname"
                    aria-label="Edit nickname"
                  >
                    ✏️
                  </button>
                )}
              </div>
              <p className="font-mono text-xs text-gray-400 truncate mt-0.5">{meterId}</p>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <h3 className="font-mono text-sm font-semibold text-white truncate">{meterId}</h3>
              {!isEditing && (
                <button
                  onClick={() => {
                    setTempNickname("");
                    setIsEditing(true);
                  }}
                  className="text-xs text-gray-400 hover:text-solar-yellow underline transition"
                >
                  Set nickname
                </button>
              )}
            </div>
          )}
          <p className="text-xs text-gray-500 truncate mt-1">
            {owner.slice(0, 8)}...{owner.slice(-8)}
          </p>
        </div>
        <MeterStatusBadge active={active} expiresAt={expiresAtNum} />
      </div>

      {/* Nickname Editor */}
      {isEditing && (
        <div className="mb-4 rounded-lg bg-solar-dark/50 border border-white/10 p-3 space-y-2">
          <label className="text-xs text-gray-400 block">Set nickname (max 30 chars)</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              maxLength={30}
              value={tempNickname}
              onChange={(e) => setTempNickname(e.target.value)}
              placeholder="e.g. Home Solar ☀️"
              className="flex-1 rounded border border-white/20 bg-solar-dark px-2.5 py-1 text-xs text-white placeholder-gray-500 focus:border-solar-yellow focus:outline-none"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveNickname();
                if (e.key === "Escape") handleCancelNickname();
              }}
            />
            <button
              onClick={handleSaveNickname}
              className="rounded bg-solar-yellow px-2.5 py-1 text-xs font-semibold text-solar-dark hover:opacity-90 transition"
            >
              Save
            </button>
            <button
              onClick={handleCancelNickname}
              className="rounded border border-white/20 px-2 py-1 text-xs text-gray-400 hover:text-white transition"
            >
              Cancel
            </button>
          </div>
          {/* Quick Emoji Picker */}
          <div className="flex items-center gap-1.5 pt-1">
            <span className="text-[10px] text-gray-500">Quick emojis:</span>
            {COMMON_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  if (tempNickname.length + emoji.length <= 30) {
                    setTempNickname((prev) => (prev ? `${prev} ${emoji}` : emoji).slice(0, 30));
                  }
                }}
                className="rounded px-1.5 py-0.5 text-xs hover:bg-white/10 transition"
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}

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

      {/* Print Report Link */}
      <Link
        href={`/meters/${meterId}/report`}
        className="block w-full rounded-lg border border-solar-yellow/30 bg-solar-yellow/10 px-3 py-2 text-xs font-semibold text-solar-yellow hover:bg-solar-yellow/20 transition text-center mt-2"
      >
        Print Report
      </Link>
    </div>
  );
}
