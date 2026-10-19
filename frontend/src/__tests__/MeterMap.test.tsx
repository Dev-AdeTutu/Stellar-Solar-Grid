import { render, screen } from "@testing-library/react";
import MeterMap from "@/components/MeterMap";

describe("MeterMap", () => {
  const points = [{ meter_id: "north", latitude: 40, longitude: -74, active: true, usage: 100, region: "north", provider: "a" }, { meter_id: "south", latitude: -20, longitude: 30, active: false, usage: 4, region: "south", provider: "b" }];
  it("renders points and filter controls", () => { render(<MeterMap points={points} />); expect(screen.getByRole("img", { name: /2 meters shown/i })).toBeInTheDocument(); expect(screen.getByRole("button", { name: /Meter north/i })).toBeInTheDocument(); expect(screen.getByLabelText("Filter by region")).toBeInTheDocument(); });
});
