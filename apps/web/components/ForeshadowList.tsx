import { SectionHeader } from './SectionHeader';
import { StatusBadge } from './StatusBadge';
import { ForeshadowItem } from '../types/dashboard';

interface Props {
  foreshadowTracks: ForeshadowItem[];
}

export function ForeshadowList({ foreshadowTracks }: Props) {
  return (
    <article className="panel p-5">
      <SectionHeader title="ForeshadowTrack" desc="伏笔读取接口与首次/最近出现章节。" />
      <div className="mt-5 space-y-3">
        {foreshadowTracks.length ? (
          foreshadowTracks.map((track) => (
            <div key={track.id} className="list-card text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-white font-medium">{track.title}</span>
                <StatusBadge value={track.reviewStatus ?? track.status} />
                <span className="badge border-slate-700 bg-slate-800 text-slate-200">{track.foreshadowStatus ?? track.status}</span>
              </div>
              {track.detail ? <div className="mt-2 text-slate-300">{track.detail}</div> : null}
              <div className="mt-2 text-xs text-slate-500">
                首次出现：第{track.firstSeenChapterNo ?? '—'}章 · 最近出现：第{track.lastSeenChapterNo ?? '—'}章
              </div>
            </div>
          ))
        ) : (
          <div className="list-card-empty">暂无 ForeshadowTrack 数据。</div>
        )}
      </div>
    </article>
  );
}
