const STATUS_STYLES: Record<string, { borderColor: string; background: string; color: string }> = {
  error:          { borderColor: 'rgba(244, 63, 94, 0.4)', background: 'var(--status-err-bg)', color: '#fb7185' },
  rejected:       { borderColor: 'rgba(244, 63, 94, 0.4)', background: 'var(--status-err-bg)', color: '#fb7185' },
  warning:        { borderColor: 'rgba(245, 158, 11, 0.4)', background: 'rgba(245, 158, 11, 0.1)', color: '#fbbf24' },
  pending_review: { borderColor: 'rgba(245, 158, 11, 0.4)', background: 'rgba(245, 158, 11, 0.1)', color: '#fbbf24' },
  user_confirmed: { borderColor: 'rgba(16, 185, 129, 0.4)', background: 'rgba(16, 185, 129, 0.1)', color: '#34d399' },
  completed:      { borderColor: 'rgba(16, 185, 129, 0.4)', background: 'rgba(16, 185, 129, 0.1)', color: '#34d399' },
  detected:       { borderColor: 'rgba(16, 185, 129, 0.4)', background: 'rgba(16, 185, 129, 0.1)', color: '#34d399' },
};

const DEFAULT_STYLE = { borderColor: 'var(--border-dim)', background: 'var(--bg-overlay)', color: 'var(--text-muted)' };

export function StatusBadge({ value }: { value: string }) {
  const style = STATUS_STYLES[value] ?? DEFAULT_STYLE;

  return (
    <span className="badge" style={style}>
      {value}
    </span>
  );
}
