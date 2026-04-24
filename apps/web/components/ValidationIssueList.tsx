import { SectionHeader } from './SectionHeader';
import { ValidationIssue } from '../types/dashboard';

interface Props {
  validationIssues: ValidationIssue[];
  onFixIssues?: (issues: ValidationIssue[]) => void | Promise<void>;
  fixingIssueId?: string;
}

const ISSUE_TYPE_LABELS: Record<string, { title: string; desc: string }> = {
  timeline_conflict: { title: '时间线冲突', desc: '事件顺序或 timelineSeq 可能前后矛盾。' },
  dead_character_appearance: { title: '死亡角色出现', desc: '已死亡角色仍被写入当前事实层。' },
  foreshadow_first_seen_mismatch: { title: '伏笔首次出现不一致', desc: '伏笔首次出现章节与当前事实记录不一致。' },
  foreshadow_range_invalid: { title: '伏笔章节范围异常', desc: '伏笔最近出现章节早于首次出现章节。' },
  spatial_error: { title: '空间位置跳转异常', desc: '场景位置或人物移动路径可能缺少过渡。' },
};

const SEVERITY_LABELS: Record<string, string> = {
  error: '严重',
  warning: '警告',
  info: '提示',
};

/**
 * 将后端规则编码转换成给作者看的问题名称；未知规则保留原始编码，便于排查。
 */
function getIssueMeta(issueType: string) {
  return ISSUE_TYPE_LABELS[issueType] ?? {
    title: issueType.replace(/_/g, ' '),
    desc: '自定义校验规则发现的问题。',
  };
}

/**
 * 根据严重程度返回视觉色值，保证问题卡片在窄侧栏里也能快速扫读。
 */
function getSeverityTone(severity: string) {
  if (severity === 'error') {
    return {
      label: SEVERITY_LABELS.error,
      color: '#fb7185',
      border: 'rgba(244, 63, 94, 0.42)',
      background: 'rgba(244, 63, 94, 0.1)',
      glow: 'rgba(244, 63, 94, 0.18)',
    };
  }

  if (severity === 'warning') {
    return {
      label: SEVERITY_LABELS.warning,
      color: '#fbbf24',
      border: 'rgba(245, 158, 11, 0.42)',
      background: 'rgba(245, 158, 11, 0.1)',
      glow: 'rgba(245, 158, 11, 0.16)',
    };
  }

  return {
    label: SEVERITY_LABELS[severity] ?? severity,
    color: 'var(--accent-cyan)',
    border: 'var(--accent-cyan-glow)',
    background: 'var(--accent-cyan-bg)',
    glow: 'var(--accent-cyan-glow)',
  };
}

/**
 * Keep the loading key aligned with the dashboard hook so cards without a DB id
 * can still display the correct in-progress state.
 */
function getIssueActionId(issue: ValidationIssue) {
  return issue.id ?? `${issue.issueType}:${issue.chapterId ?? 'project'}:${issue.message}`;
}

/**
 * 校验问题列表：展示问题名称、规则来源、详情和建议，帮助作者定位当前章节的硬规则风险。
 * AI 修复入口按当前列表批量提交，避免逐条修复造成章节正文被多次重写、事实层反复 rebuild。
 */
