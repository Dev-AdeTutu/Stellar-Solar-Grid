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
  /** Set to true when the user explicitly cancels a pending connection. */
  connectCancelled: boolean;
  lastTopUpPerMeter: Record<string, bigint>;
  connect: () => Promise<void>;
  cancelConnect: () => void;
  disconnect: () => void;
  clearConnectError: () => void;
  signTransaction: (xdr: string) => Promise<string>;
  recordTopUp: (meterId: string, amount: bigint) => void;
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
  connectCancelled: false,
  lastTopUpPerMeter: {},

  connect: async () => {
    set({ connectError: null, networkError: null, isConnecting: true, connectCancelled: false });

    // Closes #743: race the wallet handshake against a 30-second timeout so the
    // UI never hangs indefinitely when Freighter is installed but locked.
    const CONNECTION_TIMEOUT_MS = 30_000;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error("Connection timeout. Wallet is locked — please unlock Freighter and try again."));
      }, CONNECTION_TIMEOUT_MS);
    });

    try {
      if (typeof window === "undefined" || !(window as any).freighter) {
        throw new Error("Freighter extension is not installed. Please install it to continue.");
      }
      const kit = buildKit();

      const connectPromise = new Promise<void>((resolve, reject) => {
        kit.openModal({
          onWalletSelected: async (option) => {
            try {
              kit.setWallet(option.id);
              const { address } = await kit.getAddress();
              if (!address || address.length < 10) throw new Error("No account found in selected wallet");
              const networkError = await checkNetworkMismatch();
              set({ address, kit, networkError });
              resolve();
            } catch (err) {
              reject(err);
            }
          },
        }).catch(reject);
      });

      await Promise.race([connectPromise, timeoutPromise]);
    } catch (err: unknown) {
      // Do not overwrite the error if the user explicitly cancelled
      if (get().connectCancelled) return;
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
      if (timeoutId !== null) clearTimeout(timeoutId);
      set({ isConnecting: false });
    }
  },

  /** Closes #743: allow the user to abort a pending connection attempt. */
  cancelConnect: () => {
    set({
      isConnecting: false,
      connectCancelled: true,
      connectError: null,
    });
  },

  disconnect: () => set({ address: null, kit: null, connectError: null, networkError: null, connectCancelled: false }),

  clearConnectError: () => set({ connectError: null }),

  signTransaction: async (xdr: string) => {
    const { kit, address } = get();
    if (!kit || !address) throw new Error("Wallet not connected");
    const { signedTxXdr } = await kit.signTransaction(xdr, {
      address,
      networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015',
      networkPassphrase: env.NEXT_PUBLIC_NETWORK_PASSPHRASE,
    });
    return signedTxXdr;
  },

  recordTopUp: (meterId: string, amount: bigint) => {
    set((state) => ({
      lastTopUpPerMeter: {
        ...state.lastTopUpPerMeter,
        [meterId]: amount,
      },
    }));
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
