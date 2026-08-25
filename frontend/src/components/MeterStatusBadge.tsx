type MeterStatus = 'active' | 'inactive' | 'expired' | 'grace';

const labels: Record<MeterStatus, string> = {
  active: 'Active',
  inactive: 'Inactive',
  expired: 'Expired',
  grace: 'Grace Period',
};

function deriveStatus(active: boolean, expiresAt: number, graceExpiresAt?: number | null): MeterStatus {
  if (graceExpiresAt && graceExpiresAt > 0 && graceExpiresAt * 1000 > Date.now()) {
    return 'grace';
  }
  if (expiresAt > 0 && expiresAt !== Number.MAX_SAFE_INTEGER && expiresAt * 1000 < Date.now()) {
    return 'expired';
  }
  return active ? 'active' : 'inactive';
}

export function MeterStatusBadge({
  active,
  expiresAt,
  graceExpiresAt,
}: {
  active: boolean;
  expiresAt: number;
  graceExpiresAt?: number | null;
}) {
  const status = deriveStatus(active, expiresAt, graceExpiresAt);
  return (
    <span className={'badge badge--' + status} aria-label={'Meter status: ' + labels[status]}>
      {labels[status]}
    </span>
  );
}
