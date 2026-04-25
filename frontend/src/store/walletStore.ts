"use client";

import { create } from "zustand";
import { StellarWalletsKit, WalletNetwork, FREIGHTER_ID } from "@creit.tech/stellar-wallets-kit";

interface WalletState {
  address: string | null;
  kit: StellarWalletsKit | null;
  connectError: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  clearConnectError: () => void;
  signTransaction: (xdr: string) => Promise<string>;
}

function buildKit(): StellarWalletsKit {
  return new StellarWalletsKit({
    network:
      process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE?.includes("Test")
        ? WalletNetwork.TESTNET
        : WalletNetwork.PUBLIC,
    selectedWalletId: FREIGHTER_ID,
    modules: [],
  });
}

export const useWalletStore = create<WalletState>((set, get) => ({
  address: null,
  kit: null,
  connectError: null,

  connect: async () => {
    set({ connectError: null });
    try {
      const kit = buildKit();
      await kit.openModal({
        onWalletSelected: async (option) => {
          kit.setWallet(option.id);
          const { address } = await kit.getAddress();
          if (!address || address.length < 10) throw new Error("No account found in Freighter");
          set({ address, kit });
        },
      });
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to connect wallet";
      const isNotInstalled =
        msg.toLowerCase().includes("not installed") ||
        msg.toLowerCase().includes("freighter") ||
        msg.toLowerCase().includes("undefined");
      set({
        connectError: isNotInstalled
          ? "Freighter wallet is not installed."
          : msg,
      });
    }
  },

  disconnect: () => set({ address: null, kit: null, connectError: null }),

  clearConnectError: () => set({ connectError: null }),

  signTransaction: async (xdr: string) => {
    const { kit, address } = get();
    if (!kit || !address) throw new Error("Wallet not connected");
    const { signedTxXdr } = await kit.signTransaction(xdr, {
      address,
      networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE!,
    });
    return signedTxXdr;
  },
}));
