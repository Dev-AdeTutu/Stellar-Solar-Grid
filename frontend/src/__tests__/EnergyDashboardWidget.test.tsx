import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import EnergyDashboardWidget, { formatEnergyTick, type EnergyRange, type EnergySnapshot } from "@/components/EnergyDashboardWidget";

jest.mock("recharts", () => {
  const React = require("react");
  const element = (name: string) => {
    function MockChart() {
      return React.createElement("div", { "data-chart-part": name });
    }
    MockChart.displayName = name;
    return MockChart;
  };
  return {
    Area: element("area"),
    AreaChart: element("area-chart"),
    CartesianGrid: element("grid"),
    ResponsiveContainer: element("responsive"),
    Tooltip: element("tooltip"),
    XAxis: element("x-axis"),
    YAxis: element("y-axis"),
  };
});

class MockWebSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    sockets.push(this);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  message(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const sockets: MockWebSocket[] = [];
const makeSnapshot = (range: EnergyRange, productionKwh = 1.25): EnergySnapshot => ({
  meterId: "METER_001",
  range,
  updatedAt: "2026-09-29T12:00:00.000Z",
  current: { timestamp: "2026-09-29T12:00:00.000Z", productionKwh, consumptionKwh: 0.75 },
  points: [{ timestamp: "2026-09-29T12:00:00.000Z", productionKwh, consumptionKwh: 0.75 }],
});

function mockFetch(snapshot: EnergySnapshot) {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => snapshot });
}

beforeEach(() => {
  sockets.length = 0;
  jest.useRealTimers();
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  mockFetch(makeSnapshot("5m"));
});

afterEach(() => jest.restoreAllMocks());

describe("EnergyDashboardWidget", () => {
  it("renders the live metrics and requests a selected range", async () => {
    const { unmount } = render(<EnergyDashboardWidget meterId="METER_001" />);
    expect(await screen.findByText("1.25")).toBeInTheDocument();
    expect(screen.getByText("0.75")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Hourly" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("range=hourly")));
    expect(sockets.some((socket) => socket.url.includes("range=hourly"))).toBe(true);
    unmount();
  });

  it("accepts complete WebSocket snapshots and ignores malformed or mismatched frames", async () => {
    const { unmount } = render(<EnergyDashboardWidget meterId="METER_001" />);
    expect(await screen.findByText("1.25")).toBeInTheDocument();
    act(() => {
      sockets[0].open();
      sockets[0].message("not-json");
      sockets[0].message(JSON.stringify({ ...makeSnapshot("hourly", 8), range: "daily" }));
    });
    expect(screen.getByRole("status")).toHaveTextContent("Live");
    expect(screen.getByText("1.25")).toBeInTheDocument();

    act(() => sockets[0].message(JSON.stringify(makeSnapshot("5m", 2.5))));
    expect(screen.getByText("2.50")).toBeInTheDocument();
    unmount();
  });

  it("reconnects after a closed socket", async () => {
    jest.useFakeTimers();
    const { unmount } = render(<EnergyDashboardWidget meterId="METER_001" />);
    act(() => sockets[0].close());
    act(() => jest.advanceTimersByTime(1_000));
    expect(sockets).toHaveLength(2);
    unmount();
    jest.useRealTimers();
  });

  it("closes a failed socket and retries the connection", () => {
    jest.useFakeTimers();
    const { unmount } = render(<EnergyDashboardWidget meterId="METER_001" />);
    act(() => sockets[0].onerror?.());
    act(() => jest.advanceTimersByTime(1_000));
    expect(sockets).toHaveLength(2);
    unmount();
    jest.useRealTimers();
  });

  it("cancels a scheduled reconnect when the widget unmounts", () => {
    jest.useFakeTimers();
    const { unmount } = render(<EnergyDashboardWidget meterId="METER_001" />);
    act(() => sockets[0].close());
    unmount();
    act(() => jest.advanceTimersByTime(2_000));
    expect(sockets).toHaveLength(1);
    jest.useRealTimers();
  });

  it("polls the snapshot endpoint while the WebSocket is disconnected", () => {
    jest.useFakeTimers();
    const { unmount } = render(<EnergyDashboardWidget meterId="METER_001" />);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(15_000));
    expect(global.fetch).toHaveBeenCalledTimes(2);
    unmount();
    jest.useRealTimers();
  });

  it("closes an errored socket and returns to reconnecting state", async () => {
    const { unmount } = render(<EnergyDashboardWidget meterId="METER_001" />);
    act(() => {
      sockets[0].open();
      sockets[0].onerror?.();
    });
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting");
    expect(sockets[0].readyState).toBe(3);
    unmount();
  });

  it("keeps the empty chart state when the initial request fails", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("offline"));
    render(<EnergyDashboardWidget meterId="METER_001" />);
    expect(await screen.findByText("Waiting for energy readings")).toBeInTheDocument();
    expect(screen.getAllByText("--")).toHaveLength(3);
  });

  it("formats daily, hourly, and five-minute chart ticks", () => {
    const timestamp = "2026-09-29T12:05:00.000Z";
    expect(formatEnergyTick(timestamp, "daily")).toBe(new Date(timestamp).toLocaleDateString(undefined, { weekday: "short" }));
    expect(formatEnergyTick(timestamp, "hourly")).toBe(new Date(timestamp).toLocaleTimeString(undefined, { hour: "numeric" }));
    expect(formatEnergyTick(timestamp, "5m")).toBe(new Date(timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
  });
});