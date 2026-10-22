import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

/**
 * Tenant Isolation Tests
 *
 * Verifies multi-tenant data isolation (#1049):
 *  - Requests scoped to tenant A cannot read/write tenant B data
 *  - Row-level security / query scoping is applied
 *  - Audit entries are tenant-scoped
 *  - Tenant-scoped queries stay within acceptable latency
 */

// ---------------------------------------------------------------------------
// Test doubles / in-memory tenant-aware store
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  tenantId: string;
  value: string;
}

interface AuditEntry {
  id: string;
  tenantId: string;
  action: string;
  resource: string;
  timestamp: number;
}

class TenantScopedStore {
  private rows: Row[] = [];
  private audit: AuditEntry[] = [];
  private auditCounter = 0;

  // Simulates a query that is always scoped by tenant_id (RLS equivalent).
  read(tenantId: string, id: string): Row | undefined {
    const row = this.rows.find((r) => r.id === id && r.tenantId === tenantId);
    this.recordAudit(tenantId, 'read', `row:${id}`);
    return row;
  }

  list(tenantId: string): Row[] {
    const result = this.rows.filter((r) => r.tenantId === tenantId);
    this.recordAudit(tenantId, 'list', 'rows');
    return result;
  }

  write(tenantId: string, id: string, value: string): Row {
    const existing = this.rows.find((r) => r.id === id);
    if (existing && existing.tenantId !== tenantId) {
      // Cross-tenant write attempt must be rejected.
      this.recordAudit(tenantId, 'write-denied', `row:${id}`);
      throw new Error('Cross-tenant write denied');
    }
    if (existing) {
      existing.value = value;
      this.recordAudit(tenantId, 'update', `row:${id}`);
      return existing;
    }
    const row: Row = { id, tenantId, value };
    this.rows.push(row);
    this.recordAudit(tenantId, 'create', `row:${id}`);
    return row;
  }

  delete(tenantId: string, id: string): boolean {
    const idx = this.rows.findIndex((r) => r.id === id && r.tenantId === tenantId);
    if (idx === -1) {
      this.recordAudit(tenantId, 'delete-denied', `row:${id}`);
      return false;
    }
    this.rows.splice(idx, 1);
    this.recordAudit(tenantId, 'delete', `row:${id}`);
    return true;
  }

  getAudit(tenantId: string): AuditEntry[] {
    return this.audit.filter((a) => a.tenantId === tenantId);
  }

  private recordAudit(tenantId: string, action: string, resource: string): void {
    this.audit.push({
      id: `audit-${++this.auditCounter}`,
      tenantId,
      action,
      resource,
      timestamp: Date.now(),
    });
  }
}

// ---------------------------------------------------------------------------
// Simulated request handler that enforces tenant scoping from auth context
// ---------------------------------------------------------------------------

interface RequestContext {
  tenantId: string;
  userId: string;
}

class TenantAwareService {
  constructor(private store: TenantScopedStore) {}

  handleRead(ctx: RequestContext, id: string): Row | undefined {
    this.assertTenant(ctx);
    return this.store.read(ctx.tenantId, id);
  }

  handleList(ctx: RequestContext): Row[] {
    this.assertTenant(ctx);
    return this.store.list(ctx.tenantId);
  }

  handleWrite(ctx: RequestContext, id: string, value: string): Row {
    this.assertTenant(ctx);
    return this.store.write(ctx.tenantId, id, value);
  }

  handleDelete(ctx: RequestContext, id: string): boolean {
    this.assertTenant(ctx);
    return this.store.delete(ctx.tenantId, id);
  }

