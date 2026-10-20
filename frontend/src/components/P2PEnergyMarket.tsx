"use client";

import React, { useState } from "react";
import { useWalletStore } from "@/store/walletStore";

export interface EnergyListingUI {
  id: number;
  seller: string;
  kwhAvailable: number;
  pricePerKwh: number; // in XLM
  totalValue: number;
  createdAt: string;
}

export interface TradeRecordUI {
  id: string;
  seller: string;
  buyer: string;
  kwh: number;
  pricePerKwh: number;
  totalCost: number;
  settledAt: string;
}

export default function P2PEnergyMarket() {
  const { address } = useWalletStore();
  const isConnected = Boolean(address);

  const [listings, setListings] = useState<EnergyListingUI[]>([
    {
      id: 1,
      seller: "GD7K...93FA",
      kwhAvailable: 45,
      pricePerKwh: 0.12,
      totalValue: 5.4,
      createdAt: "10 mins ago",
    },
    {
      id: 2,
      seller: "GA10...43PL",
      kwhAvailable: 120,
      pricePerKwh: 0.11,
      totalValue: 13.2,
      createdAt: "35 mins ago",
    },
    {
      id: 3,
      seller: "GC88...19QZ",
      kwhAvailable: 80,
      pricePerKwh: 0.14,
      totalValue: 11.2,
      createdAt: "2 hours ago",
    },
  ]);

  const [trades, setTrades] = useState<TradeRecordUI[]>([
    {
      id: "trade-01",
      seller: "GD7K...93FA",
      buyer: "GB22...88ZZ",
      kwh: 30,
      pricePerKwh: 0.12,
      totalCost: 3.6,
      settledAt: "15 mins ago",
    },
  ]);

  // Form states
  const [listKwh, setListKwh] = useState<number>(50);
  const [listPrice, setListPrice] = useState<number>(0.12);
  const [buyKwh, setBuyKwh] = useState<number>(20);
  const [selectedListing, setSelectedListing] = useState<EnergyListingUI | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const handleCreateListing = (e: React.FormEvent) => {
    e.preventDefault();
    if (listKwh <= 0 || listPrice <= 0) return;

    const newListing: EnergyListingUI = {
      id: listings.length + 1,
      seller: address ? `${address.slice(0, 4)}...${address.slice(-4)}` : "G_YOU...PROD",
      kwhAvailable: listKwh,
      pricePerKwh: listPrice,
      totalValue: +(listKwh * listPrice).toFixed(2),
      createdAt: "Just now",
    };

    setListings([newListing, ...listings]);
    setStatusMessage(`Successfully listed ${listKwh} kWh for sale at ${listPrice} XLM/kWh!`);
    setListKwh(50);
  };

  const handleBuy = (listing: EnergyListingUI) => {
    if (buyKwh <= 0) return;
    const amountToBuy = Math.min(buyKwh, listing.kwhAvailable);
    const cost = +(amountToBuy * listing.pricePerKwh).toFixed(2);

    const newTrade: TradeRecordUI = {
      id: `trade-${Date.now()}`,
      seller: listing.seller,
      buyer: address ? `${address.slice(0, 4)}...${address.slice(-4)}` : "G_YOU...BUYR",
      kwh: amountToBuy,
      pricePerKwh: listing.pricePerKwh,
      totalCost: cost,
      settledAt: "Just now",
    };

    setTrades([newTrade, ...trades]);

    setListings((prev) =>
      prev
        .map((l) => {
          if (l.id === listing.id) {
            const remaining = l.kwhAvailable - amountToBuy;
            return {
              ...l,
              kwhAvailable: remaining,
              totalValue: +(remaining * l.pricePerKwh).toFixed(2),
            };
          }
          return l;
        })
        .filter((l) => l.kwhAvailable > 0)
    );

    setStatusMessage(`Purchased ${amountToBuy} kWh from ${listing.seller} for ${cost} XLM!`);
    setSelectedListing(null);
  };

  const handleMatchAndBuy = () => {
    if (listings.length === 0) {
      setStatusMessage("No active listings available to match.");
      return;
    }
    // Find lowest price
    const best = [...listings].sort((a, b) => a.pricePerKwh - b.pricePerKwh)[0];
    handleBuy(best);
  };

  return (
    <div className="space-y-8">
      {statusMessage && (
        <div className="p-4 bg-emerald-950/60 border border-emerald-800/80 rounded-xl text-emerald-300 text-sm">
          {statusMessage}
        </div>
      )}

      {/* Grid: Create Listing + Auto-match Engine */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Sell Energy Form */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-lg">
          <h2 className="text-lg font-bold text-white mb-2">Sell Excess Solar Energy</h2>
          <p className="text-xs text-slate-400 mb-6">
            Offer your rooftop solar export credits to neighbors at custom peer-to-peer rates.
          </p>

          <form onSubmit={handleCreateListing} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Energy Available (kWh)
              </label>
              <input
                type="number"
                min="1"
                value={listKwh}
                onChange={(e) => setListKwh(parseFloat(e.target.value) || 0)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Price per kWh (XLM)
              </label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={listPrice}
                onChange={(e) => setListPrice(parseFloat(e.target.value) || 0)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="p-3 bg-slate-950/50 rounded-lg border border-slate-800 text-xs text-slate-400 flex justify-between">
              <span>Estimated Listing Value:</span>
              <span className="font-semibold text-emerald-400">
                {(listKwh * listPrice).toFixed(2)} XLM
              </span>
            </div>

            <button
              type="submit"
              className="w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-lg text-sm transition-colors"
            >
              Post Energy Listing
            </button>
          </form>
        </div>

        {/* Smart Order Matcher */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-lg flex flex-col justify-between">
          <div>
            <h2 className="text-lg font-bold text-white mb-2">Instant Order Match Engine</h2>
            <p className="text-xs text-slate-400 mb-4">
              Automatically route your energy buy order to the cheapest available solar peer in real time.
            </p>

            <div className="space-y-3 mt-4">
              <label className="block text-xs font-medium text-slate-300">
                kWh Required
              </label>
              <input
                type="number"
                min="1"
                value={buyKwh}
                onChange={(e) => setBuyKwh(parseFloat(e.target.value) || 0)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-slate-800">
            <button
              onClick={handleMatchAndBuy}
              className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg text-sm transition-colors"
            >
              Match & Buy Best Rate
            </button>
          </div>
        </div>

        {/* Market Stats */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-lg space-y-4">
          <h2 className="text-lg font-bold text-white mb-2">Marketplace Stats</h2>
          <div className="p-3.5 bg-slate-950/60 border border-slate-800 rounded-lg">
            <span className="text-slate-400 text-xs block">Average P2P Rate</span>
            <span className="text-xl font-bold text-white">0.123 XLM / kWh</span>
          </div>
          <div className="p-3.5 bg-slate-950/60 border border-slate-800 rounded-lg">
            <span className="text-slate-400 text-xs block">Total Available Energy</span>
            <span className="text-xl font-bold text-emerald-400">
              {listings.reduce((sum, l) => sum + l.kwhAvailable, 0)} kWh
            </span>
          </div>
          <div className="p-3.5 bg-slate-950/60 border border-slate-800 rounded-lg">
            <span className="text-slate-400 text-xs block">Total Trades Settled</span>
            <span className="text-xl font-bold text-white">{trades.length}</span>
          </div>
        </div>
      </div>

      {/* Order Book Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-lg">
        <h2 className="text-lg font-bold text-white mb-4">Active Peer Listings</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-800">
              <tr>
                <th className="py-3 px-4">Seller</th>
                <th className="py-3 px-4">Available Energy</th>
                <th className="py-3 px-4">Price / kWh</th>
                <th className="py-3 px-4">Total Value</th>
                <th className="py-3 px-4">Listed</th>
                <th className="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 text-slate-300">
              {listings.map((item) => (
                <tr key={item.id} className="hover:bg-slate-950/50 transition-colors">
                  <td className="py-3 px-4 font-mono font-medium text-white">{item.seller}</td>
                  <td className="py-3 px-4 font-semibold text-emerald-400">
                    {item.kwhAvailable} kWh
                  </td>
                  <td className="py-3 px-4 font-semibold text-white">
                    {item.pricePerKwh.toFixed(2)} XLM
                  </td>
                  <td className="py-3 px-4 text-slate-400">{item.totalValue} XLM</td>
                  <td className="py-3 px-4 text-slate-500">{item.createdAt}</td>
                  <td className="py-3 px-4 text-right">
                    <button
                      onClick={() => handleBuy(item)}
                      className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-lg text-xs"
                    >
                      Buy Direct
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
