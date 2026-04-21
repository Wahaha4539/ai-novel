import { SectionHeader } from './SectionHeader';
import { StatusBadge } from './StatusBadge';
import { ValidationRunResult } from '../types/dashboard';

interface Props {
  selectedProjectId: string;
  loading: boolean;
  validationRunResult: ValidationRunResult | null;
  onRunValidation: () => void;
}

export function ValidationConsolePanel({ selectedProjectId, loading, validationRunResult, onRunValidation }: Props) {
  return (
    <article className="panel p-5">
      <SectionHeader title="事实校验器" desc="运行 Phase 4 前置硬规则：时间线、死亡角色、伏笔首次出现。" />
      <div className="mt-5 flex flex-wrap gap-3">
        <button className="btn" disabled={!selectedProjectId || loading} onClick={onRunValidation}>
          运行硬规则校验
        </button>
      </div>
      {validationRunResult ? (
        <div className="mt-5 space-y-3 text-sm text-slate-300">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3 shadow-inner">
              <div className="text-xs text-slate-500">新增问题</div>
              <div className="mt-1 text-xl font-semibold text-white">{validationRunResult.createdCount}</div>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3 shadow-inner">
              <div className="text-xs text-slate-500">替换旧问题</div>
              <div className="mt-1 text-xl font-semibold text-white">{validationRunResult.deletedCount}</div>
            </div>
          </div>
          <div className="space-y-2">
            {validationRunResult.issues.slice(0, 5).map((issue, index) => (
              <div key={`${issue.issueType}-${index}`} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3 transition-colors hover:bg-slate-900/80">
                <div className="flex items-center gap-2">
                  <StatusBadge value={issue.severity} />
                  <span className="text-white">{issue.issueType}</span>
                </div>
                <div className="mt-2 text-slate-300">{issue.message}</div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-5 text-sm text-slate-500 flex h-24 items-center justify-center rounded-2xl border border-dashed border-slate-800">
          运行后将展示本轮校验生成的问题摘要。
        </p>
      )}
    </article>
  );
}
