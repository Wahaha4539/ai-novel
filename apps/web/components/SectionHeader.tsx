import React from 'react';

export function SectionHeader({ title, desc, action }: { title: string; desc: string; action?: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center gap-4">
      <div>
        <h2 className="text-lg font-bold text-white mb-1" style={{ letterSpacing: '0.02em' }}>{title}</h2>
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>{desc}</p>
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}
