"use client";

import { useState, useEffect, useRef } from "react";
import { useToast } from "@/components/ToastProvider";
import { Skeleton } from "@/components/Skeleton";

export interface Collaborator {
  address: string;
  basisPoints: number; // 100 = 1%
}

interface Props {
  collaborators: Collaborator[];
  loading?: boolean;
  onAdd: (address: string, basisPoints: number) => Promise<void>;
  onRemove: (address: string) => Promise<void>;
  onRefresh?: () => Promise<void>;
}

import styles from './CollaboratorTable.module.css';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001";
const MAX_BASIS_POINTS = 10000;

interface TotalSharesResponse {
  total_basis_points: number;
  remaining: number;
}

export default function CollaboratorTable({ collaborators, loading, onAdd, onRemove, onRefresh }: Props) {
  const { showToast } = useToast();
  const [copied, setCopied] = useState<string | null>(null);
  const [newAddress, setNewAddress] = useState("");
  const [newBasisPoints, setNewBasisPoints] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [isRemoving, setIsRemoving] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [totalShares, setTotalShares] = useState<TotalSharesResponse | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  async function fetchTotalShares() {
    try {
      const res = await fetch(`${BACKEND_URL}/api/collaborators/total-shares`);
      if (!res.ok) return;
      const data: TotalSharesResponse = await res.json();
      setTotalShares(data);
    } catch {
      // Best-effort — remaining-bps display simply stays hidden on failure.
    }
  }

  // Fetch on mount and whenever the collaborator list changes.
  useEffect(() => {
    fetchTotalShares();
  }, [collaborators]);

  // Focus trap + Escape key for confirmation dialog
  useEffect(() => {
    if (!confirmRemove) return;

    // Focus the dialog when it opens
    const el = dialogRef.current;
    if (!el) return;
    const focusable = el.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setConfirmRemove(null);
        return;
      }
      if (e.key === "Tab") {
        if (focusable.length === 0) { e.preventDefault(); return; }
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last?.focus(); }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [confirmRemove]);

  function copyAddress(address: string) {
    navigator.clipboard.writeText(address);
    setCopied(address);
    setTimeout(() => setCopied(null), 1500);
  }

  const remaining = totalShares?.remaining ?? MAX_BASIS_POINTS - collaborators.reduce((sum, c) => sum + c.basisPoints, 0);
  const parsedBasisPoints = Number(newBasisPoints);
  const exceedsRemaining = newBasisPoints !== "" && Number.isFinite(parsedBasisPoints) && parsedBasisPoints > remaining;

  async function handleAddSubmit() {
    const address = newAddress.trim();
    if (!address || !newBasisPoints || !Number.isFinite(parsedBasisPoints) || parsedBasisPoints <= 0) {
      return;
    }
    if (parsedBasisPoints > remaining) {
      showToast({
        title: "Exceeds allocatable shares",
        description: `Only ${remaining} basis points remain (10,000 total cap).`,
        variant: "error",
      });
      return;
    }

    setIsAdding(true);
    try {
      await onAdd(address, parsedBasisPoints);
      setNewAddress("");
      setNewBasisPoints("");
      await onRefresh?.();
      await fetchTotalShares();
    } finally {
      setIsAdding(false);
    }
  }

  async function handleRemove(address: string) {
    setConfirmRemove(null);
    setIsRemoving(address);
    try {
      await onRemove(address);
      await onRefresh?.();
      await fetchTotalShares();
    } finally {
      setIsRemoving(null);
    }
  }

  if (loading) {
    return (
      <div className="card overflow-x-auto">
        <span className="badge">Collaborators</span>
        <table className="collab-table">
          <thead>
            <tr>
              <th>Address</th>
              <th className="text-right">Share</th>
            </tr>
          </thead>
          <tbody>
            {[0, 1, 2].map((i) => (
              <tr key={i}>
                <td className="py-3"><Skeleton width="70%" height={14} /></td>
                <td className="py-3"><Skeleton width="40%" height={14} /></td>
                <td className="py-3" style={{ textAlign: "right" }}><Skeleton width="60px" height={28} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Empty state — helpful message instead of silent null
  if (!collaborators.length) {
    return (
      <div className="card">
        <span className="badge">Collaborators</span>
        <p className={`text-sm mt-2 ${styles.emptyMessage}`}>
          No collaborators found. Initialize the contract to add collaborators.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Confirmation dialog */}
      {confirmRemove && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-remove-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
        >
          <div
            ref={dialogRef}
            className="w-full max-w-sm rounded-xl border border-white/10 bg-solar-accent p-6 shadow-2xl space-y-4"
          >            <h3 id="confirm-remove-title" className="text-base font-semibold text-white">
              Remove Collaborator?
            </h3>
            <p className="text-sm text-gray-400">
              This will remove{" "}
              <span className="font-mono text-white">
                {confirmRemove.slice(0, 8)}…{confirmRemove.slice(-6)}
              </span>{" "}
              and their revenue share allocation. This cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmRemove(null)}
                className="px-4 py-2 text-sm rounded-lg border border-white/10 text-gray-300 hover:border-white/30 transition"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRemove(confirmRemove)}
                className="px-4 py-2 text-sm rounded-lg bg-red-500/20 border border-red-500/40 text-red-400 hover:bg-red-500/30 transition"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="card overflow-x-auto">
        <span className="badge">Collaborators</span>
        <table className="collab-table">
          <thead>
            <tr>
              <th>Address</th>
              <th className="text-right">Share</th>
            </tr>
          </thead>
          <tbody>
            {collaborators.map((c) => (
              <tr key={c.address}>
                <td>
                  <div className="address-cell">
                    <span title={c.address} className="address-truncated">
                      {c.address.slice(0, 8)}...{c.address.slice(-6)}
                    </span>
                    <button
                      className="copy-btn-sm"
                      onClick={() => copyAddress(c.address)}
                      title="Copy address"
                    >
                      {copied === c.address ? "✓" : "⧉"}
                    </button>
                  </div>
                </td>
                <td className={styles.shareCell}>
                  <span className={styles.shareLabel}>
                    {(c.basisPoints / 100).toFixed(2)}%
                  </span>
                  <div
                    className="share-bar"
                    style={{ width: `${c.basisPoints / 100}%` }}
                    role="meter"
                    aria-valuenow={c.basisPoints / 100}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${(c.basisPoints / 100).toFixed(2)}% share`}
                  />
                </td>
                <td style={{ textAlign: "right" }}>
                  <button
                    onClick={() => setConfirmRemove(c.address)}
                    disabled={isRemoving !== null || isAdding}
                    className="text-red-400 hover:text-red-300 disabled:opacity-40 text-xs px-2.5 py-1 border border-red-500/30 rounded-lg hover:bg-red-500/10 transition"
                  >
                    {isRemoving === c.address ? "Removing..." : "Remove"}
                  </button>
                </td>
              </tr>
            ))}

            {/* Inline Add Collaborator Form Row */}
            <tr>
              <td className="pt-4">
                <input
                  type="text"
                  placeholder="Stellar Address (G...)"
                  value={newAddress}
                  onChange={(e) => setNewAddress(e.target.value)}
                  disabled={isAdding || isRemoving !== null}
                  className="w-full bg-solar-dark border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-solar-yellow transition"
                />
              </td>
              <td className="pt-4">
                <input
                  type="number"
                  placeholder="Basis points (100 = 1%)"
                  value={newBasisPoints}
                  onChange={(e) => setNewBasisPoints(e.target.value)}
                  disabled={isAdding || isRemoving !== null}
                  aria-invalid={exceedsRemaining}
                  className={`w-full bg-solar-dark border rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none transition ${
                    exceedsRemaining ? "border-red-500/60 focus:border-red-500" : "border-white/10 focus:border-solar-yellow"
                  }`}
                />
              </td>
              <td className="pt-4" style={{ textAlign: "right" }}>
                <button
                  onClick={handleAddSubmit}
                  disabled={isAdding || isRemoving !== null || exceedsRemaining}
                  className="bg-solar-yellow text-solar-dark text-xs font-semibold px-4 py-1.5 rounded-lg hover:opacity-90 disabled:opacity-50 transition"
                >
                  {isAdding ? "Adding..." : "Add"}
                </button>
              </td>
            </tr>
            <tr>
              <td colSpan={2} className={`text-xs pt-1 ${exceedsRemaining ? "text-red-400" : "text-gray-500"}`}>
                {exceedsRemaining
                  ? `Exceeds remaining allocation — only ${remaining} bps (${(remaining / 100).toFixed(2)}%) left of the 10,000 cap.`
                  : `${remaining} bps (${(remaining / 100).toFixed(2)}%) remaining of the 10,000 cap.`}
              </td>
              <td />
            </tr>
          </tbody>
          <tfoot>
            <tr className={styles.totalRow}>
              <td colSpan={2} className={styles.totalLabel}>Total</td>
              <td className={`${styles.totalValue} ${collaborators.reduce((sum, c) => sum + c.basisPoints, 0) > 10000 ? styles.totalExceeded : ""}`}>
                {(collaborators.reduce((sum, c) => sum + c.basisPoints, 0) / 100).toFixed(2)}%
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}
