/**
 * Unit tests for useBalancePoller (#574)
 *
 * Covers:
 * - Notification fires when balance < 20 % of last top-up
 * - No notification when balance >= 20 % of last top-up
 * - 4-hour rate-limit suppresses a second notification within the window
 * - Notification is allowed again after the 4-hour window expires
 * - No notification when Notification permission is not "granted"
 * - SSR-safe: hook does not access window during server render
 */

import { renderHook, act } from "@testing-library/react";
import { useBalancePoller } from "@/hooks/useBalancePoller";
import { useWalletStore } from "@/store/walletStore";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockNotification = jest.fn();
let permissionState: NotificationPermission = "granted";

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: jest.fn((key: string) => store[key] ?? null),
    setItem: jest.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: jest.fn((key: string) => { delete store[key]; }),
    clear: jest.fn(() => { store = {}; }),
  };
})();

beforeAll(() => {
  Object.defineProperty(global, "localStorage", { value: localStorageMock, writable: true });

  // Mock Notification API
  const MockNotif = function (this: unknown, title: string, opts?: NotificationOptions) {
    mockNotification(title, opts);
  } as unknown as typeof Notification;
  Object.defineProperty(MockNotif, "permission", {
    get: () => permissionState,
    configurable: true,
  });
  MockNotif.requestPermission = jest.fn().mockResolvedValue("granted");
  Object.defineProperty(global, "Notification", { value: MockNotif, writable: true, configurable: true });
});

beforeEach(() => {
  jest.useFakeTimers();
  localStorageMock.clear();
  localStorageMock.getItem.mockClear();
  localStorageMock.setItem.mockClear();
  mockNotification.mockClear();
  permissionState = "granted";

  // Seed wallet store with a known top-up for METER1
  useWalletStore.setState({
    lastTopUpPerMeter: { METER1: 100_000_000n }, // 10 XLM
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ── Helpers ────────────────────────────────────────────────────────────────

function renderPoller(meterId: string, balance: bigint | null, pollIntervalMs = 30_000) {
  return renderHook(
    ({ id, bal, interval }: { id: string; bal: bigint | null; interval: number }) =>
      useBalancePoller(id, bal, interval),
    { initialProps: { id: meterId, bal: balance, interval: pollIntervalMs } },
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("useBalancePoller – threshold", () => {
  it("fires a notification when balance is below 20 % of last top-up", () => {
    // 10 XLM top-up → threshold = 2 XLM (20_000_000 stroops)
    // balance = 1.5 XLM (15_000_000) → should fire
    renderPoller("METER1", 15_000_000n);

    expect(mockNotification).toHaveBeenCalledTimes(1);
    expect(mockNotification).toHaveBeenCalledWith(
      expect.stringContaining("Low Balance"),
      expect.objectContaining({ tag: "sg-balance-METER1" }),
    );
  });

  it("does NOT fire when balance is exactly at the 20 % threshold", () => {
    // threshold = 20_000_000 stroops; balance == threshold → no notification
    renderPoller("METER1", 20_000_000n);
    expect(mockNotification).not.toHaveBeenCalled();
  });

  it("does NOT fire when balance is above the threshold", () => {
    // balance = 5 XLM → well above 20 %
    renderPoller("METER1", 50_000_000n);
    expect(mockNotification).not.toHaveBeenCalled();
  });

  it("does NOT fire when balance is null", () => {
    renderPoller("METER1", null);
    expect(mockNotification).not.toHaveBeenCalled();
  });

  it("does NOT fire when there is no recorded top-up for the meter", () => {
    useWalletStore.setState({ lastTopUpPerMeter: {} });
    renderPoller("METER1", 5_000_000n);
    expect(mockNotification).not.toHaveBeenCalled();
  });
});

describe("useBalancePoller – 4-hour rate-limit", () => {
  it("fires only once when called multiple times within 4 hours", () => {
    renderPoller("METER1", 15_000_000n, 1_000);

    // Notification fired on mount
    expect(mockNotification).toHaveBeenCalledTimes(1);

    // Advance time by 1 second (well within 4-hour window)
    act(() => jest.advanceTimersByTime(1_000));
    expect(mockNotification).toHaveBeenCalledTimes(1); // still only once
  });

  it("fires again after the 4-hour window expires", () => {
    renderPoller("METER1", 15_000_000n, 1_000);
    expect(mockNotification).toHaveBeenCalledTimes(1);

    // Simulate 4 hours + 1 second passing — clear the stored timestamp
    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
    localStorageMock.getItem.mockImplementation((key: string) => {
      if (key === "sg_notif_ts_METER1") {
        return String(Date.now() - FOUR_HOURS_MS - 1_000);
      }
      return null;
    });

    act(() => jest.advanceTimersByTime(1_000));
    expect(mockNotification).toHaveBeenCalledTimes(2);
  });

  it("stores the notification timestamp in localStorage", () => {
    renderPoller("METER1", 15_000_000n);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      "sg_notif_ts_METER1",
      expect.any(String),
    );
  });
});

describe("useBalancePoller – permission / silent fallback", () => {
  it("does NOT fire when Notification permission is 'denied'", () => {
    permissionState = "denied";
    renderPoller("METER1", 5_000_000n);
    expect(mockNotification).not.toHaveBeenCalled();
  });

  it("does NOT fire when Notification permission is 'default'", () => {
    permissionState = "default";
    renderPoller("METER1", 5_000_000n);
    expect(mockNotification).not.toHaveBeenCalled();
  });
});
