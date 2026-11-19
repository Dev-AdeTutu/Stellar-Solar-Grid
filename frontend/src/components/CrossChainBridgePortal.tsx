import React, { useState } from 'react';
import { keccak256 } from 'ethers';

export type SupportedChain = 'Stellar' | 'Ethereum' | 'Polygon' | 'Arbitrum';

/**
 * Validates an Ethereum address against the EIP-55 mixed-case checksum.
 * Returns an error message string, or null when the address is valid.
 */
export const validateEthereumAddress = (address: string): string | null => {
  const trimmed = address.trim();
  if (!trimmed) return 'Ethereum address is required.';
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return 'Ethereum address must be 42 characters: 0x followed by 40 hex digits.';
  }

  const body = trimmed.slice(2);
  // All-lowercase / all-uppercase inputs carry no checksum information.
  if (body === body.toLowerCase() || body === body.toUpperCase()) {
    return 'Address must use EIP-55 mixed-case checksum.';
  }

  const hash = keccak256(new TextEncoder().encode(body.toLowerCase())).slice(2);
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (/[0-9]/.test(char)) continue;
    const shouldBeUpper = parseInt(hash[i], 16) >= 8;
    if (shouldBeUpper && char !== char.toUpperCase()) {
      return 'Invalid EIP-55 checksum. Please verify the address.';
    }
    if (!shouldBeUpper && char !== char.toLowerCase()) {
      return 'Invalid EIP-55 checksum. Please verify the address.';
    }
  }
  return null;
};

