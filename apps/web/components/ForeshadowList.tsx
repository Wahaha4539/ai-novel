import { SectionHeader } from './SectionHeader';
import { StatusBadge } from './StatusBadge';
import { ForeshadowItem } from '../types/dashboard';

interface Props {
  foreshadowTracks: ForeshadowItem[];
}

export function ForeshadowList({ foreshadowTracks }: Props) {
  return (
    <article className="panel p-5 animate-fade-in" style={{ animationDelay: '0.4s', animationFillMode: 'both' }}>
      <SectionHeader title="ForeshadowTrack" desc="伏笔读取接口与首次/最近出现章节。" />
      <div className="mt-5 space-y-3">
        {foreshadowTracks.length ? (
          foreshadowTracks.map((track) => (
            <div key={track.id} className="list-card text-sm">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="text-white font-medium">{track.title}</span>
                <StatusBadge value={track.reviewStatus ?? track.status} />
                <span className="badge" style={{ background: 'rgba(0,0,0,0.4)', borderColor: 'var(--border-dim)', color: 'var(--text-dim)' }}>{track.foreshadowStatus ?? track.status}</span>
              </div>
              {track.detail ? <div className="mt-2" style={{ color: 'var(--text-main)' }}>{track.detail}</div> : null}
              <div className="mt-3 text-xs flex gap-4" style={{ color: 'var(--text-dim)', borderTop: '1px solid var(--border-dim)', paddingTop: '0.5rem' }}>
                <span>首次出现：<span style={{ color: 'var(--accent-cyan)' }}>第{track.firstSeenChapterNo ?? '—'}章</span></span>
                <span>最近出现：<span style={{ color: 'var(--accent-cyan)' }}>第{track.lastSeenChapterNo ?? '—'}章</span></span>
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
