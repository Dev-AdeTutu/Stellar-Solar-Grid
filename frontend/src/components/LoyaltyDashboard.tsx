"use client";

import React, { useState } from "react";
import { useWalletStore } from "@/store/walletStore";

export type LoyaltyTier = "Bronze" | "Silver" | "Gold";

export interface LoyaltyAccountData {
  points: number;
  tier: LoyaltyTier;
  totalEarned: number;
  totalRedeemed: number;
  discountPercent: number;
}

export default function LoyaltyDashboard() {
  const { address } = useWalletStore();
  const isConnected = Boolean(address);
  const [account, setAccount] = useState<LoyaltyAccountData>({
    points: 750,
    tier: "Silver",
    totalEarned: 1250,
    totalRedeemed: 500,
    discountPercent: 5,
  });

  const [redeemAmount, setRedeemAmount] = useState<number>(100);
  const [redeemSuccess, setRedeemSuccess] = useState<string | null>(null);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const getTierColor = (tier: LoyaltyTier) => {
    switch (tier) {
      case "Gold":
        return "bg-amber-500/20 text-amber-300 border-amber-500/40";
      case "Silver":
        return "bg-slate-300/20 text-slate-200 border-slate-300/40";
      default:
        return "bg-amber-800/20 text-amber-500 border-amber-700/40";
    }
  };

  const getProgressToNextTier = () => {
    if (account.tier === "Gold") return 100;
    if (account.tier === "Silver") {
      // 500 to 2000
      const progress = ((account.points - 500) / 1500) * 100;
      return Math.min(Math.max(progress, 0), 100);
    }
    // Bronze: 0 to 500
    const progress = (account.points / 500) * 100;
    return Math.min(Math.max(progress, 0), 100);
  };

  const handleRedeem = async (e: React.FormEvent) => {
    e.preventDefault();
    setRedeemSuccess(null);
    setRedeemError(null);

    if (redeemAmount <= 0) {
      setRedeemError("Please enter a positive point amount.");
      return;
    }
    if (redeemAmount > account.points) {
      setRedeemError("You cannot redeem more points than your available balance.");
      return;
    }

    setIsSubmitting(true);
    try {
      // Simulate on-chain call
      await new Promise((res) => setTimeout(res, 600));
      const newPoints = account.points - redeemAmount;
      const newTotalRedeemed = account.totalRedeemed + redeemAmount;
      let newTier: LoyaltyTier = "Bronze";
      let newDiscount = 0;

      if (newPoints >= 2000) {
        newTier = "Gold";
        newDiscount = 10;
      } else if (newPoints >= 500) {
        newTier = "Silver";
        newDiscount = 5;
      }

      setAccount({
        points: newPoints,
        tier: newTier,
        totalEarned: account.totalEarned,
        totalRedeemed: newTotalRedeemed,
        discountPercent: newDiscount,
      });

      setRedeemSuccess(`Successfully redeemed ${redeemAmount} points for tariff credits!`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setRedeemError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
          <div className="text-slate-400 text-sm font-medium">Available Points</div>
          <div className="text-3xl font-bold text-white mt-2">
            {account.points.toLocaleString()} <span className="text-emerald-400 text-lg">PTS</span>
          </div>
          <div className="text-xs text-slate-500 mt-2">Earn 1 pt per 1 XLM spent</div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
          <div className="text-slate-400 text-sm font-medium">Current Tier</div>
          <div className="flex items-center gap-2 mt-2">
            <span
              className={`px-3 py-1 rounded-full text-sm font-semibold border ${getTierColor(
                account.tier
              )}`}
            >
              {account.tier} Tier
            </span>
          </div>
          <div className="text-xs text-slate-500 mt-2">
            {account.tier === "Gold"
              ? "Highest tier achieved!"
              : account.tier === "Silver"
              ? `${(2000 - account.points).toLocaleString()} pts to Gold`
              : `${(500 - account.points).toLocaleString()} pts to Silver`}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
          <div className="text-slate-400 text-sm font-medium">Tariff Discount</div>
          <div className="text-3xl font-bold text-emerald-400 mt-2">
            {account.discountPercent}%
          </div>
          <div className="text-xs text-slate-500 mt-2">Auto-applied to top-up rates</div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
          <div className="text-slate-400 text-sm font-medium">Lifetime Points</div>
          <div className="text-3xl font-bold text-white mt-2">
            {account.totalEarned.toLocaleString()}
          </div>
          <div className="text-xs text-slate-500 mt-2">
            {account.totalRedeemed.toLocaleString()} points redeemed
          </div>
        </div>
      </div>

      {/* Progress to Next Tier */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-lg">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm font-semibold text-slate-300">
            Tier Status & Progress
          </span>
          <span className="text-xs text-emerald-400 font-medium">
            {Math.round(getProgressToNextTier())}% complete
          </span>
        </div>
        <div className="w-full bg-slate-800 h-3 rounded-full overflow-hidden">
          <div
            className="bg-emerald-500 h-full transition-all duration-500"
            style={{ width: `${getProgressToNextTier()}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-slate-400 mt-3">
          <span>Bronze (0 pts)</span>
          <span>Silver (500 pts / 5% off)</span>
          <span>Gold (2,000+ pts / 10% off)</span>
        </div>
      </div>

      {/* Redemption & Benefits Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Redeem Form */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-lg">
          <h2 className="text-lg font-bold text-white mb-2">Redeem Points for Discounts</h2>
          <p className="text-sm text-slate-400 mb-6">
            Convert accumulated rewards points into tariff reductions on upcoming meter billing cycles.
          </p>

          {redeemSuccess && (
            <div className="mb-4 p-3 bg-emerald-950/60 border border-emerald-800/80 rounded-lg text-emerald-300 text-sm">
              {redeemSuccess}
            </div>
          )}
          {redeemError && (
            <div className="mb-4 p-3 bg-rose-950/60 border border-rose-800/80 rounded-lg text-rose-300 text-sm">
              {redeemError}
            </div>
          )}

          <form onSubmit={handleRedeem} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Points to Redeem
              </label>
              <div className="flex gap-2">
                <input
                  type="number"
                  min="1"
                  max={account.points}
                  value={redeemAmount}
                  onChange={(e) => setRedeemAmount(parseInt(e.target.value, 10) || 0)}
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500 text-sm"
                />
                <button
                  type="button"
                  onClick={() => setRedeemAmount(account.points)}
                  className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold"
                >
                  Max
                </button>
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Equivalent discount value: ~{(redeemAmount * 0.01).toFixed(2)} XLM
              </div>
            </div>

            <button
              type="submit"
              disabled={isSubmitting || account.points === 0}
              className="w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold rounded-lg text-sm transition-colors"
            >
              {isSubmitting ? "Processing Redemption..." : "Confirm Redemption"}
            </button>
          </form>
        </div>

        {/* Tier Benefits Table */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-lg">
          <h2 className="text-lg font-bold text-white mb-2">Loyalty Tier Privileges</h2>
          <p className="text-sm text-slate-400 mb-4">
            Maintain higher balances to automatically lock in preferred energy tariffs.
          </p>

          <div className="space-y-3">
            <div className="p-3.5 bg-slate-950/60 border border-slate-800 rounded-lg flex items-center justify-between">
              <div>
                <div className="font-semibold text-amber-600 text-sm">Bronze Tier</div>
                <div className="text-xs text-slate-400">0 - 499 Points</div>
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-300 font-medium">Standard Tariff</div>
                <div className="text-xs text-slate-500">0% Discount</div>
              </div>
            </div>

            <div className="p-3.5 bg-slate-950/60 border border-slate-800 rounded-lg flex items-center justify-between">
              <div>
                <div className="font-semibold text-slate-200 text-sm">Silver Tier</div>
                <div className="text-xs text-slate-400">500 - 1,999 Points</div>
              </div>
              <div className="text-right">
                <div className="text-xs text-emerald-400 font-semibold">5% Off Tariffs</div>
                <div className="text-xs text-slate-500">Priority Grid Dispatch</div>
              </div>
            </div>

            <div className="p-3.5 bg-slate-950/60 border border-slate-800 rounded-lg flex items-center justify-between">
              <div>
                <div className="font-semibold text-amber-400 text-sm">Gold Tier</div>
                <div className="text-xs text-slate-400">2,000+ Points</div>
              </div>
              <div className="text-right">
                <div className="text-xs text-emerald-400 font-bold">10% Off Tariffs</div>
                <div className="text-xs text-slate-500">Zero P2P Trading Fees</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
