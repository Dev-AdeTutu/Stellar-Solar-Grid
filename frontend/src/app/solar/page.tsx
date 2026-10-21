'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

/**
 * Community Solar Farm Marketplace
 *
 * Lists available community solar farms, allows a connected wallet to purchase
 * shares via the `buy_solar_share` contract entry point, and displays the
 * user's current share holdings and accrued generation credits.
 */

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

export interface SolarFarm {
  id: string;
  name: string;
  location: string;
  capacityKw: number;
  totalShares: number;
  availableShares: number;
  pricePerShare: number;
  totalGenerationKwh: number;
  creditPerKwh: number;
}

export interface ShareHolding {
  farmId: string;
  farmName: string;
  shares: number;
  accruedCredits: number;
}

interface ApiEnvelope<T> {
  data?: T;
  error?: string;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let message = `Request failed with status ${res.status}`;
    try {
      const body = (await res.json()) as ApiEnvelope<T>;
      if (body?.error) message = body.error;
    } catch {
      // ignore JSON parse errors, keep default message
    }
    throw new Error(message);
  }
  const body = (await res.json()) as ApiEnvelope<T> | T;
  if (body && typeof body === 'object' && 'data' in (body as ApiEnvelope<T>)) {
    const envelope = body as ApiEnvelope<T>;
    if (envelope.error) throw new Error(envelope.error);
    return envelope.data as T;
  }
  return body as T;
}

function formatNumber(value: number, fractionDigits = 2): string {
  if (!Number.isFinite(value)) return '0';
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  });
}

