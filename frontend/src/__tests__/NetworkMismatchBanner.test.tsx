/**
 * Unit tests for NetworkMismatchBanner (#575)
 *
 * Covers:
 * - Renders banner when wallet connected + network mismatch
 * - Hidden when no wallet is connected
 * - Hidden when wallet is on the correct network (no networkError)
 * - role="alert" and aria-live="polite" present
 * - Banner can be dismissed by clicking the close button
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { NetworkMismatchBanner } from "@/components/NetworkMismatchBanner";
import { useWalletStore } from "@/store/walletStore";

// Reset Zustand store before each test
function setStoreState(address: string | null, networkError: string | null) {
  useWalletStore.setState({ address, networkError, kit: null });
}

describe("NetworkMismatchBanner", () => {
  beforeEach(() => {
    setStoreState(null, null);
  });

  it("renders the banner when wallet is connected and there is a network mismatch", () => {
    setStoreState(
      "GTEST_ADDRESS",
      "Freighter is connected to TESTNET, but this app expects PUBLIC.",
    );

    render(<NetworkMismatchBanner />);

    const banner = screen.getByTestId("network-mismatch-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText(/Wrong network/i)).toBeInTheDocument();
    expect(screen.getByText(/Freighter is connected to TESTNET/i)).toBeInTheDocument();
  });

  it("is hidden when no wallet is connected (address is null)", () => {
    setStoreState(null, "Freighter is connected to TESTNET, but this app expects PUBLIC.");

    render(<NetworkMismatchBanner />);

    expect(screen.queryByTestId("network-mismatch-banner")).not.toBeInTheDocument();
  });

  it("is hidden when wallet is connected on the correct network (no networkError)", () => {
    setStoreState("GTEST_ADDRESS", null);

    render(<NetworkMismatchBanner />);

    expect(screen.queryByTestId("network-mismatch-banner")).not.toBeInTheDocument();
  });

  it("is hidden when both address and networkError are null", () => {
    setStoreState(null, null);

    render(<NetworkMismatchBanner />);

    expect(screen.queryByTestId("network-mismatch-banner")).not.toBeInTheDocument();
  });

  it("dismisses the banner when the close button is clicked", () => {
    setStoreState(
      "GTEST_ADDRESS",
      "Freighter is connected to TESTNET, but this app expects PUBLIC.",
    );

    render(<NetworkMismatchBanner />);
    expect(screen.getByTestId("network-mismatch-banner")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(screen.queryByTestId("network-mismatch-banner")).not.toBeInTheDocument();
  });

  it("has the correct ARIA attributes for accessibility", () => {
    setStoreState("GTEST_ADDRESS", "Network mismatch detected.");

    render(<NetworkMismatchBanner />);

    const banner = screen.getByTestId("network-mismatch-banner");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveAttribute("aria-live", "polite");
  });
});
