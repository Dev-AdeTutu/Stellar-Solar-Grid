import { logger } from "./logger.js";

/** A compliance rule defined as code. `check` returns a violation message or null. */
export interface ComplianceRule {
  id: string;
  description: string;
  severity: "low" | "medium" | "high";
  check: (op: Operation) => string | null;
}

export interface Operation {
  type: string;
  meterId?: string;
  amount?: number;
  actor?: string;
  timestamp?: number;
  [key: string]: unknown;
}

export interface AuditEntry {
  timestamp: number;
  operation: Operation;
  ruleId: string;
  passed: boolean;
  message?: string;
}

export const DEFAULT_RULES: ComplianceRule[] = [
  {
    id: "PAY_LIMIT",
    description: "Single payment must not exceed 10,000 XLM (AML threshold)",
    severity: "high",
    check: (op) =>
      op.type === "payment" && (op.amount ?? 0) > 10_000 ? `Payment ${op.amount} exceeds AML threshold` : null,
  },
  {
    id: "ACTOR_REQUIRED",
    description: "Every state-changing operation must have an identified actor (KYC)",
    severity: "medium",
    check: (op) => (op.type !== "read" && !op.actor ? "Operation has no identified actor" : null),
  },
  {
    id: "METER_REQUIRED",
    description: "Payments and usage reports must reference a meter",
    severity: "low",
    check: (op) =>
      ["payment", "usage"].includes(op.type) && !op.meterId ? "Missing meterId" : null,
  },
];

type AlertHandler = (entry: AuditEntry, rule: ComplianceRule) => void;

export class ComplianceEngine {
  private audit: AuditEntry[] = [];
  private alertHandlers: AlertHandler[] = [];

  constructor(private rules: ComplianceRule[] = DEFAULT_RULES) {}

  addRule(rule: ComplianceRule) {
    this.rules.push(rule);
  }

  onViolation(handler: AlertHandler) {
    this.alertHandlers.push(handler);
  }

  /** Evaluate an operation against every rule; records each check in the audit trail. */
  evaluate(op: Operation): AuditEntry[] {
    const timestamp = op.timestamp ?? Date.now();
    return this.rules.map((rule) => {
      const message = rule.check(op);
      const entry: AuditEntry = { timestamp, operation: op, ruleId: rule.id, passed: !message, ...(message && { message }) };
      this.audit.push(entry);
      if (message) {
        logger.warn({ compliance: "violation", ruleId: rule.id, message });
        this.alertHandlers.forEach((h) => h(entry, rule));
      }
      return entry;
    });
  }

  auditTrail(since = 0): AuditEntry[] {
    return this.audit.filter((e) => e.timestamp >= since);
  }

  report(since = 0) {
    const entries = this.auditTrail(since);
    const violations = entries.filter((e) => !e.passed);
    const byRule: Record<string, number> = {};
    violations.forEach((v) => (byRule[v.ruleId] = (byRule[v.ruleId] ?? 0) + 1));
    return {
      generatedAt: new Date().toISOString(),
      totalChecks: entries.length,
      violations: violations.length,
      complianceRate: entries.length ? 1 - violations.length / entries.length : 1,
      byRule,
      recentViolations: violations.slice(-20),
    };
  }
}

export const complianceEngine = new ComplianceEngine();
