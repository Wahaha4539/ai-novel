import React, { useMemo, useState } from 'react';
import { ChapterSummary, ForeshadowItem, ProjectSummary } from '../types/dashboard';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3001/api';

type ForeshadowStatus = 'planned' | 'planted' | 'triggered' | 'resolved';
type ForeshadowScope = 'book' | 'cross_volume' | 'volume' | 'cross_chapter' | 'chapter';

type ForeshadowFormState = {
  title: string;
  detail: string;
  status: ForeshadowStatus;
  scope: ForeshadowScope;
  source: string;
  chapterNo: string;
  firstSeenChapterNo: string;
  lastSeenChapterNo: string;
};

interface Props {
  selectedProject?: ProjectSummary;
  selectedProjectId: string;
  foreshadowTracks: ForeshadowItem[];
  chapters?: ChapterSummary[];
  onRefresh: () => void | Promise<void>;
}

const EMPTY_FORM: ForeshadowFormState = {
  title: '',
  detail: '',
  status: 'planned',
  scope: 'chapter',
  source: 'manual',
  chapterNo: '',
  firstSeenChapterNo: '',
  lastSeenChapterNo: '',
};

const STATUS_COLUMNS: Array<{ key: ForeshadowStatus; label: string; color: string; icon: string }> = [
  { key: 'planned', label: '已规划', color: '#f59e0b', icon: '⌖' },
  { key: 'planted', label: '已埋设', color: '#0ea5e9', icon: '◇' },
  { key: 'triggered', label: '已触发', color: '#10b981', icon: '↯' },
  { key: 'resolved', label: '已揭示', color: '#6366f1', icon: '✓' },
];

const STATUS_OPTIONS = STATUS_COLUMNS.map((item) => ({ value: item.key, label: item.label }));

const SCOPE_OPTIONS: Array<{ value: '' | ForeshadowScope; label: string }> = [
  { value: '', label: '全部' },
  { value: 'book', label: '全书' },
  { value: 'cross_volume', label: '跨卷' },
  { value: 'volume', label: '卷内' },
  { value: 'cross_chapter', label: '跨章节' },
  { value: 'chapter', label: '章节内' },
];

const SCOPE_INFO: Record<ForeshadowScope, { label: string; color: string }> = {
  book: { label: '全书', color: '#ec4899' },
  cross_volume: { label: '跨卷', color: '#8b5cf6' },
  volume: { label: '卷内', color: '#14b8a6' },
  cross_chapter: { label: '跨章节', color: '#0ea5e9' },
  chapter: { label: '章节内', color: '#f97316' },
};

const SCOPE_ALIASES: Record<string, ForeshadowScope> = {
  arc: 'book',
  global: 'book',
  whole_book: 'book',
  full_book: 'book',
  cross_arc: 'cross_volume',
  volume_arc: 'volume',
  chapter_arc: 'cross_chapter',
  local: 'chapter',
};

const SOURCE_LABELS: Record<string, string> = {
  guided: 'Agent 规划',
  auto_extracted: '自动提取',
  manual: '手动添加',
  project_outline: '全书大纲',
  volume_outline: '卷纲',
  chapter_outline: '章节细纲',
};

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `请求失败：${response.status}`);
  }

  const text = await response.text();
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

function normalizeScope(scope?: string | null): ForeshadowScope {
  if (!scope) return 'chapter';
  return SCOPE_ALIASES[scope] ?? (SCOPE_INFO[scope as ForeshadowScope] ? scope as ForeshadowScope : 'chapter');
}

function normalizeStatus(status?: string | null): ForeshadowStatus {
  return STATUS_COLUMNS.some((item) => item.key === status) ? status as ForeshadowStatus : 'planned';
}

