export function StatusBadge({ value }: { value: string }) {
  let styleLine = '';

  if (value === 'error' || value === 'rejected') {
    styleLine = 'border-color: rgba(244, 63, 94, 0.4); background: var(--status-err-bg); color: #fb7185;';
  } else if (value === 'warning' || value === 'pending_review') {
    styleLine = 'border-color: rgba(245, 158, 11, 0.4); background: rgba(245, 158, 11, 0.1); color: #fbbf24;';
  } else if (value === 'user_confirmed' || value === 'completed' || value === 'detected') {
    styleLine = 'border-color: rgba(16, 185, 129, 0.4); background: rgba(16, 185, 129, 0.1); color: #34d399;';
  } else {
    styleLine = 'border-color: var(--border-dim); background: rgba(0,0,0,0.4); color: var(--text-muted);';
  }

  return (
    <span 
      className="badge" 
      style={{
        ...(value === 'error' || value === 'rejected' ? { borderColor: 'rgba(244, 63, 94, 0.4)', background: 'var(--status-err-bg)', color: '#fb7185' } : {}),
        ...(value === 'warning' || value === 'pending_review' ? { borderColor: 'rgba(245, 158, 11, 0.4)', background: 'rgba(245, 158, 11, 0.1)', color: '#fbbf24' } : {}),
        ...(value === 'user_confirmed' || value === 'completed' || value === 'detected' ? { borderColor: 'rgba(16, 185, 129, 0.4)', background: 'rgba(16, 185, 129, 0.1)', color: '#34d399' } : {}),
        ...((value !== 'error' && value !== 'rejected' && value !== 'warning' && value !== 'pending_review' && value !== 'user_confirmed' && value !== 'completed' && value !== 'detected') ? { borderColor: 'var(--border-dim)', background: 'rgba(0,0,0,0.4)', color: 'var(--text-muted)' } : {})
      }}
    >
      {value}
    </span>
  );
}
