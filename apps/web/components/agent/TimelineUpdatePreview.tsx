'use client';

import { asArray, asRecord, numberValue, textValue } from './AgentSharedWidgets';

const ACTION_VIEW: Record<string, { label: string; tone: string; background: string; border: string; description: string }> = {
  create_planned: {
    label: '计划新增',
    tone: '#a5b4fc',
    background: 'rgba(99,102,241,0.11)',
    border: 'rgba(129,140,248,0.30)',
    description: '新增未确认的计划事件',
  },
  confirm_planned: {
    label: '确认计划',
    tone: '#34d399',
    background: 'rgba(16,185,129,0.11)',
    border: 'rgba(52,211,153,0.30)',
    description: '正文证据确认 planned 事件',
  },
  update_event: {
    label: '正文修正',
    tone: '#38bdf8',
    background: 'rgba(14,165,233,0.11)',
    border: 'rgba(56,189,248,0.30)',
    description: '用正文证据更新已有事件',
  },
  archive_event: {
    label: '归档',
    tone: '#cbd5e1',
    background: 'rgba(148,163,184,0.10)',
    border: 'rgba(203,213,225,0.24)',
    description: '归档不再参与召回的计划',
  },
  create_discovered: {
    label: '正文发现',
    tone: '#fbbf24',
    background: 'rgba(245,158,11,0.11)',
    border: 'rgba(251,191,36,0.30)',
    description: '新增计划外正文事件',
  },
  reject: {
    label: '拒绝写入',
    tone: '#fb7185',
    background: 'rgba(251,113,133,0.09)',
    border: 'rgba(251,113,133,0.30)',
    description: '校验未通过，不会写入',
  },
};

const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  eventTime: '事件时间',
  locationName: '地点',
  participants: '参与者',
  cause: '原因',
  result: '结果',
  impactScope: '影响范围',
  isPublic: '公开性',
  knownBy: '已知于',
  unknownBy: '未知于',
  eventStatus: '状态',
  sourceType: '来源类型',
  chapterId: '章节 ID',
  chapterNo: '章节号',
  metadata: 'metadata',
};

type TimelineUpdatePreviewProps = {
  entries: unknown[];
  maxItems?: number;
  emptyText?: string;
};

export function TimelineUpdatePreview({ entries, maxItems = 8, emptyText = '暂无时间线写入前 diff。' }: TimelineUpdatePreviewProps) {
  if (!entries.length) {
    return <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{emptyText}</div>;
  }

  return (
    <div className="space-y-2">
      {entries.slice(0, maxItems).map((item, index) => {
        const entry = asRecord(item);
        const action = textValue(entry?.action, 'reject');
        const actionView = actionViewFor(action);
        const before = asRecord(entry?.before);
        const after = asRecord(entry?.after);
        const fieldDiff = asRecord(entry?.fieldDiff);
        const diffFields = Object.entries(fieldDiff ?? {})
          .filter(([, changed]) => changed === true)
          .map(([field]) => field);
        const sourceTrace = asRecord(entry?.sourceTrace ?? asRecord(after?.metadata)?.sourceTrace);
        const reason = textValue(entry?.reason, '');
        const rejected = action === 'reject' || !after;

        return (
          <section key={textValue(entry?.candidateId, `timeline-diff-${index}`)} className="rounded-lg border p-3" style={{ borderColor: actionView.border, background: rejected ? ACTION_VIEW.reject.background : 'rgba(15,23,42,0.18)' }}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-xs font-bold leading-5" style={{ color: 'var(--text-main)' }}>{textValue(entry?.label, textValue(after?.title ?? before?.title, '未命名事件'))}</div>
                <div className="text-xs leading-5" style={{ color: 'var(--text-dim)' }}>
                  {chapterLabel(entry, after, before)} · {textValue(entry?.candidateId, `candidate-${index + 1}`)}
                </div>
              </div>
              <span className="px-2 py-1 text-[11px] font-bold" title={actionView.description} style={{ borderRadius: 999, border: `1px solid ${actionView.border}`, color: actionView.tone, background: actionView.background, whiteSpace: 'nowrap' }}>
                {actionView.label}
              </span>
            </div>

            {reason ? <div className="mt-2 text-xs leading-5" style={{ color: rejected ? '#fb7185' : 'var(--text-muted)' }}>原因：{reason}</div> : null}

            <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))' }}>
              <TimelineSnapshot title="写入前" event={before} muted />
              <TimelineSnapshot title="写入后" event={after} />
            </div>

            <TimelineFieldDiff before={before} after={after} diffFields={diffFields} />
            <TimelineTrace trace={sourceTrace} />
          </section>
        );
      })}
      {entries.length > maxItems && <div className="text-xs" style={{ color: 'var(--text-dim)' }}>还有 {entries.length - maxItems} 条 diff，完整内容见原始 JSON。</div>}
    </div>
  );
}

