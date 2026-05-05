import React, { useEffect, useMemo, useState } from 'react';
import { ChapterSummary, PacingBeat, ProjectSummary, VolumeSummary } from '../types/dashboard';
import { PacingBeatFormData, usePacingBeatActions } from '../hooks/useContinuityActions';

const EMPTY_FORM: PacingBeatFormData = {
  volumeId: '',
  chapterId: '',
  chapterNo: undefined,
  beatType: 'setup',
  emotionalTone: '',
  emotionalIntensity: 50,
  tensionLevel: 50,
  payoffLevel: 50,
  notes: '',
  metadata: {},
};

interface Props {
  selectedProject?: ProjectSummary;
  selectedProjectId: string;
  volumes: VolumeSummary[];
  chapters: ChapterSummary[];
}

export function PacingPanel({ selectedProject, selectedProjectId, volumes, chapters }: Props) {
  const [editingBeat, setEditingBeat] = useState<PacingBeat | null>(null);
  const [form, setForm] = useState<PacingBeatFormData>(EMPTY_FORM);
  const [metadataText, setMetadataText] = useState('{}');
  const [localError, setLocalError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [beatTypeFilter, setBeatTypeFilter] = useState('all');
  const [chapterFilter, setChapterFilter] = useState('all');
  const [searchText, setSearchText] = useState('');

  const {
    pacingBeats,
    loading,
    formLoading,
    error,
    setError,
    loadPacingBeats,
    createPacingBeat,
    updatePacingBeat,
    deletePacingBeat,
  } = usePacingBeatActions(selectedProjectId);

  useEffect(() => {
    if (selectedProjectId) {
      void loadPacingBeats();
    }
  }, [loadPacingBeats, selectedProjectId]);

  const chapterById = useMemo(() => {
    return new Map(chapters.map((chapter) => [chapter.id, chapter]));
  }, [chapters]);

  const beatTypeOptions = useMemo(() => {
    return Array.from(new Set(['setup', 'build', 'turn', 'climax', 'payoff', 'breather', ...pacingBeats.map((beat) => beat.beatType).filter(Boolean)]));
  }, [pacingBeats]);

  const visibleBeats = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return pacingBeats
      .filter((beat) => {
        if (beatTypeFilter !== 'all' && beat.beatType !== beatTypeFilter) return false;
        if (chapterFilter !== 'all' && beat.chapterId !== chapterFilter) return false;
        if (!query) return true;
        return [beat.beatType, beat.emotionalTone, beat.notes].some((value) => value?.toLowerCase().includes(query));
      })
      .slice()
      .sort((a, b) => {
        const chapterDelta = (a.chapterNo ?? Number.MAX_SAFE_INTEGER) - (b.chapterNo ?? Number.MAX_SAFE_INTEGER);
        if (chapterDelta !== 0) return chapterDelta;
        return a.beatType.localeCompare(b.beatType);
      });
  }, [beatTypeFilter, chapterFilter, pacingBeats, searchText]);

  const averageTension = useMemo(() => {
    if (!visibleBeats.length) return 0;
    return Math.round(visibleBeats.reduce((sum, beat) => sum + beat.tensionLevel, 0) / visibleBeats.length);
  }, [visibleBeats]);

  const resetForm = () => {
    setEditingBeat(null);
    setForm(EMPTY_FORM);
    setMetadataText('{}');
    setLocalError('');
    setSuccessMessage('');
    setError('');
  };

  const openEdit = (beat: PacingBeat) => {
    setEditingBeat(beat);
    setForm({
      volumeId: beat.volumeId ?? '',
      chapterId: beat.chapterId ?? '',
      chapterNo: beat.chapterNo ?? undefined,
      beatType: beat.beatType,
      emotionalTone: beat.emotionalTone ?? '',
      emotionalIntensity: beat.emotionalIntensity,
      tensionLevel: beat.tensionLevel,
      payoffLevel: beat.payoffLevel,
      notes: beat.notes ?? '',
      metadata: beat.metadata ?? {},
    });
    setMetadataText(JSON.stringify(beat.metadata ?? {}, null, 2));
    setLocalError('');
    setSuccessMessage('');
    setError('');
  };

  const updateField = <K extends keyof PacingBeatFormData>(key: K, value: PacingBeatFormData[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setSuccessMessage('');
  };

  const handleChapterChange = (chapterId: string) => {
    const chapter = chapterId ? chapterById.get(chapterId) : undefined;
    setForm((current) => ({
      ...current,
      chapterId,
      chapterNo: chapterId ? chapter?.chapterNo ?? current.chapterNo : undefined,
      volumeId: chapter?.volumeId ?? current.volumeId ?? '',
    }));
    setSuccessMessage('');
  };

  const handleSubmit = async () => {
    setLocalError('');
    setSuccessMessage('');

    const beatType = form.beatType.trim();
    if (!beatType) {
      setLocalError('节奏类型不能为空。');
      return;
    }

    let metadata: Record<string, unknown>;
    let chapterNo: number | null | undefined;
    try {
      metadata = parseJsonObject(metadataText, 'metadata');
      chapterNo = normalizeOptionalPositiveInteger(form.chapterNo, '章节号', Boolean(editingBeat));
      assertLevel(form.emotionalIntensity, '情绪强度');
      assertLevel(form.tensionLevel, '紧张度');
      assertLevel(form.payoffLevel, '兑现度');
    } catch (parseError) {
      setLocalError(parseError instanceof Error ? parseError.message : '表单格式错误。');
      return;
    }

    const payload: PacingBeatFormData = {
      volumeId: optionalText(form.volumeId, Boolean(editingBeat)),
      chapterId: optionalText(form.chapterId, Boolean(editingBeat)),
      chapterNo,
      beatType,
      emotionalTone: optionalText(form.emotionalTone, Boolean(editingBeat)),
      emotionalIntensity: normalizeLevel(form.emotionalIntensity, 50),
      tensionLevel: normalizeLevel(form.tensionLevel, 50),
      payoffLevel: normalizeLevel(form.payoffLevel, 50),
      notes: optionalText(form.notes, Boolean(editingBeat)),
      metadata,
    };

    const ok = editingBeat
      ? await updatePacingBeat(editingBeat.id, payload)
      : await createPacingBeat(payload);
    if (!ok) return;

    await loadPacingBeats();
    const message = editingBeat ? '节奏节点已更新。' : '节奏节点已创建。';
    resetForm();
    setSuccessMessage(message);
  };

  const handleDelete = async (beat: PacingBeat) => {
    if (!window.confirm(`删除节奏节点「${beat.beatType}」？`)) return;

    setLocalError('');
    setSuccessMessage('');
    const deleted = await deletePacingBeat(beat.id);
    if (!deleted) return;

    await loadPacingBeats();
    if (editingBeat?.id === beat.id) resetForm();
    setSuccessMessage('节奏节点已删除。');
  };

  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      <header className="flex items-center justify-between shrink-0" style={{ height: '3.5rem', background: 'var(--bg-editor-header)', padding: '0 2rem', borderBottom: '1px solid var(--border-light)', backdropFilter: 'blur(12px)', zIndex: 10 }}>
        <div className="flex items-center gap-3">
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 10px rgba(34,197,94,0.5)' }} />
          <h1 className="text-lg font-bold text-heading">节奏控制</h1>
          <span className="badge" style={{ background: 'rgba(34,197,94,0.12)', color: '#4ade80', border: 'none' }}>Pacing</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>{selectedProject?.title ?? '未选择项目'}</div>
          <button className="btn-secondary" onClick={loadPacingBeats} disabled={loading || formLoading} style={{ fontSize: '0.75rem' }}>刷新</button>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3 shrink-0" style={{ padding: '0.75rem 2rem', borderBottom: '1px solid var(--border-dim)', background: 'var(--bg-card)' }}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="stat-card" style={{ padding: '0.45rem 0.65rem', borderRadius: '0.5rem' }}>
            <span className="text-xs" style={{ color: 'var(--text-dim)' }}>节点</span>
            <strong className="text-sm ml-2" style={{ color: '#4ade80' }}>{visibleBeats.length}</strong>
          </span>
          <span className="stat-card" style={{ padding: '0.45rem 0.65rem', borderRadius: '0.5rem' }}>
            <span className="text-xs" style={{ color: 'var(--text-dim)' }}>平均紧张度</span>
            <strong className="text-sm ml-2" style={{ color: '#f59e0b' }}>{averageTension}</strong>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input className="input-field" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="搜索类型、情绪或备注" style={{ width: '15rem', fontSize: '0.75rem', padding: '0.45rem 0.75rem' }} />
          <select className="input-field" value={chapterFilter} onChange={(event) => setChapterFilter(event.target.value)} style={{ width: '12rem', fontSize: '0.75rem', padding: '0.45rem 0.75rem' }}>
            <option value="all">全部章节</option>
            {chapters.map((chapter) => (
              <option key={chapter.id} value={chapter.id}>Ch.{chapter.chapterNo} {chapter.title ?? ''}</option>
            ))}
          </select>
          <select className="input-field" value={beatTypeFilter} onChange={(event) => setBeatTypeFilter(event.target.value)} style={{ width: '11rem', fontSize: '0.75rem', padding: '0.45rem 0.75rem' }}>
            <option value="all">全部类型</option>
            {beatTypeOptions.map((beatType) => (
              <option key={beatType} value={beatType}>{beatType}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid flex-1 min-h-0" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(22rem, 1fr))', gap: '1rem', padding: '1.25rem 1.5rem', overflow: 'hidden' }}>
        <section className="panel flex flex-col min-h-0" style={{ overflow: 'hidden' }}>
          <div className="flex items-center justify-between shrink-0 p-4" style={{ borderBottom: '1px solid var(--border-dim)' }}>
            <div>
              <h2 className="text-base font-bold text-heading">节奏节点</h2>
              <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{visibleBeats.length} / {pacingBeats.length} 条</p>
            </div>
            <button className="btn-secondary" onClick={resetForm} disabled={formLoading}>新建</button>
          </div>

          <div className="flex-1 min-h-0" style={{ overflowY: 'auto' }}>
            {loading ? (
              <div className="p-4 text-sm" style={{ color: 'var(--text-dim)' }}>加载中...</div>
            ) : visibleBeats.length === 0 ? (
              <div className="p-4 text-sm" style={{ color: 'var(--text-dim)' }}>暂无节奏节点</div>
            ) : (
              <div className="space-y-2 p-3">
                {visibleBeats.map((beat) => {
                  const chapter = beat.chapterId ? chapterById.get(beat.chapterId) : undefined;
                  return (
                    <button key={beat.id} onClick={() => openEdit(beat)} className="w-full text-left" style={{ border: `1px solid ${editingBeat?.id === beat.id ? '#22c55e' : 'var(--border-dim)'}`, background: editingBeat?.id === beat.id ? 'rgba(34,197,94,0.12)' : 'var(--bg-card)', borderRadius: '0.5rem', padding: '0.9rem', cursor: 'pointer' }}>
                      <div className="flex items-center justify-between gap-3">
                        <strong className="text-sm truncate" style={{ color: 'var(--text-main)' }}>{beat.beatType}</strong>
                        <span className="badge" style={{ background: intensityBackground(beat.tensionLevel), borderColor: 'rgba(245,158,11,0.35)', color: '#fbbf24', fontSize: '0.62rem' }}>Tension {beat.tensionLevel}</span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1">
                        {chapter ? <span className="badge" style={{ fontSize: '0.62rem' }}>Ch.{chapter.chapterNo}</span> : beat.chapterNo != null ? <span className="badge" style={{ fontSize: '0.62rem' }}>Ch.{beat.chapterNo}</span> : null}
                        <span className="badge" style={{ fontSize: '0.62rem' }}>Emotion {beat.emotionalIntensity}</span>
                        <span className="badge" style={{ fontSize: '0.62rem' }}>Payoff {beat.payoffLevel}</span>
                        {beat.emotionalTone ? <span className="badge" style={{ fontSize: '0.62rem' }}>{beat.emotionalTone}</span> : null}
                      </div>
                      {beat.notes ? <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>{beat.notes}</p> : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="panel flex flex-col min-h-0" style={{ overflow: 'hidden' }}>
          <div className="flex items-center justify-between shrink-0 p-4" style={{ borderBottom: '1px solid var(--border-dim)' }}>
            <h2 className="text-base font-bold text-heading">{editingBeat ? '编辑节奏节点' : '新建节奏节点'}</h2>
            {editingBeat ? <button className="btn-danger" onClick={() => handleDelete(editingBeat)} disabled={formLoading}>删除</button> : null}
          </div>

          <div className="flex-1 min-h-0 p-4 space-y-3" style={{ overflowY: 'auto' }}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="节奏类型">
                <input className="input-field" value={form.beatType} onChange={(event) => updateField('beatType', event.target.value)} placeholder="setup / turn / payoff" />
              </Field>
              <Field label="情绪色调">
                <input className="input-field" value={form.emotionalTone ?? ''} onChange={(event) => updateField('emotionalTone', event.target.value)} />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="归属章节">
                <select className="input-field" value={form.chapterId ?? ''} onChange={(event) => handleChapterChange(event.target.value)}>
                  <option value="">未绑定章节</option>
                  {chapters.map((chapter) => (
                    <option key={chapter.id} value={chapter.id}>Ch.{chapter.chapterNo} {chapter.title ?? ''}</option>
                  ))}
                </select>
              </Field>
              <Field label="归属卷">
                <select className="input-field" value={form.volumeId ?? ''} onChange={(event) => updateField('volumeId', event.target.value)}>
                  <option value="">未绑定卷</option>
                  {volumes.map((volume) => (
                    <option key={volume.id} value={volume.id}>Vol.{volume.volumeNo} {volume.title ?? ''}</option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="章节号">
              <input className="input-field" type="number" min={1} value={form.chapterNo ?? ''} onChange={(event) => updateField('chapterNo', event.target.value ? Number(event.target.value) : undefined)} />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <LevelField label="情绪强度" value={form.emotionalIntensity ?? 50} onChange={(value) => updateField('emotionalIntensity', value)} color="#22c55e" />
              <LevelField label="紧张度" value={form.tensionLevel ?? 50} onChange={(value) => updateField('tensionLevel', value)} color="#f59e0b" />
            </div>

            <LevelField label="兑现度" value={form.payoffLevel ?? 50} onChange={(value) => updateField('payoffLevel', value)} color="#38bdf8" />

            <Field label="备注">
              <textarea className="input-field" value={form.notes ?? ''} onChange={(event) => updateField('notes', event.target.value)} style={{ minHeight: '7rem', resize: 'vertical' }} />
            </Field>

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

function LevelField({ label, value, onChange, color }: { label: string; value: number; onChange: (value: number) => void; color: string }) {
  return (
    <label className="block">
      <span className="flex items-center justify-between text-xs font-bold mb-1" style={{ color: 'var(--text-muted)' }}>
        <span>{label}</span>
        <span style={{ color }}>{value}</span>
      </span>
      <input className="w-full" type="range" min={0} max={100} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function optionalText(value?: string | null, nullWhenEmpty = false) {
  const trimmed = value?.trim();
  return trimmed || (nullWhenEmpty ? null : undefined);
}

function normalizeOptionalPositiveInteger(value: number | null | undefined, label: string, nullWhenEmpty = false) {
  if (value == null || !Number.isFinite(value)) return nullWhenEmpty ? null : undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label}必须是正整数。`);
  }
  return value;
}

function normalizeLevel(value: number | undefined, fallback: number) {
  return Number.isInteger(value) ? value : fallback;
}

function assertLevel(value: number | undefined, label: string) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(`${label}必须是 0 到 100 之间的整数。`);
  }
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const parsed = value.trim() ? JSON.parse(value) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON 对象。`);
  }
  return parsed as Record<string, unknown>;
}

function intensityBackground(value: number) {
  if (value >= 75) return 'rgba(244,63,94,0.14)';
  if (value >= 45) return 'rgba(245,158,11,0.14)';
  return 'rgba(34,197,94,0.12)';
}