function formatCurrency(value: number): string {
  if (!Number.isFinite(value)) return '$0.00';
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function SolarFarmMarketplacePage() {
  const [farms, setFarms] = useState<SolarFarm[]>([]);
  const [holdings, setHoldings] = useState<ShareHolding[]>([]);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);

  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedFarm, setSelectedFarm] = useState<SolarFarm | null>(null);
  const [shareAmount, setShareAmount] = useState<number>(1);
  const [purchasing, setPurchasing] = useState<boolean>(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [purchaseSuccess, setPurchaseSuccess] = useState<string | null>(null);

  const loadFarms = useCallback(async () => {
    const data = await fetchJson<SolarFarm[]>(`${API_BASE}/api/solar/farms`);
    setFarms(Array.isArray(data) ? data : []);
  }, []);

  const loadHoldings = useCallback(async (address: string) => {
    const data = await fetchJson<ShareHolding[]>(
      `${API_BASE}/api/solar/holdings?address=${encodeURIComponent(address)}`,
    );
    setHoldings(Array.isArray(data) ? data : []);
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await loadFarms();
      if (walletAddress) {
        await loadHoldings(walletAddress);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load solar farms');
    } finally {
      setLoading(false);
    }
  }, [loadFarms, loadHoldings, walletAddress]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const connectWallet = useCallback(async () => {
    setError(null);
    try {
      const injected = (globalThis as unknown as {
        ethereum?: { request: (args: { method: string }) => Promise<unknown> };
      }).ethereum;

      if (!injected?.request) {
        throw new Error('No wallet provider detected. Please install a wallet.');
      }

      const accounts = (await injected.request({
        method: 'eth_requestAccounts',
      })) as string[];

      const address = accounts?.[0];
      if (!address) throw new Error('No wallet account returned');

      setWalletAddress(address);
      await loadHoldings(address);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect wallet');
    }
  }, [loadHoldings]);

  const openPurchase = useCallback((farm: SolarFarm) => {
    setSelectedFarm(farm);
    setShareAmount(1);
    setPurchaseError(null);
    setPurchaseSuccess(null);
  }, []);

  const closePurchase = useCallback(() => {
    if (purchasing) return;
    setSelectedFarm(null);
    setPurchaseError(null);
  }, [purchasing]);

  const confirmPurchase = useCallback(async () => {
    if (!selectedFarm) return;
    if (!walletAddress) {
      setPurchaseError('Connect your wallet before purchasing shares.');
      return;
    }
    if (!Number.isInteger(shareAmount) || shareAmount < 1) {
      setPurchaseError('Enter a whole number of shares (minimum 1).');
      return;
    }
    if (shareAmount > selectedFarm.availableShares) {
      setPurchaseError(
        `Only ${selectedFarm.availableShares} shares are available for this farm.`,
      );
      return;
    }

    setPurchasing(true);
    setPurchaseError(null);
    setPurchaseSuccess(null);

    try {
      const result = await fetchJson<{ txHash?: string }>(
        `${API_BASE}/api/solar/buy-share`,
        {
          method: 'POST',
          body: JSON.stringify({
            farmId: selectedFarm.id,
            shares: shareAmount,
            buyer: walletAddress,
          }),
        },
      );

      setPurchaseSuccess(
        result?.txHash
          ? `Purchase confirmed. Transaction: ${result.txHash}`
          : 'Purchase confirmed.',
      );

      await loadFarms();
      await loadHoldings(walletAddress);
      setSelectedFarm(null);
    } catch (err) {
      setPurchaseError(
        err instanceof Error ? err.message : 'Failed to purchase shares',
      );
    } finally {
      setPurchasing(false);
    }
  }, [selectedFarm, walletAddress, shareAmount, loadFarms, loadHoldings]);

  const totalCredits = useMemo(
    () => holdings.reduce((sum, h) => sum + (h.accruedCredits || 0), 0),
    [holdings],
  );

  const totalSharesHeld = useMemo(
    () => holdings.reduce((sum, h) => sum + (h.shares || 0), 0),
    [holdings],
  );

  const estimatedCost = useMemo(() => {
    if (!selectedFarm) return 0;
    return selectedFarm.pricePerShare * (Number.isFinite(shareAmount) ? shareAmount : 0);
  }, [selectedFarm, shareAmount]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">
            Community Solar Farms
          </h1>
          <p className="mt-2 text-gray-600">
            Invest in shared solar generation and earn credits proportional to
            your shares — no rooftop required.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {walletAddress ? (
            <span className="rounded-full bg-green-100 px-4 py-2 text-sm font-medium text-green-800">
              {walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void connectWallet()}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              Connect Wallet
            </button>
          )}
          <Link
            href="/dashboard"
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Dashboard
          </Link>
        </div>
      </header>

      {walletAddress && (
        <section className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <p className="text-sm text-gray-500">Shares Held</p>
            <p className="mt-1 text-2xl font-semibold text-gray-900">
              {formatNumber(totalSharesHeld, 0)}
            </p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <p className="text-sm text-gray-500">Accrued Credits</p>
            <p className="mt-1 text-2xl font-semibold text-gray-900">
              {formatCurrency(totalCredits)}
            </p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <p className="text-sm text-gray-500">Farms Invested</p>
            <p className="mt-1 text-2xl font-semibold text-gray-900">
              {holdings.length}
            </p>
          </div>
        </section>
      )}

      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
          <span className="ml-3 text-gray-600">Loading solar farms…</span>
        </div>
      )}

      {!loading && error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-6">
          <p className="font-medium text-red-800">Unable to load solar farms</p>
          <p className="mt-1 text-sm text-red-700">{error}</p>
          <button
            type="button"
            onClick={() => void loadAll()}
            className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && farms.length === 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-10 text-center">
          <p className="text-gray-700">No community solar farms available yet.</p>
        </div>
      )}

      {!loading && !error && farms.length > 0 && (
        <section className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {farms.map((farm) => {
            const soldOut = farm.availableShares <= 0;
            return (
              <article
                key={farm.id}
                className="flex flex-col rounded-xl border border-gray-200 bg-white p-6 shadow-sm"
              >
                <h2 className="text-lg font-semibold text-gray-900">
                  {farm.name}
                </h2>
                <p className="text-sm text-gray-500">{farm.location}</p>

                <dl className="mt-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Capacity</dt>
                    <dd className="font-medium text-gray-900">
                      {formatNumber(farm.capacityKw)} kW
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Available Shares</dt>
                    <dd className="font-medium text-gray-900">
                      {formatNumber(farm.availableShares, 0)} /{' '}
                      {formatNumber(farm.totalShares, 0)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Price per Share</dt>
                    <dd className="font-medium text-gray-900">
                      {formatCurrency(farm.pricePerShare)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Total Generation</dt>
                    <dd className="font-medium text-gray-900">
                      {formatNumber(farm.totalGenerationKwh)} kWh
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Credit per kWh</dt>
                    <dd className="font-medium text-gray-900">
                      {formatCurrency(farm.creditPerKwh)}
                    </dd>
                  </div>
                </dl>

                <button
                  type="button"
                  disabled={soldOut}
                  onClick={() => openPurchase(farm)}
                  className="mt-6 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-600"
                >
                  {soldOut ? 'Sold Out' : 'Buy Shares'}
                </button>
              </article>
            );
          })}
        </section>
      )}

      {walletAddress && holdings.length > 0 && (
        <section className="mt-12">
          <h2 className="mb-4 text-xl font-semibold text-gray-900">
            Your Holdings
          </h2>
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">
                    Farm
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">
                    Shares
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">
                    Accrued Credits
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {holdings.map((holding) => (
                  <tr key={holding.farmId}>
                    <td className="px-4 py-3 text-gray-900">
                      {holding.farmName}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-900">
                      {formatNumber(holding.shares, 0)}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-900">
                      {formatCurrency(holding.accruedCredits)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {selectedFarm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="purchase-dialog-title"
        >
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2
              id="purchase-dialog-title"
              className="text-lg font-semibold text-gray-900"
            >
              Confirm Purchase
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              {selectedFarm.name} · {formatCurrency(selectedFarm.pricePerShare)}{' '}
              per share
            </p>

            <label
              htmlFor="share-amount"
              className="mt-4 block text-sm font-medium text-gray-700"
            >
              Number of shares
            </label>
            <input
              id="share-amount"
              type="number"
              min={1}
              max={selectedFarm.availableShares}
              step={1}
              value={shareAmount}
              onChange={(e) => setShareAmount(Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />

            <div className="mt-4 flex justify-between text-sm">
              <span className="text-gray-500">Estimated cost</span>
              <span className="font-semibold text-gray-900">
                {formatCurrency(estimatedCost)}
              </span>
            </div>

            {purchaseError && (
              <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {purchaseError}
              </p>
            )}

            {purchaseSuccess && (
              <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
                {purchaseSuccess}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={closePurchase}
                disabled={purchasing}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmPurchase()}
                disabled={purchasing}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {purchasing ? 'Purchasing…' : 'Confirm Purchase'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}