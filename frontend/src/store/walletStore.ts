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
  networkError: string | null;
  isConnecting: boolean;
  isTransactionPending: boolean;
  lastTopUpPerMeter: Record<string, bigint>;
  connect: () => Promise<void>;
  disconnect: () => void;
  clearConnectError: () => void;
  signTransaction: (xdr: string) => Promise<string>;
  recordTopUp: (meterId: string, amount: bigint) => void;
  setPendingTransaction: (isPending: boolean) => void;
}

const EXPECTED_NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
const EXPECTED_NETWORK_NAME = EXPECTED_NETWORK_PASSPHRASE.includes("Test")
  ? "Testnet"
  : "Public";

function buildKit(): StellarWalletsKit {
  return new StellarWalletsKit({
    network: EXPECTED_NETWORK_PASSPHRASE.includes("Test")
      ? WalletNetwork.TESTNET
      : WalletNetwork.PUBLIC,
    selectedWalletId: FREIGHTER_ID,
    modules: [new FreighterModule(), new xBullModule()],
  });
}

/**
 * Compares the network Freighter is currently set to against the network this
 * app expects (see TROUBLESHOOTING.md §6.3). Returns a human-readable mismatch
 * message, or null when the network matches (or can't be determined).
 */
async function checkNetworkMismatch(): Promise<string | null> {
  const freighter = (window as any).freighter;
  try {
    if (freighter?.getNetworkDetails) {
      const details = await freighter.getNetworkDetails();
      if (
        details?.networkPassphrase &&
        details.networkPassphrase !== EXPECTED_NETWORK_PASSPHRASE
      ) {
        return `Freighter is connected to ${details.network ?? "a different network"}, but this app expects ${EXPECTED_NETWORK_NAME}.`;
      }
    } else if (freighter?.getNetwork) {
      const network = await freighter.getNetwork();
      if (network && network.toUpperCase() !== EXPECTED_NETWORK_NAME.toUpperCase()) {
        return `Freighter is connected to ${network}, but this app expects ${EXPECTED_NETWORK_NAME}.`;
      }
    }
  } catch {
    // non-critical — if the network can't be determined, don't block connection
  }
  return null;
}

export const useWalletStore = create<WalletState>((set, get) => ({
  address: null,
  kit: null,
  connectError: null,
  networkError: null,
  isConnecting: false,
  isTransactionPending: false,
  lastTopUpPerMeter: {},

  connect: async () => {
    // Issue #694: Prevent multiple simultaneous connection attempts
    const current = get();
    if (current.isConnecting) {
      throw new Error("Connection already in progress");
    }

    set({ connectError: null, networkError: null, isConnecting: true });
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
          const networkError = await checkNetworkMismatch();
          set({ address, kit, networkError });
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

  // Issue #694: Improved disconnect with proper cleanup
  disconnect: () => {
    set({
      address: null,
      kit: null,
      connectError: null,
      networkError: null,
      isTransactionPending: false,
      lastTopUpPerMeter: {},
    });
  },

  clearConnectError: () => set({ connectError: null }),

  // Issue #694: Add race condition protection for transaction signing
  signTransaction: async (xdr: string) => {
    const { kit, address, isTransactionPending } = get();
    if (!kit || !address) throw new Error("Wallet not connected");

    // Prevent concurrent transactions
    if (isTransactionPending) {
      throw new Error("Transaction already in progress");
    }

    set({ isTransactionPending: true });
    try {
      // Check wallet is still connected before signing
      if (get().address !== address) {
        throw new Error("Wallet was disconnected during transaction");
      }

      const { signedTxXdr } = await kit.signTransaction(xdr, {
        address,
        networkPassphrase: env.NEXT_PUBLIC_NETWORK_PASSPHRASE,
      });

      // Verify wallet is still connected after signing
      if (get().address !== address) {
        throw new Error("Wallet was disconnected while signing transaction");
      }

      return signedTxXdr;
    } finally {
      set({ isTransactionPending: false });
    }
  },

  recordTopUp: (meterId: string, amount: bigint) => {
    set((state) => ({
      lastTopUpPerMeter: {
        ...state.lastTopUpPerMeter,
        [meterId]: amount,
      },
    }));
  },

  setPendingTransaction: (isPending: boolean) => {
    set({ isTransactionPending: isPending });
  },
}));

export { FREIGHTER_ID, xBullWalletId };

// Issue #694: Properly handle wallet disconnection events with transaction cleanup
if (typeof window !== "undefined" && (window as any).freighter) {
  const handleAccountChange = (newAddress: string | null) => {
    const state = useWalletStore.getState();

    if (!newAddress) {
      // Account was disconnected - cleanup properly
      state.disconnect();
    } else if (state.address !== newAddress) {
      // Account was changed - only update if not in a pending transaction
      // to avoid race conditions during signing
      if (!state.isTransactionPending) {
        useWalletStore.setState({ address: newAddress });
      } else {
        // If transaction is pending, disconnect to prevent inconsistent state
        state.disconnect();
      }
    }
  };

  (window as any).freighter.on("accountChanged", handleAccountChange);
}
