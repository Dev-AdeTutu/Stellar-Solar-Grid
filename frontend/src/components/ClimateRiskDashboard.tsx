/**
 * Climate Risk Dashboard
 * 
 * Main dashboard component for viewing climate risk assessments across the solar fleet.
 * Displays risk distribution, high-risk meters, and mitigation tracking.
 */
import { useState, useEffect } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

// Types
type InsuranceTier = 'low' | 'moderate' | 'high' | 'critical';
type ClimateScenario = 'RCP4.5' | 'RCP8.5' | 'SSP2' | 'SSP5';

interface FleetRiskSummary {
  totalMeters: number;
  riskDistribution: Record<InsuranceTier, number>;
  averageRiskScore: number | null;
  highRiskMeters: Array<{
    meterId: string;
    riskScore: number;
    location: { lat: number; lon: number };
  }>;
  mitigationCoverage: number | null;
  assessedAt: string;
}

interface RiskAssessment {
  meterId: string;
  scenario: ClimateScenario;
  overallRiskScore: number;
  floodScore: number;
  heatwaveScore: number;
  stormScore: number;
  insuranceTier: InsuranceTier;
  lat: number;
  lon: number;
  assessedAt: string;
}

interface MitigationPlan {
  id: number;
  meterId: string;
  hazardType: string;
  recommendation: string;
  priority: string;
  estimatedCostUsd: number | null;
  implementationStatus: 'pending' | 'planned' | 'in_progress' | 'completed';
  details: {
    description: string;
    timeline?: string;
  };
}

