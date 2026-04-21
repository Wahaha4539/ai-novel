import { SectionHeader } from './SectionHeader';
import { StatusBadge } from './StatusBadge';
import { ValidationIssue } from '../types/dashboard';

interface Props {
  validationIssues: ValidationIssue[];
}

export function ValidationIssueList({ validationIssues }: Props) {
  return (
    <article className="panel p-5">
      <SectionHeader title="ValidationIssue" desc="当前项目/章节的结构化事实校验结果。" />
      <div className="mt-5 space-y-3">
        {validationIssues.length ? (
          validationIssues.map((issue, index) => (
            <div key={`${issue.issueType}-${index}`} className="list-card text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge value={issue.severity} />
                <span className="text-white font-medium">{issue.issueType}</span>
              </div>
              <div className="mt-2 text-slate-300">{issue.message}</div>
              {issue.suggestion ? <div className="mt-2 text-xs text-slate-500">建议：{issue.suggestion}</div> : null}
            </div>
          ))
        ) : (
          <div className="list-card-empty">当前范围暂无校验问题。</div>
        )}
      </div>
    </article>
  );
}
