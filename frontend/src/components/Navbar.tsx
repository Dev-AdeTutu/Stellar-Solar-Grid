"use client";

import { useState } from "react";
import Link from "next/link";
import { useWalletStore } from "@/store/walletStore";

const NAV_LINKS = [
  { href: "/dashboard/user", label: "My Meter" },
  { href: "/pay", label: "Pay" },
  { href: "/dashboard/provider", label: "Provider" },
  { href: "/history", label: "History" },
];

export default function Navbar() {
  const { address, connect, disconnect, connectError, clearConnectError } = useWalletStore();
  const [menuOpen, setMenuOpen] = useState(false);

  const short = address ? `${address.slice(0, 4)}…${address.slice(-4)}` : null;

  function closeMenu() {
    setMenuOpen(false);
  }

  return (
    <nav className="bg-solar-accent border-b border-white/10 relative z-50">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 sm:px-6">
        <Link href="/" className="text-xl font-bold text-solar-yellow" onClick={closeMenu}>
          ☀️ SolarGrid
        </Link>

        {/* Desktop links */}
        <div className="hidden sm:flex items-center gap-4">
          {NAV_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-sm text-gray-300 hover:text-white transition"
            >
              {l.label}
            </Link>
          ))}
          <WalletButton address={short} connect={connect} disconnect={disconnect} />
        </div>

        {/* Mobile: wallet button + hamburger */}
        <div className="flex items-center gap-2 sm:hidden">
          <WalletButton address={short} connect={connect} disconnect={disconnect} compact />
          <button
            onClick={() => setMenuOpen((o) => !o)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            className="rounded-lg border border-white/10 p-2 text-gray-300 hover:border-solar-yellow hover:text-solar-yellow transition"
          >
            {menuOpen ? (
              /* X icon */
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                <path d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" />
              </svg>
            ) : (
              /* Hamburger icon */
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                <path d="M3 5h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2z" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Wallet connect error banner */}
      {connectError && (
        <div className="flex items-center justify-between gap-3 border-t border-red-500/30 bg-red-900/20 px-4 py-2.5 text-sm text-red-400">
          <span>
            {connectError}{" "}
            {connectError.includes("not installed") && (
              <a
                href="https://freighter.app"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 text-red-300 hover:text-white transition"
              >
                Install Freighter ↗
              </a>
            )}
          </span>
          <button
            onClick={clearConnectError}
            aria-label="Dismiss error"
            className="shrink-0 text-red-400 hover:text-white transition"
          >
            ✕
          </button>
        </div>
      )}

      {/* Mobile dropdown menu */}
      {menuOpen && (
        <div className="sm:hidden border-t border-white/10 bg-solar-accent px-4 pb-4 flex flex-col gap-1">
          {NAV_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={closeMenu}
              className="block rounded-lg px-3 py-3 text-sm text-gray-300 hover:bg-white/5 hover:text-white transition"
            >
              {l.label}
            </Link>
          ))}
        </div>
      )}
    </nav>
  );
}

function WalletButton({
  address,
  connect,
  disconnect,
  compact = false,
}: {
  address: string | null;
  connect: () => void;
  disconnect: () => void;
  compact?: boolean;
}) {
  if (address) {
    return (
      <button
        onClick={disconnect}
        className="rounded-lg border border-solar-yellow px-3 py-1.5 text-xs font-medium text-solar-yellow hover:bg-solar-yellow hover:text-solar-dark transition"
      >
        {address}
      </button>
    );
  }
  return (
    <button
      onClick={connect}
      className={`rounded-lg bg-solar-yellow font-semibold text-solar-dark hover:opacity-90 transition ${
        compact ? "px-3 py-1.5 text-xs" : "px-4 py-1.5 text-sm"
      }`}
    >
      {compact ? "Connect" : "Connect Wallet"}
    </button>
  );
}
