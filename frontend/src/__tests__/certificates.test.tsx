import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CertificatesPage from "@/app/certificates/page";
import {
  activeEnergyKwh,
  certificatePdfUrl,
  isValidReadingHash,
  shortAddress,
  type ExportCertificate,
} from "@/lib/certificates";

jest.mock("@/components/Navbar", () => ({
  __esModule: true,
  default: () => <nav data-testid="navbar" />,
}));

const OWNER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const HASH = "ab".repeat(32);

jest.mock("@/store/walletStore", () => ({
  useWalletStore: (selector: (s: { address: string | null }) => unknown) =>
    selector({ address: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H" }),
}));

function cert(overrides: Partial<ExportCertificate> = {}): ExportCertificate {
  return {
    id: "1",
    meterId: "SOLAR-1",
    producer: OWNER,
    owner: OWNER,
    energyWh: "12500",
    energyKwh: 12.5,
    periodStart: "2026-09-01T00:00:00.000Z",
    periodEnd: "2026-09-02T00:00:00.000Z",
    issuedAt: "2026-09-02T01:00:00.000Z",
    issuer: OWNER,
    readingHash: HASH,
    retiredAt: null,
    status: "active",
    ...overrides,
  };
}

function mockFetch(handler: (url: string) => unknown) {
  global.fetch = jest.fn((input: RequestInfo | URL) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(handler(String(input))),
    } as Response),
  ) as jest.Mock;
}

describe("certificate helpers", () => {
  it("validates reading hashes", () => {
    expect(isValidReadingHash(HASH)).toBe(true);
    expect(isValidReadingHash(` ${HASH.toUpperCase()} `)).toBe(true);
    expect(isValidReadingHash("abc")).toBe(false);
    expect(isValidReadingHash("zz".repeat(32))).toBe(false);
  });

  it("sums only active certificates", () => {
    expect(activeEnergyKwh([cert(), cert({ id: "2", energyKwh: 1.5 }), cert({ id: "3", status: "retired" })])).toBe(14);
  });

  it("builds the PDF download URL and shortens addresses", () => {
    expect(certificatePdfUrl("42")).toBe("http://localhost:3001/api/certificates/42/pdf");
    expect(shortAddress(OWNER)).toBe("GBRPYH…OX2H");
  });
});

describe("CertificatesPage", () => {
  it("lists the connected wallet's certificates with download links", async () => {
    mockFetch(() => ({
      certificates: [cert(), cert({ id: "2", status: "retired", retiredAt: "2026-09-05T00:00:00.000Z" })],
    }));
    render(<CertificatesPage />);

    expect(await screen.findByText("Certificate #1")).toBeInTheDocument();
    expect(screen.getByText("Certificate #2")).toBeInTheDocument();
    // Status badge plus the retirement date label.
    expect(screen.getAllByText("Retired")).toHaveLength(2);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain(`/api/certificates?owner=${OWNER}`);

    const links = screen.getAllByRole("link", { name: "Download PDF" });
    expect(links[0]).toHaveAttribute("href", "http://localhost:3001/api/certificates/1/pdf");
  });

  it("shows an empty state", async () => {
    mockFetch(() => ({ certificates: [] }));
    render(<CertificatesPage />);
    expect(await screen.findByText(/No certificates held by/)).toBeInTheDocument();
  });

  it("verifies a certificate on-chain from its card", async () => {
    mockFetch((url) =>
      url.includes("/verify")
        ? { id: "1", readingHash: HASH, valid: true, contractId: "C..." }
        : { certificates: [cert()] },
    );
    render(<CertificatesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Verify on-chain" }));
    expect(await screen.findByRole("status")).toHaveTextContent("is recorded on-chain");
    const verifyCall = (global.fetch as jest.Mock).mock.calls.find(([u]) => String(u).includes("/verify"));
    expect(String(verifyCall[0])).toContain(`/api/certificates/1/verify?readingHash=${HASH}`);
  });

  it("verifies a certificate entered manually and reports mismatches", async () => {
    mockFetch((url) =>
      url.includes("/verify") ? { id: "9", readingHash: HASH, valid: false, contractId: "C..." } : { certificates: [] },
    );
    render(<CertificatesPage />);
    const submit = screen.getByRole("button", { name: "Verify" });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Certificate number"), { target: { value: "9" } });
    fireEvent.change(screen.getByLabelText("Reading hash"), { target: { value: HASH } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No certificate #9"));
  });
});
