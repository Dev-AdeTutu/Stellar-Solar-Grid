import { renderHook, act } from "@testing-library/react";
import { useInterval } from "@/hooks/useInterval";

describe("useInterval", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("does NOT fire on mount (no double-fetch on first render)", () => {
    const cb = jest.fn();
    renderHook(() => useInterval(cb, 1000));
    expect(cb).not.toHaveBeenCalled();
  });

  it("fires after the specified delay", () => {
    const cb = jest.fn();
    renderHook(() => useInterval(cb, 1000));
    act(() => jest.advanceTimersByTime(1000));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("fires multiple times at the correct interval", () => {
    const cb = jest.fn();
    renderHook(() => useInterval(cb, 500));
    act(() => jest.advanceTimersByTime(2000));
    expect(cb).toHaveBeenCalledTimes(4);
  });

  it("stops firing after unmount (polling stops on unmount)", () => {
    const cb = jest.fn();
    const { unmount } = renderHook(() => useInterval(cb, 500));
    act(() => jest.advanceTimersByTime(500));
    expect(cb).toHaveBeenCalledTimes(1);
    unmount();
    act(() => jest.advanceTimersByTime(2000));
    // still only 1 call — interval was cleared
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("pauses when delay is null", () => {
    const cb = jest.fn();
    renderHook(() => useInterval(cb, null));
    act(() => jest.advanceTimersByTime(10_000));
    expect(cb).not.toHaveBeenCalled();
  });

  it("always uses the latest callback (no stale closure)", () => {
    const first = jest.fn();
    const second = jest.fn();
    let cb = first;

    const { rerender } = renderHook(() => useInterval(cb, 500));

    // Swap callback before the interval fires
    cb = second;
    rerender();

    act(() => jest.advanceTimersByTime(500));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("restarts the interval when delay changes", () => {
    const cb = jest.fn();
    let delay = 1000;

    const { rerender } = renderHook(() => useInterval(cb, delay));

    act(() => jest.advanceTimersByTime(500));
    expect(cb).toHaveBeenCalledTimes(0);

    // Change delay — old interval is cleared, new one starts
    delay = 200;
    rerender();

    act(() => jest.advanceTimersByTime(200));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("resumes polling when delay changes from null to a number", () => {
    const cb = jest.fn();
    let delay: number | null = null;

    const { rerender } = renderHook(() => useInterval(cb, delay));
    act(() => jest.advanceTimersByTime(5000));
    expect(cb).not.toHaveBeenCalled();

    delay = 1000;
    rerender();
    act(() => jest.advanceTimersByTime(1000));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
