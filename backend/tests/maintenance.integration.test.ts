import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock the mailer before importing modules that use it.
const sendMailMock = vi.fn().mockResolvedValue({ messageId: 'test-message-id' });
vi.mock('../src/services/mailer', () => ({
  sendMail: sendMailMock,
  default: { sendMail: sendMailMock },
}));

// Also mock a possible notification mailer path.
vi.mock('../src/services/email', () => ({
  sendMail: sendMailMock,
  default: { sendMail: sendMailMock },
}));

const ADMIN_KEY = 'test-admin-key';

let tmpDir: string;
let dbPath: string;
let app: any;
let db: any;
let sendMaintenanceNotifications: any;

async function loadModules() {
  // Import after env vars are set so the DB uses the temp path.
  const appModule = await import('../src/app');
  app = appModule.default ?? appModule.app ?? appModule;

  const dbModule = await import('../src/db');
  db = dbModule.default ?? dbModule.db ?? dbModule;

  const notifModule = await import('../src/services/maintenanceNotifications');
  sendMaintenanceNotifications =
    notifModule.sendMaintenanceNotifications ??
    notifModule.default ??
    notifModule;
}

async function resetDb() {
  // Best-effort cleanup of tables used by the maintenance feature.
  const tables = [
    'maintenance_notifications',
    'maintenance_windows',
    'maintenance_affected_meters',
    'maintenance_meters',
    'meters',
  ];
  for (const table of tables) {
    try {
      await db.run(`DELETE FROM ${table}`);
    } catch {
      // table may not exist; ignore
    }
  }
}

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

