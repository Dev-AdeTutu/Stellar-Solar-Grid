import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAdminKey } from '../middleware/requireAdminKey';
import {
  createMaintenanceWindow,
  getUpcomingMaintenanceWindows,
  getActiveMaintenanceWindow,
  getMaintenanceWindowById,
  cancelMaintenanceWindow,
} from '../services/maintenanceService';

const router = Router();

const ISO_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function isValidIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIMESTAMP_REGEX.test(value) && !Number.isNaN(Date.parse(value));
}

function parseLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

/**
 * POST /api/maintenance
 * Admin-only. Creates a scheduled maintenance window.
 */
router.post(
  '/',
  requireAdminKey,
  asyncHandler(async (req: Request, res: Response) => {
    const { title, description, starts_at, ends_at, affected_meters } = req.body ?? {};

    const errors: string[] = [];

    if (typeof title !== 'string' || title.trim().length === 0) {
      errors.push('title is required and must be a non-empty string');
    }

    if (description !== undefined && description !== null && typeof description !== 'string') {
      errors.push('description must be a string');
    }

    if (!isValidIsoTimestamp(starts_at)) {
      errors.push('starts_at is required and must be a valid ISO 8601 timestamp');
    }

    if (!isValidIsoTimestamp(ends_at)) {
      errors.push('ends_at is required and must be a valid ISO 8601 timestamp');
    }

    if (isValidIsoTimestamp(starts_at) && isValidIsoTimestamp(ends_at)) {
      if (Date.parse(ends_at) <= Date.parse(starts_at)) {
        errors.push('ends_at must be after starts_at');
      }
    }

    if (!Array.isArray(affected_meters)) {
      errors.push('affected_meters is required and must be an array of meter ids');
    } else if (!affected_meters.every((meter) => typeof meter === 'string' && meter.trim().length > 0)) {
      errors.push('affected_meters must contain only non-empty strings');
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    const window = await createMaintenanceWindow({
      title: title.trim(),
      description: typeof description === 'string' ? description.trim() : null,
      starts_at,
      ends_at,
      affected_meters: affected_meters.map((meter: string) => meter.trim()),
    });

    return res.status(201).json(window);
  })
);

/**
 * GET /api/maintenance/upcoming
 * Returns scheduled maintenance windows with starts_at in the future.
 */
router.get(
  '/upcoming',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = parseLimit(req.query.limit);
    const windows = await getUpcomingMaintenanceWindows(limit);
    return res.json({ windows });
  })
);

/**
 * GET /api/maintenance/active
 * Returns the currently active maintenance window, or null.
 */
router.get(
  '/active',
  asyncHandler(async (_req: Request, res: Response) => {
    const window = await getActiveMaintenanceWindow();
    return res.json({ window: window ?? null });
  })
);

/**
 * GET /api/maintenance/:id
 * Returns a single maintenance window including its affected meters list.
 */
router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const window = await getMaintenanceWindowById(req.params.id);
    if (!window) {
      return res.status(404).json({ error: 'Maintenance window not found' });
    }
    return res.json(window);
  })
);

/**
 * DELETE /api/maintenance/:id
 * Admin-only. Cancels a maintenance window.
 */
router.delete(
  '/:id',
  requireAdminKey,
  asyncHandler(async (req: Request, res: Response) => {
    const window = await cancelMaintenanceWindow(req.params.id);
    if (!window) {
      return res.status(404).json({ error: 'Maintenance window not found' });
    }
    return res.json(window);
  })
);

export default router;
</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>