import React from "react";
import Navbar from "@/components/Navbar";
import P2PEnergyMarket from "@/components/P2PEnergyMarket";

export default function P2PMarketplacePage() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <Navbar />
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-extrabold text-white tracking-tight">
            Peer-to-Peer Solar Energy Trading
          </h1>
          <p className="text-slate-400 mt-2">
            Buy and sell excess renewable energy directly with neighboring prosumers on Stellar Soroban.
          </p>
        </div>

        <P2PEnergyMarket />
      </main>
    </div>
  );
}
