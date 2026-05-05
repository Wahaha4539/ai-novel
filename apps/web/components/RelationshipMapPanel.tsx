import React, { useEffect, useMemo, useState } from 'react';
import { ProjectSummary, RelationshipEdge } from '../types/dashboard';
import { RelationshipEdgeFormData, useRelationshipActions } from '../hooks/useContinuityActions';

const EMPTY_FORM: RelationshipEdgeFormData = {
  characterAName: '',
  characterBName: '',
  relationType: 'ally',
  publicState: '',
  hiddenState: '',
  conflictPoint: '',
  emotionalArc: '',
  turnChapterNos: [],
  finalState: '',
  status: 'active',
  sourceType: 'manual',
  metadata: {},
};

interface Props {
  selectedProject?: ProjectSummary;
  selectedProjectId: string;
}

export function RelationshipMapPanel({ selectedProject, selectedProjectId }: Props) {
  const [editingRelationship, setEditingRelationship] = useState<RelationshipEdge | null>(null);
  const [form, setForm] = useState<RelationshipEdgeFormData>(EMPTY_FORM);
  const [turnChapterNosText, setTurnChapterNosText] = useState('');
  const [metadataText, setMetadataText] = useState('{}');
  const [localError, setLocalError] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [relationFilter, setRelationFilter] = useState('all');

  const {
    relationships,
    loading,
    formLoading,
    error,
    setError,
    loadRelationships,
    createRelationship,
    updateRelationship,
    deleteRelationship,
  } = useRelationshipActions(selectedProjectId);

  useEffect(() => {
    if (selectedProjectId) {
      void loadRelationships();
    }
  }, [loadRelationships, selectedProjectId]);

  const visibleRelationships = useMemo(() => {
    return relationships.filter((relationship) => {
      if (statusFilter !== 'all' && relationship.status !== statusFilter) return false;
      if (relationFilter !== 'all' && relationship.relationType !== relationFilter) return false;
      return true;
    });
  }, [relationFilter, relationships, statusFilter]);

  const statusOptions = useMemo(() => {
    return Array.from(new Set(['active', 'resolved', 'archived', ...relationships.map((item) => item.status).filter(Boolean)]));
  }, [relationships]);

  const relationOptions = useMemo(() => {
    return Array.from(new Set(['ally', 'rival', 'family', 'romance', 'mentor', 'enemy', ...relationships.map((item) => item.relationType).filter(Boolean)]));
  }, [relationships]);

  const characterCount = useMemo(() => {
    return new Set(relationships.flatMap((item) => [item.characterAName, item.characterBName]).filter(Boolean)).size;
  }, [relationships]);

  const resetForm = () => {
    setEditingRelationship(null);
    setForm(EMPTY_FORM);
    setTurnChapterNosText('');
    setMetadataText('{}');
    setLocalError('');
    setError('');
  };

  const openEdit = (relationship: RelationshipEdge) => {
    setEditingRelationship(relationship);
    setForm({
      characterAId: relationship.characterAId ?? '',
      characterBId: relationship.characterBId ?? '',
      characterAName: relationship.characterAName,
      characterBName: relationship.characterBName,
      relationType: relationship.relationType,
      publicState: relationship.publicState ?? '',
      hiddenState: relationship.hiddenState ?? '',
      conflictPoint: relationship.conflictPoint ?? '',
      emotionalArc: relationship.emotionalArc ?? '',
      turnChapterNos: asNumberArray(relationship.turnChapterNos),
      finalState: relationship.finalState ?? '',
      status: relationship.status,
      sourceType: relationship.sourceType,
      metadata: relationship.metadata ?? {},
    });
    setTurnChapterNosText(asNumberArray(relationship.turnChapterNos).join(', '));
    setMetadataText(JSON.stringify(relationship.metadata ?? {}, null, 2));
    setLocalError('');
    setError('');
  };

  const updateField = <K extends keyof RelationshipEdgeFormData>(key: K, value: RelationshipEdgeFormData[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = async () => {
    setLocalError('');

    const characterAName = form.characterAName.trim();
    const characterBName = form.characterBName.trim();
    const relationType = form.relationType.trim();
    if (!characterAName || !characterBName || !relationType) {
      setLocalError('双方角色名和关系类型不能为空。');
      return;
    }

    let turnChapterNos: number[];
    let metadata: Record<string, unknown>;
    try {
      turnChapterNos = parseNumberList(turnChapterNosText);
      metadata = parseJsonObject(metadataText);
    } catch (parseError) {
      setLocalError(parseError instanceof Error ? parseError.message : '表单解析失败。');
      return;
    }

    const payload: RelationshipEdgeFormData = {
      characterAId: optionalText(form.characterAId, Boolean(editingRelationship)),
      characterBId: optionalText(form.characterBId, Boolean(editingRelationship)),
      characterAName,
      characterBName,
      relationType,
      publicState: optionalText(form.publicState, Boolean(editingRelationship)),
      hiddenState: optionalText(form.hiddenState, Boolean(editingRelationship)),
      conflictPoint: optionalText(form.conflictPoint, Boolean(editingRelationship)),
      emotionalArc: optionalText(form.emotionalArc, Boolean(editingRelationship)),
      turnChapterNos,
      finalState: optionalText(form.finalState, Boolean(editingRelationship)),
      status: optionalText(form.status) ?? 'active',
      sourceType: optionalText(form.sourceType) ?? 'manual',
      metadata,
    };

    const ok = editingRelationship
      ? await updateRelationship(editingRelationship.id, payload)
      : await createRelationship(payload);
    if (!ok) return;

    await loadRelationships();
    resetForm();
  };

  const handleDelete = async (relationship: RelationshipEdge) => {
    if (!window.confirm(`删除「${relationship.characterAName} - ${relationship.characterBName}」这条关系？`)) return;

    const deleted = await deleteRelationship(relationship.id);
    if (!deleted) return;

    await loadRelationships();
    if (editingRelationship?.id === relationship.id) resetForm();
  };

  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      <header className="flex items-center justify-between shrink-0" style={{ height: '3.5rem', background: 'var(--bg-editor-header)', padding: '0 2rem', borderBottom: '1px solid var(--border-light)', backdropFilter: 'blur(12px)', zIndex: 10 }}>
        <div className="flex items-center gap-3">
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#14b8a6', boxShadow: '0 0 10px rgba(20,184,166,0.5)' }} />
          <h1 className="text-lg font-bold text-heading">人物关系</h1>
          <span className="badge" style={{ background: 'rgba(20,184,166,0.12)', color: '#2dd4bf', border: 'none' }}>Relationships</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>{selectedProject?.title ?? '未选择项目'}</div>
          <button className="btn-secondary" onClick={loadRelationships} disabled={loading || formLoading} style={{ fontSize: '0.75rem' }}>刷新</button>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3 shrink-0" style={{ padding: '0.75rem 2rem', borderBottom: '1px solid var(--border-dim)', background: 'var(--bg-card)' }}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="stat-card" style={{ padding: '0.45rem 0.65rem', borderRadius: '0.5rem' }}>
            <span className="text-xs" style={{ color: 'var(--text-dim)' }}>关系边</span>
            <strong className="text-sm ml-2" style={{ color: '#2dd4bf' }}>{relationships.length}</strong>
          </span>
          <span className="stat-card" style={{ padding: '0.45rem 0.65rem', borderRadius: '0.5rem' }}>
            <span className="text-xs" style={{ color: 'var(--text-dim)' }}>角色节点</span>
            <strong className="text-sm ml-2" style={{ color: '#38bdf8' }}>{characterCount}</strong>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select className="input-field" value={relationFilter} onChange={(event) => setRelationFilter(event.target.value)} style={{ width: '11rem', fontSize: '0.75rem', padding: '0.45rem 0.75rem' }}>
            <option value="all">全部关系</option>
            {relationOptions.map((relationType) => (
              <option key={relationType} value={relationType}>{relationType}</option>
            ))}
          </select>
          <select className="input-field" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} style={{ width: '11rem', fontSize: '0.75rem', padding: '0.45rem 0.75rem' }}>
            <option value="all">全部状态</option>
            {statusOptions.map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid flex-1 min-h-0" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(21rem, 1fr))', gap: '1rem', padding: '1.25rem 1.5rem', overflow: 'hidden' }}>
        <section className="panel flex flex-col min-h-0" style={{ overflow: 'hidden' }}>
          <div className="flex items-center justify-between shrink-0 p-4" style={{ borderBottom: '1px solid var(--border-dim)' }}>
            <div>
              <h2 className="text-base font-bold text-heading">关系图谱</h2>
              <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{visibleRelationships.length} 条可见关系</p>
            </div>
            <button className="btn-secondary" onClick={resetForm} disabled={formLoading}>新建</button>
          </div>

          <div className="flex-1 min-h-0" style={{ overflowY: 'auto' }}>
            {loading ? (
              <div className="p-4 text-sm" style={{ color: 'var(--text-dim)' }}>加载中…</div>
            ) : visibleRelationships.length === 0 ? (
              <div className="p-4 text-sm" style={{ color: 'var(--text-dim)' }}>暂无人物关系</div>
            ) : (
              <div className="space-y-2 p-3">
                {visibleRelationships.map((relationship) => (
                  <button key={relationship.id} onClick={() => openEdit(relationship)} className="w-full text-left" style={{ border: `1px solid ${editingRelationship?.id === relationship.id ? '#14b8a6' : 'var(--border-dim)'}`, background: editingRelationship?.id === relationship.id ? 'rgba(20,184,166,0.12)' : 'var(--bg-card)', borderRadius: '0.5rem', padding: '0.9rem', cursor: 'pointer' }}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
                        <strong className="text-sm truncate" style={{ color: 'var(--text-main)' }}>{relationship.characterAName}</strong>
                        <span style={{ color: '#14b8a6' }}>→</span>
                        <strong className="text-sm truncate" style={{ color: 'var(--text-main)' }}>{relationship.characterBName}</strong>
                      </div>
                      <span className="badge" style={{ background: 'rgba(20,184,166,0.14)', borderColor: 'rgba(20,184,166,0.35)', color: '#2dd4bf', fontSize: '0.62rem' }}>{relationship.relationType}</span>
                    </div>
                    {relationship.publicState ? <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>公开：{relationship.publicState}</p> : null}
                    {relationship.hiddenState ? <p className="mt-1 text-xs" style={{ color: 'var(--text-dim)' }}>隐藏：{relationship.hiddenState}</p> : null}
                    <div className="mt-3 flex flex-wrap items-center gap-1">
                      <span className="badge" style={{ fontSize: '0.62rem' }}>{relationship.status}</span>
                      <span className="badge" style={{ fontSize: '0.62rem' }}>{relationship.sourceType}</span>
                      {asNumberArray(relationship.turnChapterNos).length ? <span className="badge" style={{ fontSize: '0.62rem' }}>Turns: {asNumberArray(relationship.turnChapterNos).join(', ')}</span> : null}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="panel flex flex-col min-h-0" style={{ overflow: 'hidden' }}>
          <div className="flex items-center justify-between shrink-0 p-4" style={{ borderBottom: '1px solid var(--border-dim)' }}>
            <h2 className="text-base font-bold text-heading">{editingRelationship ? '编辑关系' : '新建关系'}</h2>
            {editingRelationship ? <button className="btn-danger" onClick={() => handleDelete(editingRelationship)} disabled={formLoading}>删除</button> : null}
          </div>

          <div className="flex-1 min-h-0 p-4 space-y-3" style={{ overflowY: 'auto' }}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="角色 A">
                <input className="input-field" value={form.characterAName} onChange={(event) => updateField('characterAName', event.target.value)} />
              </Field>
              <Field label="角色 B">
                <input className="input-field" value={form.characterBName} onChange={(event) => updateField('characterBName', event.target.value)} />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="角色 A ID">
                <input className="input-field" value={form.characterAId ?? ''} onChange={(event) => updateField('characterAId', event.target.value)} />
              </Field>
              <Field label="角色 B ID">
                <input className="input-field" value={form.characterBId ?? ''} onChange={(event) => updateField('characterBId', event.target.value)} />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="关系类型">
                <input className="input-field" value={form.relationType} onChange={(event) => updateField('relationType', event.target.value)} placeholder="ally / rival / family" />
              </Field>
              <Field label="状态">
                <input className="input-field" value={form.status} onChange={(event) => updateField('status', event.target.value)} placeholder="active" />
              </Field>
            </div>

            <Field label="公开状态">
              <input className="input-field" value={form.publicState ?? ''} onChange={(event) => updateField('publicState', event.target.value)} />
            </Field>

            <Field label="隐藏状态">
              <input className="input-field" value={form.hiddenState ?? ''} onChange={(event) => updateField('hiddenState', event.target.value)} />
            </Field>

            <Field label="冲突点">
              <textarea className="input-field" value={form.conflictPoint ?? ''} onChange={(event) => updateField('conflictPoint', event.target.value)} style={{ minHeight: '5rem', resize: 'vertical' }} />
            </Field>

            <Field label="情感弧">
              <textarea className="input-field" value={form.emotionalArc ?? ''} onChange={(event) => updateField('emotionalArc', event.target.value)} style={{ minHeight: '5rem', resize: 'vertical' }} />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="转折章节">
                <input className="input-field" value={turnChapterNosText} onChange={(event) => setTurnChapterNosText(event.target.value)} placeholder="3, 8, 12" />
              </Field>
              <Field label="来源类型">
                <input className="input-field" value={form.sourceType} onChange={(event) => updateField('sourceType', event.target.value)} placeholder="manual" />
              </Field>
            </div>

            <Field label="最终状态">
              <input className="input-field" value={form.finalState ?? ''} onChange={(event) => updateField('finalState', event.target.value)} />
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

function optionalText(value?: string | null, nullWhenEmpty = false) {
  const trimmed = value?.trim();
  return trimmed || (nullWhenEmpty ? null : undefined);
}

function parseNumberList(value: string) {
  if (!value.trim()) return [];

  const tokens = value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean);
  const numbers = tokens.map((token) => Number(token));
  if (numbers.some((number) => !Number.isInteger(number) || number <= 0)) {
    throw new Error('转折章节必须是正整数列表，例如：3, 8, 12。');
  }

  return Array.from(new Set(numbers)).sort((a, b) => a - b);
}

function asNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)
    : [];
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = value.trim() ? JSON.parse(value) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('metadata 必须是 JSON 对象。');
  }
  return parsed as Record<string, unknown>;
}
