import React, { useState } from 'react';

export interface MeterTheftStatus {
  meterId: string;
  riskScore: number;
  classification: 'NORMAL' | 'SUSPICIOUS' | 'HIGH_THEFT_PROBABILITY';
  estimatedRevenueLossKwh: number;
  anomalies: {
    type: string;
    timestamp: string;
    expectedKwh: number;
    actualKwh: number;
    severity: string;
    description: string;
  }[];
  recommendedActions: string[];
}

const SAMPLE_METERS: MeterTheftStatus[] = [
  {
    meterId: 'MTR-SOLAR-8821',
    riskScore: 85,
    classification: 'HIGH_THEFT_PROBABILITY',
    estimatedRevenueLossKwh: 18.4,
    anomalies: [
      {
        type: 'ZERO_LOAD_BYPASS',
        timestamp: '2026-10-16T09:00:00Z',
        expectedKwh: 4.5,
        actualKwh: 0.02,
        severity: 'CRITICAL',
        description: 'Near-zero consumption recorded during active load period (likely meter bypass).',
      },
      {
        type: 'SUDDEN_DROP',
        timestamp: '2026-10-16T11:00:00Z',
        expectedKwh: 4.6,
        actualKwh: 0.9,
        severity: 'HIGH',
        description: 'Consumption dropped by 80% below expected ML profile.',
      },
    ],
    recommendedActions: [
      'Dispatch field technician to inspect physical meter seals and CT clamps.',
      'Cross-check transformer feeder balance against neighboring smart meters.',
    ],
  },
  {
    meterId: 'MTR-SOLAR-4410',
    riskScore: 12,
    classification: 'NORMAL',
    estimatedRevenueLossKwh: 0,
    anomalies: [],
    recommendedActions: ['No immediate action required; consumption aligns with historical ML profile.'],
  },
];

export const MeterTheftDashboard: React.FC = () => {
  const [selectedMeter, setSelectedMeter] = useState<MeterTheftStatus>(SAMPLE_METERS[0]);

  const badgeStyle = (classification: MeterTheftStatus['classification']) => {
    if (classification === 'HIGH_THEFT_PROBABILITY') return 'bg-red-100 text-red-800 border-red-300';
    if (classification === 'SUSPICIOUS') return 'bg-amber-100 text-amber-800 border-amber-300';
    return 'bg-emerald-100 text-emerald-800 border-emerald-300';
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex justify-between items-center border-b pb-4">
        <div>
          <h2 className="text-xl font-bold">Smart Meter Energy Theft Detection Dashboard</h2>
          <p className="text-sm text-gray-600">
            ML-powered anomaly detection comparing expected vs. actual consumption patterns
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {SAMPLE_METERS.map((meter) => (
          <div
            key={meter.meterId}
            onClick={() => setSelectedMeter(meter)}
            className={`cursor-pointer border rounded-lg p-4 transition ${
              selectedMeter.meterId === meter.meterId ? 'ring-2 ring-blue-500 bg-white' : 'bg-gray-50'
            }`}
          >
            <div className="flex justify-between items-center">
              <span className="font-semibold">{meter.meterId}</span>
              <span className={`text-xs px-2 py-1 rounded border font-medium ${badgeStyle(meter.classification)}`}>
                {meter.classification} (Risk: {meter.riskScore}/100)
              </span>
            </div>
            <div className="mt-3 w-full bg-gray-200 h-2 rounded-full overflow-hidden">
              <div
                className={`h-full ${
                  meter.riskScore >= 70 ? 'bg-red-600' : meter.riskScore >= 35 ? 'bg-amber-500' : 'bg-emerald-500'
                }`}
                style={{ width: `${meter.riskScore}%` }}
              />
            </div>
            <p className="text-xs text-gray-600 mt-2">
              Estimated Unmetered Loss: <strong>{meter.estimatedRevenueLossKwh} kWh</strong>
            </p>
          </div>
        ))}
      </div>

      <div className="border rounded-lg p-5 bg-white shadow-sm space-y-4">
        <div className="flex justify-between items-center">
          <h3 className="text-lg font-bold">Investigation Report — {selectedMeter.meterId}</h3>
          {selectedMeter.riskScore >= 70 && (
            <span className="text-xs bg-red-600 text-white px-3 py-1 rounded font-semibold">
              PROVIDER ALERT SENT
            </span>
          )}
        </div>

        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-gray-700">Detected Consumption Anomalies</h4>
          {selectedMeter.anomalies.length === 0 ? (
            <p className="text-sm text-gray-500">No anomalies detected.</p>
          ) : (
            selectedMeter.anomalies.map((a, idx) => (
              <div key={idx} className="border-l-4 border-red-500 bg-red-50 p-3 rounded text-xs space-y-1">
                <div className="flex justify-between font-semibold">
                  <span>
                    [{a.severity}] {a.type}
                  </span>
                  <span>{a.timestamp}</span>
                </div>
                <p>{a.description}</p>
                <p className="text-gray-600">
                  Expected: <strong>{a.expectedKwh} kWh</strong> | Actual: <strong>{a.actualKwh} kWh</strong>
                </p>
              </div>
            ))
          )}
        </div>

        <div>
          <h4 className="text-sm font-semibold text-gray-700">Recommended Field Actions</h4>
          <ul className="list-disc list-inside text-xs text-gray-700 mt-1 space-y-1">
            {selectedMeter.recommendedActions.map((act, i) => (
              <li key={i}>{act}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};

export default MeterTheftDashboard;
