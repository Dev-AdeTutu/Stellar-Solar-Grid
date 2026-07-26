import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AllowlistPanel } from "@/components/AllowlistPanel";
import { getAllowlist, addToAllowlist, removeFromAllowlist } from "@/services/allowlistService";

jest.mock("@/services/allowlistService");

const mockGetAllowlist = getAllowlist as jest.MockedFunction<typeof getAllowlist>;
const mockAddToAllowlist = addToAllowlist as jest.MockedFunction<typeof addToAllowlist>;
const mockRemoveFromAllowlist = removeFromAllowlist as jest.MockedFunction<typeof removeFromAllowlist>;

describe("AllowlistPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows a loading state, then renders fetched addresses", async () => {
    mockGetAllowlist.mockResolvedValue({ data: ["GADDR1", "GADDR2"], total: 2, page: 1, limit: 50 });
    render(<AllowlistPanel />);

    expect(screen.getByText(/loading/i)).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("GADDR1")).toBeInTheDocument());
    expect(screen.getByText("GADDR2")).toBeInTheDocument();
    expect(screen.getByText("Allowlist (2)")).toBeInTheDocument();
    expect(mockGetAllowlist).toHaveBeenCalledWith(1, 50);
  });

  it("shows the error message when the initial load fails", async () => {
    mockGetAllowlist.mockRejectedValue(new Error("Network down"));
    render(<AllowlistPanel />);

    await waitFor(() => expect(screen.getByText("Network down")).toBeInTheDocument());
  });

  it("disables the Add button while the input is empty or whitespace", async () => {
    mockGetAllowlist.mockResolvedValue({ data: [], total: 0, page: 1, limit: 50 });
    const user = userEvent.setup();
    render(<AllowlistPanel />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Add" })).toBeDisabled());

    const input = screen.getByPlaceholderText("Stellar public key (G...)");
    await user.type(input, "   ");
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("adds a trimmed address and reloads the current page", async () => {
    mockGetAllowlist.mockResolvedValue({ data: [], total: 0, page: 1, limit: 50 });
    mockAddToAllowlist.mockResolvedValue({ hash: "abc" });
    const user = userEvent.setup();
    render(<AllowlistPanel />);

    const input = screen.getByPlaceholderText("Stellar public key (G...)");
    await user.type(input, "  GNEWADDRESS  ");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(mockAddToAllowlist).toHaveBeenCalledWith("GNEWADDRESS"));
    // Initial mount load + reload after a successful add.
    await waitFor(() => expect(mockGetAllowlist).toHaveBeenCalledTimes(2));
    expect(input).toHaveValue("");
  });

  it("shows an error and does not clear the input when adding fails", async () => {
    mockGetAllowlist.mockResolvedValue({ data: [], total: 0, page: 1, limit: 50 });
    mockAddToAllowlist.mockRejectedValue(new Error("Address already allowlisted"));
    const user = userEvent.setup();
    render(<AllowlistPanel />);

    const input = screen.getByPlaceholderText("Stellar public key (G...)");
    await user.type(input, "GDUPLICATE");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(screen.getByText("Address already allowlisted")).toBeInTheDocument(),
    );
    expect(input).toHaveValue("GDUPLICATE");
  });

  it("removes an address when Remove is clicked", async () => {
    mockGetAllowlist.mockResolvedValue({ data: ["GADDR1"], total: 1, page: 1, limit: 50 });
    mockRemoveFromAllowlist.mockResolvedValue({ hash: "def" });
    const user = userEvent.setup();
    render(<AllowlistPanel />);

    await waitFor(() => expect(screen.getByText("GADDR1")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(mockRemoveFromAllowlist).toHaveBeenCalledWith("GADDR1"));
  });

  it("hides pagination controls when everything fits on one page", async () => {
    mockGetAllowlist.mockResolvedValue({ data: ["GADDR1"], total: 1, page: 1, limit: 50 });
    render(<AllowlistPanel />);

    await waitFor(() => expect(screen.getByText("GADDR1")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  });

  it("shows pagination and requests the next page on Next click", async () => {
    mockGetAllowlist.mockResolvedValueOnce({
      data: ["GADDR1"],
      total: 120,
      page: 1,
      limit: 50,
    });
    const user = userEvent.setup();
    render(<AllowlistPanel />);

    await waitFor(() => expect(screen.getByText(/Page 1 \/ 3/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Prev" })).toBeDisabled();

    mockGetAllowlist.mockResolvedValueOnce({ data: ["GADDR2"], total: 120, page: 2, limit: 50 });
    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(mockGetAllowlist).toHaveBeenLastCalledWith(2, 50));
  });
});
