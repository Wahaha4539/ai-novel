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
        <select className="input-field" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} style={{ width: '11rem', fontSize: '0.75rem', padding: '0.45rem 0.75rem' }}>
          <option value="all">全部状态</option>
          {statusOptions.map((status) => (
            <option key={status} value={status}>{status}</option>
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
                {visibleEvents.map((event) => (
                  <button key={event.id} onClick={() => openEdit(event)} className="w-full text-left" style={{ border: `1px solid ${editingEvent?.id === event.id ? '#6366f1' : 'var(--border-dim)'}`, background: editingEvent?.id === event.id ? 'rgba(99,102,241,0.12)' : 'var(--bg-card)', borderRadius: '0.5rem', padding: '0.9rem', cursor: 'pointer' }}>
                    <div className="flex items-center justify-between gap-3">
                      <strong className="text-sm truncate" style={{ color: 'var(--text-main)' }}>{event.title}</strong>
                      <span className="badge" style={{ background: event.isPublic ? 'rgba(16,185,129,0.12)' : 'rgba(245,158,11,0.12)', borderColor: event.isPublic ? 'rgba(16,185,129,0.35)' : 'rgba(245,158,11,0.35)', color: event.isPublic ? '#34d399' : '#fbbf24', fontSize: '0.62rem' }}>{event.isPublic ? 'public' : 'hidden'}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      {event.chapterNo != null ? <span className="badge" style={{ fontSize: '0.62rem' }}>Ch.{event.chapterNo}</span> : null}
                      {event.eventTime ? <span className="badge" style={{ fontSize: '0.62rem' }}>{event.eventTime}</span> : null}
                      {event.locationName ? <span className="badge" style={{ fontSize: '0.62rem' }}>{event.locationName}</span> : null}
                      <span className="badge" style={{ fontSize: '0.62rem' }}>{event.eventStatus}</span>
                    </div>
                    {asStringArray(event.participants).length ? <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>参与：{asStringArray(event.participants).join('、')}</p> : null}
                    {event.result ? <p className="mt-1 text-xs" style={{ color: 'var(--text-dim)' }}>结果：{event.result}</p> : null}
                  </button>
                ))}
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
