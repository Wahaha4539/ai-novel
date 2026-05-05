import React, { useEffect, useMemo, useState } from 'react';
import { ChapterPattern, ProjectSummary } from '../types/dashboard';
import { ChapterPatternFormData, useChapterPatternActions } from '../hooks/useContinuityActions';

const EMPTY_FORM: ChapterPatternFormData = {
  patternType: 'standard',
  name: '',
  applicableScenes: [],
  structure: {},
  pacingAdvice: {},
  emotionalAdvice: {},
  conflictAdvice: {},
  status: 'active',
  metadata: {},
};

interface Props {
  selectedProject?: ProjectSummary;
  selectedProjectId: string;
}

export function ChapterPatternPanel({ selectedProject, selectedProjectId }: Props) {
  const [editingPattern, setEditingPattern] = useState<ChapterPattern | null>(null);
  const [form, setForm] = useState<ChapterPatternFormData>(EMPTY_FORM);
  const [applicableScenesText, setApplicableScenesText] = useState('');
  const [structureText, setStructureText] = useState('{}');
  const [pacingAdviceText, setPacingAdviceText] = useState('{}');
  const [emotionalAdviceText, setEmotionalAdviceText] = useState('{}');
  const [conflictAdviceText, setConflictAdviceText] = useState('{}');
  const [metadataText, setMetadataText] = useState('{}');
  const [localError, setLocalError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [patternTypeFilter, setPatternTypeFilter] = useState('all');
  const [searchText, setSearchText] = useState('');

  const {
    chapterPatterns,
    loading,
    formLoading,
    error,
    setError,
    loadChapterPatterns,
    createChapterPattern,
    updateChapterPattern,
    deleteChapterPattern,
  } = useChapterPatternActions(selectedProjectId);

  useEffect(() => {
    if (selectedProjectId) {
      void loadChapterPatterns();
    }
  }, [loadChapterPatterns, selectedProjectId]);

  const visiblePatterns = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return chapterPatterns.filter((pattern) => {
      if (statusFilter !== 'all' && pattern.status !== statusFilter) return false;
      if (patternTypeFilter !== 'all' && pattern.patternType !== patternTypeFilter) return false;
      if (!query) return true;
      return [
        pattern.name,
        pattern.patternType,
        ...asStringArray(pattern.applicableScenes),
      ].some((value) => value?.toLowerCase().includes(query));
    });
  }, [chapterPatterns, patternTypeFilter, searchText, statusFilter]);

  const statusOptions = useMemo(() => {
    return Array.from(new Set(['active', 'draft', 'archived', ...chapterPatterns.map((pattern) => pattern.status).filter(Boolean)]));
  }, [chapterPatterns]);

  const patternTypeOptions = useMemo(() => {
    return Array.from(new Set(['standard', 'setup', 'reversal', 'climax', 'payoff', ...chapterPatterns.map((pattern) => pattern.patternType).filter(Boolean)]));
  }, [chapterPatterns]);

  const resetForm = () => {
    setEditingPattern(null);
    setForm(EMPTY_FORM);
    setApplicableScenesText('');
    setStructureText('{}');
    setPacingAdviceText('{}');
    setEmotionalAdviceText('{}');
    setConflictAdviceText('{}');
    setMetadataText('{}');
    setLocalError('');
    setSuccessMessage('');
    setError('');
  };

  const openEdit = (pattern: ChapterPattern) => {
    setEditingPattern(pattern);
    setForm({
      patternType: pattern.patternType,
      name: pattern.name,
      applicableScenes: asStringArray(pattern.applicableScenes),
      structure: pattern.structure ?? {},
      pacingAdvice: pattern.pacingAdvice ?? {},
      emotionalAdvice: pattern.emotionalAdvice ?? {},
      conflictAdvice: pattern.conflictAdvice ?? {},
      status: pattern.status,
      metadata: pattern.metadata ?? {},
    });
    setApplicableScenesText(asStringArray(pattern.applicableScenes).join(', '));
    setStructureText(JSON.stringify(pattern.structure ?? {}, null, 2));
    setPacingAdviceText(JSON.stringify(pattern.pacingAdvice ?? {}, null, 2));
    setEmotionalAdviceText(JSON.stringify(pattern.emotionalAdvice ?? {}, null, 2));
    setConflictAdviceText(JSON.stringify(pattern.conflictAdvice ?? {}, null, 2));
    setMetadataText(JSON.stringify(pattern.metadata ?? {}, null, 2));
    setLocalError('');
    setSuccessMessage('');
    setError('');
  };

  const updateField = <K extends keyof ChapterPatternFormData>(key: K, value: ChapterPatternFormData[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setSuccessMessage('');
  };

  const handleSubmit = async () => {
    setLocalError('');
    setSuccessMessage('');

    const patternType = form.patternType.trim();
    const name = form.name.trim();
    if (!patternType || !name) {
      setLocalError('模式类型和名称不能为空。');
      return;
    }

    let structure: Record<string, unknown>;
    let pacingAdvice: Record<string, unknown>;
    let emotionalAdvice: Record<string, unknown>;
    let conflictAdvice: Record<string, unknown>;
    let metadata: Record<string, unknown>;
    try {
      structure = parseJsonObject(structureText, 'structure');
      pacingAdvice = parseJsonObject(pacingAdviceText, 'pacingAdvice');
      emotionalAdvice = parseJsonObject(emotionalAdviceText, 'emotionalAdvice');
      conflictAdvice = parseJsonObject(conflictAdviceText, 'conflictAdvice');
      metadata = parseJsonObject(metadataText, 'metadata');
    } catch (parseError) {
      setLocalError(parseError instanceof Error ? parseError.message : 'JSON 格式错误。');
      return;
    }

    const payload: ChapterPatternFormData = {
      patternType,
      name,
      applicableScenes: parseCsvList(applicableScenesText),
      structure,
      pacingAdvice,
      emotionalAdvice,
      conflictAdvice,
      status: optionalText(form.status) ?? 'active',
      metadata,
    };

    const ok = editingPattern
      ? await updateChapterPattern(editingPattern.id, payload)
      : await createChapterPattern(payload);
    if (!ok) return;

    await loadChapterPatterns();
    const message = editingPattern ? '章节模式已更新。' : '章节模式已创建。';
    resetForm();
    setSuccessMessage(message);
  };

  const handleArchive = async (pattern: ChapterPattern) => {
    setLocalError('');
    setSuccessMessage('');
    const ok = await updateChapterPattern(pattern.id, { status: 'archived' });
    if (!ok) return;

    await loadChapterPatterns();
    if (editingPattern?.id === pattern.id) resetForm();
    setSuccessMessage('章节模式已归档。');
  };

  const handleDelete = async (pattern: ChapterPattern) => {
    if (!window.confirm(`删除章节模式「${pattern.name}」？`)) return;

    setLocalError('');
    setSuccessMessage('');
    const deleted = await deleteChapterPattern(pattern.id);
    if (!deleted) return;

    await loadChapterPatterns();
    if (editingPattern?.id === pattern.id) resetForm();
    setSuccessMessage('章节模式已删除。');
  };

  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      <header className="flex items-center justify-between shrink-0" style={{ height: '3.5rem', background: 'var(--bg-editor-header)', padding: '0 2rem', borderBottom: '1px solid var(--border-light)', backdropFilter: 'blur(12px)', zIndex: 10 }}>
        <div className="flex items-center gap-3">
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#a855f7', boxShadow: '0 0 10px rgba(168,85,247,0.5)' }} />
          <h1 className="text-lg font-bold text-heading">章节模式</h1>
          <span className="badge" style={{ background: 'rgba(168,85,247,0.12)', color: '#c084fc', border: 'none' }}>Chapter Pattern</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>{selectedProject?.title ?? '未选择项目'}</div>
          <button className="btn-secondary" onClick={loadChapterPatterns} disabled={loading || formLoading} style={{ fontSize: '0.75rem' }}>刷新</button>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3 shrink-0" style={{ padding: '0.75rem 2rem', borderBottom: '1px solid var(--border-dim)', background: 'var(--bg-card)' }}>
        <div className="flex flex-wrap items-center gap-2">
          <input className="input-field" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="搜索名称、类型或适用场景" style={{ width: '18rem', fontSize: '0.75rem', padding: '0.45rem 0.75rem' }} />
          <select className="input-field" value={patternTypeFilter} onChange={(event) => setPatternTypeFilter(event.target.value)} style={{ width: '12rem', fontSize: '0.75rem', padding: '0.45rem 0.75rem' }}>
            <option value="all">全部类型</option>
            {patternTypeOptions.map((patternType) => (
              <option key={patternType} value={patternType}>{patternType}</option>
            ))}
          </select>
        </div>
        <select className="input-field" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} style={{ width: '11rem', fontSize: '0.75rem', padding: '0.45rem 0.75rem' }}>
          <option value="all">全部状态</option>
          {statusOptions.map((status) => (
            <option key={status} value={status}>{status}</option>
          ))}
        </select>
      </div>

      <div className="grid flex-1 min-h-0" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(22rem, 1fr))', gap: '1rem', padding: '1.25rem 1.5rem', overflow: 'hidden' }}>
        <section className="panel flex flex-col min-h-0" style={{ overflow: 'hidden' }}>
          <div className="flex items-center justify-between shrink-0 p-4" style={{ borderBottom: '1px solid var(--border-dim)' }}>
            <div>
              <h2 className="text-base font-bold text-heading">模式清单</h2>
              <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{visiblePatterns.length} / {chapterPatterns.length} 条</p>
            </div>
            <button className="btn-secondary" onClick={resetForm} disabled={formLoading}>新建</button>
          </div>

          <div className="flex-1 min-h-0" style={{ overflowY: 'auto' }}>
            {loading ? (
              <div className="p-4 text-sm" style={{ color: 'var(--text-dim)' }}>加载中...</div>
            ) : visiblePatterns.length === 0 ? (
              <div className="p-4 text-sm" style={{ color: 'var(--text-dim)' }}>暂无章节模式</div>
            ) : (
              <div className="space-y-2 p-3">
                {visiblePatterns.map((pattern) => (
                  <button key={pattern.id} onClick={() => openEdit(pattern)} className="w-full text-left" style={{ border: `1px solid ${editingPattern?.id === pattern.id ? '#a855f7' : 'var(--border-dim)'}`, background: editingPattern?.id === pattern.id ? 'rgba(168,85,247,0.12)' : 'var(--bg-card)', borderRadius: '0.5rem', padding: '0.9rem', cursor: 'pointer' }}>
                    <div className="flex items-center justify-between gap-3">
                      <strong className="text-sm truncate" style={{ color: 'var(--text-main)' }}>{pattern.name}</strong>
                      <span className="badge" style={{ background: pattern.status === 'archived' ? 'rgba(100,116,139,0.16)' : 'rgba(168,85,247,0.14)', borderColor: pattern.status === 'archived' ? 'rgba(148,163,184,0.3)' : 'rgba(168,85,247,0.35)', color: pattern.status === 'archived' ? 'var(--text-dim)' : '#c084fc', fontSize: '0.62rem' }}>{pattern.status}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      <span className="badge" style={{ fontSize: '0.62rem' }}>{pattern.patternType}</span>
                      {asStringArray(pattern.applicableScenes).slice(0, 4).map((scene) => (
                        <span key={scene} className="badge" style={{ fontSize: '0.62rem' }}>{scene}</span>
                      ))}
                    </div>
                    <p className="mt-2 text-xs" style={{ color: 'var(--text-dim)' }}>
                      structure {Object.keys(pattern.structure ?? {}).length} 项 · pacing {Object.keys(pattern.pacingAdvice ?? {}).length} 项
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="panel flex flex-col min-h-0" style={{ overflow: 'hidden' }}>
          <div className="flex items-center justify-between shrink-0 p-4" style={{ borderBottom: '1px solid var(--border-dim)' }}>
            <h2 className="text-base font-bold text-heading">{editingPattern ? '编辑章节模式' : '新建章节模式'}</h2>
            {editingPattern ? (
              <div className="flex items-center gap-2">
                {editingPattern.status !== 'archived' ? <button className="btn-secondary" onClick={() => handleArchive(editingPattern)} disabled={formLoading}>归档</button> : null}
                <button className="btn-danger" onClick={() => handleDelete(editingPattern)} disabled={formLoading}>删除</button>
              </div>
            ) : null}
          </div>

          <div className="flex-1 min-h-0 p-4 space-y-3" style={{ overflowY: 'auto' }}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="模式类型">
                <input className="input-field" value={form.patternType} onChange={(event) => updateField('patternType', event.target.value)} placeholder="standard" />
              </Field>
              <Field label="状态">
                <input className="input-field" value={form.status} onChange={(event) => updateField('status', event.target.value)} placeholder="active" />
              </Field>
            </div>

            <Field label="模式名称">
              <input className="input-field" value={form.name} onChange={(event) => updateField('name', event.target.value)} />
            </Field>

            <Field label="适用场景">
              <input className="input-field" value={applicableScenesText} onChange={(event) => setApplicableScenesText(event.target.value)} placeholder="opening, reveal, chase" />
            </Field>

            <Field label="structure JSON">
              <textarea className="input-field font-mono" value={structureText} onChange={(event) => setStructureText(event.target.value)} style={{ minHeight: '7rem', resize: 'vertical', fontSize: '0.78rem', lineHeight: 1.5 }} />
            </Field>

            <Field label="pacingAdvice JSON">
              <textarea className="input-field font-mono" value={pacingAdviceText} onChange={(event) => setPacingAdviceText(event.target.value)} style={{ minHeight: '7rem', resize: 'vertical', fontSize: '0.78rem', lineHeight: 1.5 }} />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="emotionalAdvice JSON">
                <textarea className="input-field font-mono" value={emotionalAdviceText} onChange={(event) => setEmotionalAdviceText(event.target.value)} style={{ minHeight: '7rem', resize: 'vertical', fontSize: '0.78rem', lineHeight: 1.5 }} />
              </Field>
              <Field label="conflictAdvice JSON">
                <textarea className="input-field font-mono" value={conflictAdviceText} onChange={(event) => setConflictAdviceText(event.target.value)} style={{ minHeight: '7rem', resize: 'vertical', fontSize: '0.78rem', lineHeight: 1.5 }} />
              </Field>
            </div>

            <Field label="metadata JSON">
              <textarea className="input-field font-mono" value={metadataText} onChange={(event) => setMetadataText(event.target.value)} style={{ minHeight: '7rem', resize: 'vertical', fontSize: '0.78rem', lineHeight: 1.5 }} />
            </Field>

            {(localError || error) ? (
              <div className="text-xs" style={{ color: 'var(--status-err)', background: 'var(--status-err-bg)', borderRadius: '0.5rem', padding: '0.6rem' }}>{localError || error}</div>
            ) : null}
            {successMessage ? (
              <div className="text-xs" style={{ color: '#10b981', background: 'rgba(16,185,129,0.1)', borderRadius: '0.5rem', padding: '0.6rem' }}>{successMessage}</div>
            ) : null}
          </div>

          <div className="flex justify-end gap-3 shrink-0 p-4" style={{ borderTop: '1px solid var(--border-dim)' }}>
            <button className="btn-secondary" onClick={resetForm} disabled={formLoading}>重置</button>
            <button className="btn" onClick={handleSubmit} disabled={formLoading}>{formLoading ? '保存中...' : '保存'}</button>
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

function optionalText(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean) : [];
}

function parseCsvList(value: string) {
  return Array.from(new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean)));
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const parsed = value.trim() ? JSON.parse(value) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON 对象。`);
  }
  return parsed as Record<string, unknown>;
}
