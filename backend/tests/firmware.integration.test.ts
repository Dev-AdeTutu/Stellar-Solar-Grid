import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  FirmwareRepository,
  FirmwareUpdateService,
  handleFirmwareStatusMessage,
  type FirmwareVersion,
  type MeterUpdate,
} from '../src/firmware';

describe('Firmware OTA integration', () => {
  let repository: FirmwareRepository;
  let service: FirmwareUpdateService;
  let publish: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    repository = new FirmwareRepository();
    publish = vi.fn().mockResolvedValue(undefined);
    service = new FirmwareUpdateService(repository, publish);
  });

  describe('firmware storage and versioning', () => {
    it('stores a firmware version and lists it', async () => {
      const stored = await repository.storeVersion({
        version: '1.2.0',
        checksum: 'abc123',
        sizeBytes: 1024,
        url: 'https://firmware.example.com/1.2.0.bin',
        releaseNotes: 'Initial OTA release',
      });

      expect(stored.version).toBe('1.2.0');
      expect(stored.checksum).toBe('abc123');

      const versions = await repository.listVersions();
      expect(versions).toHaveLength(1);
      expect(versions[0].version).toBe('1.2.0');
    });

    it('lists multiple versions in order', async () => {
      await repository.storeVersion({
        version: '1.0.0',
        checksum: 'aaa',
        sizeBytes: 512,
        url: 'https://firmware.example.com/1.0.0.bin',
      });
      await repository.storeVersion({
        version: '1.1.0',
        checksum: 'bbb',
        sizeBytes: 768,
        url: 'https://firmware.example.com/1.1.0.bin',
      });

      const versions = await repository.listVersions();
      expect(versions.map((v: FirmwareVersion) => v.version)).toEqual(['1.0.0', '1.1.0']);
    });
  });

  describe('creating an update and publishing the OTA MQTT command', () => {
    it('publishes an OTA command to the meter topic', async () => {
      await repository.storeVersion({
        version: '2.0.0',
        checksum: 'ccc',
        sizeBytes: 2048,
        url: 'https://firmware.example.com/2.0.0.bin',
      });

      const update = await service.createUpdate('meter-1', '2.0.0');

      expect(update.meterId).toBe('meter-1');
      expect(update.version).toBe('2.0.0');
      expect(update.status).toBe('pending');
      expect(publish).toHaveBeenCalledTimes(1);

      const [topic, payload] = publish.mock.calls[0];
      expect(topic).toBe('meters/meter-1/ota');
      const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
      expect(parsed.version).toBe('2.0.0');
      expect(parsed.url).toBe('https://firmware.example.com/2.0.0.bin');
      expect(parsed.checksum).toBe('ccc');
    });

    it('rejects an update for an unknown firmware version', async () => {
      await expect(service.createUpdate('meter-1', '9.9.9')).rejects.toThrow();
      expect(publish).not.toHaveBeenCalled();
    });
  });

  describe('staged rollout selection', () => {
    beforeEach(async () => {
      await repository.storeVersion({
        version: '3.0.0',
        checksum: 'ddd',
        sizeBytes: 4096,
        url: 'https://firmware.example.com/3.0.0.bin',
      });
    });

    const meters = Array.from({ length: 100 }, (_, i) => `meter-${i}`);

    it('selects roughly 10% of meters at the 10% stage', () => {
      const selected = service.selectForRollout(meters, '3.0.0', 10);
      expect(selected.length).toBeGreaterThan(0);
      expect(selected.length).toBeLessThanOrEqual(15);
    });

    it('selects roughly 50% of meters at the 50% stage', () => {
      const selected = service.selectForRollout(meters, '3.0.0', 50);
      expect(selected.length).toBeGreaterThanOrEqual(40);
      expect(selected.length).toBeLessThanOrEqual(60);
    });

    it('selects all meters at the 100% stage', () => {
      const selected = service.selectForRollout(meters, '3.0.0', 100);
      expect(selected).toHaveLength(100);
    });

    it('is deterministic for the same meter and version', () => {
      const first = service.selectForRollout(meters, '3.0.0', 10);
      const second = service.selectForRollout(meters, '3.0.0', 10);
      expect(second).toEqual(first);
    });
  });

  describe('recording update status', () => {
    it('records a successful update status', async () => {
      await repository.storeVersion({
        version: '4.0.0',
        checksum: 'eee',
        sizeBytes: 8192,
        url: 'https://firmware.example.com/4.0.0.bin',
      });
      const update = await service.createUpdate('meter-42', '4.0.0');

      const result = await handleFirmwareStatusMessage(
        {
          meterId: 'meter-42',
          updateId: update.id,
          version: '4.0.0',
          status: 'success',
        },
        service,
      );

      expect(result.status).toBe('success');
      const stored = await service.getUpdate(update.id);
      expect(stored?.status).toBe('success');
    });
  });

  describe('automatic rollback on failure', () => {
    it('rolls back when a failure status is reported', async () => {
      await repository.storeVersion({
        version: '5.0.0',
        checksum: 'fff',
        sizeBytes: 16384,
        url: 'https://firmware.example.com/5.0.0.bin',
      });
      const update = await service.createUpdate('meter-7', '5.0.0');

      const result = await handleFirmwareStatusMessage(
        {
          meterId: 'meter-7',
          updateId: update.id,
          version: '5.0.0',
          status: 'failure',
          error: 'checksum mismatch',
        },
        service,
      );

      expect(result.status).toBe('failure');
      expect(result.rolledBack).toBe(true);

      const stored = await service.getUpdate(update.id);
      expect(stored?.status).toBe('rolled_back');

      const rollbackCall = publish.mock.calls.find(([topic]) =>
        String(topic).includes('rollback'),
      );
      expect(rollbackCall).toBeDefined();
    });

    it('does not roll back on a successful status', async () => {
      await repository.storeVersion({
        version: '6.0.0',
        checksum: 'ggg',
        sizeBytes: 32768,
        url: 'https://firmware.example.com/6.0.0.bin',
      });
      const update = await service.createUpdate('meter-8', '6.0.0');

      const result = await handleFirmwareStatusMessage(
        {
          meterId: 'meter-8',
          updateId: update.id,
          version: '6.0.0',
          status: 'success',
        },
        service,
      );

      expect(result.rolledBack).toBe(false);
      const stored = await service.getUpdate(update.id);
      expect(stored?.status).toBe('success');
    });
  });
});