export const CrossChainBridgePortal: React.FC = () => {
  const [selectedChain, setSelectedChain] = useState<SupportedChain>('Polygon');
  const [balances, setBalances] = useState<Record<SupportedChain, number>>({
    Stellar: 1450,
    Ethereum: 620,
    Polygon: 890,
    Arbitrum: 240,
  });
  const [amount, setAmount] = useState<number>(100);
  const [meterId, setMeterId] = useState<string>('MTR-SOLAR-8821');
  const [ethereumAddress, setEthereumAddress] = useState<string>('');
  const [addressError, setAddressError] = useState<string | null>(null);
  const [txHistory, setTxHistory] = useState<string[]>([
    'Wrapped 300 SOLAR -> Polygon (wSOLAR)',
    'Cross-Chain Payment: 85 wSOLAR from Ethereum to MTR-SOLAR-4410',
  ]);

  const unifiedBalance = Object.values(balances).reduce((acc, v) => acc + v, 0);

  const requiresEthereumAddress = selectedChain === 'Ethereum';

  const isAddressValid = (): boolean => {
    if (!requiresEthereumAddress) return true;
    const error = validateEthereumAddress(ethereumAddress);
    setAddressError(error);
    return error === null;
  };

  const handleAddressBlur = () => {
    if (!requiresEthereumAddress) return;
    setAddressError(validateEthereumAddress(ethereumAddress));
  };

  const handleWrap = () => {
    if (!isAddressValid()) return;
    if (balances.Stellar < amount || amount <= 0) return;
    setBalances((prev) => ({
      ...prev,
      Stellar: prev.Stellar - amount,
      [selectedChain]: prev[selectedChain] + amount,
    }));
    setTxHistory((h) => [`Wrapped ${amount} SOLAR -> ${selectedChain} (wSOLAR)`, ...h]);
  };

  const handleUnwrap = () => {
    if (!isAddressValid()) return;
    if (balances[selectedChain] < amount || amount <= 0) return;
    setBalances((prev) => ({
      ...prev,
      [selectedChain]: prev[selectedChain] - amount,
      Stellar: prev.Stellar + amount,
    }));
    setTxHistory((h) => [`Unwrapped ${amount} wSOLAR from ${selectedChain} -> Stellar`, ...h]);
  };

  const handleCrossChainPayment = () => {
    if (!isAddressValid()) return;
    if (balances[selectedChain] < amount || amount <= 0) return;
    setBalances((prev) => ({
      ...prev,
      [selectedChain]: prev[selectedChain] - amount,
    }));
    setTxHistory((h) => [
      `Cross-Chain Payment: ${amount} wSOLAR on ${selectedChain} -> Meter ${meterId}`,
      ...h,
    ]);
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <header className="flex flex-wrap justify-between items-center border-b pb-4">
        <div>
          <h1 className="text-2xl font-bold">Cross-Chain Solar Bridge</h1>
          <p className="text-sm text-gray-600">
            Wrap/unwrap SOLAR tokens and pay meter bills across Stellar, Ethereum, Polygon, and Arbitrum
          </p>
        </div>
        <div className="bg-indigo-50 border border-indigo-200 rounded px-4 py-2">
          <span className="text-xs uppercase text-indigo-700 block">Unified Multi-Chain Balance</span>
          <span className="text-xl font-bold">{unifiedBalance.toLocaleString()} SOLAR</span>
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(['Stellar', 'Ethereum', 'Polygon', 'Arbitrum'] as SupportedChain[]).map((chain) => (
          <button
            key={chain}
            onClick={() => setSelectedChain(chain)}
            className={`border rounded-lg p-3 text-left transition ${
              selectedChain === chain ? 'ring-2 ring-indigo-600 bg-indigo-50/40' : 'bg-white'
            }`}
          >
            <span className="text-xs text-gray-500 block">{chain} Network</span>
            <span className="text-lg font-semibold">{balances[chain]} SOLAR</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="border rounded-lg p-4 bg-white space-y-4">
          <h2 className="text-base font-bold">Bridge & Wrap/Unwrap Tokens</h2>
          <div>
            <label className="block text-xs font-medium mb-1">Target / Source Chain Selector</label>
            <select
              value={selectedChain}
              onChange={(e) => setSelectedChain(e.target.value as SupportedChain)}
              className="w-full border rounded px-2 py-1.5 text-sm"
            >
              <option value="Ethereum">Ethereum (ERC-20 wSOLAR)</option>
              <option value="Polygon">Polygon PoS (wSOLAR)</option>
              <option value="Arbitrum">Arbitrum One (wSOLAR)</option>
              <option value="Stellar">Stellar Soroban (Native SOLAR)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Ethereum Address (EIP-55)</label>
            <input
              value={ethereumAddress}
              onChange={(e) => {
                setEthereumAddress(e.target.value);
                if (addressError) setAddressError(null);
              }}
              onBlur={handleAddressBlur}
              placeholder="0x..."
              aria-invalid={addressError !== null}
              className={`w-full border rounded px-2 py-1.5 text-sm font-mono ${
                addressError ? 'border-red-500' : ''
              }`}
            />
            {addressError && (
              <p className="text-xs text-red-600 mt-1" role="alert">
                {addressError}
              </p>
            )}
            {requiresEthereumAddress && !addressError && ethereumAddress && (
              <p className="text-xs text-emerald-600 mt-1">Valid EIP-55 checksum.</p>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Amount (SOLAR)</label>
            <input
              type="number"
              min={1}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              className="w-full border rounded px-2 py-1.5 text-sm"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleWrap}
              disabled={requiresEthereumAddress && validateEthereumAddress(ethereumAddress) !== null}
              className="flex-1 bg-indigo-600 text-white rounded py-2 text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Wrap Stellar → {selectedChain}
            </button>
            <button
              onClick={handleUnwrap}
              disabled={requiresEthereumAddress && validateEthereumAddress(ethereumAddress) !== null}
              className="flex-1 bg-gray-800 text-white rounded py-2 text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Unwrap {selectedChain} → Stellar
            </button>
          </div>
        </div>

        <div className="border rounded-lg p-4 bg-white space-y-4">
          <h2 className="text-base font-bold">Cross-Chain Meter Bill Payment</h2>
          <div>
            <label className="block text-xs font-medium mb-1">Target Smart Meter ID</label>
            <input
              value={meterId}
              onChange={(e) => setMeterId(e.target.value)}
              className="w-full border rounded px-2 py-1.5 text-sm"
            />
          </div>
          <p className="text-xs text-gray-500">
            Pay directly using your <strong>{selectedChain}</strong> balance ({balances[selectedChain]} wSOLAR)
            with automatic settlement on Stellar.
          </p>
          <button
            onClick={handleCrossChainPayment}
            disabled={requiresEthereumAddress && validateEthereumAddress(ethereumAddress) !== null}
            className="w-full bg-emerald-600 text-white rounded py-2 text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Pay {amount} wSOLAR from {selectedChain}
          </button>
        </div>
      </div>

      <section className="border rounded-lg p-4 bg-gray-50 space-y-2">
        <h3 className="text-xs font-semibold uppercase text-gray-500">Recent Cross-Chain Activity</h3>
        <ul className="text-xs text-gray-700 space-y-1">
          {txHistory.map((item, idx) => (
            <li key={idx}>• {item}</li>
          ))}
        </ul>
      </section>
    </div>
  );
};

export default CrossChainBridgePortal;
