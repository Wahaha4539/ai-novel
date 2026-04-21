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
    <article className="panel p-5">
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
        <div className="mt-5 space-y-4 text-sm text-slate-300">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3 shadow-inner">
              <div className="text-xs text-slate-500">成功章节</div>
              <div className="mt-1 text-xl font-semibold text-white">{rebuildResult.processedChapterCount}</div>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3 shadow-inner">
              <div className="text-xs text-slate-500">失败章节</div>
              <div className="mt-1 text-xl font-semibold text-white">{rebuildResult.failedChapterCount ?? 0}</div>
            </div>
          </div>
          <div className="space-y-2">
            {Object.entries(rebuildResult.diffSummary ?? {}).map(([key, value]) => (
              <div key={key} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3 transition-colors hover:bg-slate-900/80">
                <div className="font-medium text-white">{key}</div>
                <div className="mt-1 text-xs text-slate-400">
                  deleted {value.deleted} / created {value.created} / delta {value.delta}
                </div>
              </div>
            ))}
          </div>
          {(rebuildResult.failedChapters?.length ?? 0) > 0 && (
            <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-4">
              <div className="font-medium text-rose-200">失败章节</div>
              <div className="mt-2 space-y-2 text-xs text-rose-100">
                {rebuildResult.failedChapters?.map((item, index) => (
                  <div key={`${item.chapterNo}-${index}`}>第{item.chapterNo ?? '?'}章：{item.error}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="mt-5 text-sm text-slate-500 flex h-24 items-center justify-center rounded-2xl border border-dashed border-slate-800">
          执行 rebuild 后将在这里显示 diffSummary 与 failedChapters。
        </p>
      )}
    </article>
  );
}
