import type { ReturnStatus } from './localApi';

export const STATUS_FLOW: ReturnStatus[] = [
  'Intake',
  'Awaiting Info',
  'Under Validation',
  'Ready for Manager Review',
  'Approved',
  'Rejected',
];

export function statusStyles(status: ReturnStatus): string {
  const styles: Record<ReturnStatus, string> = {
    Intake: 'bg-slate-100 text-slate-700',
    'Awaiting Info': 'bg-amber-100 text-amber-800',
    'Under Validation': 'bg-blue-100 text-blue-800',
    'Ready for Manager Review': 'bg-violet-100 text-violet-800',
    Approved: 'bg-emerald-100 text-emerald-800',
    Rejected: 'bg-red-100 text-red-800',
  };

  return styles[status] ?? styles.Intake;
}

export function statusDot(status: ReturnStatus): string {
  const styles: Record<ReturnStatus, string> = {
    Intake: 'bg-slate-400',
    'Awaiting Info': 'bg-amber-500',
    'Under Validation': 'bg-blue-500',
    'Ready for Manager Review': 'bg-violet-500',
    Approved: 'bg-emerald-500',
    Rejected: 'bg-red-500',
  };

  return styles[status] ?? styles.Intake;
}

export function formatCurrency(value: number | string | null | undefined): string {
  const amount = Number(value ?? 0);

  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(Number.isFinite(amount) ? amount : 0);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '-';

  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '-';

  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
