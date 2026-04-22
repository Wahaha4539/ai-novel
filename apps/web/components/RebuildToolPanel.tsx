import { SectionHeader } from './SectionHeader';
import { RebuildResult } from '../types/dashboard';

interface Props {
  selectedProjectId: string;
  loading: boolean;
  rebuildResult: RebuildResult | null;
  onRunRebuild: (dryRun: boolean) => void;
}

export function RebuildToolPanel({ selectedProjectId, loading, rebuildResult, onRunRebuild }: Props) {
  return (
    <article className="panel p-5 animate-fade-in" style={{ animationDelay: '0.2s', animationFillMode: 'both' }}>
      <SectionHeader title="Rebuild 工具" desc="支持 dry-run / 正式执行，显示 diff 摘要与失败统计。" />
      <div className="mt-5 flex flex-wrap gap-3">
        <button className="btn-secondary" disabled={!selectedProjectId || loading} onClick={() => onRunRebuild(true)}>
          Dry Run
        </button>
        <button className="btn" disabled={!selectedProjectId || loading} onClick={() => onRunRebuild(false)}>
          正式 Rebuild
        </button>
      </div>
      {rebuildResult ? (
        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3" style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '12px', border: '1px solid var(--border-light)', boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.5)' }}>
              <div className="text-xs" style={{ color: 'var(--text-dim)' }}>成功章节</div>
              <div className="mt-1 text-xl font-bold" style={{ color: 'var(--accent-cyan)' }}>{rebuildResult.processedChapterCount}</div>
            </div>
            <div className="p-3" style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '12px', border: '1px solid var(--border-light)', boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.5)' }}>
              <div className="text-xs" style={{ color: 'var(--text-dim)' }}>失败章节</div>
              <div className="mt-1 text-xl font-bold" style={{ color: rebuildResult.failedChapterCount ? 'var(--status-err)' : 'var(--text-main)' }}>{rebuildResult.failedChapterCount ?? 0}</div>
            </div>
          </div>
          <div className="space-y-2">
            {Object.entries(rebuildResult.diffSummary ?? {}).map(([key, value]) => (
              <div key={key} className="list-card p-3">
                <div className="font-medium text-white">{key}</div>
                <div className="mt-2 flex gap-4 text-xs font-semibold" style={{ color: 'var(--text-dim)' }}>
                  <span style={{ color: '#fb7185' }}>- deleted {value.deleted}</span>
                  <span style={{ color: '#34d399' }}>+ created {value.created}</span>
                  <span style={{ color: 'var(--accent-cyan)' }}>~ delta {value.delta}</span>
                </div>
              </div>
            ))}
          </div>
          {(rebuildResult.failedChapters?.length ?? 0) > 0 && (
            <div className="p-4" style={{ borderRadius: '12px', border: '1px solid rgba(244, 63, 94, 0.3)', background: 'var(--status-err-bg)' }}>
              <div className="font-medium" style={{ color: '#fb7185' }}>失败章节</div>
              <div className="mt-2 space-y-2 text-xs" style={{ color: '#ffe4e6' }}>
                {rebuildResult.failedChapters?.map((item, index) => (
                  <div key={`${item.chapterNo}-${index}`}>第{item.chapterNo ?? '?'}章：{item.error}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="mt-5 text-sm list-card-empty text-center px-4">
          执行 rebuild 后将在这里显示 diffSummary 与 failedChapters。
        </p>
      )}
    </article>
  );
}
