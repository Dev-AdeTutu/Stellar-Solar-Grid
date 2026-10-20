import React from "react";
import Navbar from "@/components/Navbar";
import LoyaltyDashboard from "@/components/LoyaltyDashboard";

export default function LoyaltyPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <Navbar />
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-extrabold text-white tracking-tight">
            Solar Grid Rewards & Loyalty
          </h1>
          <p className="text-slate-400 mt-2">
            Earn rewards points on every XLM spent and unlock permanent tariff discounts across the grid.
          </p>
        </div>

        <LoyaltyDashboard />
      </main>
    </div>
  );
}
