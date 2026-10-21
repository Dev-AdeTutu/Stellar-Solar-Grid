import React, { useCallback, useEffect, useState } from 'react';

interface CircuitItem {
  circuitId: string;
  name: string;
  isOn: boolean;
  powerWatts: number;
}

interface DrEvent {
  eventId: string;
  name: string;
  status: 'scheduled' | 'active' | 'completed' | 'cancelled';
  startsAt: string;
  endsAt: string;
  curtailmentTargetKw: number;
  incentiveRatePerKwh: number;
}

interface DrParticipation {
  eventId: string;
  eventName: string;
  date: string;
  curtailedKw: number;
  verified: boolean;
  incentiveEarned: number;
}

interface DrLoadPreference {
  circuitId: string;
  optedIn: boolean;
  maxCurtailmentWatts: number;
}

interface DrVerification {
  eventId: string;
  baselineKw: number;
  actualKw: number;
  curtailedKw: number;
  targetKw: number;
  verified: boolean;
  notes: string;
}

const DR_API_BASE = '/api/demand-response';

export const SmartHomeDashboard: React.FC = () => {
  const [circuits, setCircuits] = useState<CircuitItem[]>([
    { circuitId: 'c-hvac', name: 'HVAC Heat Pump', isOn: true, powerWatts: 1850 },
    { circuitId: 'c-ev', name: 'EV Garage Charger', isOn: false, powerWatts: 7200 },
    { circuitId: 'c-water', name: 'Solar Water Heater', isOn: true, powerWatts: 1200 },
  ]);
  const [mqttConnected] = useState(true);
  const [voiceAssistants] = useState(['Home Assistant (MQTT)', 'Google Home', 'Amazon Alexa']);

  const [drEvents, setDrEvents] = useState<DrEvent[]>([]);
  const [drEnrolled, setDrEnrolled] = useState(false);
  const [drPreferences, setDrPreferences] = useState<DrLoadPreference[]>([]);
  const [drHistory, setDrHistory] = useState<DrParticipation[]>([]);
  const [drVerifications, setDrVerifications] = useState<DrVerification[]>([]);
  const [drLoading, setDrLoading] = useState(true);
  const [drError, setDrError] = useState<string | null>(null);

  const toggleCircuit = (id: string) => {
    setCircuits((prev) =>
      prev.map((c) => (c.circuitId === id ? { ...c, isOn: !c.isOn } : c))
    );
  };

  const loadDemandResponse = useCallback(async () => {
    setDrLoading(true);
    setDrError(null);
    try {
      const [eventsRes, enrollmentRes, historyRes, verificationRes] = await Promise.all([
        fetch(`${DR_API_BASE}/events`),
        fetch(`${DR_API_BASE}/enrollment`),
        fetch(`${DR_API_BASE}/history`),
        fetch(`${DR_API_BASE}/verification`),
      ]);
      if (!eventsRes.ok || !enrollmentRes.ok || !historyRes.ok || !verificationRes.ok) {
        throw new Error('Failed to load demand response data');
      }
      const events = (await eventsRes.json()) as { events: DrEvent[] };
      const enrollment = (await enrollmentRes.json()) as {
        enrolled: boolean;
        preferences: DrLoadPreference[];
      };
      const history = (await historyRes.json()) as { participations: DrParticipation[] };
      const verification = (await verificationRes.json()) as {
        verifications: DrVerification[];
      };

      setDrEvents(events.events ?? []);
      setDrEnrolled(enrollment.enrolled ?? false);
      setDrPreferences(enrollment.preferences ?? []);
      setDrHistory(history.participations ?? []);
      setDrVerifications(verification.verifications ?? []);
    } catch (err) {
      setDrError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setDrLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDemandResponse();
  }, [loadDemandResponse]);

  const toggleEnrollment = async () => {
    const next = !drEnrolled;
    try {
      const res = await fetch(`${DR_API_BASE}/enrollment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enrolled: next, preferences: drPreferences }),
      });
      if (!res.ok) throw new Error('Failed to update enrollment');
      setDrEnrolled(next);
    } catch (err) {
      setDrError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const updatePreference = async (
    circuitId: string,
    patch: Partial<DrLoadPreference>
  ) => {
    const existing = drPreferences.find((p) => p.circuitId === circuitId) ?? {
      circuitId,
      optedIn: false,
      maxCurtailmentWatts: 0,
    };
    const updated = { ...existing, ...patch };
    const nextPreferences = [
      ...drPreferences.filter((p) => p.circuitId !== circuitId),
      updated,
    ];
    setDrPreferences(nextPreferences);
    try {
      const res = await fetch(`${DR_API_BASE}/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
      if (!res.ok) throw new Error('Failed to save load preference');
    } catch (err) {
      setDrError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const totalIncentivesEarned = drHistory.reduce((sum, h) => sum + h.incentiveEarned, 0);
  const activeOrScheduledEvents = drEvents.filter(
    (e) => e.status === 'active' || e.status === 'scheduled'
  );

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <header className="flex justify-between items-center border-b pb-4">
        <div>
          <h2 className="text-xl font-bold">Smart Home IoT Hub & Energy Dashboard</h2>
          <p className="text-sm text-gray-600">
            Unified Home Assistant MQTT Discovery, Google Home / Alexa voice control, and circuit automations
          </p>
        </div>
        <span className="text-xs px-3 py-1 rounded bg-emerald-100 text-emerald-800 font-semibold">
          {mqttConnected ? 'MQTT Broker Connected' : 'Disconnected'}
        </span>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="border rounded-lg p-4 bg-amber-50">
          <span className="text-xs uppercase text-amber-700">Solar Generation</span>
          <p className="text-2xl font-bold mt-1">4.85 kW</p>
        </div>
        <div className="border rounded-lg p-4 bg-blue-50">
          <span className="text-xs uppercase text-blue-700">Daily Grid Energy</span>
          <p className="text-2xl font-bold mt-1">26.4 kWh</p>
        </div>
        <div className="border rounded-lg p-4 bg-emerald-50">
          <span className="text-xs uppercase text-emerald-700">Battery Storage SoC</span>
          <p className="text-2xl font-bold mt-1">84%</p>
        </div>
      </div>

      <section className="border rounded-lg p-4 bg-white space-y-3">
        <h3 className="text-base font-bold">Smart Circuit Load Control & Automations</h3>
        <div className="divide-y">
          {circuits.map((c) => (
            <div key={c.circuitId} className="py-3 flex justify-between items-center">
              <div>
                <p className="font-medium text-sm">{c.name}</p>
                <p className="text-xs text-gray-500">
                  ID: {c.circuitId} • Draw: {c.isOn ? `${c.powerWatts} W` : '0 W'}
                </p>
              </div>
              <button
                onClick={() => toggleCircuit(c.circuitId)}
                className={`px-4 py-1.5 rounded text-xs font-semibold ${
                  c.isOn ? 'bg-green-600 text-white' : 'bg-gray-200 text-gray-700'
                }`}
              >
                {c.isOn ? 'ON' : 'OFF'}
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="border rounded-lg p-4 bg-white space-y-4">
        <div className="flex justify-between items-center">
          <div>
            <h3 className="text-base font-bold">Energy Demand Response Program</h3>
            <p className="text-xs text-gray-500">
              Automated load curtailment with smart-contract incentive payouts
            </p>
          </div>
          <button
            onClick={() => void toggleEnrollment()}
            className={`px-4 py-1.5 rounded text-xs font-semibold ${
              drEnrolled ? 'bg-emerald-600 text-white' : 'bg-gray-200 text-gray-700'
            }`}
          >
            {drEnrolled ? 'Enrolled — Opt Out' : 'Opt In to DR Program'}
          </button>
        </div>

        {drError && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">
            {drError}
          </p>
        )}

        {drLoading ? (
          <p className="text-xs text-gray-500">Loading demand response data…</p>
        ) : (
          <>
            <div>
              <h4 className="text-xs font-semibold uppercase text-gray-500 mb-2">
                Active & Scheduled DR Events
              </h4>
              {activeOrScheduledEvents.length === 0 ? (
                <p className="text-xs text-gray-500">No upcoming DR events.</p>
              ) : (
                <div className="divide-y">
                  {activeOrScheduledEvents.map((e) => (
                    <div key={e.eventId} className="py-2 flex justify-between items-center">
                      <div>
                        <p className="font-medium text-sm">{e.name}</p>
                        <p className="text-xs text-gray-500">
                          {new Date(e.startsAt).toLocaleString()} –{' '}
                          {new Date(e.endsAt).toLocaleTimeString()} • Target:{' '}
                          {e.curtailmentTargetKw} kW • ${e.incentiveRatePerKwh}/kWh
                        </p>
                      </div>
                      <span
                        className={`text-xs px-2 py-0.5 rounded font-semibold ${
                          e.status === 'active'
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-blue-100 text-blue-800'
                        }`}
                      >
                        {e.status.toUpperCase()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase text-gray-500 mb-2">
                Load Preferences (per circuit)
              </h4>
              <div className="divide-y">
                {circuits.map((c) => {
                  const pref = drPreferences.find((p) => p.circuitId === c.circuitId);
                  return (
                    <div key={c.circuitId} className="py-2 flex justify-between items-center gap-3">
                      <div>
                        <p className="font-medium text-sm">{c.name}</p>
                        <p className="text-xs text-gray-500">
                          Max curtailment: {pref?.maxCurtailmentWatts ?? 0} W
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={0}
                          max={c.powerWatts}
                          value={pref?.maxCurtailmentWatts ?? 0}
                          onChange={(ev) =>
                            void updatePreference(c.circuitId, {
                              maxCurtailmentWatts: Number(ev.target.value),
                            })
                          }
                          className="w-24 border rounded px-2 py-1 text-xs"
                        />
                        <label className="flex items-center gap-1 text-xs">
                          <input
                            type="checkbox"
                            checked={pref?.optedIn ?? false}
                            onChange={(ev) =>
                              void updatePreference(c.circuitId, {
                                optedIn: ev.target.checked,
                              })
                            }
                          />
                          Opted in
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase text-gray-500 mb-2">
                Participation History & Incentives
              </h4>
              <p className="text-xs text-gray-600 mb-2">
                Total incentives earned:{' '}
                <span className="font-bold text-emerald-700">
                  ${totalIncentivesEarned.toFixed(2)}
                </span>
              </p>
              {drHistory.length === 0 ? (
                <p className="text-xs text-gray-500">No participation history yet.</p>
              ) : (
                <div className="divide-y">
                  {drHistory.map((h) => (
                    <div
                      key={`${h.eventId}-${h.date}`}
                      className="py-2 flex justify-between items-center"
                    >
                      <div>
                        <p className="font-medium text-sm">{h.eventName}</p>
                        <p className="text-xs text-gray-500">
                          {new Date(h.date).toLocaleDateString()} • Curtailed {h.curtailedKw} kW
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-emerald-700">
                          ${h.incentiveEarned.toFixed(2)}
                        </p>
                        <p className="text-xs text-gray-500">
                          {h.verified ? 'Verified' : 'Pending'}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase text-gray-500 mb-2">
                Performance Verification
              </h4>
              {drVerifications.length === 0 ? (
                <p className="text-xs text-gray-500">No verification results available.</p>
              ) : (
                <div className="divide-y">
                  {drVerifications.map((v) => (
                    <div key={v.eventId} className="py-2">
                      <div className="flex justify-between items-center">
                        <p className="font-medium text-sm">Event {v.eventId}</p>
                        <span
                          className={`text-xs px-2 py-0.5 rounded font-semibold ${
                            v.verified
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-red-100 text-red-800'
                          }`}
                        >
                          {v.verified ? 'VERIFIED' : 'UNVERIFIED'}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500">
                        Baseline {v.baselineKw} kW → Actual {v.actualKw} kW • Curtailed{' '}
                        {v.curtailedKw} kW of {v.targetKw} kW target
                      </p>
                      {v.notes && <p className="text-xs text-gray-400">{v.notes}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </section>

      <section className="border rounded-lg p-4 bg-gray-50">
        <h4 className="text-xs font-semibold uppercase text-gray-500">Active Integrations</h4>
        <div className="flex gap-2 mt-2">
          {voiceAssistants.map((va) => (
            <span key={va} className="text-xs bg-white border px-3 py-1 rounded">
              {va}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
};

export default SmartHomeDashboard;
