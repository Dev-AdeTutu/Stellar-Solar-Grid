import React, { useCallback, useEffect, useMemo, useState } from 'react';

export interface CarbonListing {
  id: string;
  seller: string;
  amount: number;
  pricePerCredit: number;
  vintage?: string;
  project?: string;
  verified?: boolean;
  createdAt?: string;
}

export interface CarbonMarketplaceProps {
  /** Base URL for the backend marketplace API. */
  apiBaseUrl?: string;
  /** Connected wallet address, if any. */
  walletAddress?: string | null;
  /** Optional callback invoked after a successful purchase. */
  onPurchase?: (listing: CarbonListing, amount: number) => void;
  /** Optional callback invoked after a successful listing. */
  onList?: (listing: CarbonListing) => void;
  /** Optional callback invoked after a successful bid. */
  onBid?: (listingId: string, amount: number, pricePerCredit: number) => void;
}

type StatusType = 'success' | 'error' | 'info';

interface StatusMessage {
  type: StatusType;
  text: string;
}

const DEFAULT_API_BASE_URL = '/api/carbon';

const formatCurrency = (value: number): string => {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

const CarbonMarketplace: React.FC<CarbonMarketplaceProps> = ({
  apiBaseUrl = DEFAULT_API_BASE_URL,
  walletAddress = null,
  onPurchase,
  onList,
  onBid,
}) => {
  const [listings, setListings] = useState<CarbonListing[]>([]);
  const [indexPrice, setIndexPrice] = useState<number | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  // List form state
  const [listAmount, setListAmount] = useState<string>('');
  const [listPrice, setListPrice] = useState<string>('');
  const [listVintage, setListVintage] = useState<string>('');
  const [listProject, setListProject] = useState<string>('');

  // Bid form state
  const [bidListingId, setBidListingId] = useState<string>('');
  const [bidAmount, setBidAmount] = useState<string>('');
  const [bidPrice, setBidPrice] = useState<string>('');

  const isConnected = Boolean(walletAddress);

  const fetchMarketplace = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [listingsRes, priceRes] = await Promise.all([
        fetch(`${apiBaseUrl}/listings`),
        fetch(`${apiBaseUrl}/price`),
      ]);

      if (!listingsRes.ok) {
        throw new Error(`Failed to load listings (${listingsRes.status})`);
      }
      const listingsData = await listingsRes.json();
      const parsedListings: CarbonListing[] = Array.isArray(listingsData)
        ? listingsData
        : Array.isArray(listingsData?.listings)
        ? listingsData.listings
        : [];
      setListings(parsedListings);

      if (priceRes.ok) {
        const priceData = await priceRes.json();
        const price =
          typeof priceData === 'number'
            ? priceData
            : typeof priceData?.indexPrice === 'number'
            ? priceData.indexPrice
            : typeof priceData?.price === 'number'
            ? priceData.price
            : null;
        setIndexPrice(price);
      } else {
        setIndexPrice(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      setStatus({ type: 'error', text: `Unable to load marketplace: ${message}` });
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    void fetchMarketplace();
  }, [fetchMarketplace]);

  const sortedListings = useMemo(() => {
    return [...listings].sort((a, b) => {
      if (a.pricePerCredit !== b.pricePerCredit) {
        return a.pricePerCredit - b.pricePerCredit;
      }
      return (b.amount || 0) - (a.amount || 0);
    });
  }, [listings]);

  const resetStatus = () => setStatus(null);

  const handleListCredits = async (event: React.FormEvent) => {
    event.preventDefault();
    resetStatus();

    if (!isConnected) {
      setStatus({ type: 'error', text: 'Connect your wallet to list credits.' });
      return;
    }

    const amount = Number(listAmount);
    const pricePerCredit = Number(listPrice);

    if (!Number.isFinite(amount) || amount <= 0) {
      setStatus({ type: 'error', text: 'Enter a valid credit amount greater than zero.' });
      return;
    }
    if (!Number.isFinite(pricePerCredit) || pricePerCredit <= 0) {
      setStatus({ type: 'error', text: 'Enter a valid price per credit greater than zero.' });
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(`${apiBaseUrl}/listings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seller: walletAddress,
          amount,
          pricePerCredit,
          vintage: listVintage || undefined,
          project: listProject || undefined,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `Failed to list credits (${response.status})`);
      }

      const created: CarbonListing = await response.json();
      setStatus({
        type: 'success',
        text: `Listed ${amount} credit(s) at ${formatCurrency(pricePerCredit)} each.`,
      });
      setListAmount('');
      setListPrice('');
      setListVintage('');
      setListProject('');
      onList?.(created);
      await fetchMarketplace();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setStatus({ type: 'error', text: `Listing failed: ${message}` });
    } finally {
      setSubmitting(false);
    }
  };

  const handlePlaceBid = async (event: React.FormEvent) => {
    event.preventDefault();
    resetStatus();

    if (!isConnected) {
      setStatus({ type: 'error', text: 'Connect your wallet to place a bid.' });
      return;
    }

    if (!bidListingId) {
      setStatus({ type: 'error', text: 'Select a listing to bid on.' });
      return;
    }

    const amount = Number(bidAmount);
    const pricePerCredit = Number(bidPrice);

    if (!Number.isFinite(amount) || amount <= 0) {
      setStatus({ type: 'error', text: 'Enter a valid bid amount greater than zero.' });
      return;
    }
    if (!Number.isFinite(pricePerCredit) || pricePerCredit <= 0) {
      setStatus({ type: 'error', text: 'Enter a valid bid price greater than zero.' });
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(`${apiBaseUrl}/listings/${bidListingId}/bids`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bidder: walletAddress,
          amount,
          pricePerCredit,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `Failed to place bid (${response.status})`);
      }

      setStatus({
        type: 'success',
        text: `Bid placed: ${amount} credit(s) at ${formatCurrency(pricePerCredit)} each.`,
      });
      setBidAmount('');
      setBidPrice('');
      onBid?.(bidListingId, amount, pricePerCredit);
      await fetchMarketplace();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setStatus({ type: 'error', text: `Bid failed: ${message}` });
    } finally {
      setSubmitting(false);
    }
  };

  const handlePurchase = async (listing: CarbonListing, amount: number) => {
    resetStatus();

    if (!isConnected) {
      setStatus({ type: 'error', text: 'Connect your wallet to purchase credits.' });
      return;
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      setStatus({ type: 'error', text: 'Enter a valid purchase amount.' });
      return;
    }
    if (amount > listing.amount) {
      setStatus({
        type: 'error',
        text: `Only ${listing.amount} credit(s) available in this listing.`,
      });
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(`${apiBaseUrl}/listings/${listing.id}/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buyer: walletAddress,
          amount,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `Failed to purchase credits (${response.status})`);
      }

      setStatus({
        type: 'success',
        text: `Purchased ${amount} credit(s) for ${formatCurrency(
          amount * listing.pricePerCredit,
        )}.`,
      });
      onPurchase?.(listing, amount);
      await fetchMarketplace();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setStatus({ type: 'error', text: `Purchase failed: ${message}` });
    } finally {
      setSubmitting(false);
    }
  };

  const statusColor =
    status?.type === 'success'
      ? '#1a7f37'
      : status?.type === 'error'
      ? '#d1242f'
      : '#0969da';

  return (
    <div className="carbon-marketplace" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0 }}>Carbon Credit Marketplace</h2>
          <p style={{ margin: '4px 0 0', color: '#57606a' }}>
            Buy and sell tokenized carbon credits generated from solar production.
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 12, color: '#57606a' }}>Index Price</div>
          <div style={{ fontSize: 22, fontWeight: 600 }}>
            {indexPrice !== null ? formatCurrency(indexPrice) : '—'}
          </div>
        </div>
      </header>

      {!isConnected && (
        <div
          role="note"
          style={{
            padding: '10px 14px',
            borderRadius: 6,
            background: '#fff8c5',
            border: '1px solid #d4a72c',
            color: '#7d4e00',
          }}
        >
          Connect your wallet to list, bid, or purchase carbon credits.
        </div>
      )}

      {status && (
        <div
          role="status"
          style={{
            padding: '10px 14px',
            borderRadius: 6,
            border: `1px solid ${statusColor}`,
            color: statusColor,
            background: '#ffffff',
          }}
        >
          {status.text}
        </div>
      )}

      {error && (
        <div
          role="alert"
          style={{
            padding: '10px 14px',
            borderRadius: 6,
            border: '1px solid #d1242f',
            color: '#d1242f',
            background: '#ffebe9',
          }}
        >
          {error}
        </div>
      )}

      <section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: '0 0 12px' }}>Open Listings</h3>
          <button
            type="button"
            onClick={() => void fetchMarketplace()}
            disabled={loading || submitting}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid #d0d7de',
              background: '#f6f8fa',
              cursor: loading || submitting ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {loading && listings.length === 0 ? (
          <p style={{ color: '#57606a' }}>Loading listings…</p>
        ) : sortedListings.length === 0 ? (
          <p style={{ color: '#57606a' }}>No open listings available.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #d0d7de' }}>
                <th style={{ padding: '8px 6px' }}>Project</th>
                <th style={{ padding: '8px 6px' }}>Vintage</th>
                <th style={{ padding: '8px 6px' }}>Seller</th>
                <th style={{ padding: '8px 6px' }}>Available</th>
                <th style={{ padding: '8px 6px' }}>Price / Credit</th>
                <th style={{ padding: '8px 6px' }}>Verified</th>
                <th style={{ padding: '8px 6px' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {sortedListings.map((listing) => (
                <ListingRow
                  key={listing.id}
                  listing={listing}
                  disabled={!isConnected || submitting}
                  onPurchase={handlePurchase}
                  onSelectForBid={(id) => {
                    setBidListingId(id);
                    setBidAmount(String(listing.amount));
                    setBidPrice(String(listing.pricePerCredit));
                  }}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 24,
        }}
      >
        <form
          onSubmit={handleListCredits}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: 16,
            border: '1px solid #d0d7de',
            borderRadius: 8,
          }}
        >
          <h3 style={{ margin: 0 }}>List Credits for Sale</h3>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, color: '#57606a' }}>Amount (credits)</span>
            <input
              type="number"
              min="0"
              step="any"
              value={listAmount}
              onChange={(e) => setListAmount(e.target.value)}
              disabled={!isConnected || submitting}
              placeholder="e.g. 10"
              style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #d0d7de' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, color: '#57606a' }}>Price per credit</span>
            <input
              type="number"
              min="0"
              step="any"
              value={listPrice}
              onChange={(e) => setListPrice(e.target.value)}
              disabled={!isConnected || submitting}
              placeholder="e.g. 12.50"
              style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #d0d7de' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, color: '#57606a' }}>Vintage (optional)</span>
            <input
              type="text"
              value={listVintage}
              onChange={(e) => setListVintage(e.target.value)}
              disabled={!isConnected || submitting}
              placeholder="e.g. 2024"
              style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #d0d7de' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, color: '#57606a' }}>Project (optional)</span>
            <input
              type="text"
              value={listProject}
              onChange={(e) => setListProject(e.target.value)}
              disabled={!isConnected || submitting}
              placeholder="e.g. Rooftop Solar - Site A"
              style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #d0d7de' }}
            />
          </label>
          <button
            type="submit"
            disabled={!isConnected || submitting}
            style={{
              marginTop: 4,
              padding: '8px 12px',
              borderRadius: 6,
              border: '1px solid #1f883d',
              background: !isConnected || submitting ? '#94d3a2' : '#1f883d',
              color: '#ffffff',
              cursor: !isConnected || submitting ? 'not-allowed' : 'pointer',
            }}
          >
            {submitting ? 'Submitting…' : 'List Credits'}
          </button>
        </form>

        <form
          onSubmit={handlePlaceBid}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: 16,
            border: '1px solid #d0d7de',
            borderRadius: 8,
          }}
        >
          <h3 style={{ margin: 0 }}>Place a Bid</h3>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, color: '#57606a' }}>Listing</span>
            <select
              value={bidListingId}
              onChange={(e) => setBidListingId(e.target.value)}
              disabled={!isConnected || submitting}
              style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #d0d7de' }}
            >
              <option value="">Select a listing…</option>
              {sortedListings.map((listing) => (
                <option key={listing.id} value={listing.id}>
                  {listing.project || listing.id} — {formatCurrency(listing.pricePerCredit)} / credit
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, color: '#57606a' }}>Amount (credits)</span>
            <input
              type="number"
              min="0"
              step="any"
              value={bidAmount}
              onChange={(e) => setBidAmount(e.target.value)}
              disabled={!isConnected || submitting}
              placeholder="e.g. 5"
              style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #d0d7de' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, color: '#57606a' }}>Bid price per credit</span>
            <input
              type="number"
              min="0"
              step="any"
              value={bidPrice}
              onChange={(e) => setBidPrice(e.target.value)}
              disabled={!isConnected || submitting}
              placeholder="e.g. 11.00"
              style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #d0d7de' }}
            />
          </label>
          <button
            type="submit"
            disabled={!isConnected || submitting}
            style={{
              marginTop: 4,
              padding: '8px 12px',
              borderRadius: 6,
              border: '1px solid #0969da',
              background: !isConnected || submitting ? '#a5c9f5' : '#0969da',
              color: '#ffffff',
              cursor: !isConnected || submitting ? 'not-allowed' : 'pointer',
            }}
          >
            {submitting ? 'Submitting…' : 'Place Bid'}
          </button>
        </form>
      </section>
    </div>
  );
};