export function ForeshadowBoard({ selectedProject, selectedProjectId, foreshadowTracks, chapters = [], onRefresh }: Props) {
  const [filterScope, setFilterScope] = useState<string>('');
  const [editingTrack, setEditingTrack] = useState<ForeshadowItem | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<ForeshadowFormState>(EMPTY_FORM);
  const [metadataText, setMetadataText] = useState('{}');
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState('');

  const filtered = useMemo(() => {
    if (!filterScope) return foreshadowTracks;
    return foreshadowTracks.filter((track) => normalizeScope(track.scope) === filterScope);
  }, [foreshadowTracks, filterScope]);

  const columns = useMemo(() => {
    const map = new Map<ForeshadowStatus, ForeshadowItem[]>();
    for (const col of STATUS_COLUMNS) map.set(col.key, []);
    for (const track of filtered) {
      const status = normalizeStatus(track.status);
      map.get(status)?.push(track);
    }
    return map;
  }, [filtered]);

  const openCreate = () => {
    setEditingTrack(null);
    setForm(EMPTY_FORM);
    setMetadataText('{}');
    setFormError('');
    setNotice('');
    setFormOpen(true);
  };

  const openEdit = (track: ForeshadowItem) => {
    setEditingTrack(track);
    setForm({
      title: track.title ?? '',
      detail: track.detail ?? '',
      status: normalizeStatus(track.status),
      scope: normalizeScope(track.scope),
      source: track.source ?? 'manual',
      chapterNo: formatInputNumber(track.chapterNo),
      firstSeenChapterNo: formatInputNumber(track.firstSeenChapterNo),
      lastSeenChapterNo: formatInputNumber(track.lastSeenChapterNo),
    });
    setMetadataText(JSON.stringify(track.metadata ?? {}, null, 2));
    setFormError('');
    setNotice('');
    setFormOpen(true);
  };

  const updateField = <K extends keyof ForeshadowFormState>(key: K, value: ForeshadowFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setFormError('');
    setNotice('');
  };

  const handleSubmit = async () => {
    if (!selectedProjectId || saving) return;
    setFormError('');
    setNotice('');

    const title = form.title.trim();
    if (!title) {
      setFormError('伏笔标题不能为空。');
      return;
    }

    let metadata: Record<string, unknown>;
    let chapterNo: number | null;
    let firstSeenChapterNo: number | null;
    let lastSeenChapterNo: number | null;
    try {
      metadata = parseJsonObject(metadataText);
      chapterNo = parseOptionalPositiveInt(form.chapterNo, '归属章节');
      firstSeenChapterNo = parseOptionalPositiveInt(form.firstSeenChapterNo, '首次出现章节');
      lastSeenChapterNo = parseOptionalPositiveInt(form.lastSeenChapterNo, '回收章节');
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '表单格式错误。');
      return;
    }

    if (firstSeenChapterNo != null && lastSeenChapterNo != null && firstSeenChapterNo > lastSeenChapterNo) {
      setFormError('首次出现章节不能晚于回收章节。');
      return;
    }

    const payload = {
      title,
      detail: form.detail.trim() || null,
      status: form.status,
      scope: form.scope,
      source: form.source.trim() || 'manual',
      chapterNo,
      firstSeenChapterNo,
      lastSeenChapterNo,
      metadata,
    };

    setSaving(true);
    try {
      if (editingTrack) {
        await apiFetch<ForeshadowItem>(`/projects/${selectedProjectId}/foreshadow-tracks/${editingTrack.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        setNotice('伏笔已更新。');
      } else {
        await apiFetch<ForeshadowItem>(`/projects/${selectedProjectId}/foreshadow-tracks`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setNotice('伏笔已添加。');
      }
      await onRefresh();
      setFormOpen(false);
      setEditingTrack(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '保存伏笔失败。');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (track: ForeshadowItem) => {
    if (!selectedProjectId || deletingId) return;
    if (!window.confirm(`删除伏笔「${track.title}」？`)) return;

    setDeletingId(track.id);
    setFormError('');
    setNotice('');
    try {
      await apiFetch(`/projects/${selectedProjectId}/foreshadow-tracks/${track.id}`, { method: 'DELETE' });
      if (editingTrack?.id === track.id) {
        setFormOpen(false);
        setEditingTrack(null);
      }
      await onRefresh();
      setNotice('伏笔已删除。');
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '删除伏笔失败。');
    } finally {
      setDeletingId('');
    }
  };

  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      <header className="flex items-center justify-between shrink-0" style={{ height: '3.5rem', background: 'var(--bg-editor-header)', padding: '0 2rem', borderBottom: '1px solid var(--border-light)', backdropFilter: 'blur(12px)', zIndex: 10 }}>
        <div className="flex items-center gap-3">
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ec4899', boxShadow: '0 0 10px rgba(236,72,153,0.5)' }} />
          <h1 className="text-lg font-bold text-heading" style={{ textShadow: '0 2px 10px var(--accent-cyan-glow)' }}>伏笔看板</h1>
          <span className="badge" style={{ background: 'rgba(236,72,153,0.12)', color: '#ec4899', border: 'none' }}>Foreshadow</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>{selectedProject?.title ?? '未选择项目'}</div>
          <button className="btn-secondary" onClick={onRefresh} style={{ fontSize: '0.7rem' }}>刷新</button>
          <button className="btn" onClick={openCreate} disabled={!selectedProjectId} style={{ fontSize: '0.72rem' }}>＋ 新建伏笔</button>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3 shrink-0" style={{ padding: '0.75rem 2rem', borderBottom: '1px solid var(--border-dim)', background: 'var(--bg-card)' }}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>范围筛选：</span>
          {SCOPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setFilterScope(opt.value)}
              style={{
                fontSize: '0.7rem',
                padding: '0.2rem 0.5rem',
                borderRadius: '0.4rem',
                border: filterScope === opt.value ? '1px solid #ec4899' : '1px solid var(--border-dim)',
                background: filterScope === opt.value ? 'rgba(236,72,153,0.12)' : 'transparent',
                color: filterScope === opt.value ? '#ec4899' : 'var(--text-muted)',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {notice ? <span className="text-xs" style={{ color: '#10b981' }}>{notice}</span> : null}
          {formError && !formOpen ? <span className="text-xs" style={{ color: 'var(--status-err)' }}>{formError}</span> : null}
          <div className="text-xs" style={{ color: 'var(--text-dim)' }}>共 {filtered.length} 条伏笔</div>
        </div>
      </div>

      <div className="flex-1 flex gap-4 p-6" style={{ overflowX: 'auto', minHeight: 0 }}>
        {!selectedProjectId ? (
          <div className="flex items-center justify-center w-full text-sm" style={{ color: 'var(--text-dim)' }}>请先选择一个项目</div>
        ) : (
          STATUS_COLUMNS.map((col) => {
            const items = columns.get(col.key) ?? [];
            return (
              <div key={col.key} className="flex flex-col shrink-0" style={{ width: '18rem', minHeight: 0 }}>
                <div className="flex items-center justify-between mb-3" style={{ padding: '0.5rem 0.75rem', borderRadius: '0.5rem', background: `${col.color}12`, border: `1px solid ${col.color}30` }}>
                  <div className="flex items-center gap-2">
                    <span style={{ color: col.color }}>{col.icon}</span>
                    <span className="text-sm font-bold" style={{ color: col.color }}>{col.label}</span>
                  </div>
                  <span style={{ fontSize: '0.65rem', background: `${col.color}20`, color: col.color, padding: '2px 6px', borderRadius: '4px', fontWeight: 600 }}>{items.length}</span>
                </div>

                <div className="flex-1 space-y-2" style={{ overflowY: 'auto' }}>
                  {items.length === 0 ? (
                    <div className="text-xs text-center py-8" style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>暂无</div>
                  ) : (
                    items.map((track) => (
                      <ForeshadowCard
                        key={track.id}
                        track={track}
                        disabled={saving || Boolean(deletingId)}
                        deleting={deletingId === track.id}
                        onEdit={() => openEdit(track)}
                        onDelete={() => handleDelete(track)}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {formOpen ? (
        <ForeshadowFormModal
          editingTrack={editingTrack}
          form={form}
          metadataText={metadataText}
          chapters={chapters}
          saving={saving}
          error={formError}
          onUpdate={updateField}
          onMetadataChange={setMetadataText}
          onClose={() => {
            if (saving) return;
            setFormOpen(false);
            setEditingTrack(null);
            setFormError('');
          }}
          onSubmit={handleSubmit}
        />
      ) : null}
    </article>
  );
}

function ForeshadowCard({ track, disabled, deleting, onEdit, onDelete }: { track: ForeshadowItem; disabled: boolean; deleting: boolean; onEdit: () => void; onDelete: () => void }) {
  const normalizedScope = normalizeScope(track.scope);
  const scopeInfo = SCOPE_INFO[normalizedScope];
  const sourceLabel = SOURCE_LABELS[track.source ?? 'manual'] ?? track.source ?? '手动';
  const status = STATUS_COLUMNS.find((item) => item.key === normalizeStatus(track.status)) ?? STATUS_COLUMNS[0];

  return (
    <div className="panel p-3 animate-fade-in" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-light)' }}>
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-xs font-bold mb-1.5" style={{ color: 'var(--text-main)', lineHeight: 1.4 }}>{track.title}</h4>
        <span style={{ width: '0.45rem', height: '0.45rem', borderRadius: '999px', background: status.color, marginTop: '0.25rem', flexShrink: 0 }} />
      </div>

      {track.detail ? <p className="text-xs mb-2" style={{ color: 'var(--text-muted)', lineHeight: 1.5, maxHeight: '3.25rem', overflow: 'hidden' }}>{track.detail}</p> : null}

      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="badge" style={{ background: `${scopeInfo.color}15`, color: scopeInfo.color, border: 'none', fontSize: '0.55rem', padding: '1px 5px' }}>{scopeInfo.label}</span>
        <span className="badge" style={{ background: 'var(--bg-hover-subtle)', color: 'var(--text-dim)', border: 'none', fontSize: '0.55rem', padding: '1px 5px' }}>{sourceLabel}</span>
        {displayChapterRange(track) ? <span className="text-xs" style={{ color: 'var(--text-dim)', fontSize: '0.55rem' }}>{displayChapterRange(track)}</span> : null}
      </div>

      <div className="flex items-center justify-end gap-2 mt-3">
        <button className="btn-secondary" onClick={onEdit} disabled={disabled} style={{ fontSize: '0.62rem', padding: '0.25rem 0.5rem' }}>编辑</button>
        <button className="btn-danger" onClick={onDelete} disabled={disabled} style={{ fontSize: '0.62rem', padding: '0.25rem 0.5rem' }}>{deleting ? '删除中' : '删除'}</button>
      </div>
    </div>
  );
}

function ForeshadowFormModal({
  editingTrack,
  form,
  metadataText,
  chapters,
  saving,
  error,
  onUpdate,
  onMetadataChange,
  onClose,
  onSubmit,
}: {
  editingTrack: ForeshadowItem | null;
  form: ForeshadowFormState;
  metadataText: string;
  chapters: ChapterSummary[];
  saving: boolean;
  error: string;
  onUpdate: <K extends keyof ForeshadowFormState>(key: K, value: ForeshadowFormState[K]) => void;
  onMetadataChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="fixed inset-0 flex items-center justify-center" style={{ background: 'rgba(15,23,42,0.34)', backdropFilter: 'blur(8px)', zIndex: 50, padding: '1.25rem' }}>
      <section className="panel flex flex-col" style={{ width: 'min(46rem, 96vw)', maxHeight: '90vh', overflow: 'hidden', border: '1px solid rgba(236,72,153,0.28)', boxShadow: '0 24px 70px rgba(15,23,42,0.24)' }}>
        <div className="flex items-center justify-between shrink-0 p-4" style={{ borderBottom: '1px solid var(--border-dim)' }}>
          <div>
            <h2 className="text-base font-bold text-heading">{editingTrack ? '编辑伏笔' : '新建伏笔'}</h2>
            <p className="text-xs mt-1" style={{ color: 'var(--text-dim)' }}>{editingTrack ? '修改后会立即影响后续正文召回。' : '手动添加的伏笔会进入后续章节生成上下文。'}</p>
          </div>
          <button className="btn-secondary" onClick={onClose} disabled={saving} style={{ fontSize: '0.72rem' }}>关闭</button>
        </div>

        <div className="flex-1 min-h-0 p-4 space-y-3" style={{ overflowY: 'auto' }}>
          <Field label="标题">
            <input className="input-field" value={form.title} onChange={(event) => onUpdate('title', event.target.value)} placeholder="例如：低城钟楼倾角一厘" />
          </Field>

          <Field label="详情">
            <textarea className="input-field" value={form.detail} onChange={(event) => onUpdate('detail', event.target.value)} placeholder="写清楚埋设方式、可见证据、后续回收方式。" style={{ minHeight: '7rem', resize: 'vertical', lineHeight: 1.6 }} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="状态">
              <select className="input-field" value={form.status} onChange={(event) => onUpdate('status', event.target.value as ForeshadowStatus)}>
                {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </Field>
            <Field label="影响范围">
              <select className="input-field" value={form.scope} onChange={(event) => onUpdate('scope', event.target.value as ForeshadowScope)}>
                {SCOPE_OPTIONS.filter((item) => item.value).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field label="归属章节">
              <input className="input-field" list="foreshadow-chapter-options" type="number" min={1} value={form.chapterNo} onChange={(event) => onUpdate('chapterNo', event.target.value)} placeholder="可空" />
            </Field>
            <Field label="首次出现章节">
              <input className="input-field" type="number" min={1} value={form.firstSeenChapterNo} onChange={(event) => onUpdate('firstSeenChapterNo', event.target.value)} placeholder="可空" />
            </Field>
            <Field label="回收章节">
              <input className="input-field" type="number" min={1} value={form.lastSeenChapterNo} onChange={(event) => onUpdate('lastSeenChapterNo', event.target.value)} placeholder="可空" />
            </Field>
          </div>

          <datalist id="foreshadow-chapter-options">
            {chapters.map((chapter) => <option key={chapter.id} value={chapter.chapterNo}>{chapter.title ?? `第 ${chapter.chapterNo} 章`}</option>)}
          </datalist>

          <Field label="来源">
            <select className="input-field" value={form.source} onChange={(event) => onUpdate('source', event.target.value)}>
              <option value="manual">手动添加</option>
              <option value="project_outline">全书大纲</option>
              <option value="volume_outline">卷纲</option>
              <option value="chapter_outline">章节细纲</option>
              <option value="auto_extracted">自动提取</option>
              <option value="guided">Agent 规划</option>
            </select>
          </Field>

          <Field label="metadata JSON">
            <textarea className="input-field font-mono" value={metadataText} onChange={(event) => onMetadataChange(event.target.value)} style={{ minHeight: '7rem', resize: 'vertical', fontSize: '0.78rem', lineHeight: 1.5 }} />
          </Field>

          {error ? <div className="text-xs" style={{ color: 'var(--status-err)', background: 'var(--status-err-bg)', borderRadius: '0.5rem', padding: '0.6rem' }}>{error}</div> : null}
        </div>

        <div className="flex justify-end gap-3 shrink-0 p-4" style={{ borderTop: '1px solid var(--border-dim)' }}>
          <button className="btn-secondary" onClick={onClose} disabled={saving}>取消</button>
          <button className="btn" onClick={onSubmit} disabled={saving}>{saving ? '保存中...' : '保存伏笔'}</button>
        </div>
      </section>
    </div>
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

function displayChapterRange(track: ForeshadowItem) {
  const first = track.firstSeenChapterNo ?? track.chapterNo;
  const last = track.lastSeenChapterNo;
  if (first == null && last == null) return '';
  if (first != null && last != null && first !== last) return `Ch.${first} → ${last}`;
  return `Ch.${first ?? last}`;
}

function formatInputNumber(value?: number | null) {
  return value == null ? '' : String(value);
}

function parseOptionalPositiveInt(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new Error(`${label}必须是正整数。`);
  }
  return numeric;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = value.trim() ? JSON.parse(value) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('metadata 必须是 JSON 对象。');
  }
  return parsed as Record<string, unknown>;
}
