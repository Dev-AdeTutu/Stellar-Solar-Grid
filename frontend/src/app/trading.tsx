'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DerivativeType = 'future' | 'call' | 'put';
type PositionSide = 'long' | 'short';
type DerivativeStatus = 'open' | 'filled' | 'settled' | 'expired' | 'liquidated';

interface DerivativeOrder {
  id: string;
  type: DerivativeType;
  side: PositionSide;
  quantity: number;
  strikePrice?: number;
  expiry: string;
  price: number;
  status: DerivativeStatus;
  createdAt: string;
}

interface DerivativePosition {
  id: string;
  type: DerivativeType;
  side: PositionSide;
  quantity: number;
  strikePrice?: number;
  expiry: string;
  entryPrice: number;
  currentPrice: number;
  margin: number;
  maintenanceMargin: number;
  unrealizedPnl: number;
  status: DerivativeStatus;
}

interface MarginStatus {
  totalMargin: number;
  usedMargin: number;
  availableMargin: number;
  maintenanceMargin: number;
  marginRatio: number;
  liquidationRisk: boolean;
}

interface CreateOrderPayload {
  type: DerivativeType;
  side: PositionSide;
  quantity: number;
  strikePrice?: number;
  expiry: string;
  price: number;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

const API_BASE = '/api/derivatives';

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Request failed (${res.status}): ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

async function getOpenOrders(): Promise<DerivativeOrder[]> {
  return fetchJson<DerivativeOrder[]>(`${API_BASE}/orders?status=open`);
}

async function getPositions(): Promise<DerivativePosition[]> {
  return fetchJson<DerivativePosition[]>(`${API_BASE}/positions`);
}

async function getMarginStatus(): Promise<MarginStatus> {
  return fetchJson<MarginStatus>(`${API_BASE}/margin`);
}

async function createOrder(payload: CreateOrderPayload): Promise<DerivativeOrder> {
  return fetchJson<DerivativeOrder>(`${API_BASE}/orders`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function settlePosition(id: string): Promise<DerivativePosition> {
  return fetchJson<DerivativePosition>(`${API_BASE}/positions/${encodeURIComponent(id)}/settle`, {
    method: 'POST',
  });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function typeLabel(type: DerivativeType): string {
  switch (type) {
    case 'future':
      return 'Future';
    case 'call':
      return 'Call Option';
    case 'put':
      return 'Put Option';
    default:
      return type;
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: DerivativeStatus }) {
  const colorMap: Record<DerivativeStatus, string> = {
    open: '#2563eb',
    filled: '#059669',
    settled: '#6b7280',
    expired: '#b45309',
    liquidated: '#dc2626',
  };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 9999,
        fontSize: 12,
        fontWeight: 600,
        color: '#fff',
        backgroundColor: colorMap[status] ?? '#6b7280',
        textTransform: 'capitalize',
      }}
    >
      {status}
    </span>
  );
}

function MarginPanel({ margin }: { margin: MarginStatus | null }) {
  if (!margin) {
    return <p style={{ color: '#6b7280' }}>Loading margin status…</p>;
  }
  return (
    <div
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        padding: 16,
        backgroundColor: margin.liquidationRisk ? '#fef2f2' : '#f9fafb',
      }}
    >
      <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>Margin Status</h3>
      {margin.liquidationRisk && (
        <p style={{ color: '#dc2626', fontWeight: 600, margin: '0 0 12px' }}>
          ⚠️ Liquidation risk: margin ratio below maintenance requirement.
        </p>
      )}
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 12,
          margin: 0,
        }}
      >
        <div>
          <dt style={{ fontSize: 12, color: '#6b7280' }}>Total Margin</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>{formatCurrency(margin.totalMargin)}</dd>
        </div>
        <div>
          <dt style={{ fontSize: 12, color: '#6b7280' }}>Used Margin</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>{formatCurrency(margin.usedMargin)}</dd>
        </div>
        <div>
          <dt style={{ fontSize: 12, color: '#6b7280' }}>Available Margin</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>{formatCurrency(margin.availableMargin)}</dd>
        </div>
        <div>
          <dt style={{ fontSize: 12, color: '#6b7280' }}>Maintenance Margin</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>{formatCurrency(margin.maintenanceMargin)}</dd>
        </div>
        <div>
          <dt style={{ fontSize: 12, color: '#6b7280' }}>Margin Ratio</dt>
          <dd
            style={{
              margin: 0,
              fontWeight: 600,
              color: margin.liquidationRisk ? '#dc2626' : 'inherit',
            }}
          >
            {formatPercent(margin.marginRatio)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function DerivativesTradingPage() {
  const [orders, setOrders] = useState<DerivativeOrder[]>([]);
  const [positions, setPositions] = useState<DerivativePosition[]>([]);
  const [margin, setMargin] = useState<MarginStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [settlingId, setSettlingId] = useState<string | null>(null);

  // Form state
  const [formType, setFormType] = useState<DerivativeType>('future');
  const [formSide, setFormSide] = useState<PositionSide>('long');
  const [formQuantity, setFormQuantity] = useState<string>('1');
  const [formStrike, setFormStrike] = useState<string>('');
  const [formExpiry, setFormExpiry] = useState<string>('');
  const [formPrice, setFormPrice] = useState<string>('');
  const [formError, setFormError] = useState<string | null>(null);

  const isOption = formType === 'call' || formType === 'put';

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ordersData, positionsData, marginData] = await Promise.all([
        getOpenOrders(),
        getPositions(),
        getMarginStatus(),
      ]);
      setOrders(ordersData);
      setPositions(positionsData);
      setMargin(marginData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load derivatives data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const resetForm = () => {
    setFormType('future');
    setFormSide('long');
    setFormQuantity('1');
    setFormStrike('');
    setFormExpiry('');
    setFormPrice('');
    setFormError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const quantity = Number(formQuantity);
    const price = Number(formPrice);
    const strike = Number(formStrike);

    if (!Number.isFinite(quantity) || quantity <= 0) {
      setFormError('Quantity must be a positive number.');
      return;
    }
    if (!Number.isFinite(price) || price <= 0) {
      setFormError('Price must be a positive number.');
      return;
    }
    if (!formExpiry) {
      setFormError('Expiry date is required.');
      return;
    }
    if (new Date(formExpiry).getTime() <= Date.now()) {
      setFormError('Expiry must be in the future.');
      return;
    }
    if (isOption && (!Number.isFinite(strike) || strike <= 0)) {
      setFormError('Strike price is required for options.');
      return;
    }

    const payload: CreateOrderPayload = {
      type: formType,
      side: formSide,
      quantity,
      expiry: new Date(formExpiry).toISOString(),
      price,
    };
    if (isOption) {
      payload.strikePrice = strike;
    }

    setSubmitting(true);
    try {
      const created = await createOrder(payload);
      setOrders((prev) => [created, ...prev]);
      resetForm();
      // Refresh margin/positions after placing an order.
      const [positionsData, marginData] = await Promise.all([getPositions(), getMarginStatus()]);
      setPositions(positionsData);
      setMargin(marginData);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create order');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSettle = async (id: string) => {
    setSettlingId(id);
    setError(null);
    try {
      const settled = await settlePosition(id);
      setPositions((prev) => prev.map((p) => (p.id === id ? settled : p)));
      const marginData = await getMarginStatus();
      setMargin(marginData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to settle position');
    } finally {
      setSettlingId(null);
    }
  };

  const openPositions = useMemo(
    () => positions.filter((p) => p.status === 'open' || p.status === 'filled'),
    [positions],
  );

  const settledPositions = useMemo(
    () => positions.filter((p) => p.status !== 'open' && p.status !== 'filled'),
    [positions],
  );

  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: '0 0 8px', fontSize: 28 }}>Energy Credit Derivatives</h1>
        <p style={{ margin: 0, color: '#6b7280' }}>
          Trade futures and options on energy credits to hedge price risk.
        </p>
      </header>

      {error && (
        <div
          role="alert"
          style={{
            padding: 12,
            marginBottom: 16,
            borderRadius: 8,
            backgroundColor: '#fef2f2',
            color: '#dc2626',
            border: '1px solid #fecaca',
          }}
        >
          {error}
        </div>
      )}

      <section style={{ marginBottom: 24 }}>
        <MarginPanel margin={margin} />
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 24 }}>
        {/* New order form */}
        <section
          style={{
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            padding: 16,
          }}
        >
          <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>New Derivative Order</h2>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Instrument Type</span>
              <select
                value={formType}
                onChange={(e) => setFormType(e.target.value as DerivativeType)}
                style={{ padding: 8, borderRadius: 6, border: '1px solid #d1d5db' }}
              >
                <option value="future">Future</option>
                <option value="call">Call Option</option>
                <option value="put">Put Option</option>
              </select>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Side</span>
              <select
                value={formSide}
                onChange={(e) => setFormSide(e.target.value as PositionSide)}
                style={{ padding: 8, borderRadius: 6, border: '1px solid #d1d5db' }}
              >
                <option value="long">Long</option>
                <option value="short">Short</option>
              </select>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Quantity (credits)</span>
              <input
                type="number"
                min="1"
                step="1"
                value={formQuantity}
                onChange={(e) => setFormQuantity(e.target.value)}
                style={{ padding: 8, borderRadius: 6, border: '1px solid #d1d5db' }}
              />
            </label>

            {isOption && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Strike Price (USD)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={formStrike}
                  onChange={(e) => setFormStrike(e.target.value)}
                  placeholder="e.g. 25.00"
                  style={{ padding: 8, borderRadius: 6, border: '1px solid #d1d5db' }}
                />
              </label>
            )}

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Expiry</span>
              <input
                type="datetime-local"
                value={formExpiry}
                onChange={(e) => setFormExpiry(e.target.value)}
                style={{ padding: 8, borderRadius: 6, border: '1px solid #d1d5db' }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Limit Price (USD)</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={formPrice}
                onChange={(e) => setFormPrice(e.target.value)}
                placeholder="e.g. 24.50"
                style={{ padding: 8, borderRadius: 6, border: '1px solid #d1d5db' }}
              />
            </label>

            {formError && (
              <p role="alert" style={{ color: '#dc2626', margin: 0, fontSize: 13 }}>
                {formError}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              style={{
                padding: '10px 16px',
                borderRadius: 6,
                border: 'none',
                backgroundColor: submitting ? '#93c5fd' : '#2563eb',
                color: '#fff',
                fontWeight: 600,
                cursor: submitting ? 'not-allowed' : 'pointer',
              }}
            >
              {submitting ? 'Submitting…' : 'Place Order'}
            </button>
          </form>
        </section>

        {/* Open orders */}
        <section
          style={{
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            padding: 16,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>Open Orders</h2>
            <button
              type="button"
              onClick={() => void loadData()}
              disabled={loading}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                border: '1px solid #d1d5db',
                backgroundColor: '#fff',
                cursor: loading ? 'not-allowed' : 'pointer',
                fontSize: 13,
              }}
            >
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          {loading && orders.length === 0 ? (
            <p style={{ color: '#6b7280' }}>Loading orders…</p>
          ) : orders.length === 0 ? (
            <p style={{ color: '#6b7280' }}>No open orders.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>
                    <th style={{ padding: '6px 4px' }}>Type</th>
                    <th style={{ padding: '6px 4px' }}>Side</th>
                    <th style={{ padding: '6px 4px' }}>Qty</th>
                    <th style={{ padding: '6px 4px' }}>Strike</th>
                    <th style={{ padding: '6px 4px' }}>Price</th>
                    <th style={{ padding: '6px 4px' }}>Expiry</th>
                    <th style={{ padding: '6px 4px' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '6px 4px' }}>{typeLabel(o.type)}</td>
                      <td style={{ padding: '6px 4px', textTransform: 'capitalize' }}>{o.side}</td>
                      <td style={{ padding: '6px 4px' }}>{o.quantity}</td>
                      <td style={{ padding: '6px 4px' }}>
                        {o.strikePrice != null ? formatCurrency(o.strikePrice) : '—'}
                      </td>
                      <td style={{ padding: '6px 4px' }}>{formatCurrency(o.price)}</td>
                      <td style={{ padding: '6px 4px' }}>{formatDate(o.expiry)}</td>
                      <td style={{ padding: '6px 4px' }}>
                        <StatusBadge status={o.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* Positions */}
      <section
        style={{
          marginTop: 24,
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          padding: 16,
        }}
      >
        <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>Positions</h2>

        {openPositions.length === 0 && settledPositions.length === 0 ? (
          <p style={{ color: '#6b7280' }}>No positions.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>
                  <th style={{ padding: '6px 4px' }}>Type</th>
                  <th style={{ padding: '6px 4px' }}>Side</th>
                  <th style={{ padding: '6px 4px' }}>Qty</th>
                  <th style={{ padding: '6px 4px' }}>Strike</th>
                  <th style={{ padding: '6px 4px' }}>Expiry</th>
                  <th style={{ padding: '6px 4px' }}>Entry</th>
                  <th style={{ padding: '6px 4px' }}>Current</th>
                  <th style={{ padding: '6px 4px' }}>Margin</th>
                  <th style={{ padding: '6px 4px' }}>Unrealized PnL</th>
                  <th style={{ padding: '6px 4px' }}>Status</th>
                  <th style={{ padding: '6px 4px' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {[...openPositions, ...settledPositions].map((p) => {
                  const isOpen = p.status === 'open' || p.status === 'filled';
                  return (
                    <tr key={p.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '6px 4px' }}>{typeLabel(p.type)}</td>
                      <td style={{ padding: '6px 4px', textTransform: 'capitalize' }}>{p.side}</td>
                      <td style={{ padding: '6px 4px' }}>{p.quantity}</td>
                      <td style={{ padding: '6px 4px' }}>
                        {p.strikePrice != null ? formatCurrency(p.strikePrice) : '—'}
                      </td>
                      <td style={{ padding: '6px 4px' }}>{formatDate(p.expiry)}</td>
                      <td style={{ padding: '6px 4px' }}>{formatCurrency(p.entryPrice)}</td>
                      <td style={{ padding: '6px 4px' }}>{formatCurrency(p.currentPrice)}</td>
                      <td style={{ padding: '6px 4px' }}>
                        {formatCurrency(p.margin)}
                        <div style={{ fontSize: 11, color: '#6b7280' }}>
                          maint {formatCurrency(p.maintenanceMargin)}
                        </div>
                      </td>
                      <td
                        style={{
                          padding: '6px 4px',
                          fontWeight: 600,
                          color: p.unrealizedPnl >= 0 ? '#059669' : '#dc2626',
                        }}
                      >
                        {formatCurrency(p.unrealizedPnl)}
                      </td>
                      <td style={{ padding: '6px 4px' }}>
                        <StatusBadge status={p.status} />
                      </td>
                      <td style={{ padding: '6px 4px' }}>
                        {isOpen ? (
                          <button
                            type="button"
                            onClick={() => void handleSettle(p.id)}
                            disabled={settlingId === p.id}
                            style={{
                              padding: '4px 10px',
                              borderRadius: 6,
                              border: '1px solid #d1d5db',
                              backgroundColor: '#fff',
                              cursor: settlingId === p.id ? 'not-allowed' : 'pointer',
                              fontSize: 12,
                            }}
                          >
                            {settlingId === p.id ? 'Settling…' : 'Settle'}
                          </button>
                        ) : (
                          <span style={{ color: '#9ca3af' }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}