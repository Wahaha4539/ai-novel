export function StatusBadge({ value }: { value: string }) {
  const style =
    value === 'error' || value === 'rejected'
      ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
      : value === 'warning' || value === 'pending_review'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
        : value === 'user_confirmed' || value === 'completed' || value === 'detected'
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
          : 'border-slate-600 bg-slate-800 text-slate-200';

  return <span className={`badge ${style}`}>{value}</span>;
}