describe('maintenance integration', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-test-'));
    dbPath = path.join(tmpDir, 'test.sqlite');

    process.env.DATABASE_PATH = dbPath;
    process.env.DB_PATH = dbPath;
    process.env.SQLITE_PATH = dbPath;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.ADMIN_KEY = ADMIN_KEY;
    process.env.NODE_ENV = 'test';

    sendMailMock.mockClear();

    await loadModules();
    await resetDb();
  });

  afterEach(async () => {
    try {
      if (db && typeof db.close === 'function') {
        await db.close();
      }
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    vi.resetModules();
  });

  describe('POST /api/maintenance', () => {
    it('requires an admin key', async () => {
      const res = await request(app)
        .post('/api/maintenance')
        .send({
          title: 'Scheduled upgrade',
          starts_at: hoursFromNow(72),
          ends_at: hoursFromNow(74),
        });

      expect(res.status).toBeGreaterThanOrEqual(401);
      expect(res.status).toBeLessThan(404);
    });

    it('rejects a request where ends_at is before starts_at', async () => {
      const res = await request(app)
        .post('/api/maintenance')
        .set('x-admin-key', ADMIN_KEY)
        .send({
          title: 'Bad window',
          starts_at: hoursFromNow(10),
          ends_at: hoursFromNow(5),
        });

      expect(res.status).toBe(400);
    });

    it('rejects a request where ends_at equals starts_at', async () => {
      const same = hoursFromNow(10);
      const res = await request(app)
        .post('/api/maintenance')
        .set('x-admin-key', ADMIN_KEY)
        .send({
          title: 'Zero-length window',
          starts_at: same,
          ends_at: same,
        });

      expect(res.status).toBe(400);
    });

    it('creates a maintenance window with an admin key', async () => {
      const startsAt = hoursFromNow(72);
      const endsAt = hoursFromNow(74);

      const res = await request(app)
        .post('/api/maintenance')
        .set('x-admin-key', ADMIN_KEY)
        .send({
          title: 'Scheduled upgrade',
          description: 'Upgrading the grid',
          starts_at: startsAt,
          ends_at: endsAt,
          affected_meters: ['M-001', 'M-002'],
        });

      expect([200, 201]).toContain(res.status);
      expect(res.body).toBeTruthy();
      expect(res.body.id ?? res.body.window?.id).toBeTruthy();
      expect(res.body.title ?? res.body.window?.title).toBe('Scheduled upgrade');
    });
  });

  describe('GET /api/maintenance/upcoming', () => {
    it('lists scheduled maintenance windows', async () => {
      const createRes = await request(app)
        .post('/api/maintenance')
        .set('x-admin-key', ADMIN_KEY)
        .send({
          title: 'Upcoming window',
          starts_at: hoursFromNow(48),
          ends_at: hoursFromNow(50),
        });
      expect([200, 201]).toContain(createRes.status);

      const res = await request(app).get('/api/maintenance/upcoming');

      expect(res.status).toBe(200);
      const list = Array.isArray(res.body)
        ? res.body
        : res.body.windows ?? res.body.data ?? [];
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThanOrEqual(1);
      expect(list.some((w: any) => w.title === 'Upcoming window')).toBe(true);
    });

    it('does not list past maintenance windows', async () => {
      // Insert a past window directly to avoid validation constraints.
      await db.run(
        `INSERT INTO maintenance_windows (title, starts_at, ends_at)
         VALUES (?, ?, ?)`,
        'Past window',
        hoursFromNow(-48),
        hoursFromNow(-46),
      );

      const res = await request(app).get('/api/maintenance/upcoming');

      expect(res.status).toBe(200);
      const list = Array.isArray(res.body)
        ? res.body
        : res.body.windows ?? res.body.data ?? [];
      expect(list.some((w: any) => w.title === 'Past window')).toBe(false);
    });
  });

  describe('GET /api/maintenance/active', () => {
    it('returns the currently active maintenance window', async () => {
      await db.run(
        `INSERT INTO maintenance_windows (title, starts_at, ends_at)
         VALUES (?, ?, ?)`,
        'Active window',
        hoursFromNow(-1),
        hoursFromNow(1),
      );

      const res = await request(app).get('/api/maintenance/active');

      expect(res.status).toBe(200);
      const body = res.body?.window ?? res.body;
      expect(body).toBeTruthy();
      expect(body.title).toBe('Active window');
    });

    it('returns no active window when none is in progress', async () => {
      const res = await request(app).get('/api/maintenance/active');

      expect([200, 204]).toContain(res.status);
      if (res.status === 200) {
        const body = res.body?.window ?? res.body;
        expect(body == null || body.title == null).toBe(true);
      }
    });
  });

  describe('affected meters', () => {
    it('lists affected meters for a maintenance window', async () => {
      const createRes = await request(app)
        .post('/api/maintenance')
        .set('x-admin-key', ADMIN_KEY)
        .send({
          title: 'Window with meters',
          starts_at: hoursFromNow(24),
          ends_at: hoursFromNow(26),
          affected_meters: ['M-100', 'M-101', 'M-102'],
        });
      expect([200, 201]).toContain(createRes.status);

      const id = createRes.body.id ?? createRes.body.window?.id;

      const res = await request(app).get(
        `/api/maintenance/${id}/meters`,
      );

      expect(res.status).toBe(200);
      const meters = Array.isArray(res.body)
        ? res.body
        : res.body.meters ?? res.body.data ?? [];
      expect(Array.isArray(meters)).toBe(true);
      expect(meters.length).toBe(3);
      const ids = meters.map((m: any) =>
        typeof m === 'string' ? m : m.meter_id ?? m.id ?? m.serial,
      );
      expect(ids).toEqual(expect.arrayContaining(['M-100', 'M-101', 'M-102']));
    });
  });

  describe('sendMaintenanceNotifications', () => {
    it('sends exactly one email per threshold per window', async () => {
      // Window starting in 47 hours: within the 48h threshold, but not 24h/1h.
      await db.run(
        `INSERT INTO maintenance_windows (title, starts_at, ends_at)
         VALUES (?, ?, ?)`,
        'Notify window',
        hoursFromNow(47),
        hoursFromNow(49),
      );

      await sendMaintenanceNotifications();

      expect(sendMailMock).toHaveBeenCalledTimes(1);
    });

    it('does not re-send notifications on subsequent runs', async () => {
      await db.run(
        `INSERT INTO maintenance_windows (title, starts_at, ends_at)
         VALUES (?, ?, ?)`,
        'Notify window',
        hoursFromNow(47),
        hoursFromNow(49),
      );

      await sendMaintenanceNotifications();
      const firstRunCalls = sendMailMock.mock.calls.length;
      expect(firstRunCalls).toBe(1);

      sendMailMock.mockClear();

      await sendMaintenanceNotifications();

      expect(sendMailMock).toHaveBeenCalledTimes(0);
    });

    it('sends one email for each threshold as time passes', async () => {
      const windowId = await db.run(
        `INSERT INTO maintenance_windows (title, starts_at, ends_at)
         VALUES (?, ?, ?)`,
        'Multi threshold window',
        hoursFromNow(47),
        hoursFromNow(49),
      );

      // 48h threshold
      await sendMaintenanceNotifications();
      expect(sendMailMock).toHaveBeenCalledTimes(1);

      // Move the window so it is now within the 24h threshold.
      await db.run(
        `UPDATE maintenance_windows SET starts_at = ?, ends_at = ? WHERE id = ?`,
        hoursFromNow(23),
        hoursFromNow(25),
        windowId?.lastID ?? windowId,
      );

      await sendMaintenanceNotifications();
      expect(sendMailMock).toHaveBeenCalledTimes(2);

      // Move the window so it is now within the 1h threshold.
      await db.run(
        `UPDATE maintenance_windows SET starts_at = ?, ends_at = ? WHERE id = ?`,
        hoursFromNow(0.5),
        hoursFromNow(2),
        windowId?.lastID ?? windowId,
      );

      await sendMaintenanceNotifications();
      expect(sendMailMock).toHaveBeenCalledTimes(3);
    });

    it('does not send notifications for windows far in the future', async () => {
      await db.run(
        `INSERT INTO maintenance_windows (title, starts_at, ends_at)
         VALUES (?, ?, ?)`,
        'Far future window',
        hoursFromNow(200),
        hoursFromNow(202),
      );

      await sendMaintenanceNotifications();

      expect(sendMailMock).toHaveBeenCalledTimes(0);
    });
  });
});