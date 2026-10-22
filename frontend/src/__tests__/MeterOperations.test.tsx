import React from "react";
import { render, screen } from "@testing-library/react";
import { EnergyMixChart } from "../components/EnergyMixPanel";
import { LoadDistribution, SlaReports } from "../components/MeterOperationsDashboard";

jest.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_BACKEND_URL: "http://localhost:3001" } }));

describe("accessible meter operations visualization", () => {
  it("provides a labeled pie and exact text equivalents including unreported energy", () => {
    render(<EnergyMixChart mix={{ meterId: "A", totalUnits: 1000, readings: 3, hasData: true,
      units: { solar: 500, grid: 250, battery: 100, unknown: 150 },
      percentages: { solar: 50, grid: 25, battery: 10, unknown: 15 } }} />);
    expect(screen.getByRole("img", { name: /Energy source pie chart for A/ })).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveTextContent("Solar");
    expect(screen.getByRole("table")).toHaveTextContent("50.00%");
    expect(screen.getByRole("table")).toHaveTextContent("Unreported");
    expect(screen.getByRole("table")).toHaveTextContent("0.150");
  });
  it("does not render an invented mix in the absence of energy readings", () => {
    render(<EnergyMixChart mix={{ meterId: "A", totalUnits: 0, readings: 0, hasData: false,
      units: { solar: 0, grid: 0, battery: 0, unknown: 0 }, percentages: { solar: 0, grid: 0, battery: 0, unknown: 0 } }} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText(/No energy readings available/)).toBeInTheDocument();
  });
  it("labels stale load evidence and pending/unknown requests without claiming execution", () => {
    render(<LoadDistribution groups={[{ rule: { id: "G", enabled: true },
      meters: [{ meterId: "A", capacityWatts: 1000, ratio: .95, stale: true, observation: { load_watts: 950 } }],
      commands: [{ id: "1", from_id: "A", to_id: "B", watts: 100, status: "pending", reason: null },
        { id: "2", from_id: "A", to_id: "B", watts: 100, status: "unknown", reason: "No ack" }] }]} />);
    expect(screen.getByText(/Stale or unavailable; excluded/)).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();
    expect(screen.getByText("unknown")).toBeInTheDocument();
    expect(screen.queryByText("Controller acknowledged execution")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/A: 950 W/)).toBeInTheDocument();
  });
  it("shows target compliance, insufficient data, accessible trends, and recovery history", () => {
    const report = { since: 0, until: 10000, metrics: { uptimePct: 90, responseP95Ms: null, responseSuccessPct: null, mtbfMs: null }, compliance: { uptimePct: "breached", responseP95Ms: "insufficient_data" } };
    render(<SlaReports meters={[{ meterId: "A", report, trends: [{ report }] }]} alerts={[{ id: "alert1", event: "sla_recovery", metric: "uptimePct", meterId: "A", timestamp: "2026-01-01" }]} />);
    expect(screen.getAllByText("90.00%")).toHaveLength(2);
    expect(screen.getByText("breached")).toBeInTheDocument();
    expect(screen.getByText(/Insufficient data \(no failures\)/)).toBeInTheDocument();
    expect(screen.getByText(/sla recovery/)).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveAccessibleName(/Uptime trend/);
  });
});