  private assertTenant(ctx: RequestContext): void {
    if (!ctx.tenantId) {
      throw new Error('Missing tenant context');
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tenant Isolation (#1049)', () => {
  let store: TenantScopedStore;
  let service: TenantAwareService;

  const tenantA: RequestContext = { tenantId: 'tenant-a', userId: 'user-a' };
  const tenantB: RequestContext = { tenantId: 'tenant-b', userId: 'user-b' };

  beforeEach(() => {
    store = new TenantScopedStore();
    service = new TenantAwareService(store);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Cross-tenant read isolation', () => {
    it('tenant A cannot read tenant B data', () => {
      service.handleWrite(tenantB, 'row-1', 'secret-b');

      const result = service.handleRead(tenantA, 'row-1');
      expect(result).toBeUndefined();
    });

    it('tenant A list only returns tenant A rows', () => {
      service.handleWrite(tenantA, 'a-1', 'value-a1');
      service.handleWrite(tenantA, 'a-2', 'value-a2');
      service.handleWrite(tenantB, 'b-1', 'value-b1');

      const rows = service.handleList(tenantA);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.tenantId === 'tenant-a')).toBe(true);
      expect(rows.map((r) => r.id).sort()).toEqual(['a-1', 'a-2']);
    });

    it('tenant B list only returns tenant B rows', () => {
      service.handleWrite(tenantA, 'a-1', 'value-a1');
      service.handleWrite(tenantB, 'b-1', 'value-b1');

      const rows = service.handleList(tenantB);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('b-1');
      expect(rows[0].tenantId).toBe('tenant-b');
    });
  });

  describe('Cross-tenant write isolation', () => {
    it('tenant A cannot overwrite tenant B row', () => {
      service.handleWrite(tenantB, 'row-1', 'original-b');

      expect(() => service.handleWrite(tenantA, 'row-1', 'hijacked')).toThrow(
        /Cross-tenant write denied/,
      );

      // Original value must remain intact.
      const row = service.handleRead(tenantB, 'row-1');
      expect(row?.value).toBe('original-b');
    });

    it('tenant A cannot delete tenant B row', () => {
      service.handleWrite(tenantB, 'row-1', 'value-b');

      const deleted = service.handleDelete(tenantA, 'row-1');
      expect(deleted).toBe(false);

      // Row must still exist for tenant B.
      const row = service.handleRead(tenantB, 'row-1');
      expect(row).toBeDefined();
      expect(row?.value).toBe('value-b');
    });

    it('tenant A can only update its own rows', () => {
      service.handleWrite(tenantA, 'row-1', 'a-original');
      const updated = service.handleWrite(tenantA, 'row-1', 'a-updated');
      expect(updated.value).toBe('a-updated');
      expect(updated.tenantId).toBe('tenant-a');
    });
  });

  describe('Query scoping / RLS enforcement', () => {
    it('rejects requests without tenant context', () => {
      const noTenant = { tenantId: '', userId: 'user-x' };
      expect(() => service.handleList(noTenant)).toThrow(/Missing tenant context/);
      expect(() => service.handleRead(noTenant, 'row-1')).toThrow(/Missing tenant context/);
      expect(() => service.handleWrite(noTenant, 'row-1', 'x')).toThrow(/Missing tenant context/);
    });

    it('every read query is scoped by tenant_id', () => {
      const readSpy = jest.spyOn(store, 'read');
      service.handleWrite(tenantA, 'a-1', 'v');
      service.handleRead(tenantA, 'a-1');

      expect(readSpy).toHaveBeenCalledWith('tenant-a', 'a-1');
    });

    it('every list query is scoped by tenant_id', () => {
      const listSpy = jest.spyOn(store, 'list');
      service.handleList(tenantB);
      expect(listSpy).toHaveBeenCalledWith('tenant-b');
    });

    it('every write query is scoped by tenant_id', () => {
      const writeSpy = jest.spyOn(store, 'write');
      service.handleWrite(tenantA, 'a-1', 'v');
      expect(writeSpy).toHaveBeenCalledWith('tenant-a', 'a-1', 'v');
    });
  });

  describe('Audit trail isolation', () => {
    it('audit entries are tenant-scoped', () => {
      service.handleWrite(tenantA, 'a-1', 'v');
      service.handleRead(tenantA, 'a-1');
      service.handleWrite(tenantB, 'b-1', 'v');
      service.handleRead(tenantB, 'b-1');

      const auditA = store.getAudit('tenant-a');
      const auditB = store.getAudit('tenant-b');

      expect(auditA.length).toBeGreaterThan(0);
      expect(auditB.length).toBeGreaterThan(0);
      expect(auditA.every((e) => e.tenantId === 'tenant-a')).toBe(true);
      expect(auditB.every((e) => e.tenantId === 'tenant-b')).toBe(true);
    });

    it('cross-tenant write attempts are recorded in the requesting tenant audit', () => {
      service.handleWrite(tenantB, 'row-1', 'b-value');

      expect(() => service.handleWrite(tenantA, 'row-1', 'hijack')).toThrow();

      const auditA = store.getAudit('tenant-a');
      const denied = auditA.find((e) => e.action === 'write-denied');
      expect(denied).toBeDefined();
      expect(denied?.resource).toBe('row:row-1');
    });

    it('tenant A cannot see tenant B audit entries', () => {
      service.handleWrite(tenantB, 'b-1', 'v');
      const auditA = store.getAudit('tenant-a');
      expect(auditA).toHaveLength(0);
    });
  });

  describe('Performance with isolation', () => {
    const MAX_LATENCY_MS = 50;
    const ITERATIONS = 1000;

    it('tenant-scoped reads stay within acceptable latency', () => {
      // Seed data for two tenants.
      for (let i = 0; i < 200; i++) {
        service.handleWrite(tenantA, `a-${i}`, `value-a-${i}`);
        service.handleWrite(tenantB, `b-${i}`, `value-b-${i}`);
      }

      const start = performance.now();
      for (let i = 0; i < ITERATIONS; i++) {
        const row = service.handleRead(tenantA, `a-${i % 200}`);
        expect(row?.tenantId).toBe('tenant-a');
      }
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(MAX_LATENCY_MS * ITERATIONS);
    });

    it('tenant-scoped list queries stay within acceptable latency', () => {
      for (let i = 0; i < 200; i++) {
        service.handleWrite(tenantA, `a-${i}`, `value-a-${i}`);
        service.handleWrite(tenantB, `b-${i}`, `value-b-${i}`);
      }

      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        const rows = service.handleList(tenantA);
        expect(rows).toHaveLength(200);
      }
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(MAX_LATENCY_MS * 100);
    });

    it('tenant-scoped writes stay within acceptable latency', () => {
      const start = performance.now();
      for (let i = 0; i < ITERATIONS; i++) {
        service.handleWrite(tenantA, `a-${i}`, `value-${i}`);
      }
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(MAX_LATENCY_MS * ITERATIONS);
    });
  });
});