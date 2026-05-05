import React, { useEffect, useMemo, useState } from 'react';
import { ChapterSummary, ProjectSummary, SceneCard, VolumeSummary } from '../types/dashboard';
import { SceneCardFormData, useSceneActions } from '../hooks/useContinuityActions';

const EMPTY_FORM: SceneCardFormData = {
  volumeId: '',
  chapterId: '',
  sceneNo: undefined,
  title: '',
  locationName: '',
  participants: [],
  purpose: '',
  conflict: '',
  emotionalTone: '',
  keyInformation: '',
  result: '',
  relatedForeshadowIds: [],
  status: 'planned',
  metadata: {},
};

interface Props {
  selectedProject?: ProjectSummary;
  selectedProjectId: string;
  volumes: VolumeSummary[];
  chapters: ChapterSummary[];
}

export function SceneBankPanel({ selectedProject, selectedProjectId, volumes, chapters }: Props) {
  const [editingScene, setEditingScene] = useState<SceneCard | null>(null);
  const [form, setForm] = useState<SceneCardFormData>(EMPTY_FORM);
  const [participantsText, setParticipantsText] = useState('');
  const [foreshadowText, setForeshadowText] = useState('');
  const [metadataText, setMetadataText] = useState('{}');
  const [localError, setLocalError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [chapterFilter, setChapterFilter] = useState('all');
  const [searchText, setSearchText] = useState('');

  const {
    scenes,
    loading,
    formLoading,
    error,
    setError,
    loadScenes,
    createScene,
    updateScene,
    deleteScene,
  } = useSceneActions(selectedProjectId);

  useEffect(() => {
    if (selectedProjectId) {
      void loadScenes();
    }
  }, [loadScenes, selectedProjectId]);

  const chapterById = useMemo(() => {
    return new Map(chapters.map((chapter) => [chapter.id, chapter]));
  }, [chapters]);

  const volumeById = useMemo(() => {
    return new Map(volumes.map((volume) => [volume.id, volume]));
  }, [volumes]);

  const visibleScenes = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return scenes
      .filter((scene) => {
        if (statusFilter !== 'all' && scene.status !== statusFilter) return false;
        if (chapterFilter !== 'all' && scene.chapterId !== chapterFilter) return false;
        if (!query) return true;
        return [
          scene.title,
          scene.locationName,
          scene.purpose,
          scene.conflict,
          scene.emotionalTone,
          scene.keyInformation,
          scene.result,
          ...asStringArray(scene.participants),
        ].some((value) => value?.toLowerCase().includes(query));
      })
      .slice()
      .sort((a, b) => {
        const aChapterNo = a.chapterId ? chapterById.get(a.chapterId)?.chapterNo ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
        const bChapterNo = b.chapterId ? chapterById.get(b.chapterId)?.chapterNo ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
        if (aChapterNo !== bChapterNo) return aChapterNo - bChapterNo;
        return (a.sceneNo ?? Number.MAX_SAFE_INTEGER) - (b.sceneNo ?? Number.MAX_SAFE_INTEGER);
      });
  }, [chapterById, chapterFilter, scenes, searchText, statusFilter]);

  const statusOptions = useMemo(() => {
    return Array.from(new Set(['planned', 'drafting', 'completed', 'archived', ...scenes.map((scene) => scene.status).filter(Boolean)]));
  }, [scenes]);

  const resetForm = () => {
    setEditingScene(null);
    setForm(EMPTY_FORM);
    setParticipantsText('');
    setForeshadowText('');
    setMetadataText('{}');
    setLocalError('');
    setSuccessMessage('');
    setError('');
  };

  const openEdit = (scene: SceneCard) => {
    setEditingScene(scene);
    setForm({
      volumeId: scene.volumeId ?? '',
      chapterId: scene.chapterId ?? '',
      sceneNo: scene.sceneNo ?? undefined,
      title: scene.title,
      locationName: scene.locationName ?? '',
      participants: asStringArray(scene.participants),
      purpose: scene.purpose ?? '',
      conflict: scene.conflict ?? '',
      emotionalTone: scene.emotionalTone ?? '',
      keyInformation: scene.keyInformation ?? '',
      result: scene.result ?? '',
      relatedForeshadowIds: asStringArray(scene.relatedForeshadowIds),
      status: scene.status,
      metadata: scene.metadata ?? {},
    });
    setParticipantsText(asStringArray(scene.participants).join(', '));
    setForeshadowText(asStringArray(scene.relatedForeshadowIds).join(', '));
    setMetadataText(JSON.stringify(scene.metadata ?? {}, null, 2));
    setLocalError('');
    setSuccessMessage('');
    setError('');
  };

  const updateField = <K extends keyof SceneCardFormData>(key: K, value: SceneCardFormData[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setSuccessMessage('');
  };

  const handleChapterChange = (chapterId: string) => {
    const chapter = chapterId ? chapterById.get(chapterId) : undefined;
    setForm((current) => ({
      ...current,
      chapterId,
      volumeId: chapter?.volumeId ?? current.volumeId ?? '',
    }));
    setSuccessMessage('');
  };

  const handleSubmit = async () => {
    setLocalError('');
    setSuccessMessage('');

    const title = form.title.trim();
    if (!title) {
      setLocalError('场景标题不能为空。');
      return;
    }

    let metadata: Record<string, unknown>;
    let sceneNo: number | null | undefined;
    try {
      metadata = parseJsonObject(metadataText, 'metadata');
      sceneNo = normalizeOptionalPositiveInteger(form.sceneNo, '场景序号', Boolean(editingScene));
    } catch (parseError) {
      setLocalError(parseError instanceof Error ? parseError.message : '表单格式错误。');
      return;
    }

    const payload: SceneCardFormData = {
      volumeId: optionalText(form.volumeId, Boolean(editingScene)),
      chapterId: optionalText(form.chapterId, Boolean(editingScene)),
      sceneNo,
      title,
      locationName: optionalText(form.locationName, Boolean(editingScene)),
      participants: parseCsvList(participantsText),
      purpose: optionalText(form.purpose, Boolean(editingScene)),
      conflict: optionalText(form.conflict, Boolean(editingScene)),
      emotionalTone: optionalText(form.emotionalTone, Boolean(editingScene)),
      keyInformation: optionalText(form.keyInformation, Boolean(editingScene)),
      result: optionalText(form.result, Boolean(editingScene)),
      relatedForeshadowIds: parseCsvList(foreshadowText),
      status: optionalText(form.status) ?? 'planned',
      metadata,
    };

    const ok = editingScene
      ? await updateScene(editingScene.id, payload)
      : await createScene(payload);
    if (!ok) return;

    await loadScenes();
    const message = editingScene ? '场景卡已更新。' : '场景卡已创建。';
    resetForm();
    setSuccessMessage(message);
  };

  const handleArchive = async (scene: SceneCard) => {
    setLocalError('');
    setSuccessMessage('');
    const ok = await updateScene(scene.id, { status: 'archived' });
    if (!ok) return;

    await loadScenes();
    if (editingScene?.id === scene.id) resetForm();
    setSuccessMessage('场景卡已归档。');
  };

  const handleDelete = async (scene: SceneCard) => {
    if (!window.confirm(`删除场景卡「${scene.title}」？`)) return;

    setLocalError('');
    setSuccessMessage('');
    const deleted = await deleteScene(scene.id);
    if (!deleted) return;

    await loadScenes();
    if (editingScene?.id === scene.id) resetForm();
    setSuccessMessage('场景卡已删除。');
  };

  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      <header className="flex items-center justify-between shrink-0" style={{ height: '3.5rem', background: 'var(--bg-editor-header)', padding: '0 2rem', borderBottom: '1px solid var(--border-light)', backdropFilter: 'blur(12px)', zIndex: 10 }}>
        <div className="flex items-center gap-3">
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#f97316', boxShadow: '0 0 10px rgba(249,115,22,0.5)' }} />
          <h1 className="text-lg font-bold text-heading">场景库</h1>
          <span className="badge" style={{ background: 'rgba(249,115,22,0.12)', color: '#fb923c', border: 'none' }}>Scene Bank</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>{selectedProject?.title ?? '未选择项目'}</div>
          <button className="btn-secondary" onClick={loadScenes} disabled={loading || formLoading} style={{ fontSize: '0.75rem' }}>刷新</button>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3 shrink-0" style={{ padding: '0.75rem 2rem', borderBottom: '1px solid var(--border-dim)', background: 'var(--bg-card)' }}>
        <div className="flex flex-wrap items-center gap-2">
          <input className="input-field" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="搜索标题、地点、冲突或参与者" style={{ width: '18rem', fontSize: '0.75rem', padding: '0.45rem 0.75rem' }} />
          <select className="input-field" value={chapterFilter} onChange={(event) => setChapterFilter(event.target.value)} style={{ width: '12rem', fontSize: '0.75rem', padding: '0.45rem 0.75rem' }}>
            <option value="all">全部章节</option>
            {chapters.map((chapter) => (
              <option key={chapter.id} value={chapter.id}>Ch.{chapter.chapterNo} {chapter.title ?? ''}</option>
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
              <h2 className="text-base font-bold text-heading">场景卡列表</h2>
              <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{visibleScenes.length} / {scenes.length} 张</p>
            </div>
            <button className="btn-secondary" onClick={resetForm} disabled={formLoading}>新建</button>
          </div>

          <div className="flex-1 min-h-0" style={{ overflowY: 'auto' }}>
            {loading ? (
              <div className="p-4 text-sm" style={{ color: 'var(--text-dim)' }}>加载中...</div>
            ) : visibleScenes.length === 0 ? (
              <div className="p-4 text-sm" style={{ color: 'var(--text-dim)' }}>暂无场景卡</div>
            ) : (
              <div className="space-y-2 p-3">
                {visibleScenes.map((scene) => {
                  const chapter = scene.chapterId ? chapterById.get(scene.chapterId) : undefined;
                  return (
                    <button key={scene.id} onClick={() => openEdit(scene)} className="w-full text-left" style={{ border: `1px solid ${editingScene?.id === scene.id ? '#f97316' : 'var(--border-dim)'}`, background: editingScene?.id === scene.id ? 'rgba(249,115,22,0.12)' : 'var(--bg-card)', borderRadius: '0.5rem', padding: '0.9rem', cursor: 'pointer' }}>
                      <div className="flex items-center justify-between gap-3">
                        <strong className="text-sm truncate" style={{ color: 'var(--text-main)' }}>{scene.title}</strong>
                        <span className="badge" style={{ background: scene.status === 'archived' ? 'rgba(100,116,139,0.16)' : 'rgba(249,115,22,0.14)', borderColor: scene.status === 'archived' ? 'rgba(148,163,184,0.3)' : 'rgba(249,115,22,0.35)', color: scene.status === 'archived' ? 'var(--text-dim)' : '#fb923c', fontSize: '0.62rem' }}>{scene.status}</span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1">
                        {chapter ? <span className="badge" style={{ fontSize: '0.62rem' }}>Ch.{chapter.chapterNo}</span> : null}
                        {scene.sceneNo != null ? <span className="badge" style={{ fontSize: '0.62rem' }}>Scene {scene.sceneNo}</span> : null}
                        {scene.locationName ? <span className="badge" style={{ fontSize: '0.62rem' }}>{scene.locationName}</span> : null}
                      </div>
                      {scene.purpose ? <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>{scene.purpose}</p> : null}
                      {asStringArray(scene.participants).length ? <p className="mt-1 text-xs" style={{ color: 'var(--text-dim)' }}>参与者：{asStringArray(scene.participants).join('、')}</p> : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="panel flex flex-col min-h-0" style={{ overflow: 'hidden' }}>
          <div className="flex items-center justify-between shrink-0 p-4" style={{ borderBottom: '1px solid var(--border-dim)' }}>
            <h2 className="text-base font-bold text-heading">{editingScene ? '编辑场景卡' : '新建场景卡'}</h2>
            {editingScene ? (
              <div className="flex items-center gap-2">
                {editingScene.status !== 'archived' ? <button className="btn-secondary" onClick={() => handleArchive(editingScene)} disabled={formLoading}>归档</button> : null}
                <button className="btn-danger" onClick={() => handleDelete(editingScene)} disabled={formLoading}>删除</button>
              </div>
            ) : null}
          </div>

          <div className="flex-1 min-h-0 p-4 space-y-3" style={{ overflowY: 'auto' }}>
            <Field label="场景标题">
              <input className="input-field" value={form.title} onChange={(event) => updateField('title', event.target.value)} />
            </Field>

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

            <div className="grid grid-cols-2 gap-3">
              <Field label="场景序号">
                <input className="input-field" type="number" min={1} value={form.sceneNo ?? ''} onChange={(event) => updateField('sceneNo', event.target.value ? Number(event.target.value) : undefined)} />
              </Field>
              <Field label="状态">
                <input className="input-field" value={form.status} onChange={(event) => updateField('status', event.target.value)} placeholder="planned" />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="地点">
                <input className="input-field" value={form.locationName ?? ''} onChange={(event) => updateField('locationName', event.target.value)} />
              </Field>
              <Field label="情绪色调">
                <input className="input-field" value={form.emotionalTone ?? ''} onChange={(event) => updateField('emotionalTone', event.target.value)} />
              </Field>
            </div>

            <Field label="参与者">
              <input className="input-field" value={participantsText} onChange={(event) => setParticipantsText(event.target.value)} placeholder="林舟, 许青, 白榆" />
            </Field>

            <Field label="场景目的">
              <textarea className="input-field" value={form.purpose ?? ''} onChange={(event) => updateField('purpose', event.target.value)} style={{ minHeight: '4.75rem', resize: 'vertical' }} />
            </Field>

            <Field label="冲突">
              <textarea className="input-field" value={form.conflict ?? ''} onChange={(event) => updateField('conflict', event.target.value)} style={{ minHeight: '4.75rem', resize: 'vertical' }} />
            </Field>

            <Field label="关键信息">
              <textarea className="input-field" value={form.keyInformation ?? ''} onChange={(event) => updateField('keyInformation', event.target.value)} style={{ minHeight: '4.75rem', resize: 'vertical' }} />
            </Field>

            <Field label="结果">
              <textarea className="input-field" value={form.result ?? ''} onChange={(event) => updateField('result', event.target.value)} style={{ minHeight: '4.75rem', resize: 'vertical' }} />
            </Field>

            <Field label="关联伏笔 ID">
              <input className="input-field" value={foreshadowText} onChange={(event) => setForeshadowText(event.target.value)} placeholder="用逗号分隔" />
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
