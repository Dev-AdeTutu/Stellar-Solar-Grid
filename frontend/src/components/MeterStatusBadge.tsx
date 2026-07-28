type MeterStatus = 'active' | 'inactive' | 'expired';

const labels: Record<MeterStatus, string> = {
  active: 'Active',
  inactive: 'Inactive',
  expired: 'Expired',
};

function deriveStatus(active: boolean, expiresAt: number): MeterStatus {
  if (expiresAt > 0 && expiresAt !== Number.MAX_SAFE_INTEGER && expiresAt * 1000 < Date.now()) {
    return 'expired';
  }
  return active ? 'active' : 'inactive';
}

export function MeterStatusBadge({ active, expiresAt }: { active: boolean; expiresAt: number }) {
  const status = deriveStatus(active, expiresAt);
  return (
    <span className={'badge badge--' + status} aria-label={'Meter status: ' + labels[status]}>
      {labels[status]}
    </span>
  );
}
