import { SectionHeader } from './SectionHeader';
import { StatusBadge } from './StatusBadge';
import { CharacterStateItem } from '../types/dashboard';

interface Props {
  characterStates: CharacterStateItem[];
}

export function CharacterStateList({ characterStates }: Props) {
  return (
    <article className="panel p-5 animate-fade-in" style={{ animationDelay: '0.3s', animationFillMode: 'both' }}>
      <SectionHeader title="CharacterStateSnapshot" desc="角色状态快照与审核状态。" />
      <div className="mt-5 space-y-3">
        {characterStates.length ? (
          characterStates.map((state) => (
            <div key={state.id} className="list-card text-sm">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="text-heading font-medium">{state.characterName}</span>
                <StatusBadge value={state.status} />
                <span className="badge" style={{ background: 'var(--bg-overlay)', borderColor: 'var(--border-dim)', color: 'var(--text-dim)' }}>{state.stateType}</span>
              </div>
              <div className="mt-2" style={{ color: 'var(--text-main)' }}>{state.stateValue}</div>
              {state.summary ? <div className="mt-3 text-xs" style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-dim)', paddingTop: '0.5rem' }}>{state.summary}</div> : null}
            </div>
          ))
        ) : (
          <div className="list-card-empty">暂无 CharacterStateSnapshot 数据。</div>
        )}
      </div>
    </article>
  );
}
