import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AnalyticsPage from "@/app/analytics/page";
import { exportUrl, formatChange, formatPrice, priceSeries, type MarketAnalytics } from "@/lib/marketAnalytics";

jest.mock("@/components/Navbar", () => ({
  __esModule: true,
  default: () => <nav data-testid="navbar" />,
}));

// ResponsiveContainer measures 0x0 in jsdom; render charts at a fixed size.
jest.mock("recharts", () => {
  const actual = jest.requireActual("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) => (
      <div style={{ width: 600, height: 240 }}>{children}</div>
    ),
  };
});

function analytics(range: MarketAnalytics["range"] = "7d"): MarketAnalytics {
  const daily = Array.from({ length: 3 }, (_, i) => ({
    date: `2026-09-2${6 + i}`,
    energyKwh: 10 + i,
    valueStroops: 1_000_000,
    trades: 4,
    activeMeters: 2,
    avgPrice: 100_000 + i * 1_000,
    minPrice: 90_000,
    maxPrice: 110_000,
    movingAvgPrice: 100_000,
  }));
  return {
    range,
    meterId: null,
    from: "2026-09-22T00:00:00.000Z",
    to: "2026-09-29T00:00:00.000Z",
    generatedAt: "2026-09-28T12:00:00.000Z",
    summary: {
      totalEnergyKwh: 33,
      totalValueStroops: 30_000_000,
      trades: 12,
      activeMeters: 2,
      avgPrice: 101_000,
      avgTradeKwh: 2.75,
      priceVolatilityPct: 1,
      priceChangePct: 12.5,
      volumeChangePct: -4,
      peakDay: { date: "2026-09-28", energyKwh: 12 },
    },
    daily,
    forecast: {
      horizonDays: 7,
      slopePerDay: 1_000,
      r2: 0.9,
      points: [{ date: "2026-09-29", price: 103_000, lower: 101_000, upper: 105_000 }],
    },
    hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, energyKwh: hour === 18 ? 5 : 1, trades: 1 })),
    weekday: Array.from({ length: 7 }, (_, weekday) => ({ weekday, energyKwh: 1, trades: 1 })),
    topMeters: [{ meterId: "SOLAR-1", energyKwh: 20, valueStroops: 20_000_000, sharePct: 60.6 }],
    insights: ["The average price rose 12.5% compared with the previous 7 days."],
  };
}

beforeEach(() => {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const range = new URL(String(input)).searchParams.get("range") as MarketAnalytics["range"];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(analytics(range)) } as Response);
  }) as jest.Mock;
});

describe("market analytics helpers", () => {
  it("formats prices and changes", () => {
    expect(formatPrice(10_000_000)).toBe("1 XLM/kWh");
    expect(formatPrice(null)).toBe("–");
    expect(formatChange(12.5)).toBe("+12.5% vs prior period");
    expect(formatChange(-4)).toBe("−4.0% vs prior period");
    expect(formatChange(null)).toBe("no prior data");
  });

  it("joins the forecast onto the last actual price", () => {
    const series = priceSeries(analytics());
    expect(series).toHaveLength(4);
    expect(series[2]).toMatchObject({ price: 102_000, forecast: 102_000, band: [102_000, 102_000] });
    expect(series[3]).toMatchObject({ price: null, forecast: 103_000, band: [101_000, 105_000] });
  });

  it("builds export URLs with the active filters", () => {
    expect(exportUrl("90d", "pdf", " M1 ")).toBe(
      "http://localhost:3001/api/analytics/market/export?range=90d&format=pdf&meter_id=M1",
    );
  });
});

describe("AnalyticsPage", () => {
  it("shows KPIs, insights and top meters for the default 30-day range", async () => {
    render(<AnalyticsPage />);
    expect(await screen.findByText("33 kWh")).toBeInTheDocument();
    expect(screen.getByText("+12.5% vs prior period")).toBeInTheDocument();
    expect(screen.getByText(/average price rose 12.5%/)).toBeInTheDocument();
    expect(screen.getByText("SOLAR-1")).toBeInTheDocument();
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain("range=30d");
    expect(screen.getByRole("button", { name: "30 days" })).toHaveAttribute("aria-pressed", "true");
  });

  it("switches range and meter filter and updates export links", async () => {
    render(<AnalyticsPage />);
    await screen.findByText("33 kWh");
    fireEvent.click(screen.getByRole("button", { name: "90 days" }));
    await waitFor(() => expect(String((global.fetch as jest.Mock).mock.calls.at(-1)[0])).toContain("range=90d"));

    fireEvent.change(screen.getByLabelText("Meter filter"), { target: { value: "SOLAR-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(String((global.fetch as jest.Mock).mock.calls.at(-1)[0])).toContain("meter_id=SOLAR-1"));
    expect(screen.getByRole("link", { name: "Export CSV" })).toHaveAttribute(
      "href",
      "http://localhost:3001/api/analytics/market/export?range=90d&format=csv&meter_id=SOLAR-1",
    );
  });

  it("offers a table view of the daily data", async () => {
    render(<AnalyticsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Show table" }));
    expect(screen.getByText("2026-09-26")).toBeInTheDocument();
  });

  it("reports API errors", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: "range must be one of 7d, 30d, 90d" }) } as Response),
    ) as jest.Mock;
    render(<AnalyticsPage />);
    expect(await screen.findByText(/range must be one of/)).toBeInTheDocument();
  });
});
