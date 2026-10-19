import React, { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * InstallmentTracker
 *
 * Fetches a payer's installment plans and renders their status, amounts,
 * next due date, and provides a "Pay Now" action for due plans.
 *
 * Expected contract interface:
 *   getPayerInstallments(payer: string): Promise<number[] | string[]>
 *   getInstallmentPlan(planId: number | string): Promise<InstallmentPlan>
 *   payInstallment(planId: number | string): Promise<unknown>
 */

export interface InstallmentScheduleEntry {
  dueDate: number | string | Date;
  amount: number | string | bigint;
  paid?: boolean;
}

export interface InstallmentPlan {
  id: number | string;
  payer?: string;
  total: number | string | bigint;
  paid: number | string | bigint;
  remaining?: number | string | bigint;
  schedule?: InstallmentScheduleEntry[];
  nextDueDate?: number | string | Date | null;
  status?: string;
}

export interface InstallmentTrackerProps {
  /** Address of the payer whose plans should be loaded. */
  payer: string;
  /** Contract client exposing getPayerInstallments, getInstallmentPlan, payInstallment. */
  contract: {
    getPayerInstallments: (payer: string) => Promise<Array<number | string>>;
    getInstallmentPlan: (planId: number | string) => Promise<InstallmentPlan>;
    payInstallment: (planId: number | string) => Promise<unknown>;
  };
  /** Optional callback fired after a successful payment. */
  onPaymentSuccess?: (planId: number | string) => void;
  /** Optional callback fired when loading or paying fails. */
  onError?: (error: Error) => void;
}

type PlanStatus = 'Active' | 'Completed' | 'Defaulted';

const STATUS_ACTIVE: PlanStatus = 'Active';
const STATUS_COMPLETED: PlanStatus = 'Completed';
const STATUS_DEFAULTED: PlanStatus = 'Defaulted';

function toNumber(value: number | string | bigint | undefined | null): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDate(value: number | string | Date | null | undefined): Date | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    // Heuristic: treat values below 1e12 as seconds since epoch.
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatAmount(value: number | string | bigint | undefined | null): string {
  const n = toNumber(value);
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function formatDate(value: number | string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '—';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function normalizeStatus(plan: InstallmentPlan): PlanStatus {
  const raw = (plan.status ?? '').toString().trim().toLowerCase();
  if (raw === 'completed' || raw === 'complete' || raw === 'paid') {
    return STATUS_COMPLETED;
  }
  if (raw === 'defaulted' || raw === 'default' || raw === 'missed') {
    return STATUS_DEFAULTED;
  }
  if (raw === 'active' || raw === 'pending' || raw === 'in_progress') {
    return STATUS_ACTIVE;
  }

  // Fall back to deriving status from amounts.
  const total = toNumber(plan.total);
  const paid = toNumber(plan.paid);
  const remaining = plan.remaining !== undefined ? toNumber(plan.remaining) : total - paid;

  if (total > 0 && remaining <= 0) return STATUS_COMPLETED;
  if (total > 0 && paid > total) return STATUS_DEFAULTED;
  return STATUS_ACTIVE;
}

function computeRemaining(plan: InstallmentPlan): number {
  if (plan.remaining !== undefined && plan.remaining !== null) {
    return toNumber(plan.remaining);
  }
  return Math.max(0, toNumber(plan.total) - toNumber(plan.paid));
}

function computeNextDueDate(plan: InstallmentPlan): Date | null {
  if (plan.nextDueDate) {
    const d = toDate(plan.nextDueDate);
    if (d) return d;
  }
  if (Array.isArray(plan.schedule)) {
    const unpaid = plan.schedule
      .filter((entry) => !entry.paid)
      .map((entry) => toDate(entry.dueDate))
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime());
    if (unpaid.length > 0) return unpaid[0];
  }
  return null;
}

function isDue(plan: InstallmentPlan, status: PlanStatus): boolean {
  if (status !== STATUS_ACTIVE) return false;
  const nextDue = computeNextDueDate(plan);
  if (!nextDue) return false;
  return nextDue.getTime() <= Date.now();
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    fontFamily: 'inherit',
  },
  header: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '0.5rem',
  },
  title: {
    fontSize: '1.25rem',
    fontWeight: 600,
    margin: 0,
  },
  subtitle: {
    fontSize: '0.85rem',
    color: '#6b7280',
    margin: 0,
  },
  card: {
    border: '1px solid #e5e7eb',
    borderRadius: '0.75rem',
    padding: '1rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    background: '#ffffff',
  },
  cardDefaulted: {
    borderColor: '#fca5a5',
    background: '#fef2f2',
  },
  cardCompleted: {
    borderColor: '#86efac',
    background: '#f0fdf4',
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.5rem',
  },
  planId: {
    fontWeight: 600,
    fontSize: '1rem',
  },
  badge: {
    display: 'inline-block',
    padding: '0.15rem 0.6rem',
    borderRadius: '9999px',
    fontSize: '0.75rem',
    fontWeight: 600,
    lineHeight: 1.4,
  },
  badgeActive: {
    background: '#dbeafe',
    color: '#1d4ed8',
  },
  badgeCompleted: {
    background: '#dcfce7',
    color: '#15803d',
  },
  badgeDefaulted: {
    background: '#fee2e2',
    color: '#b91c1c',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: '0.75rem',
  },
  metric: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.15rem',
  },
  metricLabel: {
    fontSize: '0.75rem',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: '#6b7280',
  },
  metricValue: {
    fontSize: '1rem',
    fontWeight: 600,
  },
  progressTrack: {
    width: '100%',
    height: '0.5rem',
    borderRadius: '9999px',
    background: '#e5e7eb',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    background: '#2563eb',
    transition: 'width 0.3s ease',
  },
  progressFillCompleted: {
    background: '#16a34a',
  },
  progressFillDefaulted: {
    background: '#dc2626',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.5rem',
  },
  button: {
    padding: '0.5rem 1rem',
    borderRadius: '0.5rem',
    border: 'none',
    background: '#2563eb',
    color: '#ffffff',
    fontWeight: 600,
    cursor: 'pointer',
  },
  buttonDisabled: {
    background: '#93c5fd',
    cursor: 'not-allowed',
  },
  banner: {
    borderRadius: '0.5rem',
    padding: '0.75rem 1rem',
    fontSize: '0.9rem',
    fontWeight: 500,
  },
  bannerDefaulted: {
    background: '#fee2e2',
    color: '#991b1b',
    border: '1px solid #fca5a5',
  },
  bannerCompleted: {
    background: '#dcfce7',
    color: '#166534',
    border: '1px solid #86efac',
  },
  bannerError: {
    background: '#fef3c7',
    color: '#92400e',
    border: '1px solid #fcd34d',
  },
  empty: {
    padding: '1.5rem',
    textAlign: 'center',
    color: '#6b7280',
    border: '1px dashed #d1d5db',
    borderRadius: '0.75rem',
  },
};

