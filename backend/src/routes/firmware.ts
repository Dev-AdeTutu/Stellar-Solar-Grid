import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireAdminKey } from '../middleware/auth';
import { getMqttClient } from '../mqtt/client';
import {
  storeFirmware,
  listFirmwareVersions,
  getFirmwareVersion,
  recordMeterUpdate,
  advanceRollout,
} from '../services/firmwareService';

const router = Router();

/**
 * POST /api/firmware/upload
 * Admin-only endpoint to upload a new firmware binary/version.
 */
router.post(
  '/api/firmware/upload',
  requireAdminKey,
  asyncHandler(async (req: Request, res: Response) => {
    const { version, binary, checksum, releaseNotes } = req.body || {};

    if (!version || typeof version !== 'string') {
      return res.status(400).json({ error: 'version is required' });
    }
    if (!binary) {
      return res.status(400).json({ error: 'binary is required' });
    }

    const firmware = await storeFirmware({
      version,
      binary,
      checksum,
      releaseNotes,
    });

    return res.status(201).json({ firmware });
  })
);

/**
 * GET /api/firmware/versions
 * Lists all stored firmware versions.
 */
router.get(
  '/api/firmware/versions',
  asyncHandler(async (_req: Request, res: Response) => {
    const versions = await listFirmwareVersions();
    return res.json({ versions });
  })
);

/**
 * POST /api/meters/:meterId/update
 * Admin-only endpoint that triggers an OTA update for a meter by publishing
 * an MQTT command and recording the update.
 */
router.post(
  '/api/meters/:meterId/update',
  requireAdminKey,
  asyncHandler(async (req: Request, res: Response) => {
    const { meterId } = req.params;
    const { version, versionId } = req.body || {};

    if (!meterId) {
      return res.status(400).json({ error: 'meterId is required' });
    }

    let firmware = null;
    if (versionId) {
      firmware = await getFirmwareVersion(versionId);
    } else if (version) {
      const versions = await listFirmwareVersions();
      firmware = versions.find((v: any) => v.version === version) || null;
    }

    if (!firmware) {
      return res.status(404).json({ error: 'firmware version not found' });
    }

    const mqttClient = getMqttClient();
    const command = {
      type: 'firmware_update',
      meterId,
      versionId: firmware.id,
      version: firmware.version,
      checksum: firmware.checksum,
      issuedAt: new Date().toISOString(),
    };

    mqttClient.publish(
      `meters/${meterId}/commands/firmware`,
      JSON.stringify(command)
    );

    const update = await recordMeterUpdate({
      meterId,
      versionId: firmware.id,
      version: firmware.version,
      status: 'pending',
      issuedAt: command.issuedAt,
    });

    return res.status(202).json({ update });
  })
);

/**
 * POST /api/firmware/:versionId/rollout
 * Admin-only endpoint that advances the staged rollout for a firmware version.
 */
router.post(
  '/api/firmware/:versionId/rollout',
  requireAdminKey,
  asyncHandler(async (req: Request, res: Response) => {
    const { versionId } = req.params;

    if (!versionId) {
      return res.status(400).json({ error: 'versionId is required' });
    }

    const firmware = await getFirmwareVersion(versionId);
    if (!firmware) {
      return res.status(404).json({ error: 'firmware version not found' });
    }

    const rollout = await advanceRollout(versionId);

    return res.json({ rollout });
  })
);

export default router;