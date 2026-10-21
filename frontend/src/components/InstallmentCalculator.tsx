import React, { useMemo, useState } from 'react';
import { createInstallmentPlan } from '../services/paymentService';

export interface InstallmentCalculatorProps {
  /** Optional wallet address; when provided, the plan can be submitted on-chain. */
  walletAddress?: string | null;
  /** Optional callback invoked after a plan is successfully created. */
  onPlanCreated?: (planId: string) => void;
}

const MIN_INSTALLMENTS = 1;
const MAX_INSTALLMENTS = 60;
const SCHEDULE_DAYS = 30;

interface ScheduleEntry {
  index: number;
  dueDate: Date;
  amount: number;
}

const formatCurrency = (value: number): string =>
  value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const formatDate = (date: Date): string =>
  date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

const InstallmentCalculator: React.FC<InstallmentCalculatorProps> = ({
  walletAddress,
  onPlanCreated,
}) => {
  const [totalInput, setTotalInput] = useState<string>('');
  const [installmentsInput, setInstallmentsInput] = useState<string>('12');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [planId, setPlanId] = useState<string | null>(null);

  const total = useMemo(() => {
    const parsed = Number.parseFloat(totalInput);
    return Number.isFinite(parsed) ? parsed : NaN;
  }, [totalInput]);

  const installments = useMemo(() => {
    const parsed = Number.parseInt(installmentsInput, 10);
    return Number.isFinite(parsed) ? parsed : NaN;
  }, [installmentsInput]);

  const totalError = useMemo(() => {
    if (totalInput.trim() === '') return null;
    if (!Number.isFinite(total) || total <= 0) {
      return 'Total amount must be greater than 0.';
    }
    return null;
  }, [totalInput, total]);

  const installmentsError = useMemo(() => {
    if (installmentsInput.trim() === '') return null;
    if (
      !Number.isFinite(installments) ||
      !Number.isInteger(installments) ||
      installments < MIN_INSTALLMENTS ||
      installments > MAX_INSTALLMENTS
    ) {
      return `Number of installments must be between ${MIN_INSTALLMENTS} and ${MAX_INSTALLMENTS}.`;
    }
    return null;
  }, [installmentsInput, installments]);

  const isValid =
    Number.isFinite(total) &&
    total > 0 &&
    Number.isFinite(installments) &&
    Number.isInteger(installments) &&
    installments >= MIN_INSTALLMENTS &&
    installments <= MAX_INSTALLMENTS;

  const perInstallment = useMemo(() => {
    if (!isValid) return 0;
    return total / installments;
  }, [isValid, total, installments]);

  const schedule = useMemo<ScheduleEntry[]>(() => {
    if (!isValid) return [];
    const now = new Date();
    const entries: ScheduleEntry[] = [];
    for (let i = 0; i < installments; i += 1) {
      const dueDate = new Date(now.getTime());
      dueDate.setDate(dueDate.getDate() + SCHEDULE_DAYS * (i + 1));
      entries.push({
        index: i + 1,
        dueDate,
        amount: perInstallment,
      });
    }
    return entries;
  }, [isValid, installments, perInstallment]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setPlanId(null);

    if (!isValid) {
      setError('Please correct the highlighted fields before continuing.');
      return;
    }

    if (!walletAddress) {
      setError('Connect a wallet to create an installment plan.');
      return;
    }

    setLoading(true);
    try {
      const plan = await createInstallmentPlan({
        walletAddress,
        total,
        installments,
      });
      const createdId =
        typeof plan === 'string' ? plan : plan?.id ?? plan?.planId ?? null;
      if (!createdId) {
        throw new Error('Payment service did not return a plan id.');
      }
      setPlanId(createdId);
      if (onPlanCreated) {
        onPlanCreated(createdId);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to create installment plan.';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="installment-calculator">
      <h2>Installment Calculator</h2>
      <p className="installment-calculator__intro">
        Spread the cost of a meter purchase or upgrade across up to{' '}
        {MAX_INSTALLMENTS} monthly installments.
      </p>

      <form onSubmit={handleSubmit} noValidate>
        <div className="installment-calculator__field">
          <label htmlFor="installment-total">Total amount</label>
          <input
            id="installment-total"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={totalInput}
            onChange={(e) => setTotalInput(e.target.value)}
            disabled={loading}
            aria-invalid={Boolean(totalError)}
            aria-describedby={totalError ? 'installment-total-error' : undefined}
          />
          {totalError && (
            <span
              id="installment-total-error"
              className="installment-calculator__error"
              role="alert"
            >
              {totalError}
            </span>
          )}
        </div>

        <div className="installment-calculator__field">
          <label htmlFor="installment-count">Number of installments</label>
          <input
            id="installment-count"
            type="number"
            inputMode="numeric"
            min={MIN_INSTALLMENTS}
            max={MAX_INSTALLMENTS}
            step="1"
            value={installmentsInput}
            onChange={(e) => setInstallmentsInput(e.target.value)}
            disabled={loading}
            aria-invalid={Boolean(installmentsError)}
            aria-describedby={
              installmentsError ? 'installment-count-error' : undefined
            }
          />
          {installmentsError && (
            <span
              id="installment-count-error"
              className="installment-calculator__error"
              role="alert"
            >
              {installmentsError}
            </span>
          )}
        </div>

        <div className="installment-calculator__summary">
          <div>
            <span className="installment-calculator__label">
              Per installment
            </span>
            <span className="installment-calculator__value">
              {isValid ? formatCurrency(perInstallment) : '—'}
            </span>
          </div>
          <div>
            <span className="installment-calculator__label">
              Payment interval
            </span>
            <span className="installment-calculator__value">
              Every {SCHEDULE_DAYS} days
            </span>
          </div>
        </div>

        {schedule.length > 0 && (
          <div className="installment-calculator__schedule">
            <h3>Payment schedule</h3>
            <table>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Due date</th>
                  <th scope="col">Amount</th>
                </tr>
              </thead>
              <tbody>
                {schedule.map((entry) => (
                  <tr key={entry.index}>
                    <td>{entry.index}</td>
                    <td>{formatDate(entry.dueDate)}</td>
                    <td>{formatCurrency(entry.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {error && (
          <div className="installment-calculator__error" role="alert">
            {error}
          </div>
        )}

        {planId && (
          <div className="installment-calculator__success" role="status">
            <p>
              Installment plan created. Plan ID: <strong>{planId}</strong>
            </p>
            <a href={`/installments/${encodeURIComponent(planId)}`}>
              View plan in tracker
            </a>
          </div>
        )}

        <button type="submit" disabled={loading || !isValid || !walletAddress}>
          {loading ? 'Creating plan…' : 'Create installment plan'}
        </button>

        {!walletAddress && (
          <p className="installment-calculator__hint">
            Connect your wallet to create an installment plan.
          </p>
        )}
      </form>
    </div>
  );
};

export default InstallmentCalculator;