export function ClimateRiskDashboard() {
  const [scenario, setScenario] = useState<ClimateScenario>('RCP8.5');
  const [fleetSummary, setFleetSummary] = useState<FleetRiskSummary | null>(null);
  const [selectedMeter, setSelectedMeter] = useState<string | null>(null);
  const [meterScenarios, setMeterScenarios] = useState<RiskAssessment[]>([]);
  const [mitigationPlans, setMitigationPlans] = useState<MitigationPlan[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch fleet summary
  useEffect(() => {
    fetchFleetSummary();
  }, [scenario]);

  const fetchFleetSummary = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/climate-risk/fleet?scenario=${scenario}`);
      if (!response.ok) throw new Error('Failed to fetch fleet summary');
      const data = await response.json();
      setFleetSummary(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Fetch meter details when selected
  const handleMeterClick = async (meterId: string) => {
    setSelectedMeter(meterId);
    setLoading(true);
    try {
      // Fetch all scenarios for this meter
      const scenariosResponse = await fetch(`/api/climate-risk/scenarios/${meterId}`);
      if (!scenariosResponse.ok) throw new Error('Failed to fetch meter scenarios');
      const scenariosData = await scenariosResponse.json();
      setMeterScenarios(scenariosData.scenarios);

      // Fetch mitigation plans
      const mitigationResponse = await fetch(`/api/climate-risk/mitigation/${meterId}`);
      if (!mitigationResponse.ok) throw new Error('Failed to fetch mitigation plans');
      const mitigationData = await mitigationResponse.json();
      setMitigationPlans(mitigationData.plans);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const tierColors: Record<InsuranceTier, string> = {
    low: '#10b981',
    moderate: '#f59e0b',
    high: '#f97316',
    critical: '#ef4444',
  };

  const tierLabels: Record<InsuranceTier, string> = {
    low: 'Low Risk',
    moderate: 'Moderate Risk',
    high: 'High Risk',
    critical: 'Critical Risk',
  };

  // Prepare chart data
  const distributionChartData = fleetSummary
    ? Object.entries(fleetSummary.riskDistribution).map(([tier, count]) => ({
        tier: tierLabels[tier as InsuranceTier],
        count,
        fill: tierColors[tier as InsuranceTier],
      }))
    : [];

  const scenarioComparisonData = meterScenarios.map(assessment => ({
    scenario: assessment.scenario,
    overall: assessment.overallRiskScore,
    flood: assessment.floodScore,
    heatwave: assessment.heatwaveScore,
    storm: assessment.stormScore,
  }));

  return (
    <div className="p-6 space-y-6 bg-gray-50 min-h-screen">
      <div className="bg-white shadow rounded-lg p-6">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-bold text-gray-900">Climate Risk Assessment</h1>
          <div className="flex gap-2">
            {(['RCP4.5', 'RCP8.5', 'SSP2', 'SSP5'] as ClimateScenario[]).map(s => (
              <button
                key={s}
                onClick={() => setScenario(s)}
                className={`px-4 py-2 rounded ${
                  scenario === s
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        {loading && <div className="text-center py-8">Loading...</div>}

        {fleetSummary && !loading && (
          <>
            {/* Summary Stats */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
              <div className="bg-blue-50 p-4 rounded-lg">
                <div className="text-sm text-gray-600">Total Meters</div>
                <div className="text-2xl font-bold text-blue-900">{fleetSummary.totalMeters}</div>
              </div>
              <div className="bg-green-50 p-4 rounded-lg">
                <div className="text-sm text-gray-600">Average Risk Score</div>
                <div className="text-2xl font-bold text-green-900">
                  {fleetSummary.averageRiskScore?.toFixed(1) || 'N/A'}
                </div>
              </div>
              <div className="bg-orange-50 p-4 rounded-lg">
                <div className="text-sm text-gray-600">High Risk Meters</div>
                <div className="text-2xl font-bold text-orange-900">
                  {fleetSummary.riskDistribution.high + fleetSummary.riskDistribution.critical}
                </div>
              </div>
              <div className="bg-purple-50 p-4 rounded-lg">
                <div className="text-sm text-gray-600">Mitigation Coverage</div>
                <div className="text-2xl font-bold text-purple-900">
                  {fleetSummary.mitigationCoverage
                    ? `${(fleetSummary.mitigationCoverage * 100).toFixed(0)}%`
                    : 'N/A'}
                </div>
              </div>
            </div>

            {/* Risk Distribution Chart */}
            <div className="mb-6">
              <h2 className="text-xl font-semibold mb-4">Risk Distribution by Tier</h2>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={distributionChartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="tier" />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey="count" fill="#3b82f6" />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* High Risk Meters Table */}
            <div>
              <h2 className="text-xl font-semibold mb-4">High Risk Meters</h2>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Meter ID
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Risk Score
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Location
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {fleetSummary.highRiskMeters.map(meter => (
                      <tr key={meter.meterId}>
                        <td className="px-6 py-4 whitespace-nowrap font-medium">{meter.meterId}</td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span
                            className={`px-2 py-1 rounded text-white font-semibold ${
                              meter.riskScore > 80 ? 'bg-red-600' : 'bg-orange-600'
                            }`}
                          >
                            {meter.riskScore.toFixed(1)}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                          {meter.location.lat.toFixed(4)}, {meter.location.lon.toFixed(4)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <button
                            onClick={() => handleMeterClick(meter.meterId)}
                            className="text-blue-600 hover:text-blue-800 font-medium"
                          >
                            View Details
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Meter Detail Modal */}
      {selectedMeter && (
        <div className="bg-white shadow rounded-lg p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-2xl font-bold">Meter {selectedMeter} - Detailed Analysis</h2>
            <button
              onClick={() => setSelectedMeter(null)}
              className="text-gray-500 hover:text-gray-700"
            >
              ✕ Close
            </button>
          </div>

          {/* Scenario Comparison Chart */}
          {meterScenarios.length > 0 && (
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-3">Scenario Comparison</h3>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={scenarioComparisonData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="scenario" />
                  <YAxis domain={[0, 100]} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="overall" stroke="#3b82f6" name="Overall" />
                  <Line type="monotone" dataKey="flood" stroke="#06b6d4" name="Flood" />
                  <Line type="monotone" dataKey="heatwave" stroke="#f59e0b" name="Heatwave" />
                  <Line type="monotone" dataKey="storm" stroke="#8b5cf6" name="Storm" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Mitigation Plans */}
          {mitigationPlans.length > 0 && (
            <div>
              <h3 className="text-lg font-semibold mb-3">Mitigation Recommendations</h3>
              <div className="space-y-3">
                {mitigationPlans.map(plan => (
                  <div
                    key={plan.id}
                    className="border border-gray-200 rounded-lg p-4 hover:shadow-md transition"
                  >
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <span className="font-semibold text-gray-900">{plan.recommendation}</span>
                        <span className="ml-2 text-sm text-gray-500">({plan.hazardType})</span>
                      </div>
                      <span
                        className={`px-2 py-1 rounded text-xs font-semibold ${
                          plan.priority === 'critical'
                            ? 'bg-red-100 text-red-800'
                            : plan.priority === 'high'
                            ? 'bg-orange-100 text-orange-800'
                            : plan.priority === 'medium'
                            ? 'bg-yellow-100 text-yellow-800'
                            : 'bg-green-100 text-green-800'
                        }`}
                      >
                        {plan.priority.toUpperCase()}
                      </span>
                    </div>
                    <p className="text-sm text-gray-700 mb-2">{plan.details.description}</p>
                    <div className="flex justify-between items-center text-sm">
                      <div>
                        <span className="text-gray-600">Cost:</span>{' '}
                        <span className="font-semibold">
                          {plan.estimatedCostUsd ? `$${plan.estimatedCostUsd.toLocaleString()}` : 'TBD'}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-600">Status:</span>{' '}
                        <span
                          className={`font-semibold ${
                            plan.implementationStatus === 'completed'
                              ? 'text-green-600'
                              : plan.implementationStatus === 'in_progress'
                              ? 'text-blue-600'
                              : 'text-gray-600'
                          }`}
                        >
                          {plan.implementationStatus.replace('_', ' ')}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ClimateRiskDashboard;
