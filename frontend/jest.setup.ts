process.env.NEXT_PUBLIC_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
process.env.NEXT_PUBLIC_BACKEND_URL = "http://localhost:3001";
process.env.NEXT_PUBLIC_API_URL = "http://localhost:3001";
process.env.NEXT_PUBLIC_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

import "@testing-library/jest-dom";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      tagline: "Pay-as-you-go solar energy on the Stellar network",
      userDashboard: "User Dashboard",
      providerDashboard: "Provider Dashboard",
    };
    return map[key] ?? key;
  },
}));

if (!global.fetch) {
  global.fetch = jest.fn().mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    })
  ) as any;
}

jest.mock("@creit.tech/stellar-wallets-kit", () => ({
  StellarWalletsKit: jest.fn().mockImplementation(() => ({
    openModal: jest.fn(),
    setWallet: jest.fn(),
    getAddress: jest.fn(),
    signTransaction: jest.fn(),
  })),
  WalletNetwork: {
    TESTNET: "TESTNET",
    PUBLIC: "PUBLIC",
  },
  allowAllModules: () => [],
  FREIGHTER_ID: "freighter",
  ALBEDO_ID: "albedo",
  XBULL_ID: "xbull",
  RABET_ID: "rabet",
}));


