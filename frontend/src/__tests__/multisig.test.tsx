import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import MultisigPage from "@/app/multisig/page";
import { canSign, sortProposals, type MultisigProposal } from "@/lib/multisig";

jest.mock("@/components/Navbar", () => ({
  __esModule: true,
  default: () => <nav data-testid="navbar" />,
}));

const ALICE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const BOB = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const CAROL = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ";
const WALLET = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

const signAuthEntry = jest.fn();
jest.mock("@/store/walletStore", () => ({
  useWalletStore: (selector: (s: object) => unknown) =>
    selector({ address: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H", signAuthEntry }),
}));

function proposal(overrides: Partial<MultisigProposal> = {}): MultisigProposal {
  return {
    id: "p1",
    wallet: WALLET,
    function: "make_payment",
    description: "Pay 5000000 stroops (Monthly) for meter ORG-1",
    preimageXdr: "AAAACQ==",
    payloadHex: "ab".repeat(32),
    expirationLedger: 1_100,
    threshold: 2,
    status: "pending",
    signedBy: [ALICE],
    pendingSigners: [BOB, CAROL],
    createdBy: ALICE,
    createdAt: "2026-09-28T10:00:00.000Z",
    txHash: null,
    error: null,
    ...overrides,
  };
}

const wallet = {
  address: WALLET,
  name: "Acme Solar Co-op",
  threshold: 2,
  signers: [
    { publicKey: ALICE, label: "Treasurer", notifications: true },
    { publicKey: BOB, label: null, notifications: true },
    { publicKey: CAROL, label: null, notifications: false },
  ],
  createdAt: "2026-09-01T00:00:00.000Z",
};

type Route = (url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined;

function mockApi(route: Route) {
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const hit = route(url, init) ??
      (url.endsWith(`/wallets/${WALLET}`)
        ? { body: { wallet } }
        : url.endsWith(`/wallets/${WALLET}/proposals`)
          ? { body: { proposals: [proposal()] } }
          : { status: 404, body: { error: "not found" } });
    const status = hit.status ?? 200;
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(hit.body) } as Response);
  }) as jest.Mock;
}

function openWallet() {
  render(<MultisigPage />);
  fireEvent.change(screen.getByLabelText("Wallet address"), { target: { value: WALLET } });
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
}

beforeEach(() => signAuthEntry.mockReset());

describe("multisig helpers", () => {
  it("puts actionable proposals first", () => {
    const sorted = sortProposals([
      proposal({ id: "done", status: "submitted" }),
      proposal({ id: "old", createdAt: "2026-09-01T00:00:00.000Z" }),
      proposal({ id: "ready", status: "ready" }),
      proposal({ id: "new", createdAt: "2026-09-29T00:00:00.000Z" }),
    ]);
    expect(sorted.map((p) => p.id)).toEqual(["ready", "new", "old", "done"]);
  });

  it("only lets pending signers sign open proposals", () => {
    expect(canSign(proposal(), BOB)).toBe(true);
    expect(canSign(proposal(), ALICE)).toBe(false);
    expect(canSign(proposal({ status: "expired" }), BOB)).toBe(false);
    expect(canSign(proposal(), null)).toBe(false);
  });
});

describe("MultisigPage", () => {
  it("shows the wallet and pending approvals with progress", async () => {
    mockApi(() => undefined);
    openWallet();

    expect(await screen.findByText("Acme Solar Co-op")).toBeInTheDocument();
    expect(screen.getByText("Pending approvals (1)")).toBeInTheDocument();
    const card = screen.getByText(/Pay 5000000 stroops/).closest("li") as HTMLElement;
    expect(within(card).getByText("1 of 2")).toBeInTheDocument();
    expect(within(card).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
    expect(within(card).getByText(/Signed: Treasurer/)).toBeInTheDocument();
  });

  it("signs with the connected wallet and submits the signature", async () => {
    signAuthEntry.mockResolvedValue("c2lnbmF0dXJl");
    mockApi((url, init) =>
      url.endsWith("/proposals/p1/signatures") && init?.method === "POST"
        ? { body: { proposal: proposal({ status: "ready", signedBy: [ALICE, BOB], pendingSigners: [CAROL] }) } }
        : undefined,
    );
    openWallet();

    fireEvent.click(await screen.findByRole("button", { name: "Approve with wallet" }));
    expect(await screen.findByRole("button", { name: "Submit transaction" })).toBeInTheDocument();
    expect(signAuthEntry).toHaveBeenCalledWith("AAAACQ==");
    const call = (global.fetch as jest.Mock).mock.calls.find(([u]) => String(u).endsWith("/signatures"));
    expect(JSON.parse(call[1].body)).toEqual({ publicKey: BOB, signature: "c2lnbmF0dXJl" });
    expect(screen.queryByRole("button", { name: "Approve with wallet" })).not.toBeInTheDocument();
  });

  it("creates a payment proposal as the connected signer", async () => {
    mockApi((url, init) =>
      url.endsWith(`/wallets/${WALLET}/proposals`) && init?.method === "POST"
        ? { status: 201, body: { proposal: proposal({ id: "p2" }) } }
        : undefined,
    );
    openWallet();
    await screen.findByText("Acme Solar Co-op");

    fireEvent.change(screen.getByLabelText("Meter ID"), { target: { value: "ORG-9" } });
    fireEvent.change(screen.getByLabelText("Amount (stroops)"), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: "Create proposal" }));

    await waitFor(() => {
      const post = (global.fetch as jest.Mock).mock.calls.find(([, i]) => i?.method === "POST");
      expect(post).toBeDefined();
      expect(JSON.parse(post[1].body)).toEqual({
        action: "make_payment",
        params: { meterId: "ORG-9", amount: "1000", plan: "Monthly" },
        proposer: BOB,
      });
    });
  });

  it("reports unknown wallets", async () => {
    mockApi((url) => (url.includes("/wallets/") ? { status: 404, body: { error: "Multisig wallet is not registered" } } : undefined));
    openWallet();
    expect(await screen.findByText(/Multisig wallet is not registered/)).toBeInTheDocument();
  });
});