export const InstallmentTracker: React.FC<InstallmentTrackerProps> = ({
  payer,
  contract,
  onPaymentSuccess,
  onError,
}) => {
  const [plans, setPlans] = useState<InstallmentPlan[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<number | string | null>(null);

  const reportError = useCallback(
    (err: unknown) => {
      const normalized = err instanceof Error ? err : new Error(String(err));
      setError(normalized.message);
      if (onError) onError(normalized);
    },
    [onError],
  );

  const loadPlans = useCallback(async () => {
    if (!payer || !contract) {
      setPlans([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const ids = await contract.getPayerInstallments(payer);
      const fetched = await Promise.all(
        (ids ?? []).map(async (id) => {
          const plan = await contract.getInstallmentPlan(id);
          return { ...plan, id: plan.id ?? id };
        }),
      );
      setPlans(fetched);
    } catch (err) {
      reportError(err);
      setPlans([]);
    } finally {
      setLoading(false);
    }
  }, [payer, contract, reportError]);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (!payer || !contract) {
        setPlans([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const ids = await contract.getPayerInstallments(payer);
        const fetched = await Promise.all(
          (ids ?? []).map(async (id) => {
            const plan = await contract.getInstallmentPlan(id);
            return { ...plan, id: plan.id ?? id };
          }),
        );
        if (!cancelled) setPlans(fetched);
      } catch (err) {
        if (!cancelled) {
          reportError(err);
          setPlans([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [payer, contract, reportError]);

  const handlePayNow = useCallback(
    async (planId: number | string) => {
      setPayingId(planId);
      setError(null);
      try {
        await contract.payInstallment(planId);
        if (onPaymentSuccess) onPaymentSuccess(planId);
        await loadPlans();
      } catch (err) {
        reportError(err);
      } finally {
        setPayingId(null);
      }
    },
    [contract, loadPlans, onPaymentSuccess, reportError],
  );

  const decoratedPlans = useMemo(
    () =>
      plans.map((plan) => {
        const status = normalizeStatus(plan);
        const total = toNumber(plan.total);
        const paid = toNumber(plan.paid);
        const remaining = computeRemaining(plan);
        const nextDueDate = computeNextDueDate(plan);
        const due = isDue(plan, status);
        const progress =
          total > 0 ? Math.min(100, Math.max(0, (paid / total) * 100)) : 0;
        return { plan, status, total, paid, remaining, nextDueDate, due, progress };
      }),
    [plans],
  );

  const hasDefaulted = decoratedPlans.some((p) => p.status === STATUS_DEFAULTED);
  const allCompleted =
    decoratedPlans.length > 0 &&
    decoratedPlans.every((p) => p.status === STATUS_COMPLETED);

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.empty}>Loading installment plans…</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>Installment Plans</h2>
        <p style={styles.subtitle}>{payer}</p>
      </div>

      {error && (
        <div style={{ ...styles.banner, ...styles.bannerError }} role="alert">
          {error}
        </div>
      )}

      {hasDefaulted && (
        <div
          style={{ ...styles.banner, ...styles.bannerDefaulted }}
          role="alert"
          data-testid="defaulted-warning"
        >
          ⚠️ One or more installment plans have defaulted. Please contact support
          or settle the outstanding balance to restore your account.
        </div>
      )}

      {allCompleted && (
        <div
          style={{ ...styles.banner, ...styles.bannerCompleted }}
          role="status"
          data-testid="completed-success"
        >
          ✅ All installment plans are fully paid. Thank you!
        </div>
      )}

      {decoratedPlans.length === 0 && !error && (
        <div style={styles.empty}>No installment plans found for this payer.</div>
      )}

      {decoratedPlans.map(
        ({ plan, status, total, paid, remaining, nextDueDate, due, progress }) => {
          const cardStyle =
            status === STATUS_DEFAULTED
              ? { ...styles.card, ...styles.cardDefaulted }
              : status === STATUS_COMPLETED
                ? { ...styles.card, ...styles.cardCompleted }
                : styles.card;

          const badgeStyle =
            status === STATUS_DEFAULTED
              ? { ...styles.badge, ...styles.badgeDefaulted }
              : status === STATUS_COMPLETED
                ? { ...styles.badge, ...styles.badgeCompleted }
                : { ...styles.badge, ...styles.badgeActive };

          const fillStyle =
            status === STATUS_DEFAULTED
              ? { ...styles.progressFill, ...styles.progressFillDefaulted }
              : status === STATUS_COMPLETED
                ? { ...styles.progressFill, ...styles.progressFillCompleted }
                : styles.progressFill;

          const isPaying = payingId === plan.id;

          return (
            <div
              key={String(plan.id)}
              style={cardStyle}
              data-testid={`installment-plan-${plan.id}`}
            >
              <div style={styles.cardHeader}>
                <span style={styles.planId}>Plan #{String(plan.id)}</span>
                <span style={badgeStyle} data-testid={`plan-status-${plan.id}`}>
                  {status}
                </span>
              </div>

              <div style={styles.grid}>
                <div style={styles.metric}>
                  <span style={styles.metricLabel}>Total</span>
                  <span style={styles.metricValue}>{formatAmount(total)}</span>
                </div>
                <div style={styles.metric}>
                  <span style={styles.metricLabel}>Paid</span>
                  <span style={styles.metricValue}>{formatAmount(paid)}</span>
                </div>
                <div style={styles.metric}>
                  <span style={styles.metricLabel}>Remaining</span>
                  <span style={styles.metricValue}>
                    {formatAmount(remaining)}
                  </span>
                </div>
                <div style={styles.metric}>
                  <span style={styles.metricLabel}>Next Due</span>
                  <span style={styles.metricValue}>
                    {status === STATUS_COMPLETED
                      ? '—'
                      : formatDate(nextDueDate)}
                  </span>
                </div>
              </div>

              <div
                style={styles.progressTrack}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress)}
              >
                <div style={{ ...fillStyle, width: `${progress}%` }} />
              </div>

              {status === STATUS_DEFAULTED && (
                <div
                  style={{ ...styles.banner, ...styles.bannerDefaulted }}
                  role="alert"
                >
                  This plan has defaulted. Outstanding balance:{' '}
                  {formatAmount(remaining)}.
                </div>
              )}

              {status === STATUS_COMPLETED && (
                <div
                  style={{ ...styles.banner, ...styles.bannerCompleted }}
                  role="status"
                >
                  Plan completed — all installments paid.
                </div>
              )}

              <div style={styles.actions}>
                <button
                  type="button"
                  style={{
                    ...styles.button,
                    ...(status !== STATUS_ACTIVE || isPaying
                      ? styles.buttonDisabled
                      : {}),
                  }}
                  disabled={status !== STATUS_ACTIVE || isPaying}
                  onClick={() => handlePayNow(plan.id)}
                  data-testid={`pay-now-${plan.id}`}
                  title={
                    status !== STATUS_ACTIVE
                      ? 'Payment is not available for this plan'
                      : due
                        ? 'Payment is due'
                        : 'Pay the next installment'
                  }
                >
                  {isPaying ? 'Processing…' : 'Pay Now'}
                </button>
              </div>
            </div>
          );
        },
      )}
    </div>
  );
};

export default InstallmentTracker;