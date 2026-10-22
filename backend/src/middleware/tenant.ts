import { Request, Response, NextFunction } from 'express';

/**
 * Tenant context attached to authenticated requests.
 */
export interface TenantContext {
  providerId: string;
  source: 'api-key' | 'header' | 'user';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: TenantContext;
    }
  }
}

/**
 * Error thrown when a request has no resolvable tenant context.
 */
export class MissingTenantError extends Error {
  public readonly statusCode = 401;
  public readonly code = 'MISSING_TENANT';

  constructor(message = 'Tenant context is required for this resource') {
    super(message);
    this.name = 'MissingTenantError';
  }
}

/**
 * Resolves the provider id from the authenticated request.
 *
 * Resolution order:
 *  1. Authenticated API key (req.apiKey.providerId or req.auth.providerId)
 *  2. Authenticated user (req.user.providerId)
 *  3. Explicit `x-provider-id` header (only trusted when the request is
 *     already authenticated; otherwise it is ignored to prevent spoofing).
 */
export function resolveProviderId(req: Request): TenantContext | null {
  const anyReq = req as any;

  // 1. API key based authentication.
  const apiKeyProviderId =
    anyReq.apiKey?.providerId ?? anyReq.auth?.providerId ?? anyReq.providerId;
  if (typeof apiKeyProviderId === 'string' && apiKeyProviderId.length > 0) {
    return { providerId: apiKeyProviderId, source: 'api-key' };
  }

  // 2. Authenticated user.
  const userProviderId = anyReq.user?.providerId;
  if (typeof userProviderId === 'string' && userProviderId.length > 0) {
    return { providerId: userProviderId, source: 'user' };
  }

  // 3. Explicit header, only when the request is authenticated.
  const isAuthenticated = Boolean(anyReq.user || anyReq.apiKey || anyReq.auth);
  const headerProviderId = req.header('x-provider-id');
  if (isAuthenticated && typeof headerProviderId === 'string' && headerProviderId.length > 0) {
    return { providerId: headerProviderId, source: 'header' };
  }

  return null;
}

/**
 * Middleware that resolves and attaches the tenant context to the request.
 *
 * When `required` is true (default), requests without a resolvable tenant
 * context are rejected with a 401. When false, the middleware is a no-op for
 * requests without a tenant (useful for public routes) but still attaches the
 * context when available.
 */
export function tenantIsolation(options: { required?: boolean } = {}) {
  const required = options.required !== false;

  return function tenantIsolationMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const context = resolveProviderId(req);

    if (!context) {
      if (required) {
        res.status(401).json({
          error: 'MISSING_TENANT',
          message: 'Tenant context is required for this resource',
        });
        return;
      }
      next();
      return;
    }

    req.tenant = context;
    next();
  };
}

/**
 * Convenience middleware for tenant-scoped routes. Rejects requests that do
 * not carry a tenant context.
 */
export const requireTenant = tenantIsolation({ required: true });

/**
 * Returns the tenant context for a request or throws when it is missing.
 */
export function getTenant(req: Request): TenantContext {
  if (!req.tenant) {
    throw new MissingTenantError();
  }
  return req.tenant;
}

/**
 * Returns the provider id for a request or throws when it is missing.
 */
export function getProviderId(req: Request): string {
  return getTenant(req).providerId;
}

/**
 * A tenant-scoped query builder. Wraps a query so that the provider_id
 * constraint is always applied, preventing cross-tenant access.
 */
export interface TenantScopedQuery {
  providerId: string;
  /** The WHERE clause fragment to append to a query. */
  where: string;
  /** Positional parameters matching the `where` fragment. */
  params: unknown[];
  /** Applies the tenant filter to a base WHERE clause. */
  apply(baseWhere?: string): { where: string; params: unknown[] };
}

/**
 * Builds a tenant-scoped query helper for the given provider id.
 *
 * Usage:
 *   const q = buildTenantQuery(req);
 *   db.query(`SELECT * FROM appointments WHERE ${q.where}`, q.params);
 */
export function buildTenantQuery(
  reqOrProviderId: Request | string,
  column = 'provider_id',
): TenantScopedQuery {
  const providerId =
    typeof reqOrProviderId === 'string'
      ? reqOrProviderId
      : getProviderId(reqOrProviderId);

  if (!providerId) {
    throw new MissingTenantError();
  }

  const where = `${column} = $1`;
  const params: unknown[] = [providerId];

  return {
    providerId,
    where,
    params,
    apply(baseWhere?: string) {
      if (baseWhere && baseWhere.trim().length > 0) {
        return {
          where: `(${baseWhere}) AND ${where}`,
          params,
        };
      }
      return { where, params };
    },
  };
}

/**
 * Ensures a record belongs to the current tenant. Throws when the record's
 * provider id does not match the request tenant.
 */
export function assertTenantOwnership(
  req: Request,
  recordProviderId: string | null | undefined,
): void {
  const providerId = getProviderId(req);
  if (recordProviderId !== providerId) {
    throw new MissingTenantError('Cross-tenant access denied');
  }
}

export default tenantIsolation;
```

File: backend/src/middleware/index.ts
```typescript
export {
  tenantIsolation,
  requireTenant,
  getTenant,
  getProviderId,
  buildTenantQuery,
  assertTenantOwnership,
  resolveProviderId,
  MissingTenantError,
} from './tenant';
export type { TenantContext, TenantScopedQuery } from './tenant';