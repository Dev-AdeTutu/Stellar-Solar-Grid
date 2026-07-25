import { create } from "zustand";
import { env } from "@/lib/env";
import {
  StellarWalletsKit,
  WalletNetwork,
  FREIGHTER_ID,
  FreighterModule,
  XBULL_ID as xBullWalletId,
  xBullModule,
} from "@creit.tech/stellar-wallets-kit";

interface WalletState {
  address: string | null;
  kit: StellarWalletsKit | null;
  connectError: string | null;
  isConnecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  clearConnectError: () => void;
  signTransaction: (xdr: string) => Promise<string>;
}

function buildKit(): StellarWalletsKit {
  return new StellarWalletsKit({
    network: env.NEXT_PUBLIC_NETWORK_PASSPHRASE.includes("Test")
      ? WalletNetwork.TESTNET
      : WalletNetwork.PUBLIC,
    selectedWalletId: FREIGHTER_ID,
    modules: [new FreighterModule(), new xBullModule()],
  });
}

export const useWalletStore = create<WalletState>((set, get) => ({
  address: null,
  kit: null,
  connectError: null,
  isConnecting: false,

  connect: async () => {
    set({ connectError: null, isConnecting: true });
    try {
      if (typeof window === "undefined" || !(window as any).freighter) {
        throw new Error("Freighter extension is not installed. Please install it to continue.");
      }
      const kit = buildKit();
      await kit.openModal({
        onWalletSelected: async (option) => {
          kit.setWallet(option.id);
          const { address } = await kit.getAddress();
          if (!address || address.length < 10) throw new Error("No account found in selected wallet");
          set({ address, kit });
        },
      });
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to connect wallet";
      const isNotInstalled =
        msg.toLowerCase().includes("not installed") ||
        msg.toLowerCase().includes("undefined");
      set({
        connectError: isNotInstalled
          ? "Selected wallet is not installed."
          : msg,
      });
    } finally {
      set({ isConnecting: false });
    }
  },

  disconnect: () => set({ address: null, kit: null, connectError: null }),

  clearConnectError: () => set({ connectError: null }),

  signTransaction: async (xdr: string) => {
    const { kit, address } = get();
    if (!kit || !address) throw new Error("Wallet not connected");
    const { signedTxXdr } = await kit.signTransaction(xdr, {
      address,
      networkPassphrase: env.NEXT_PUBLIC_NETWORK_PASSPHRASE,
    });
    return signedTxXdr;
  },
}));

export { FREIGHTER_ID, xBullWalletId };

if (typeof window !== "undefined" && (window as any).freighter) {
  (window as any).freighter.on("accountChanged", (newAddress: string | null) => {
    if (!newAddress) {
      useWalletStore.getState().disconnect();
    } else {
      useWalletStore.setState({ address: newAddress });
    }
  });
}
