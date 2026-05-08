import React, { useEffect, useMemo, useState } from 'react';
import { ProjectSummary, TimelineEvent } from '../types/dashboard';
import { TimelineEventFormData, useTimelineActions } from '../hooks/useContinuityActions';

const EMPTY_FORM: TimelineEventFormData = {
  chapterId: '',
  chapterNo: undefined,
  title: '',
  eventTime: '',
  locationName: '',
  participants: [],
  cause: '',
  result: '',
  impactScope: '',
  isPublic: true,
  knownBy: [],
  unknownBy: [],
  eventStatus: 'active',
  sourceType: 'manual',
  metadata: {},
};

const STATUS_VIEW: Record<string, { label: string; hint: string; color: string; background: string; border: string }> = {
  planned: {
    label: '计划',
    hint: '仅作为本章执行目标，尚未被正文确认',
    color: '#a5b4fc',
    background: 'rgba(99,102,241,0.13)',
    border: 'rgba(129,140,248,0.34)',
  },
  active: {
    label: '已确认',
    hint: '已可作为后续召回事实约束',
    color: '#34d399',
    background: 'rgba(16,185,129,0.12)',
    border: 'rgba(52,211,153,0.34)',
  },
  changed: {
    label: '已修正',
    hint: '计划与正文不一致，已按正文证据修正',
    color: '#38bdf8',
    background: 'rgba(14,165,233,0.12)',
    border: 'rgba(56,189,248,0.34)',
  },
  archived: {
    label: '已归档',
    hint: '不再参与后续章节事实召回',
    color: '#cbd5e1',
    background: 'rgba(148,163,184,0.11)',
    border: 'rgba(203,213,225,0.26)',
  },
};

const SOURCE_LABELS: Record<string, string> = {
  manual: '人工维护',
  agent_continuity: '连续性修复',
  agent_timeline_plan: '规划生成',
  agent_timeline_alignment: '正文对齐',
  chapter_generation: '章节生成',
  imported_asset: '导入资产',
};

const ACTION_LABELS: Record<string, string> = {
  create_planned: '新增计划',
  confirm_planned: '计划确认',
  update_event: '正文修正',
  archive_event: '归档计划',
  create_discovered: '正文发现',
};

const DIFF_VIEW: Record<string, { label: string; hint: string; color: string; background: string; border: string }> = {
  create_planned: {
    label: '计划目标',
    hint: '来自规划阶段，等待正文确认',
    color: '#a5b4fc',
    background: 'rgba(99,102,241,0.12)',
    border: 'rgba(129,140,248,0.30)',
  },
  confirm_planned: {
    label: '正文已确认',
    hint: '计划事件已被正文证据确认',
    color: '#34d399',
    background: 'rgba(16,185,129,0.12)',
    border: 'rgba(52,211,153,0.32)',
  },
  update_event: {
    label: '正文修正',
    hint: '正文证据与原计划不同，已产生修正',
    color: '#38bdf8',
    background: 'rgba(14,165,233,0.12)',
    border: 'rgba(56,189,248,0.32)',
  },
  archive_event: {
    label: '归档',
    hint: '计划被废弃或被新事件替代',
    color: '#cbd5e1',
    background: 'rgba(148,163,184,0.10)',
    border: 'rgba(203,213,225,0.24)',
  },
  create_discovered: {
    label: '正文发现',
    hint: '正文出现计划外关键事件',
    color: '#fbbf24',
    background: 'rgba(245,158,11,0.11)',
    border: 'rgba(251,191,36,0.30)',
  },
};

interface Props {
  selectedProject?: ProjectSummary;
  selectedProjectId: string;
}

