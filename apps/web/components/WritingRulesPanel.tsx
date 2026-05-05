import React, { useEffect, useMemo, useState } from 'react';
import { ProjectSummary, WritingRule } from '../types/dashboard';
import { useWritingRuleActions, WritingRuleFormData } from '../hooks/useContinuityActions';

const EMPTY_FORM: WritingRuleFormData = {
  ruleType: 'continuity',
  title: '',
  content: '',
  severity: 'warning',
  status: 'active',
  metadata: {},
};

const SEVERITY_STYLES: Record<WritingRule['severity'], { color: string; label: string }> = {
  info: { color: '#38bdf8', label: 'Info' },
  warning: { color: '#f59e0b', label: 'Warning' },
  error: { color: '#f43f5e', label: 'Error' },
};

interface Props {
  selectedProject?: ProjectSummary;
  selectedProjectId: string;
}

export function WritingRulesPanel({ selectedProject, selectedProjectId }: Props) {
  const [editingRule, setEditingRule] = useState<WritingRule | null>(null);
  const [form, setForm] = useState<WritingRuleFormData>(EMPTY_FORM);
  const [metadataText, setMetadataText] = useState('{}');
  const [localError, setLocalError] = useState('');
  const [severityFilter, setSeverityFilter] = useState<'all' | WritingRule['severity']>('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const {
    writingRules,
    loading,
    formLoading,
    error,
    setError,
    loadWritingRules,
    createWritingRule,
    updateWritingRule,
    deleteWritingRule,
  } = useWritingRuleActions(selectedProjectId);

  useEffect(() => {
    if (selectedProjectId) {
      void loadWritingRules();
    }
  }, [loadWritingRules, selectedProjectId]);

  const visibleRules = useMemo(() => {
    return writingRules.filter((rule) => {
      if (severityFilter !== 'all' && rule.severity !== severityFilter) return false;
      if (statusFilter !== 'all' && rule.status !== statusFilter) return false;
      return true;
    });
  }, [severityFilter, statusFilter, writingRules]);

  const statusOptions = useMemo(() => {
    return Array.from(new Set(['active', 'draft', 'archived', ...writingRules.map((rule) => rule.status).filter(Boolean)]));
  }, [writingRules]);

  const resetForm = () => {
    setEditingRule(null);
    setForm(EMPTY_FORM);
    setMetadataText('{}');
    setLocalError('');
    setError('');
  };

  const openEdit = (rule: WritingRule) => {
    setEditingRule(rule);
    setForm({
      ruleType: rule.ruleType,
      title: rule.title,
      content: rule.content,
      severity: rule.severity,
      appliesFromChapterNo: rule.appliesFromChapterNo ?? undefined,
      appliesToChapterNo: rule.appliesToChapterNo ?? undefined,
      entityType: rule.entityType ?? '',
      entityRef: rule.entityRef ?? '',
      status: rule.status,
      metadata: rule.metadata ?? {},
    });
    setMetadataText(JSON.stringify(rule.metadata ?? {}, null, 2));
    setLocalError('');
    setError('');
  };

  const updateField = <K extends keyof WritingRuleFormData>(key: K, value: WritingRuleFormData[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = async () => {
    setLocalError('');

    const title = form.title.trim();
    const content = form.content.trim();
    const ruleType = form.ruleType.trim();
    if (!title || !content || !ruleType) {
      setLocalError('规则类型、标题和正文不能为空。');
      return;
    }

    let metadata: Record<string, unknown>;
    try {
      metadata = parseJsonObject(metadataText);
    } catch (parseError) {
      setLocalError(parseError instanceof Error ? parseError.message : 'metadata 不是有效 JSON 对象。');
      return;
    }

    const payload: WritingRuleFormData = {
      ruleType,
      title,
      content,
      severity: form.severity,
      appliesFromChapterNo: normalizeOptionalNumber(form.appliesFromChapterNo, Boolean(editingRule)),
      appliesToChapterNo: normalizeOptionalNumber(form.appliesToChapterNo, Boolean(editingRule)),
      entityType: optionalText(form.entityType, Boolean(editingRule)),
      entityRef: optionalText(form.entityRef, Boolean(editingRule)),
      status: optionalText(form.status) ?? 'active',
      metadata,
    };

    const ok = editingRule
      ? await updateWritingRule(editingRule.id, payload)
      : await createWritingRule(payload);
    if (!ok) return;

    await loadWritingRules();
    resetForm();
  };

  const handleDelete = async (rule: WritingRule) => {
    if (!window.confirm(`删除写作规则「${rule.title}」？`)) return;

    const deleted = await deleteWritingRule(rule.id);
    if (!deleted) return;

    await loadWritingRules();
    if (editingRule?.id === rule.id) resetForm();
  };

  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      <header className="flex items-center justify-between shrink-0" style={{ height: '3.5rem', background: 'var(--bg-editor-header)', padding: '0 2rem', borderBottom: '1px solid var(--border-light)', backdropFilter: 'blur(12px)', zIndex: 10 }}>
        <div className="flex items-center gap-3">
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#f43f5e', boxShadow: '0 0 10px rgba(244,63,94,0.5)' }} />
          <h1 className="text-lg font-bold text-heading">写作规则</h1>
          <span className="badge" style={{ background: 'rgba(244,63,94,0.12)', color: '#fb7185', border: 'none' }}>Rules</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>{selectedProject?.title ?? '未选择项目'}</div>
          <button className="btn-secondary" onClick={loadWritingRules} disabled={loading || formLoading} style={{ fontSize: '0.75rem' }}>刷新</button>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3 shrink-0" style={{ padding: '0.75rem 2rem', borderBottom: '1px solid var(--border-dim)', background: 'var(--bg-card)' }}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>严重程度</span>
          {(['all', 'info', 'warning', 'error'] as const).map((item) => (
            <FilterButton
              key={item}
              label={item === 'all' ? '全部' : SEVERITY_STYLES[item].label}
              active={severityFilter === item}
              color={item === 'all' ? '#94a3b8' : SEVERITY_STYLES[item].color}
              onClick={() => setSeverityFilter(item)}
            />
          ))}
        </div>
        <select className="input-field" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} style={{ width: '11rem', fontSize: '0.75rem', padding: '0.45rem 0.75rem' }}>
          <option value="all">全部状态</option>
          {statusOptions.map((status) => (
            <option key={status} value={status}>{status}</option>
          ))}
        </select>
      </div>

      <div className="grid flex-1 min-h-0" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(20rem, 1fr))', gap: '1rem', padding: '1.25rem 1.5rem', overflow: 'hidden' }}>
        <section className="panel flex flex-col min-h-0" style={{ overflow: 'hidden' }}>
          <div className="flex items-center justify-between shrink-0 p-4" style={{ borderBottom: '1px solid var(--border-dim)' }}>
            <div>
              <h2 className="text-base font-bold text-heading">规则清单</h2>
              <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{visibleRules.length} / {writingRules.length} 条</p>
            </div>
            <button className="btn-secondary" onClick={resetForm} disabled={formLoading}>新建</button>
          </div>

          <div className="flex-1 min-h-0" style={{ overflowY: 'auto' }}>
            {loading ? (
              <div className="p-4 text-sm" style={{ color: 'var(--text-dim)' }}>加载中…</div>
            ) : visibleRules.length === 0 ? (
              <div className="p-4 text-sm" style={{ color: 'var(--text-dim)' }}>暂无写作规则</div>
            ) : (
              <div className="space-y-2 p-3">
                {visibleRules.map((rule) => {
                  const severity = SEVERITY_STYLES[rule.severity] ?? SEVERITY_STYLES.warning;
                  return (
                    <button key={rule.id} onClick={() => openEdit(rule)} className="w-full text-left" style={{ border: `1px solid ${editingRule?.id === rule.id ? severity.color : 'var(--border-dim)'}`, background: editingRule?.id === rule.id ? `${severity.color}14` : 'var(--bg-card)', borderRadius: '0.5rem', padding: '0.85rem', cursor: 'pointer' }}>
                      <div className="flex items-center justify-between gap-3">
                        <strong className="text-sm truncate" style={{ color: 'var(--text-main)' }}>{rule.title}</strong>
                        <span className="badge" style={{ background: `${severity.color}18`, borderColor: `${severity.color}40`, color: severity.color, fontSize: '0.62rem' }}>{severity.label}</span>
                      </div>
                      <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>{rule.content}</p>
                      <div className="mt-3 flex flex-wrap items-center gap-1">
                        <span className="badge" style={{ fontSize: '0.62rem' }}>{rule.ruleType}</span>
                        <span className="badge" style={{ fontSize: '0.62rem' }}>{rule.status}</span>
                        {formatChapterRange(rule) ? <span className="badge" style={{ fontSize: '0.62rem' }}>{formatChapterRange(rule)}</span> : null}
                        {rule.entityType || rule.entityRef ? <span className="badge" style={{ fontSize: '0.62rem' }}>{[rule.entityType, rule.entityRef].filter(Boolean).join(':')}</span> : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="panel flex flex-col min-h-0" style={{ overflow: 'hidden' }}>
          <div className="flex items-center justify-between shrink-0 p-4" style={{ borderBottom: '1px solid var(--border-dim)' }}>
            <h2 className="text-base font-bold text-heading">{editingRule ? '编辑规则' : '新建规则'}</h2>
            {editingRule ? <button className="btn-danger" onClick={() => handleDelete(editingRule)} disabled={formLoading}>删除</button> : null}
          </div>

          <div className="flex-1 min-h-0 p-4 space-y-3" style={{ overflowY: 'auto' }}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="规则类型">
                <input className="input-field" value={form.ruleType} onChange={(event) => updateField('ruleType', event.target.value)} placeholder="continuity" />
              </Field>
              <Field label="严重程度">
                <select className="input-field" value={form.severity} onChange={(event) => updateField('severity', event.target.value as WritingRuleFormData['severity'])}>
                  <option value="info">info</option>
                  <option value="warning">warning</option>
                  <option value="error">error</option>
                </select>
              </Field>
            </div>

            <Field label="标题">
              <input className="input-field" value={form.title} onChange={(event) => updateField('title', event.target.value)} />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="起始章节">
                <input className="input-field" type="number" min={1} value={form.appliesFromChapterNo ?? ''} onChange={(event) => updateField('appliesFromChapterNo', event.target.value ? Number(event.target.value) : undefined)} />
              </Field>
              <Field label="结束章节">
                <input className="input-field" type="number" min={1} value={form.appliesToChapterNo ?? ''} onChange={(event) => updateField('appliesToChapterNo', event.target.value ? Number(event.target.value) : undefined)} />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="实体类型">
                <input className="input-field" value={form.entityType ?? ''} onChange={(event) => updateField('entityType', event.target.value)} placeholder="character / world / plot" />
              </Field>
              <Field label="实体引用">
                <input className="input-field" value={form.entityRef ?? ''} onChange={(event) => updateField('entityRef', event.target.value)} />
              </Field>
            </div>

            <Field label="状态">
              <input className="input-field" value={form.status} onChange={(event) => updateField('status', event.target.value)} placeholder="active" />
            </Field>

            <Field label="规则正文">
              <textarea className="input-field" value={form.content} onChange={(event) => updateField('content', event.target.value)} style={{ minHeight: '10rem', resize: 'vertical', lineHeight: 1.6 }} />
            </Field>

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

function FilterButton({ label, active, color, onClick }: { label: string; active: boolean; color: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: '0.72rem',
        padding: '0.25rem 0.55rem',
        borderRadius: '0.45rem',
        border: active ? `1px solid ${color}` : '1px solid var(--border-dim)',
        background: active ? `${color}18` : 'transparent',
        color: active ? color : 'var(--text-muted)',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function formatChapterRange(rule: WritingRule) {
  const from = rule.appliesFromChapterNo;
  const to = rule.appliesToChapterNo;
  if (from == null && to == null) return '';
  if (from != null && to != null) return `Ch.${from}-${to}`;
  if (from != null) return `Ch.${from}+`;
  return `<= Ch.${to}`;
}

function optionalText(value?: string | null, nullWhenEmpty = false) {
  const trimmed = value?.trim();
  return trimmed || (nullWhenEmpty ? null : undefined);
}

function normalizeOptionalNumber(value?: number | null, nullWhenEmpty = false) {
  return Number.isFinite(value) ? value as number : nullWhenEmpty ? null : undefined;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = value.trim() ? JSON.parse(value) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('metadata 必须是 JSON 对象。');
  }
  return parsed as Record<string, unknown>;
}
