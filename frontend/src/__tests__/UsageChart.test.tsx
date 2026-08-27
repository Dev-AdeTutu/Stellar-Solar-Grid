import { render, screen } from "@testing-library/react";
import UsageChart, {
  UsageDataPoint,
  formatTickLocal,
  formatTooltipLocal,
  hasTimeComponent,
} from "@/components/UsageChart";

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

  // ── Timezone formatting (issue: x-axis showed raw UTC, no tz indicator) ────

  describe("hasTimeComponent", () => {
    it("is true for a full ISO 8601 timestamp", () => {
      expect(hasTimeComponent("2026-08-24T06:00:00Z")).toBe(true);
    });

    it("is false for a plain calendar date", () => {
      expect(hasTimeComponent("2026-08-24")).toBe(false);
    });
  });

  describe("formatTickLocal", () => {
    it("renders a full timestamp as a local clock time, not the raw UTC string", () => {
      const formatted = formatTickLocal("2026-08-24T06:00:00Z");
      expect(formatted).not.toBe("2026-08-24T06:00:00Z");
      expect(formatted).toMatch(/\d{1,2}:\d{2}/);
    });

    it("renders a plain date as a short calendar date, not a clock time", () => {
      const formatted = formatTickLocal("2026-08-24");
      expect(formatted).not.toMatch(/\d{1,2}:\d{2}/);
    });

    it("falls back to the raw value for an unparseable string", () => {
      expect(formatTickLocal("not-a-date")).toBe("not-a-date");
    });
  });

  describe("formatTooltipLocal", () => {
    it("includes an explicit timezone indicator alongside the local time", () => {
      const formatted = formatTooltipLocal("2026-08-24T06:00:00Z");
      // Should carry the clock time plus a timezone abbreviation/offset
      // (e.g. "Aug 24, 6:00 AM GMT+3") — never just the bare UTC string.
      expect(formatted).not.toBe("2026-08-24T06:00:00Z");
      expect(formatted).toMatch(/\d{1,2}:\d{2}/);
      expect(formatted.length).toBeGreaterThan(formatTickLocal("2026-08-24T06:00:00Z").length);
    });

    it("falls back to the raw value for an unparseable string", () => {
      expect(formatTooltipLocal("not-a-date")).toBe("not-a-date");
    });
  });
});
