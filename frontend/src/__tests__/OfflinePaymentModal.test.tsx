import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import OfflinePaymentModal from "@/components/OfflinePaymentModal";
import { useOffline } from "@/hooks/useOffline";

jest.mock("@/hooks/useOffline");

const mockUseOffline = useOffline as jest.MockedFunction<typeof useOffline>;

describe("OfflinePaymentModal", () => {
  const onClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseOffline.mockReturnValue(false);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it("builds the SMS example from the provided meterId", () => {
    render(<OfflinePaymentModal meterId="M42" onClose={onClose} />);
    expect(screen.getByText("PAY M42 5 D")).toBeInTheDocument();
  });

  it("falls back to METER1 when meterId is omitted", () => {
    render(<OfflinePaymentModal onClose={onClose} />);
    expect(screen.getByText("PAY METER1 5 D")).toBeInTheDocument();
  });

  it("falls back to METER1 when meterId is blank/whitespace", () => {
    render(<OfflinePaymentModal meterId="   " onClose={onClose} />);
    expect(screen.getByText("PAY METER1 5 D")).toBeInTheDocument();
  });

  it("calls onClose when the footer Close button is clicked", async () => {
    const user = userEvent.setup();
    render(<OfflinePaymentModal onClose={onClose} />);

    const closeButtons = screen.getAllByRole("button", { name: "Close" });
    await user.click(closeButtons[closeButtons.length - 1]);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the backdrop overlay is clicked", () => {
    render(<OfflinePaymentModal onClose={onClose} />);

    const dialog = screen.getByRole("dialog");
    const overlay = dialog.querySelector('[aria-hidden="true"]');
    fireEvent.click(overlay as Element);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows an offline banner and disables Pay when offline", () => {
    mockUseOffline.mockReturnValue(true);
    render(<OfflinePaymentModal onClose={onClose} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/you are offline/i);
    const payButton = screen.getByRole("button", { name: /offline — use qr/i });
    expect(payButton).toBeDisabled();
  });

  it("keeps Pay enabled and hides the offline banner when online", () => {
    mockUseOffline.mockReturnValue(false);
    render(<OfflinePaymentModal onClose={onClose} />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay" })).not.toBeDisabled();
  });

  it("copies the SMS example to the clipboard and shows confirmation", async () => {
    const writeTextSpy = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextSpy },
      configurable: true,
      writable: true,
    });

    render(<OfflinePaymentModal meterId="M42" onClose={onClose} />);

    const copyBtn = screen.getByRole("button", { name: "Copy SMS example" });
    fireEvent.click(copyBtn);

    expect(writeTextSpy).toHaveBeenCalledWith("PAY M42 5 D");
    expect(await screen.findByText("✓ Copied")).toBeInTheDocument();
  });

  it("renders a docs link that opens in a new tab", () => {
    render(<OfflinePaymentModal onClose={onClose} />);

    const link = screen.getByRole("link", { name: /sms webhook documentation/i });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });
});
