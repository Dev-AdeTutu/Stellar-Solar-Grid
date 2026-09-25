import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { ErrorBoundary, buildIssueUrl } from "@/components/ErrorBoundary";

function Bomb({ explode }: { explode: boolean }) {
  if (explode) throw new Error("boom");
  return <p>all good</p>;
}

describe("ErrorBoundary", () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => jest.restoreAllMocks());

  it("renders children when no error", () => {
    render(<ErrorBoundary><Bomb explode={false} /></ErrorBoundary>);
    expect(screen.getByText("all good")).toBeInTheDocument();
  });

  it("shows fallback UI, logs error and offers report link", () => {
    render(<ErrorBoundary><Bomb explode /></ErrorBoundary>);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/client-errors"),
      expect.objectContaining({ method: "POST" }),
    );
    const link = screen.getByText("Report Issue").closest("a")!;
    expect(link.getAttribute("href")).toContain("issues/new");
    expect(link.getAttribute("href")).toContain("boom");
  });

  it("recovers after reset", () => {
    function Harness() {
      const [explode, setExplode] = useState(true);
      return (
        <>
          <button onClick={() => setExplode(false)}>fix</button>
          <ErrorBoundary><Bomb explode={explode} /></ErrorBoundary>
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByText("fix"));
    fireEvent.click(screen.getByText("Try Again"));
    expect(screen.getByText("all good")).toBeInTheDocument();
  });

  it("buildIssueUrl encodes error details", () => {
    expect(buildIssueUrl(new Error("x y"))).toContain("title=Frontend+error%3A+x+y");
  });
});