export function ValidationIssueList({ validationIssues, onFixIssues, fixingIssueId }: Props) {
  const isAnyIssueFixing = Boolean(fixingIssueId);

  return (
    <article className="panel p-5 animate-fade-in" style={{ animationDelay: '0.4s', animationFillMode: 'both', borderColor: validationIssues.length ? 'rgba(245, 158, 11, 0.28)' : undefined }}>
      <SectionHeader
        title="校验问题"
        desc={validationIssues.length ? `发现 ${validationIssues.length} 个需要确认的结构化事实问题。` : '当前项目/章节暂未发现结构化事实问题。'}
        action={
          validationIssues.length ? (
            <span className="badge" style={{ borderColor: 'rgba(245, 158, 11, 0.38)', background: 'rgba(245, 158, 11, 0.1)', color: '#fbbf24' }}>
              {validationIssues.length} 条
            </span>
          ) : null
        }
      />
      {validationIssues.length > 0 && onFixIssues ? (
        <div className="mt-5" style={{ border: '1px solid rgba(6, 182, 212, 0.35)', borderRadius: '14px', background: 'rgba(6,182,212,0.07)', padding: '0.85rem' }}>
          <button
            type="button"
            onClick={() => onFixIssues(validationIssues)}
            disabled={isAnyIssueFixing}
            className="btn"
            style={{
              width: '100%',
              justifyContent: 'center',
              borderColor: isAnyIssueFixing ? 'var(--accent-cyan)' : 'rgba(6, 182, 212, 0.48)',
              background: isAnyIssueFixing
                ? 'linear-gradient(135deg, rgba(6,182,212,0.18), rgba(139,92,246,0.16))'
                : 'rgba(6,182,212,0.1)',
              color: 'var(--accent-cyan)',
              cursor: isAnyIssueFixing ? 'wait' : 'pointer',
            }}
          >
            {isAnyIssueFixing ? '批量修复中…' : `🤖 AI 一键修复全部 ${validationIssues.length} 条`}
          </button>
          {/* 批量入口会把当前范围的问题合并到同一轮 LLM 指令，减少多次改稿造成的新连续性偏差。 */}
          <div className="mt-2 text-xs" style={{ color: 'var(--text-dim)', lineHeight: 1.65 }}>
            将一次性合并当前列表所有问题生成修复稿，并自动重建事实层后复检。
          </div>
        </div>
      ) : null}
      <div className="mt-5 space-y-3">
        {validationIssues.length ? (
          validationIssues.map((issue, index) => {
            const meta = getIssueMeta(issue.issueType);
            const tone = getSeverityTone(issue.severity);
            const issueActionId = getIssueActionId(issue);
            const isFixing = fixingIssueId === issueActionId;

            return (
            <div
              key={issue.id ?? `${issue.issueType}-${index}`}
              className="list-card text-sm"
              style={{
                position: 'relative',
                overflow: 'hidden',
                borderColor: tone.border,
                background: `linear-gradient(135deg, ${tone.background}, var(--bg-card) 48%)`,
                boxShadow: `0 14px 30px -22px ${tone.glow}`,
              }}
            >
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '3px', background: tone.color, opacity: 0.9 }} />

              <div className="flex items-start justify-between gap-3 mb-3">
                <div style={{ minWidth: 0 }}>
                  <div className="text-xs font-semibold mb-1" style={{ color: 'var(--text-dim)', letterSpacing: '0.04em' }}>问题名称</div>
                  <div className="text-white font-bold" style={{ fontSize: '1rem', lineHeight: 1.35 }}>{meta.title}</div>
                </div>
                <span
                  className="badge"
                  style={{
                    flexShrink: 0,
                    borderColor: tone.border,
                    background: tone.background,
                    color: tone.color,
                  }}
                >
                  {tone.label}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2 mb-3">
                <span className="badge" style={{ background: 'var(--bg-overlay)', borderColor: 'var(--border-dim)', color: 'var(--text-dim)', textTransform: 'none' }}>
                  规则：{issue.issueType}
                </span>
                <span className="text-xs" style={{ color: 'var(--text-dim)' }}>{meta.desc}</span>
              </div>

              <div style={{ borderTop: '1px solid var(--border-dim)', paddingTop: '0.75rem' }}>
                <div className="text-xs font-semibold mb-2" style={{ color: 'var(--accent-cyan)', letterSpacing: '0.04em' }}>详情</div>
                <p style={{ color: 'var(--text-muted)', lineHeight: 1.75, margin: 0 }}>{issue.message}</p>
              </div>

              {issue.suggestion ? (
                <div className="mt-3 text-xs" style={{ color: 'var(--text-main)', background: 'var(--bg-overlay)', border: '1px dashed var(--border-light)', borderRadius: '12px', padding: '0.75rem', lineHeight: 1.65 }}>
                  <span style={{ color: 'var(--accent-cyan)', fontWeight: 700 }}>建议：</span>{issue.suggestion}
                </div>
              ) : null}

              {isFixing ? <div className="mt-3 text-xs" style={{ color: 'var(--accent-cyan)' }}>该问题正在批量修复队列中…</div> : null}
            </div>
            );
          })
        ) : (
          <div className="list-card-empty">当前范围暂无校验问题。</div>
        )}
      </div>
    </article>
  );
}
