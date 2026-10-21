import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';

// Polyfill ResizeObserver for recharts
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// @ts-ignore
global.ResizeObserver = ResizeObserverMock;

// Mock recharts to render simple, testable elements
jest.mock('recharts', () => {
  const React = require('react');
  return {
    ResponsiveContainer: ({ children }: any) =>
      React.createElement('div', { 'data-testid': 'responsive-container' }, children),
    LineChart: ({ children, data }: any) =>
      React.createElement('div', { 'data-testid': 'line-chart', 'data-points': data ? data.length : 0 }, children),
    Line: ({ dataKey, name }: any) =>
      React.createElement('div', { 'data-testid': `line-${dataKey}`, 'data-name': name }),
    XAxis: () => React.createElement('div', { 'data-testid': 'x-axis' }),
    YAxis: () => React.createElement('div', { 'data-testid': 'y-axis' }),
    CartesianGrid: () => React.createElement('div', { 'data-testid': 'cartesian-grid' }),
    Tooltip: () => React.createElement('div', { 'data-testid': 'tooltip' }),
    Legend: () => React.createElement('div', { 'data-testid': 'legend' }),
    ReferenceLine: ({ y }: any) =>
      React.createElement('div', { 'data-testid': 'reference-line', 'data-y': y }),
  };
});

import PowerQualityChart from '../components/PowerQualityChart';

const mockFetch = jest.fn();
// @ts-ignore
global.fetch = mockFetch;

const buildQualityResponse = (overrides: any = {}) => ({
  meterId: 'meter-1',
  current: {
    voltage: 230.5,
    frequency: 50.02,
    thd: 3.4,
    timestamp: '2024-01-01T00:00:00.000Z',
    ...(overrides.current || {}),
  },
  issues: overrides.issues || [],
  history: overrides.history || [
    { timestamp: '2024-01-01T00:00:00.000Z', voltage: 230.5, frequency: 50.02, thd: 3.4 },
    { timestamp: '2024-01-01T00:15:00.000Z', voltage: 228.1, frequency: 49.98, thd: 4.1 },
    { timestamp: '2024-01-01T00:30:00.000Z', voltage: 231.0, frequency: 50.05, thd: 3.9 },
  ],
});

const mockFetchSuccess = (payload: any) => {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => payload,
  });
};

describe('PowerQualityChart', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders current voltage, frequency, and THD values', async () => {
    mockFetchSuccess(buildQualityResponse());

    render(<PowerQualityChart meterId="meter-1" />);

    await waitFor(() => {
      expect(screen.getByText(/230\.5/)).toBeInTheDocument();
    });

    expect(screen.getByText(/50\.02/)).toBeInTheDocument();
    expect(screen.getByText(/3\.4/)).toBeInTheDocument();

    // Labels for the metrics
    expect(screen.getByText(/voltage/i)).toBeInTheDocument();
    expect(screen.getByText(/frequency/i)).toBeInTheDocument();
    expect(screen.getByText(/thd|harmonic/i)).toBeInTheDocument();
  });

  it('renders detected issues with correct severity styling', async () => {
    mockFetchSuccess(
      buildQualityResponse({
        issues: [
          { type: 'sag', severity: 'high', message: 'Voltage sag detected', value: 190 },
          { type: 'swell', severity: 'medium', message: 'Voltage swell detected', value: 260 },
          { type: 'harmonic', severity: 'low', message: 'Elevated harmonics', value: 8.2 },
        ],
      })
    );

    render(<PowerQualityChart meterId="meter-1" />);

    await waitFor(() => {
      expect(screen.getByText(/voltage sag detected/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/voltage swell detected/i)).toBeInTheDocument();
    expect(screen.getByText(/elevated harmonics/i)).toBeInTheDocument();

    // Severity styling via data attributes / classes
    const highIssue = screen.getByText(/voltage sag detected/i).closest('[data-severity]');
    const mediumIssue = screen.getByText(/voltage swell detected/i).closest('[data-severity]');
    const lowIssue = screen.getByText(/elevated harmonics/i).closest('[data-severity]');

    expect(highIssue).toHaveAttribute('data-severity', 'high');
    expect(mediumIssue).toHaveAttribute('data-severity', 'medium');
    expect(lowIssue).toHaveAttribute('data-severity', 'low');

    expect(highIssue?.className).toMatch(/high|error|danger/i);
    expect(mediumIssue?.className).toMatch(/medium|warning/i);
    expect(lowIssue?.className).toMatch(/low|info/i);
  });

  it('renders the historical trend chart with provided history data', async () => {
    mockFetchSuccess(buildQualityResponse());

    render(<PowerQualityChart meterId="meter-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('line-chart')).toBeInTheDocument();
    });

    const chart = screen.getByTestId('line-chart');
    expect(chart).toHaveAttribute('data-points', '3');

    expect(screen.getByTestId('line-voltage')).toBeInTheDocument();
    expect(screen.getByTestId('line-frequency')).toBeInTheDocument();
    expect(screen.getByTestId('line-thd')).toBeInTheDocument();
  });

  it('shows an empty state when history is empty', async () => {
    mockFetchSuccess(buildQualityResponse({ history: [] }));

    render(<PowerQualityChart meterId="meter-1" />);

    await waitFor(() => {
      expect(screen.getByText(/no historical data|no data available/i)).toBeInTheDocument();
    });

    expect(screen.queryByTestId('line-chart')).not.toBeInTheDocument();
  });

  it('handles API errors gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    render(<PowerQualityChart meterId="meter-1" />);

    await waitFor(() => {
      expect(screen.getByText(/failed to load|error|unable to load/i)).toBeInTheDocument();
    });

    // Should not crash and should not render chart
    expect(screen.queryByTestId('line-chart')).not.toBeInTheDocument();
  });

  it('handles non-ok API responses gracefully', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Server error' }),
    });

    render(<PowerQualityChart meterId="meter-1" />);

    await waitFor(() => {
      expect(screen.getByText(/failed to load|error|unable to load/i)).toBeInTheDocument();
    });
  });

  it('polls/refetches on the configured interval', async () => {
    jest.useFakeTimers();
    mockFetchSuccess(buildQualityResponse());

    render(<PowerQualityChart meterId="meter-1" refreshInterval={5000} />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      jest.advanceTimersByTime(5000);
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      jest.advanceTimersByTime(5000);
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    // Ensure the endpoint is the power-quality endpoint for the meter
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/meters/meter-1/power-quality')
    );
  });

  it('refetches when the meterId changes', async () => {
    mockFetchSuccess(buildQualityResponse());

    const { rerender } = render(<PowerQualityChart meterId="meter-1" />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/meters/meter-1/power-quality')
      );
    });

    rerender(<PowerQualityChart meterId="meter-2" />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/meters/meter-2/power-quality')
      );
    });
  });

  it('allows manual refresh via a refresh button', async () => {
    mockFetchSuccess(buildQualityResponse());

    render(<PowerQualityChart meterId="meter-1" />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const refreshButton = screen.getByRole('button', { name: /refresh/i });
    fireEvent.click(refreshButton);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});