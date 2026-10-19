import express, { Request, Response, Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { registerDatabase } from '../database';

const router: Router = express.Router();

// ---------------------------------------------------------------------------
// Database setup (SQLite via better-sqlite3 style abstraction)
// ---------------------------------------------------------------------------

interface SqliteLike {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

let db: SqliteLike | null = null;

function getDb(): SqliteLike {
  if (!db) {
    // Lazy require so tests can inject a mock via setDatabase().
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    const dbPath = process.env.WORK_ORDERS_DB_PATH || path.join(process.cwd(), 'data', 'work-orders.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath) as SqliteLike;
    initSchema(db);
    registerDatabase(db as unknown as Parameters<typeof registerDatabase>[0]);
  }
  return db;
}

export function setDatabase(instance: SqliteLike): void {
  db = instance;
  initSchema(db);
  registerDatabase(db as unknown as Parameters<typeof registerDatabase>[0]);
}

function initSchema(database: SqliteLike): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS technicians (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS work_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meter_id TEXT,
      technician_id INTEGER,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'normal',
      scheduled_at TEXT,
      completed_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (technician_id) REFERENCES technicians(id)
    );

    CREATE TABLE IF NOT EXISTS work_order_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      path TEXT NOT NULL,
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (work_order_id) REFERENCES work_orders(id)
    );

    CREATE INDEX IF NOT EXISTS idx_work_orders_technician ON work_orders(technician_id);
    CREATE INDEX IF NOT EXISTS idx_work_orders_status ON work_orders(status);
    CREATE INDEX IF NOT EXISTS idx_work_order_photos_order ON work_order_photos(work_order_id);
  `);
}

// ---------------------------------------------------------------------------
// Photo upload configuration
// ---------------------------------------------------------------------------

const UPLOAD_DIR = process.env.WORK_ORDER_UPLOAD_DIR || path.join(process.cwd(), 'uploads', 'work-orders');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image uploads are allowed'));
    }
  },
});

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

interface AuthedRequest extends Request {
  user?: { id?: number; role?: string };
}

function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: express.NextFunction): void => {
    const user = (req as AuthedRequest).user;
    // If no auth middleware is mounted, fall back to header-based role.
    const role = user?.role || (req.header('x-user-role') || '').toLowerCase();
    if (!role) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (roles.length > 0 && !roles.includes(role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkOrderRow {
  id: number;
  meter_id: string | null;
  technician_id: number | null;
  type: string;
  status: string;
  priority: string;
  scheduled_at: string | null;
  completed_at: string | null;
  notes: string | null;
  created_at: string;
}

interface PhotoRow {
  id: number;
  work_order_id: number;
  filename: string;
  path: string;
  uploaded_at: string;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * POST /api/work-orders
 * Create a work order. Requires admin or technician role.
 */
router.post('/', requireRole('admin', 'technician'), (req: Request, res: Response) => {
  try {
    const {
      meter_id,
      technician_id,
      type,
      priority,
      scheduled_at,
      notes,
    } = req.body || {};

    if (!type || typeof type !== 'string') {
      res.status(400).json({ error: 'type is required' });
      return;
    }

    const database = getDb();
    const result = database
      .prepare(
        `INSERT INTO work_orders (meter_id, technician_id, type, status, priority, scheduled_at, notes)
         VALUES (?, ?, ?, 'open', ?, ?, ?)`
      )
      .run(
        meter_id ?? null,
        technician_id ?? null,
        type,
        priority || 'normal',
        scheduled_at ?? null,
        notes ?? null
      );

    const created = database
      .prepare('SELECT * FROM work_orders WHERE id = ?')
      .get(result.lastInsertRowid) as WorkOrderRow;

    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/work-orders/assigned/:techId
 * List a technician's open/assigned tasks.
 */
router.get('/assigned/:techId', (req: Request, res: Response) => {
  try {
    const techId = Number(req.params.techId);
    if (!Number.isFinite(techId)) {
      res.status(400).json({ error: 'Invalid technician id' });
      return;
    }

    const database = getDb();
    const rows = database
      .prepare(
        `SELECT * FROM work_orders
         WHERE technician_id = ? AND status IN ('open', 'assigned', 'in_progress')
         ORDER BY
           CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
           COALESCE(scheduled_at, created_at) ASC`
      )
      .all(techId) as WorkOrderRow[];

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * PATCH /api/work-orders/:id/complete
 * Mark a work order complete with optional notes.
 */
router.patch('/:id/complete', requireRole('admin', 'technician'), (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid work order id' });
      return;
    }

    const database = getDb();
    const existing = database.prepare('SELECT * FROM work_orders WHERE id = ?').get(id) as
      | WorkOrderRow
      | undefined;

    if (!existing) {
      res.status(404).json({ error: 'Work order not found' });
      return;
    }

    const { notes } = req.body || {};
    const mergedNotes = notes != null ? notes : existing.notes;

    database
      .prepare(
        `UPDATE work_orders
         SET status = 'completed', completed_at = datetime('now'), notes = ?
         WHERE id = ?`
      )
      .run(mergedNotes ?? null, id);

    const updated = database.prepare('SELECT * FROM work_orders WHERE id = ?').get(id) as WorkOrderRow;
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/work-orders/:id/photos
 * Multipart photo upload for installation verification.
 */
router.post(
  '/:id/photos',
  requireRole('admin', 'technician'),
  upload.single('photo'),
  (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'Invalid work order id' });
        return;
      }

      const database = getDb();
      const existing = database.prepare('SELECT * FROM work_orders WHERE id = ?').get(id) as
        | WorkOrderRow
        | undefined;

      if (!existing) {
        res.status(404).json({ error: 'Work order not found' });
        return;
      }

      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'photo file is required' });
        return;
      }

      const result = database
        .prepare(
          `INSERT INTO work_order_photos (work_order_id, filename, path)
           VALUES (?, ?, ?)`
        )
        .run(id, file.filename, file.path);

      const photo = database
        .prepare('SELECT * FROM work_order_photos WHERE id = ?')
        .get(result.lastInsertRowid) as PhotoRow;

      res.status(201).json(photo);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }
);

/**
 * GET /api/work-orders/:id
 * Single work order with its photos.
 */
router.get('/:id', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid work order id' });
      return;
    }

    const database = getDb();
    const order = database.prepare('SELECT * FROM work_orders WHERE id = ?').get(id) as
      | WorkOrderRow
      | undefined;

    if (!order) {
      res.status(404).json({ error: 'Work order not found' });
      return;
    }

    const photos = database
      .prepare('SELECT * FROM work_order_photos WHERE work_order_id = ? ORDER BY uploaded_at ASC')
      .all(id) as PhotoRow[];

    res.json({ ...order, photos });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
export { router as workOrdersRouter };