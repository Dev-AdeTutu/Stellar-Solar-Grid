import fs from "node:fs";
import path from "node:path";
import YAML from "yamljs";

interface OpenAPIPath {
  path: string;
  methods: string[];
}

interface ExpressRoute {
  path: string;
  method: string;
}

/**
 * Parse OpenAPI spec and extract {path, method} pairs.
 */
function parseOpenAPISpec(filePath: string): OpenAPIPath[] {
  const spec = YAML.load(filePath);
  const paths: OpenAPIPath[] = [];

  if (!spec.paths || typeof spec.paths !== "object") {
    console.warn("No paths found in OpenAPI spec");
    return paths;
  }

  for (const [pathPattern, pathObj] of Object.entries(spec.paths)) {
    const methods: string[] = [];
    const methodsObj = pathObj as Record<string, any>;

    for (const method of ["get", "post", "put", "delete", "patch", "options"]) {
      if (method in methodsObj) {
        methods.push(method.toUpperCase());
      }
    }

    if (methods.length > 0) {
      paths.push({ path: pathPattern, methods });
    }
  }

  return paths;
}

/**
 * Normalize path patterns for comparison.
 * Converts OpenAPI {id} to Express :id format.
 */
function normalizePathPattern(pattern: string): string {
  return pattern.replace(/{([^}]+)}/g, ":$1");
}

/**
 * Internal-only routes that should not be in OpenAPI spec.
 */
const INTERNAL_ROUTE_PATTERNS = [
  /^\/metrics$/,
  /^\/api\/metrics$/,
  /^\/health$/,
];

// Suppress unused warning
void isInternalRoute;

function isInternalRoute(path: string): boolean {
  return INTERNAL_ROUTE_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Test that OpenAPI spec matches actual Express routes.
 */
async function testOpenAPIValidation() {
  const openApiPath = path.resolve(
    import.meta.url.replace("file://", ""),
    "../../openapi.yaml",
  );

  if (!fs.existsSync(openApiPath)) {
    throw new Error(`OpenAPI spec not found at ${openApiPath}`);
  }

  const apiPaths = parseOpenAPISpec(openApiPath);

  // Build a map of documented paths
  const documentedPaths = new Set<string>();
  const documentedMethods = new Map<string, Set<string>>();

  for (const { path: pathPattern, methods } of apiPaths) {
    const normalized = normalizePathPattern(pathPattern);
    documentedPaths.add(normalized);

    if (!documentedMethods.has(normalized)) {
      documentedMethods.set(normalized, new Set());
    }
    for (const method of methods) {
      documentedMethods.get(normalized)!.add(method);
    }
  }

  // Known implemented routes (these should be in the spec)
  const expectedRoutes = [
    // Health
    { path: "/api/health", methods: ["GET"] },

    // Meters
    { path: "/api/meters", methods: ["GET", "POST"] },
    { path: "/api/meters/export", methods: ["GET"] },
    { path: "/api/meters/owner/:address", methods: ["GET"] },
    { path: "/api/meters/:id", methods: ["GET"] },
    { path: "/api/meters/:id/note", methods: ["POST"] },
    { path: "/api/meters/:id/access", methods: ["GET"] },
    { path: "/api/meters/:id/balance", methods: ["GET"] },
    { path: "/api/meters/balances", methods: ["GET"] },
    { path: "/api/meters/:id/history", methods: ["GET"] },
    { path: "/api/meters/:id/usage", methods: ["POST"] },
    { path: "/api/meters/:id/activate", methods: ["POST"] },
    { path: "/api/meters/:id/deactivate", methods: ["POST"] },
    { path: "/api/meters/:id/set-daily-limit", methods: ["POST"] },

    // Payments
    { path: "/api/payments/:address", methods: ["GET"] },
    { path: "/api/payments/history/:address", methods: ["GET"] },
    { path: "/api/payments", methods: ["POST"] },

    // Webhooks
    { path: "/api/webhooks/sms-payment", methods: ["POST"] },
    { path: "/api/webhooks/low-balance", methods: ["POST", "DELETE"] },
    { path: "/api/webhooks", methods: ["GET"] },
    { path: "/api/webhooks/:id/deliveries", methods: ["GET"] },

    // Solar
    { path: "/api/solar/forecast", methods: ["GET"] },
    { path: "/api/solar/irradiance-zones", methods: ["GET"] },

    // Allowlist
    { path: "/api/allowlist", methods: ["GET", "POST"] },
    { path: "/api/allowlist/:address", methods: ["DELETE"] },

    // Collaborators
    { path: "/api/collaborators", methods: ["GET", "POST"] },
    { path: "/api/collaborators/:address", methods: ["DELETE"] },
    { path: "/api/collaborators/total-shares", methods: ["GET"] },
    { path: "/api/collaborators/meter/:meterId", methods: ["GET"] },

    // Stats
    { path: "/api/stats", methods: ["GET"] },
    { path: "/api/stats/summary", methods: ["GET"] },

    // Usage Events
    { path: "/api/usage-events", methods: ["DELETE"] },
    { path: "/api/usage-events/failed", methods: ["GET"] },
    { path: "/api/usage-events/:id/replay", methods: ["POST"] },

    // Metrics (internal, may not be in spec)
    // { path: "/api/metrics/summary", methods: ["GET"] },
  ];

  const errors: string[] = [];

  // Check that expected routes are documented
  for (const { path: routePath, methods } of expectedRoutes) {
    if (isInternalRoute(routePath)) {
      // Skip internal routes
      continue;
    }

    if (!documentedPaths.has(routePath)) {
      errors.push(`Route not documented in OpenAPI: ${routePath}`);
    } else {
      const docMethods = documentedMethods.get(routePath);
      for (const method of methods) {
        if (!docMethods || !docMethods.has(method)) {
          errors.push(
            `Method ${method} not documented for ${routePath} in OpenAPI`,
          );
        }
      }
    }
  }

  // Check for documented routes that might not exist (optional warning)
  const warnings: string[] = [];
  for (const { path: docPath } of apiPaths) {
    if (isInternalRoute(docPath)) {
      continue;
    }

    const normalized = normalizePathPattern(docPath);
    const found = expectedRoutes.some((r) => r.path === normalized);

    if (!found) {
      warnings.push(`Documented route not found in expected list: ${docPath}`);
    }
  }

  if (errors.length > 0) {
    console.error("❌ OpenAPI validation failed:");
    errors.forEach((e) => console.error(`  - ${e}`));
    throw new Error(`${errors.length} OpenAPI validation error(s)`);
  }

  if (warnings.length > 0) {
    console.warn("⚠️  OpenAPI warnings:");
    warnings.forEach((w) => console.warn(`  - ${w}`));
  }

  console.log(`✅ OpenAPI spec validation passed (${apiPaths.length} paths)`);
}

// Run test
testOpenAPIValidation().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
