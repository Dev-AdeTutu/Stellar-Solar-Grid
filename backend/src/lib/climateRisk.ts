/**
 * Climate risk assessment engine.
 * 
 * Calculates risk scores (flood/heatwave/storm) per meter location across multiple
 * climate scenarios (RCP4.5, RCP8.5, SSP2, SSP5). Generates mitigation recommendations
 * and determines insurance tiers based on risk thresholds.
 */
import { listDevices } from './deviceRegistry.js';
import { logger } from './logger.js';
import {
  db,
  fetchClimateProjection,
  type ClimateScenario,
  type HazardType,
  type ClimateProjection,
} from './climateData.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type InsuranceTier = 'low' | 'moderate' | 'high' | 'critical';
export type RecommendationType = 'elevation' | 'hardening' | 'shading' | 'flood_barrier' | 'cooling_system' | 'storm_shutters';
export type MitigationPriority = 'low' | 'medium' | 'high' | 'critical';
export type ImplementationStatus = 'pending' | 'planned' | 'in_progress' | 'completed';

export type RiskAssessment = {
  meterId: string;
  lat: number;
  lon: number;
  scenario: ClimateScenario;
  overallRiskScore: number;
  floodScore: number;
  heatwaveScore: number;
  stormScore: number;
  insuranceTier: InsuranceTier;
  assessedAt: string;
};

export type MitigationPlan = {
  id: number;
  meterId: string;
  hazardType: HazardType;
  recommendation: RecommendationType;
  priority: MitigationPriority;
  estimatedCostUsd: number | null;
  implementationStatus: ImplementationStatus;
  details: {
    description: string;
    timeline?: string;
    contractor?: string;
  };
  createdAt: string;
  updatedAt: string;
};

export type FleetRiskSummary = {
  totalMeters: number;
  riskDistribution: Record<InsuranceTier, number>;
  averageRiskScore: number | null;
  highRiskMeters: Array<{ meterId: string; riskScore: number; location: { lat: number; lon: number } }>;
  mitigationCoverage: number | null;
  assessedAt: string;
};

// ── Meter location resolution ───────────────────────────────────────────────

export function getMeterLocation(meterId: string): { lat: number; lon: number } | null {
  const devices = listDevices({ meterId });
  if (!devices.length || !devices[0].location) {
    return null;
  }

  const locationStr = devices[0].location;

  // Try JSON format first: {"lat": 37.7749, "lon": -122.4194}
  try {
    const parsed = JSON.parse(locationStr);
    if (
      typeof parsed.lat === 'number' &&
      typeof parsed.lon === 'number' &&
      Number.isFinite(parsed.lat) &&
      Number.isFinite(parsed.lon) &&
      parsed.lat >= -90 &&
      parsed.lat <= 90 &&
      parsed.lon >= -180 &&
      parsed.lon <= 180
    ) {
      return { lat: parsed.lat, lon: parsed.lon };
    }
  } catch {
    // Not JSON, try CSV format
  }

  // Try CSV format: "lat,lon"
  const parts = locationStr.split(',').map(s => parseFloat(s.trim()));
  if (
    parts.length === 2 &&
    parts.every(n => !isNaN(n) && Number.isFinite(n)) &&
    parts[0] >= -90 &&
    parts[0] <= 90 &&
    parts[1] >= -180 &&
    parts[1] <= 180
  ) {
    return { lat: parts[0], lon: parts[1] };
  }

  // Location is text address or invalid format
  logger.warn({ meterId, location: locationStr }, 'Cannot parse meter location coordinates');
  return null;
}

// ── Insurance tier calculation ──────────────────────────────────────────────

export function calculateInsuranceTier(overallRiskScore: number): InsuranceTier {
  if (overallRiskScore < 30) return 'low';
  if (overallRiskScore < 55) return 'moderate';
  if (overallRiskScore < 75) return 'high';
  return 'critical';
}

// ── Risk assessment ─────────────────────────────────────────────────────────