interface ListingRowProps {
  listing: CarbonListing;
  disabled: boolean;
  onPurchase: (listing: CarbonListing, amount: number) => void;
  onSelectForBid: (id: string) => void;
}

const ListingRow: React.FC<ListingRowProps> = ({
  listing,
  disabled,
  onPurchase,
  onSelectForBid,
}) => {
  const [amount, setAmount] = useState<string>(String(listing.amount));

  useEffect(() => {
    setAmount(String(listing.amount));
  }, [listing.amount]);

  const parsedAmount = Number(amount);
  const total =
    Number.isFinite(parsedAmount) && parsedAmount > 0
      ? parsedAmount * listing.pricePerCredit
      : 0;

  return (
    <tr style={{ borderBottom: '1px solid #eaeef2' }}>
      <td style={{ padding: '8px 6px' }}>{listing.project || '—'}</td>
      <td style={{ padding: '8px 6px' }}>{listing.vintage || '—'}</td>
      <td style={{ padding: '8px 6px', fontFamily: 'monospace', fontSize: 12 }}>
        {listing.seller
          ? `${listing.seller.slice(0, 6)}…${listing.seller.slice(-4)}`
          : '—'}
      </td>
      <td style={{ padding: '8px 6px' }}>{listing.amount}</td>
      <td style={{ padding: '8px 6px' }}>{formatCurrency(listing.pricePerCredit)}</td>
      <td style={{ padding: '8px 6px' }}>
        {listing.verified ? (
          <span style={{ color: '#1a7f37' }}>✓ Verified</span>
        ) : (
          <span style={{ color: '#9a6700' }}>Pending</span>
        )}
      </td>
      <td style={{ padding: '8px 6px' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="number"
            min="0"
            max={listing.amount}
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={disabled}
            style={{
              width: 72,
              padding: '4px 6px',
              borderRadius: 6,
              border: '1px solid #d0d7de',
            }}
            aria-label={`Amount to purchase from listing ${listing.id}`}
          />
          <button
            type="button"
            onClick={() => onPurchase(listing, parsedAmount)}
            disabled={disabled || !Number.isFinite(parsedAmount) || parsedAmount <= 0}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid #1f883d',
              background:
                disabled || !Number.isFinite(parsedAmount) || parsedAmount <= 0
                  ? '#94d3a2'
                  : '#1f883d',
              color: '#ffffff',
              cursor:
                disabled || !Number.isFinite(parsedAmount) || parsedAmount <= 0
                  ? 'not-allowed'
                  : 'pointer',
            }}
            title={total > 0 ? `Total: ${formatCurrency(total)}` : undefined}
          >
            Buy
          </button>
          <button
            type="button"
            onClick={() => onSelectForBid(listing.id)}
            disabled={disabled}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid #d0d7de',
              background: '#f6f8fa',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            Bid
          </button>
        </div>
      </td>
    </tr>
  );
};

export default CarbonMarketplace;