function TimelineSnapshot({ title, event, muted = false }: { title: string; event?: Record<string, unknown>; muted?: boolean }) {
  if (!event) {
    return (
      <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-dim)', color: 'var(--text-dim)', background: 'rgba(2,6,23,0.12)' }}>
        <div className="text-[11px] font-bold">{title}</div>
        <div className="text-xs leading-5">无对应事件</div>
      </div>
    );
  }

  return (
    <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-dim)', background: muted ? 'rgba(2,6,23,0.12)' : 'rgba(20,184,166,0.06)' }}>
      <div className="text-[11px] font-bold" style={{ color: muted ? 'var(--text-dim)' : '#5eead4' }}>{title}</div>
      <div className="mt-1 space-y-1 text-xs leading-5" style={{ color: 'var(--text-muted)' }}>
        <div><b style={{ color: 'var(--text-main)' }}>{textValue(event.title, '未命名事件')}</b></div>
        <div>{textValue(event.eventStatus, '未标注状态')} · {textValue(event.eventTime, '未标注时间')}</div>
        <div>{textValue(event.locationName, '未标注地点')} · {textValue(event.sourceType, '未标注来源')}</div>
      </div>
    </div>
  );
}

function TimelineFieldDiff({ before, after, diffFields }: { before?: Record<string, unknown>; after?: Record<string, unknown>; diffFields: string[] }) {
  if (!diffFields.length) {
    return <div className="mt-2 text-xs" style={{ color: 'var(--text-dim)' }}>无字段差异，通常表示拒绝写入或仅记录审计原因。</div>;
  }

  return (
    <div className="mt-3 space-y-1">
      <div className="text-[11px] font-bold" style={{ color: 'var(--text-dim)' }}>字段差异</div>
      {diffFields.slice(0, 6).map((field) => (
        <div key={field} className="grid gap-2 text-xs leading-5" style={{ gridTemplateColumns: '7rem minmax(0, 1fr)', color: 'var(--text-muted)' }}>
          <span style={{ color: '#fbbf24' }}>{FIELD_LABELS[field] ?? field}</span>
          <span style={{ overflowWrap: 'anywhere' }}>{formatValue(before?.[field])} → {formatValue(after?.[field])}</span>
        </div>
      ))}
      {diffFields.length > 6 ? <div className="text-xs" style={{ color: 'var(--text-dim)' }}>另有 {diffFields.length - 6} 个字段变化。</div> : null}
    </div>
  );
}

function TimelineTrace({ trace }: { trace?: Record<string, unknown> }) {
  const sources = asArray(trace?.contextSources).map((item) => asRecord(item)).filter(Boolean);
  if (!trace && !sources.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <span className="px-2 py-1 text-[11px]" style={{ borderRadius: 999, border: '1px solid rgba(20,184,166,0.28)', color: '#5eead4', background: 'rgba(20,184,166,0.08)' }}>
        {textValue(trace?.sourceKind, 'timeline')} · {textValue(trace?.toolName ?? trace?.originTool, 'unknown_tool')}
      </span>
      {sources.slice(0, 3).map((source, index) => (
        <span key={index} className="px-2 py-1 text-[11px]" style={{ borderRadius: 999, border: '1px solid var(--border-dim)', color: 'var(--text-muted)' }}>
          {textValue(source?.sourceType, 'source')}{source?.chapterNo ? `@第${numberValue(source.chapterNo)}章` : ''}{source?.title ? ` · ${textValue(source.title)}` : ''}
        </span>
      ))}
    </div>
  );
}

function actionViewFor(action: string) {
  return ACTION_VIEW[action] ?? {
    label: action,
    tone: 'var(--text-muted)',
    background: 'rgba(148,163,184,0.09)',
    border: 'rgba(148,163,184,0.24)',
    description: '自定义时间线动作',
  };
}

function chapterLabel(entry?: Record<string, unknown>, after?: Record<string, unknown>, before?: Record<string, unknown>) {
  const chapterNo = numberValue(entry?.chapterNo ?? after?.chapterNo ?? before?.chapterNo, 0);
  return chapterNo ? `第${chapterNo}章` : '未标注章节';
}

function formatValue(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => textValue(item)).filter(Boolean).join('、') || '空';
  if (typeof value === 'boolean') return value ? '公开' : '隐藏';
  if (value == null || value === '') return '空';
  if (typeof value === 'object') return '对象已变化';
  return textValue(value);
}
