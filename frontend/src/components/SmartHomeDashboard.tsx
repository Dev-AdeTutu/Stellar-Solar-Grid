import React, { useState } from 'react';

interface CircuitItem {
  circuitId: string;
  name: string;
  isOn: boolean;
  powerWatts: number;
}

export const SmartHomeDashboard: React.FC = () => {
  const [circuits, setCircuits] = useState<CircuitItem[]>([
    { circuitId: 'c-hvac', name: 'HVAC Heat Pump', isOn: true, powerWatts: 1850 },
    { circuitId: 'c-ev', name: 'EV Garage Charger', isOn: false, powerWatts: 7200 },
    { circuitId: 'c-water', name: 'Solar Water Heater', isOn: true, powerWatts: 1200 },
  ]);
  const [mqttConnected] = useState(true);
  const [voiceAssistants] = useState(['Home Assistant (MQTT)', 'Google Home', 'Amazon Alexa']);

  const toggleCircuit = (id: string) => {
    setCircuits((prev) =>
      prev.map((c) => (c.circuitId === id ? { ...c, isOn: !c.isOn } : c))
    );
  };

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
