/**
 * Climate Risk Assessment API Routes
 * 
 * Endpoints:
 * - GET /api/climate-risk/assess/:meterId - Single meter risk assessment
 * - GET /api/climate-risk/fleet - Fleet-wide risk summary
 * - GET /api/climate-risk/scenarios/:meterId - Detailed scenario breakdown
 * - POST /api/climate-risk/refresh/:meterId - Force refresh from APIs
 * - GET /api/climate-risk/mitigation/:meterId - Mitigation recommendations
 * - PATCH /api/climate-risk/mitigation/:id - Update mitigation status
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { logger } from '../lib/logger.js';
import {
  assessMeterRisk,
  getFleetRiskSummary,
  getMitigationPlans,
  updateMitigationStatus,
  type ImplementationStatus,
} from '../lib/climateRisk.js';
import { fetchClimateProjection, type ClimateScenario, type HazardType } from '../lib/climateData.js';

export const climateRiskRouter = Router();

/**
 * GET /api/climate-risk/assess/:meterId
 * 
 * Assess climate risk for a single meter. Returns risk scores across all scenarios.
 */
climateRiskRouter.get('/assess/:meterId', asyncHandler(async (req, res) => {
  const { meterId } = req.params;
  const scenario = (req.query.scenario as ClimateScenario) || 'RCP8.5';

  if (!['RCP4.5', 'RCP8.5', 'SSP2', 'SSP5'].includes(scenario)) {
    return res.status(400).json({ error: 'Invalid scenario. Must be RCP4.5, RCP8.5, SSP2, or SSP5' });
  }

  const assessment = await assessMeterRisk(meterId, scenario);

  if (!assessment) {
    return res.status(404).json({ error: 'Meter not found or location unavailable' });
  }

  logger.info(`Climate risk assessed for meter ${meterId}: ${assessment.overallRiskScore.toFixed(1)} (${assessment.insuranceTier})`);

  res.json(assessment);
}));

/**
 * GET /api/climate-risk/fleet
 * 
 * Get fleet-wide risk summary with distribution by tier and high-risk meters.
 */
climateRiskRouter.get('/fleet', asyncHandler(async (req, res) => {
  const scenario = (req.query.scenario as ClimateScenario) || 'RCP8.5';

  if (!['RCP4.5', 'RCP8.5', 'SSP2', 'SSP5'].includes(scenario)) {
    return res.status(400).json({ error: 'Invalid scenario. Must be RCP4.5, RCP8.5, SSP2, or SSP5' });
  }

  const summary = await getFleetRiskSummary(scenario);

  logger.info(`Fleet risk summary generated: ${summary.totalMeters} meters, avg risk ${summary.averageRiskScore?.toFixed(1) || 'N/A'}`);

  res.json(summary);
}));

/**
 * GET /api/climate-risk/scenarios/:meterId
 * 
 * Detailed scenario breakdown for a single meter (all 4 scenarios).
 */
climateRiskRouter.get('/scenarios/:meterId', asyncHandler(async (req, res) => {
  const { meterId } = req.params;

  const scenarios: ClimateScenario[] = ['RCP4.5', 'RCP8.5', 'SSP2', 'SSP5'];
  const assessments = await Promise.all(
    scenarios.map(scenario => assessMeterRisk(meterId, scenario))
  );

  const results = assessments.filter(Boolean);

  if (results.length === 0) {
    return res.status(404).json({ error: 'Meter not found or location unavailable' });
  }

  logger.info(`Scenario breakdown generated for meter ${meterId}: ${results.length} scenarios`);

  res.json({
    meterId,
    scenarios: results,
    comparisonSummary: {
      bestCase: results.reduce((min, curr) => curr!.overallRiskScore < min!.overallRiskScore ? curr : min),
      worstCase: results.reduce((max, curr) => curr!.overallRiskScore > max!.overallRiskScore ? curr : max),
    },
  });
}));

/**
 * POST /api/climate-risk/refresh/:meterId
 * 
 * Force refresh climate data from APIs (bypasses cache).
 */
climateRiskRouter.post('/refresh/:meterId', asyncHandler(async (req, res) => {
  const { meterId } = req.params;

  // Get meter location first
  const { getMeterLocation } = await import('../lib/climateRisk.js');
  const location = getMeterLocation(meterId);

  if (!location) {
    return res.status(404).json({ error: 'Meter not found or location unavailable' });
  }

  // Fetch fresh data for all scenarios and hazards (bypasses cache by forcing refresh)
  const scenarios: ClimateScenario[] = ['RCP4.5', 'RCP8.5', 'SSP2', 'SSP5'];
  const hazards: HazardType[] = ['flood', 'heatwave', 'storm'];
  const projectionYear = 2050;

  const refreshPromises = scenarios.flatMap(scenario =>
    hazards.map(hazardType =>
      fetchClimateProjection(location.lat, location.lon, scenario, hazardType, projectionYear, true)
    )
  );

  await Promise.all(refreshPromises);

  logger.info(`Climate data refreshed for meter ${meterId} at location (${location.lat}, ${location.lon})`);

  res.json({ success: true, message: 'Climate data refreshed', meterId, location });
}));

/**
 * GET /api/climate-risk/mitigation/:meterId
 * 
 * Get mitigation recommendations for a meter.
 */
climateRiskRouter.get('/mitigation/:meterId', asyncHandler(async (req, res) => {
  const { meterId } = req.params;

  const plans = getMitigationPlans(meterId);

  logger.info(`Retrieved ${plans.length} mitigation plans for meter ${meterId}`);

  res.json({ meterId, plans });
}));

/**
 * PATCH /api/climate-risk/mitigation/:id
 * 
 * Update mitigation plan implementation status.
 */
climateRiskRouter.patch('/mitigation/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status, details } = req.body;

  if (!status || !['pending', 'planned', 'in_progress', 'completed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Must be pending, planned, in_progress, or completed' });
  }

  const updated = updateMitigationStatus(id, status as ImplementationStatus, details);

  if (!updated) {
    return res.status(404).json({ error: 'Mitigation plan not found' });
  }

  logger.info(`Mitigation plan ${id} status updated to ${status}`);

  res.json(updated);
}));