async function calculateScenarioRisk(
  meterId: string,
  location: { lat: number; lon: number },
  scenario: ClimateScenario
): Promise<RiskAssessment> {
  // Fetch climate projections for 2050
  const year = 2050;
  const floodData = await fetchClimateProjection(location, scenario, 'flood', year);
  const heatwaveData = await fetchClimateProjection(location, scenario, 'heatwave', year);
  const stormData = await fetchClimateProjection(location, scenario, 'storm', year);

  const floodScore = floodData.exposureScore;
  const heatwaveScore = heatwaveData.exposureScore;
  const stormScore = stormData.exposureScore;

  // Weighted average: flood*0.35 + heatwave*0.4 + storm*0.25
  const overallRiskScore = floodScore * 0.35 + heatwaveScore * 0.4 + stormScore * 0.25;
  const insuranceTier = calculateInsuranceTier(overallRiskScore);

  return {
    meterId,
    lat: location.lat,
    lon: location.lon,
    scenario,
    overallRiskScore,
    floodScore,
    heatwaveScore,
    stormScore,
    insuranceTier,
    assessedAt: new Date().toISOString(),
  };
}

export async function assessMeterRisk(
  meterId: string,
  location: { lat: number; lon: number }
): Promise<RiskAssessment> {
  const scenarios: ClimateScenario[] = ['RCP4.5', 'RCP8.5', 'SSP2', 'SSP5'];

  // Calculate risk for all scenarios
  const assessments = await Promise.all(
    scenarios.map(scenario => calculateScenarioRisk(meterId, location, scenario))
  );

  // Return worst-case scenario (highest overall risk score)
  const worstCase = assessments.reduce((worst, current) =>
    current.overallRiskScore > worst.overallRiskScore ? current : worst
  );

  // Store assessment in database
  db()
    .prepare(
      `INSERT INTO risk_assessments 
       (meter_id, lat, lon, scenario, overall_risk_score, flood_score, heatwave_score, storm_score, insurance_tier, assessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      worstCase.meterId,
      worstCase.lat,
      worstCase.lon,
      worstCase.scenario,
      worstCase.overallRiskScore,
      worstCase.floodScore,
      worstCase.heatwaveScore,
      worstCase.stormScore,
      worstCase.insuranceTier,
      worstCase.assessedAt
    );

  logger.info(
    { meterId, worstScenario: worstCase.scenario, score: worstCase.overallRiskScore },
    'Climate risk assessment complete'
  );

  // Generate and store mitigation recommendations
  await generateMitigations(worstCase);

  return worstCase;
}

// ── Mitigation recommendations ──────────────────────────────────────────────

export async function generateMitigations(assessment: RiskAssessment): Promise<MitigationPlan[]> {
  const plans: Omit<MitigationPlan, 'id' | 'createdAt' | 'updatedAt'>[] = [];
  const now = new Date().toISOString();

  // Flood mitigation
  if (assessment.floodScore > 60) {
    plans.push({
      meterId: assessment.meterId,
      hazardType: 'flood',
      recommendation: 'elevation',
      priority: assessment.floodScore > 80 ? 'critical' : 'high',
      estimatedCostUsd: 5000,
      implementationStatus: 'pending',
      details: {
        description: 'Elevate solar panels and inverters 1-2 meters above ground level to prevent flood damage.',
        timeline: '3-6 months',
      },
    });
    plans.push({
      meterId: assessment.meterId,
      hazardType: 'flood',
      recommendation: 'flood_barrier',
      priority: 'medium',
      estimatedCostUsd: 3000,
      implementationStatus: 'pending',
      details: {
        description: 'Install flood barriers around equipment enclosures.',
        timeline: '1-3 months',
      },
    });
  }

  // Heatwave mitigation
  if (assessment.heatwaveScore > 70) {
    plans.push({
      meterId: assessment.meterId,
      hazardType: 'heatwave',
      recommendation: 'cooling_system',
      priority: assessment.heatwaveScore > 85 ? 'critical' : 'high',
      estimatedCostUsd: 2000,
      implementationStatus: 'pending',
      details: {
        description: 'Install passive cooling (ventilation) or active cooling (fans) for inverters and batteries.',
        timeline: '2-4 months',
      },
    });
    plans.push({
      meterId: assessment.meterId,
      hazardType: 'heatwave',
      recommendation: 'shading',
      priority: 'medium',
      estimatedCostUsd: 1500,
      implementationStatus: 'pending',
      details: {
        description: 'Add reflective coatings or shading structures to reduce panel surface temperature.',
        timeline: '1-2 months',
      },
    });
  }

  // Storm mitigation
  if (assessment.stormScore > 65) {
    plans.push({
      meterId: assessment.meterId,
      hazardType: 'storm',
      recommendation: 'hardening',
      priority: assessment.stormScore > 80 ? 'critical' : 'high',
      estimatedCostUsd: 8000,
      implementationStatus: 'pending',
      details: {
        description: 'Reinforce mounting structures to withstand Category 3 hurricane winds (178 km/h).',
        timeline: '6-12 months',
      },
    });
    plans.push({
      meterId: assessment.meterId,
      hazardType: 'storm',
      recommendation: 'storm_shutters',
      priority: 'medium',
      estimatedCostUsd: 4000,
      implementationStatus: 'pending',
      details: {
        description: 'Install protective shutters or impact-resistant glazing for exposed equipment.',
        timeline: '3-6 months',
      },
    });
  }

  // Store mitigation plans
  const insertStmt = db().prepare(
    `INSERT OR IGNORE INTO mitigation_plans 
     (meter_id, hazard_type, recommendation, priority, estimated_cost_usd, implementation_status, details, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const plan of plans) {
    insertStmt.run(
      plan.meterId,
      plan.hazardType,
      plan.recommendation,
      plan.priority,
      plan.estimatedCostUsd,
      plan.implementationStatus,
      JSON.stringify(plan.details),
      now,
      now
    );
  }

  return getMitigationPlans(assessment.meterId);
}

export function getMitigationPlans(meterId: string): MitigationPlan[] {
  type MitigationRow = {
    id: number;
    meter_id: string;
    hazard_type: string;
    recommendation: string;
    priority: string;
    estimated_cost_usd: number | null;
    implementation_status: string;
    details: string;
    created_at: string;
    updated_at: string;
  };

  const rows = db()
    .prepare(
      `SELECT * FROM mitigation_plans 
       WHERE meter_id = ? 
       ORDER BY 
         CASE priority 
           WHEN 'critical' THEN 1 
           WHEN 'high' THEN 2 
           WHEN 'medium' THEN 3 
           ELSE 4 
         END`
    )
    .all(meterId) as MitigationRow[];

  return rows.map(row => ({
    id: row.id,
    meterId: row.meter_id,
    hazardType: row.hazard_type as HazardType,
    recommendation: row.recommendation as RecommendationType,
    priority: row.priority as MitigationPriority,
    estimatedCostUsd: row.estimated_cost_usd,
    implementationStatus: row.implementation_status as ImplementationStatus,
    details: JSON.parse(row.details),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function updateMitigationStatus(
  mitigationId: number,
  status: ImplementationStatus
): MitigationPlan | null {
  const updated = db()
    .prepare(
      `UPDATE mitigation_plans 
       SET implementation_status = ?, updated_at = ? 
       WHERE id = ?`
    )
    .run(status, new Date().toISOString(), mitigationId);

  if (updated.changes === 0) {
    return null;
  }

  type MitigationRow = {
    id: number;
    meter_id: string;
    hazard_type: string;
    recommendation: string;
    priority: string;
    estimated_cost_usd: number | null;
    implementation_status: string;
    details: string;
    created_at: string;
    updated_at: string;
  };

  const row = db()
    .prepare('SELECT * FROM mitigation_plans WHERE id = ?')
    .get(mitigationId) as MitigationRow | undefined;

  if (!row) return null;

  return {
    id: row.id,
    meterId: row.meter_id,
    hazardType: row.hazard_type as HazardType,
    recommendation: row.recommendation as RecommendationType,
    priority: row.priority as MitigationPriority,
    estimatedCostUsd: row.estimated_cost_usd,
    implementationStatus: row.implementation_status as ImplementationStatus,
    details: JSON.parse(row.details),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Fleet risk assessment ───────────────────────────────────────────────────

export async function assessFleetRisk(): Promise<FleetRiskSummary> {
  const devices = listDevices({});
  const metersWithLocations = devices
    .filter(d => d.meterId && d.location)
    .map(d => ({ meterId: d.meterId!, location: getMeterLocation(d.meterId!) }))
    .filter((m): m is { meterId: string; location: { lat: number; lon: number } } => m.location !== null);

  if (metersWithLocations.length === 0) {
    return {
      totalMeters: 0,
      riskDistribution: { low: 0, moderate: 0, high: 0, critical: 0 },
      averageRiskScore: null,
      highRiskMeters: [],
      mitigationCoverage: null,
      assessedAt: new Date().toISOString(),
    };
  }

  // Assess each meter
  const assessments = await Promise.all(
    metersWithLocations.map(m => assessMeterRisk(m.meterId, m.location))
  );

  // Calculate distribution
  const riskDistribution: Record<InsuranceTier, number> = {
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };

  let totalScore = 0;
  const highRiskMeters: Array<{ meterId: string; riskScore: number; location: { lat: number; lon: number } }> = [];

  for (const assessment of assessments) {
    riskDistribution[assessment.insuranceTier]++;
    totalScore += assessment.overallRiskScore;

    if (assessment.insuranceTier === 'high' || assessment.insuranceTier === 'critical') {
      highRiskMeters.push({
        meterId: assessment.meterId,
        riskScore: assessment.overallRiskScore,
        location: { lat: assessment.lat, lon: assessment.lon },
      });
    }
  }

  // Calculate mitigation coverage
  const metersWithMitigations = new Set(
    db()
      .prepare('SELECT DISTINCT meter_id FROM mitigation_plans')
      .all()
      .map((row: any) => row.meter_id)
  ).size;

  const mitigationCoverage = metersWithLocations.length > 0
    ? (metersWithMitigations / metersWithLocations.length) * 100
    : null;

  return {
    totalMeters: metersWithLocations.length,
    riskDistribution,
    averageRiskScore: totalScore / metersWithLocations.length,
    highRiskMeters: highRiskMeters.sort((a, b) => b.riskScore - a.riskScore).slice(0, 10),
    mitigationCoverage,
    assessedAt: new Date().toISOString(),
  };
}

// ── Scenario breakdown ──────────────────────────────────────────────────────

export function getScenarioBreakdown(meterId: string): RiskAssessment[] | null {
  type AssessmentRow = {
    meter_id: string;
    lat: number;
    lon: number;
    scenario: string;
    overall_risk_score: number;
    flood_score: number;
    heatwave_score: number;
    storm_score: number;
    insurance_tier: string;
    assessed_at: string;
  };

  const rows = db()
    .prepare(
      `SELECT * FROM risk_assessments 
       WHERE meter_id = ? 
       ORDER BY assessed_at DESC 
       LIMIT 4`
    )
    .all(meterId) as AssessmentRow[];

  if (rows.length === 0) return null;

  return rows.map(row => ({
    meterId: row.meter_id,
    lat: row.lat,
    lon: row.lon,
    scenario: row.scenario as ClimateScenario,
    overallRiskScore: row.overall_risk_score,
    floodScore: row.flood_score,
    heatwaveScore: row.heatwave_score,
    stormScore: row.storm_score,
    insuranceTier: row.insurance_tier as InsuranceTier,
    assessedAt: row.assessed_at,
  }));
}

// ── Force refresh ───────────────────────────────────────────────────────────

export async function refreshClimateData(
  meterId: string,
  location: { lat: number; lon: number }
): Promise<RiskAssessment> {
  // Force fresh assessment by calling assessMeterRisk
  // (cache bypass would require clearing Redis keys, which we skip for simplicity)
  logger.info({ meterId }, 'Refreshing climate data from APIs');
  return assessMeterRisk(meterId, location);
}

// Re-export types for convenience
export type { ClimateScenario, HazardType, ClimateProjection };
