import { SectionHeader } from './SectionHeader';
import { StatusBadge } from './StatusBadge';
import { CharacterStateItem } from '../types/dashboard';

interface Props {
  characterStates: CharacterStateItem[];
}

export function CharacterStateList({ characterStates }: Props) {
  return (
    <article className="panel p-5">
      <SectionHeader title="CharacterStateSnapshot" desc="角色状态快照与审核状态。" />
      <div className="mt-5 space-y-3">
        {characterStates.length ? (
          characterStates.map((state) => (
            <div key={state.id} className="list-card text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-white font-medium">{state.characterName}</span>
                <StatusBadge value={state.status} />
                <span className="badge border-slate-700 bg-slate-800 text-slate-200">{state.stateType}</span>
              </div>
              <div className="mt-2 text-slate-300">{state.stateValue}</div>
              {state.summary ? <div className="mt-2 text-xs text-slate-500">{state.summary}</div> : null}
            </div>
          ))
        ) : (
          <div className="list-card-empty">暂无 CharacterStateSnapshot 数据。</div>
        )}
      </div>
    </article>
  );
}