export function TimelinePanel({ selectedProject, selectedProjectId }: Props) {
  const [editingEvent, setEditingEvent] = useState<TimelineEvent | null>(null);
  const [form, setForm] = useState<TimelineEventFormData>(EMPTY_FORM);
  const [participantsText, setParticipantsText] = useState('');
  const [knownByText, setKnownByText] = useState('');
  const [unknownByText, setUnknownByText] = useState('');
  const [metadataText, setMetadataText] = useState('{}');
  const [localError, setLocalError] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [visibilityFilter, setVisibilityFilter] = useState<'all' | 'public' | 'hidden'>('all');

  const {
    timelineEvents,
    loading,
    formLoading,
    error,
    setError,
    loadTimelineEvents,
    createTimelineEvent,
    updateTimelineEvent,
    deleteTimelineEvent,
  } = useTimelineActions(selectedProjectId);

  useEffect(() => {
    if (selectedProjectId) {
      void loadTimelineEvents();
    }
  }, [loadTimelineEvents, selectedProjectId]);

  const visibleEvents = useMemo(() => {
    return timelineEvents
      .filter((event) => {
        if (statusFilter !== 'all' && event.eventStatus !== statusFilter) return false;
        if (visibilityFilter === 'public' && !event.isPublic) return false;
        if (visibilityFilter === 'hidden' && event.isPublic) return false;
        return true;
      })
      .slice()
      .sort((a, b) => {
        const chapterDelta = (a.chapterNo ?? Number.MAX_SAFE_INTEGER) - (b.chapterNo ?? Number.MAX_SAFE_INTEGER);
        if (chapterDelta !== 0) return chapterDelta;
        return (a.eventTime ?? '').localeCompare(b.eventTime ?? '');
      });
  }, [statusFilter, timelineEvents, visibilityFilter]);

  const statusOptions = useMemo(() => {
    return Array.from(new Set(['active', 'planned', 'changed', 'archived', ...timelineEvents.map((item) => item.eventStatus).filter(Boolean)]));
  }, [timelineEvents]);

  const statusCounts = useMemo(() => {
    return statusOptions.map((status) => ({
      status,
      count: timelineEvents.filter((event) => event.eventStatus === status).length,
      view: statusView(status),
    }));
  }, [statusOptions, timelineEvents]);

  const resetForm = () => {
    setEditingEvent(null);
    setForm(EMPTY_FORM);
    setParticipantsText('');
    setKnownByText('');
    setUnknownByText('');
    setMetadataText('{}');
    setLocalError('');
    setError('');
  };

  const openEdit = (event: TimelineEvent) => {
    setEditingEvent(event);
    setForm({
      chapterId: event.chapterId ?? '',
      chapterNo: event.chapterNo ?? undefined,
      title: event.title,
      eventTime: event.eventTime ?? '',
      locationName: event.locationName ?? '',
      participants: asStringArray(event.participants),
      cause: event.cause ?? '',
      result: event.result ?? '',
      impactScope: event.impactScope ?? '',
      isPublic: event.isPublic,
      knownBy: asStringArray(event.knownBy),
      unknownBy: asStringArray(event.unknownBy),
      eventStatus: event.eventStatus,
      sourceType: event.sourceType,
      metadata: event.metadata ?? {},
    });
    setParticipantsText(asStringArray(event.participants).join(', '));
    setKnownByText(asStringArray(event.knownBy).join(', '));
    setUnknownByText(asStringArray(event.unknownBy).join(', '));
    setMetadataText(JSON.stringify(event.metadata ?? {}, null, 2));
    setLocalError('');
    setError('');
  };

  const updateField = <K extends keyof TimelineEventFormData>(key: K, value: TimelineEventFormData[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = async () => {
    setLocalError('');

    const title = form.title.trim();
    if (!title) {
      setLocalError('事件标题不能为空。');
      return;
    }

    let metadata: Record<string, unknown>;
    try {
      metadata = parseJsonObject(metadataText);
    } catch (parseError) {
      setLocalError(parseError instanceof Error ? parseError.message : 'metadata 不是有效 JSON 对象。');
      return;
    }

    const payload: TimelineEventFormData = {
      chapterId: optionalText(form.chapterId, Boolean(editingEvent)),
      chapterNo: normalizeOptionalNumber(form.chapterNo, Boolean(editingEvent)),
      title,
      eventTime: optionalText(form.eventTime, Boolean(editingEvent)),
      locationName: optionalText(form.locationName, Boolean(editingEvent)),
      participants: parseCsvList(participantsText),
      cause: optionalText(form.cause, Boolean(editingEvent)),
      result: optionalText(form.result, Boolean(editingEvent)),
      impactScope: optionalText(form.impactScope, Boolean(editingEvent)),
      isPublic: form.isPublic,
      knownBy: parseCsvList(knownByText),
      unknownBy: parseCsvList(unknownByText),
      eventStatus: optionalText(form.eventStatus) ?? 'active',
      sourceType: optionalText(form.sourceType) ?? 'manual',
      metadata,
    };

    const ok = editingEvent
      ? await updateTimelineEvent(editingEvent.id, payload)
      : await createTimelineEvent(payload);
    if (!ok) return;

    await loadTimelineEvents();
    resetForm();
  };

  const handleDelete = async (event: TimelineEvent) => {
    if (!window.confirm(`删除时间线事件「${event.title}」？`)) return;

    const deleted = await deleteTimelineEvent(event.id);
    if (!deleted) return;

    await loadTimelineEvents();
    if (editingEvent?.id === event.id) resetForm();
  };

  const selectedAudit = editingEvent ? readTimelineAudit(editingEvent) : null;

  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      <header className="flex items-center justify-between shrink-0" style={{ height: '3.5rem', background: 'var(--bg-editor-header)', padding: '0 2rem', borderBottom: '1px solid var(--border-light)', backdropFilter: 'blur(12px)', zIndex: 10 }}>
        <div className="flex items-center gap-3">
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#6366f1', boxShadow: '0 0 10px rgba(99,102,241,0.5)' }} />
          <h1 className="text-lg font-bold text-heading">时间线</h1>
          <span className="badge" style={{ background: 'rgba(99,102,241,0.12)', color: '#818cf8', border: 'none' }}>Timeline</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>{selectedProject?.title ?? '未选择项目'}</div>
          <button className="btn-secondary" onClick={loadTimelineEvents} disabled={loading || formLoading} style={{ fontSize: '0.75rem' }}>刷新</button>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3 shrink-0" style={{ padding: '0.75rem 2rem', borderBottom: '1px solid var(--border-dim)', background: 'var(--bg-card)' }}>
        <div className="flex flex-wrap items-center gap-2">
          {(['all', 'public', 'hidden'] as const).map((item) => (
            <button
              key={item}
              onClick={() => setVisibilityFilter(item)}
              style={{
                fontSize: '0.72rem',
                padding: '0.25rem 0.55rem',
                borderRadius: '0.45rem',
                border: visibilityFilter === item ? '1px solid #6366f1' : '1px solid var(--border-dim)',
                background: visibilityFilter === item ? 'rgba(99,102,241,0.16)' : 'transparent',
                color: visibilityFilter === item ? '#818cf8' : 'var(--text-muted)',
                cursor: 'pointer',
              }}
            >
              {item === 'all' ? '全部' : item === 'public' ? '公开事件' : '隐藏事件'}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {statusCounts.map(({ status, count, view }) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              title={view.hint}
              style={{
                fontSize: '0.68rem',
                padding: '0.25rem 0.55rem',
                borderRadius: '0.45rem',
                border: statusFilter === status ? `1px solid ${view.border}` : '1px solid var(--border-dim)',
                background: statusFilter === status ? view.background : 'transparent',
                color: statusFilter === status ? view.color : 'var(--text-muted)',
                cursor: 'pointer',
              }}
            >
              {view.label} {count}
            </button>
          ))}
        </div>
        <select className="input-field" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} style={{ width: '11rem', fontSize: '0.75rem', padding: '0.45rem 0.75rem' }}>
          <option value="all">全部状态</option>
          {statusOptions.map((status) => (
            <option key={status} value={status}>{statusView(status).label} / {status}</option>
          ))}
        </select>
      </div>

      <div className="grid flex-1 min-h-0" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(21rem, 1fr))', gap: '1rem', padding: '1.25rem 1.5rem', overflow: 'hidden' }}>
        <section className="panel flex flex-col min-h-0" style={{ overflow: 'hidden' }}>
          <div className="flex items-center justify-between shrink-0 p-4" style={{ borderBottom: '1px solid var(--border-dim)' }}>
            <div>
              <h2 className="text-base font-bold text-heading">事件序列</h2>
              <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{visibleEvents.length} / {timelineEvents.length} 条</p>
            </div>
            <button className="btn-secondary" onClick={resetForm} disabled={formLoading}>新建</button>
          </div>

          <div className="flex-1 min-h-0" style={{ overflowY: 'auto' }}>
            {loading ? (
              <div className="p-4 text-sm" style={{ color: 'var(--text-dim)' }}>加载中…</div>
            ) : visibleEvents.length === 0 ? (
              <div className="p-4 text-sm" style={{ color: 'var(--text-dim)' }}>暂无时间线事件</div>
            ) : (
              <div className="space-y-2 p-3">
                {visibleEvents.map((event) => {
                  const eventStatus = statusView(event.eventStatus);
                  const audit = readTimelineAudit(event);
                  const diff = differenceView(event, audit);
                  const participants = asStringArray(event.participants);
                  return (
                    <button key={event.id} onClick={() => openEdit(event)} className="w-full text-left" style={{ border: `1px solid ${editingEvent?.id === event.id ? '#6366f1' : 'var(--border-dim)'}`, background: editingEvent?.id === event.id ? 'rgba(99,102,241,0.12)' : 'var(--bg-card)', borderRadius: '0.5rem', padding: '0.9rem', cursor: 'pointer' }}>
                      <div className="flex items-start justify-between gap-3">
                        <strong className="text-sm" style={{ color: 'var(--text-main)', overflowWrap: 'anywhere' }}>{event.title}</strong>
                        <span className="badge" style={{ background: event.isPublic ? 'rgba(16,185,129,0.12)' : 'rgba(245,158,11,0.12)', borderColor: event.isPublic ? 'rgba(16,185,129,0.35)' : 'rgba(245,158,11,0.35)', color: event.isPublic ? '#34d399' : '#fbbf24', fontSize: '0.62rem', whiteSpace: 'nowrap' }}>{event.isPublic ? 'public' : 'hidden'}</span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1">
                        <span className="badge" title={eventStatus.hint} style={{ fontSize: '0.62rem', color: eventStatus.color, background: eventStatus.background, borderColor: eventStatus.border }}>{eventStatus.label}</span>
                        <span className="badge" title={diff.hint} style={{ fontSize: '0.62rem', color: diff.color, background: diff.background, borderColor: diff.border }}>{diff.label}</span>
                        {event.chapterNo != null ? <span className="badge" style={{ fontSize: '0.62rem' }}>Ch.{event.chapterNo}</span> : null}
                        {event.eventTime ? <span className="badge" style={{ fontSize: '0.62rem' }}>{event.eventTime}</span> : null}
                        {event.locationName ? <span className="badge" style={{ fontSize: '0.62rem' }}>{event.locationName}</span> : null}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--text-dim)' }}>
                        <span>来源：{timelineSourceLabel(event.sourceType)}</span>
                        {audit.action ? <span>动作：{audit.actionLabel}</span> : null}
                        {audit.toolName ? <span>工具：{audit.toolName}</span> : null}
                      </div>
                      {participants.length ? <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>参与：{participants.join('、')}</p> : null}
                      {event.result ? <p className="mt-1 text-xs" style={{ color: 'var(--text-dim)' }}>结果：{event.result}</p> : null}
                      {audit.evidence ? <p className="mt-1 text-xs" style={{ color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>证据：{audit.evidence}</p> : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="panel flex flex-col min-h-0" style={{ overflow: 'hidden' }}>
          <div className="flex items-center justify-between shrink-0 p-4" style={{ borderBottom: '1px solid var(--border-dim)' }}>
            <h2 className="text-base font-bold text-heading">{editingEvent ? '编辑事件' : '新建事件'}</h2>
            {editingEvent ? <button className="btn-danger" onClick={() => handleDelete(editingEvent)} disabled={formLoading}>删除</button> : null}
          </div>

          <div className="flex-1 min-h-0 p-4 space-y-3" style={{ overflowY: 'auto' }}>
            {editingEvent && selectedAudit ? <TimelineAuditBlock event={editingEvent} audit={selectedAudit} /> : null}

            <Field label="事件标题">
              <input className="input-field" value={form.title} onChange={(event) => updateField('title', event.target.value)} />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="章节 ID">
                <input className="input-field" value={form.chapterId ?? ''} onChange={(event) => updateField('chapterId', event.target.value)} />
              </Field>
              <Field label="章节号">
                <input className="input-field" type="number" min={1} value={form.chapterNo ?? ''} onChange={(event) => updateField('chapterNo', event.target.value ? Number(event.target.value) : undefined)} />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="事件时间">
                <input className="input-field" value={form.eventTime ?? ''} onChange={(event) => updateField('eventTime', event.target.value)} placeholder="第七日傍晚 / 1024-03" />
              </Field>
              <Field label="地点">
                <input className="input-field" value={form.locationName ?? ''} onChange={(event) => updateField('locationName', event.target.value)} />
              </Field>
            </div>

            <Field label="参与者">
              <input className="input-field" value={participantsText} onChange={(event) => setParticipantsText(event.target.value)} placeholder="林舟, 许青, 白榆" />
            </Field>

            <Field label="原因">
              <textarea className="input-field" value={form.cause ?? ''} onChange={(event) => updateField('cause', event.target.value)} style={{ minHeight: '5rem', resize: 'vertical' }} />
            </Field>

            <Field label="结果">
              <textarea className="input-field" value={form.result ?? ''} onChange={(event) => updateField('result', event.target.value)} style={{ minHeight: '5rem', resize: 'vertical' }} />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="影响范围">
                <input className="input-field" value={form.impactScope ?? ''} onChange={(event) => updateField('impactScope', event.target.value)} placeholder="chapter / volume / arc" />
              </Field>
              <Field label="事件状态">
                <input className="input-field" value={form.eventStatus} onChange={(event) => updateField('eventStatus', event.target.value)} placeholder="active" />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="已知于">
                <input className="input-field" value={knownByText} onChange={(event) => setKnownByText(event.target.value)} placeholder="角色名列表" />
              </Field>
              <Field label="未知于">
                <input className="input-field" value={unknownByText} onChange={(event) => setUnknownByText(event.target.value)} placeholder="角色名列表" />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="flex items-center gap-2 text-xs font-bold" style={{ color: 'var(--text-muted)' }}>
                <input type="checkbox" checked={form.isPublic} onChange={(event) => updateField('isPublic', event.target.checked)} />
                公开事件
              </label>
              <Field label="来源类型">
                <input className="input-field" value={form.sourceType} onChange={(event) => updateField('sourceType', event.target.value)} placeholder="manual" />
              </Field>
            </div>

            <Field label="metadata JSON">
              <textarea className="input-field font-mono" value={metadataText} onChange={(event) => setMetadataText(event.target.value)} style={{ minHeight: '7rem', resize: 'vertical', fontSize: '0.78rem', lineHeight: 1.5 }} />
            </Field>

            {(localError || error) ? (
              <div className="text-xs" style={{ color: 'var(--status-err)', background: 'var(--status-err-bg)', borderRadius: '0.5rem', padding: '0.6rem' }}>{localError || error}</div>
            ) : null}
          </div>

          <div className="flex justify-end gap-3 shrink-0 p-4" style={{ borderTop: '1px solid var(--border-dim)' }}>
            <button className="btn-secondary" onClick={resetForm} disabled={formLoading}>重置</button>
            <button className="btn" onClick={handleSubmit} disabled={formLoading}>{formLoading ? '保存中…' : '保存'}</button>
          </div>
        </section>
      </div>
    </article>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-bold mb-1" style={{ color: 'var(--text-muted)' }}>{label}</span>
      {children}
    </label>
  );
}

function TimelineAuditBlock({ event, audit }: { event: TimelineEvent; audit: TimelineAudit }) {
  const eventStatus = statusView(event.eventStatus);
  const diff = differenceView(event, audit);
  return (
    <div className="space-y-3" style={{ border: '1px solid var(--border-dim)', borderLeft: `3px solid ${eventStatus.color}`, borderRadius: '0.5rem', padding: '0.75rem', background: 'rgba(15,23,42,0.18)' }}>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(8.5rem, 1fr))' }}>
        <AuditMetric label="状态" value={eventStatus.label} detail={eventStatus.hint} color={eventStatus.color} />
        <AuditMetric label="差异" value={diff.label} detail={diff.hint} color={diff.color} />
        <AuditMetric label="来源" value={timelineSourceLabel(event.sourceType)} detail={audit.sourceKind ?? '未记录 sourceKind'} />
      </div>

      <div className="flex flex-wrap gap-2 text-xs" style={{ color: 'var(--text-dim)' }}>
        {audit.action ? <span>动作：{audit.actionLabel}</span> : null}
        {audit.toolName ? <span>工具：{audit.toolName}</span> : null}
        {audit.candidateId ? <span>候选：{shortId(audit.candidateId)}</span> : null}
        {audit.draftId ? <span>草稿：{shortId(audit.draftId)}</span> : null}
        {audit.previousTimelineEventId ? <span>原事件：{shortId(audit.previousTimelineEventId)}</span> : null}
        {audit.planVersion != null ? <span>计划版本：{audit.planVersion}</span> : null}
      </div>

      {audit.contextSources.length ? (
        <div className="flex flex-wrap gap-2">
          {audit.contextSources.slice(0, 4).map((source, index) => (
            <span key={`${source.sourceType}-${source.sourceId ?? index}`} className="badge" style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>
              {source.sourceType}{source.chapterNo != null ? `@Ch.${source.chapterNo}` : ''}{source.title ? ` · ${source.title}` : source.sourceId ? ` · ${shortId(source.sourceId)}` : ''}
            </span>
          ))}
        </div>
      ) : null}

      {audit.evidence ? (
        <p className="text-xs leading-5" style={{ color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>来源证据：{audit.evidence}</p>
      ) : null}

      {audit.validationStatus ? (
        <div className="text-xs leading-5" style={{ color: audit.validationStatus === 'failed' ? '#fb7185' : audit.validationIssueCount ? '#fbbf24' : '#34d399' }}>
          校验：{audit.validationStatus}，问题 {audit.validationIssueCount ?? 0} 个
          {audit.validationErrors.length ? `；错误：${audit.validationErrors.slice(0, 2).join('；')}` : ''}
          {audit.validationWarnings.length ? `；警告：${audit.validationWarnings.slice(0, 2).join('；')}` : ''}
        </div>
      ) : null}
    </div>
  );
}

function AuditMetric({ label, value, detail, color }: { label: string; value: string; detail?: string; color?: string }) {
  return (
    <div>
      <div className="text-[11px] font-bold" style={{ color: 'var(--text-dim)' }}>{label}</div>
      <div className="text-sm font-bold" style={{ color: color ?? 'var(--text-main)' }}>{value}</div>
      {detail ? <div className="text-[11px] leading-4" style={{ color: 'var(--text-dim)' }}>{detail}</div> : null}
    </div>
  );
}

type TimelineAudit = {
  action?: string;
  actionLabel?: string;
  sourceKind?: string;
  toolName?: string;
  candidateId?: string;
  draftId?: string;
  previousTimelineEventId?: string;
  planVersion?: number;
  evidence?: string;
  validationStatus?: string;
  validationIssueCount?: number;
  validationErrors: string[];
  validationWarnings: string[];
  contextSources: Array<{
    sourceType: string;
    sourceId?: string;
    title?: string;
    chapterNo?: number;
  }>;
};

function statusView(status?: string | null) {
  if (status && STATUS_VIEW[status]) return STATUS_VIEW[status];
  return {
    label: status || '未标注',
    hint: '自定义状态，需查看 metadata 确认语义',
    color: 'var(--text-muted)',
    background: 'rgba(148,163,184,0.10)',
    border: 'rgba(148,163,184,0.24)',
  };
}

function differenceView(event: TimelineEvent, audit: TimelineAudit) {
  if (audit.action && DIFF_VIEW[audit.action]) return DIFF_VIEW[audit.action];
  if (event.eventStatus === 'planned') return DIFF_VIEW.create_planned;
  if (event.eventStatus === 'changed') return DIFF_VIEW.update_event;
  if (event.eventStatus === 'archived') return DIFF_VIEW.archive_event;
  if (event.sourceType === 'agent_timeline_alignment' || event.sourceType === 'chapter_generation') return DIFF_VIEW.confirm_planned;
  return {
    label: '事实约束',
    hint: '已维护为可召回时间线事实',
    color: '#34d399',
    background: 'rgba(16,185,129,0.10)',
    border: 'rgba(52,211,153,0.28)',
  };
}

function timelineSourceLabel(sourceType?: string | null) {
  return sourceType ? SOURCE_LABELS[sourceType] ?? sourceType : '未知来源';
}

function readTimelineAudit(event: TimelineEvent): TimelineAudit {
  const metadata = readRecord(event.metadata) ?? {};
  const trace = readRecord(metadata.sourceTrace);
  const validation = readRecord(metadata.validation);
  const action = readString(metadata.candidateAction) ?? readString(trace?.candidateAction);
  const contextSources = asArray(trace?.contextSources)
    .map((source) => readRecord(source))
    .filter((source): source is Record<string, unknown> => Boolean(source))
    .map((source) => ({
      sourceType: readString(source.sourceType) ?? 'source',
      sourceId: readString(source.sourceId),
      title: readString(source.title),
      chapterNo: readNumber(source.chapterNo),
    }));

  return {
    action,
    actionLabel: action ? ACTION_LABELS[action] ?? action : undefined,
    sourceKind: readString(metadata.sourceKind) ?? readString(trace?.sourceKind),
    toolName: readString(trace?.toolName) ?? readString(trace?.originTool),
    candidateId: readString(metadata.candidateId) ?? readString(trace?.candidateId),
    draftId: readString(trace?.draftId),
    previousTimelineEventId: readString(metadata.previousTimelineEventId),
    planVersion: readNumber(trace?.planVersion),
    evidence: readString(trace?.evidence),
    validationStatus: readString(validation?.status),
    validationIssueCount: readNumber(validation?.issueCount),
    validationErrors: asStringArray(validation?.errors),
    validationWarnings: asStringArray(validation?.warnings),
    contextSources,
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function shortId(value: string) {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function optionalText(value?: string | null, nullWhenEmpty = false) {
  const trimmed = value?.trim();
  return trimmed || (nullWhenEmpty ? null : undefined);
}

function normalizeOptionalNumber(value?: number | null, nullWhenEmpty = false) {
  return Number.isFinite(value) ? value as number : nullWhenEmpty ? null : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean) : [];
}

function parseCsvList(value: string) {
  return Array.from(new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean)));
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = value.trim() ? JSON.parse(value) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('metadata 必须是 JSON 对象。');
  }
  return parsed as Record<string, unknown>;
}
