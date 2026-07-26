import { render, screen } from "@testing-library/react";
import UsageChart, { UsageDataPoint } from "@/components/UsageChart";

// recharts uses ResizeObserver internally — polyfill for jsdom
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const SAMPLE_DATA: UsageDataPoint[] = [
  { date: "2024-01-01", units: 3.2, cost: 0.48 },
  { date: "2024-01-02", units: 4.1, cost: 0.62 },
  { date: "2024-01-03", units: 2.8, cost: 0.42 },
];

describe("UsageChart", () => {
  // ── Empty / null / undefined guards ──────────────────────────────────────

  it("renders empty state placeholder when data is an empty array", () => {
    render(<UsageChart data={[]} />);
    expect(screen.getByRole("status", { name: /no usage data/i })).toBeInTheDocument();
    expect(screen.getByText(/no usage data yet/i)).toBeInTheDocument();
    expect(screen.getByText(/first recorded unit/i)).toBeInTheDocument();
  });

  it("renders empty state placeholder when data is null (does not throw)", () => {
    // TypeScript allows null via the optional prop — runtime guard must hold
    expect(() => render(<UsageChart data={null as any} />)).not.toThrow();
    expect(screen.getByRole("status", { name: /no usage data/i })).toBeInTheDocument();
  });

  it("renders empty state placeholder when data is undefined (does not throw)", () => {
    expect(() => render(<UsageChart data={undefined} />)).not.toThrow();
    expect(screen.getByRole("status", { name: /no usage data/i })).toBeInTheDocument();
  });

  it("renders empty state placeholder when data prop is omitted entirely", () => {
    expect(() => render(<UsageChart />)).not.toThrow();
    expect(screen.getByText(/no usage data yet/i)).toBeInTheDocument();
  });

  // ── Layout consistency ────────────────────────────────────────────────────

  it("empty state container has h-48 class to preserve card height", () => {
    render(<UsageChart data={[]} />);
    const placeholder = screen.getByRole("status");
    expect(placeholder.className).toContain("h-48");
  });

  // ── Loading state ─────────────────────────────────────────────────────────

  it("renders skeleton when loading=true, even with empty data", () => {
    const { container } = render(<UsageChart data={[]} loading={true} />);
    // Skeleton uses animate-pulse; empty state must NOT appear while loading
    expect(screen.queryByRole("status", { name: /no usage data/i })).not.toBeInTheDocument();
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  // ── Data rendering ────────────────────────────────────────────────────────

  it("does not show empty state when data has entries", () => {
    render(<UsageChart data={SAMPLE_DATA} />);
    expect(screen.queryByText(/no usage data yet/i)).not.toBeInTheDocument();
  });

  it("shows meterId in header when provided", () => {
    render(<UsageChart data={SAMPLE_DATA} meterId="METER_001" />);
    expect(screen.getByText("METER_001")).toBeInTheDocument();
  });

  it("shows meter header without meterId", () => {
    render(<UsageChart data={SAMPLE_DATA} />);
    expect(screen.getByText("Energy Usage")).toBeInTheDocument();
  });
});
