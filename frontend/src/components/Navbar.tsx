"use client";

import Link from "next/link";
import { useWalletStore } from "@/store/walletStore";

export default function Navbar() {
  const { address, connect, disconnect } = useWalletStore();

  const short = address ? `${address.slice(0, 4)}…${address.slice(-4)}` : null;

  return (
    <nav className="flex items-center justify-between px-6 py-4 bg-solar-accent border-b border-white/10">
      <Link href="/" className="text-xl font-bold text-solar-yellow">
        ☀️ SolarGrid
      </Link>

      <div className="flex items-center gap-4">
        <Link href="/dashboard/user" className="text-sm text-gray-300 hover:text-white transition">
          My Meter
        </Link>
        <Link
          href="/dashboard/provider"
          className="text-sm text-gray-300 hover:text-white transition"
        >
          Provider
        </Link>
        <Link
          href="/history"
          className="text-sm text-gray-300 hover:text-white transition"
        >
          History
        </Link>

        {address ? (
          <button
            onClick={disconnect}
            className="rounded-lg border border-solar-yellow px-4 py-1.5 text-sm text-solar-yellow hover:bg-solar-yellow hover:text-solar-dark transition"
          >
            {short}
          </button>
        ) : (
          <button
            onClick={connect}
            className="rounded-lg bg-solar-yellow px-4 py-1.5 text-sm font-semibold text-solar-dark hover:opacity-90 transition"
          >
            Connect Wallet
          </button>
        )}
      </div>
    </nav>
  );
}
