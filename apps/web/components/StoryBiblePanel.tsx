import React, { useEffect, useMemo, useState } from 'react';
import { LorebookEntry, ProjectSummary, StoryBibleEntryType } from '../types/dashboard';
import { LorebookFormData, useLorebookActions } from '../hooks/useLorebookActions';

type StoryBibleTabKey = StoryBibleEntryType | 'all';

const ENTRY_TYPE_TABS: Array<{ key: StoryBibleEntryType; label: string; color: string }> = [
  { key: 'world_rule', label: '世界观', color: '#10b981' },
  { key: 'power_system', label: '力量体系', color: '#0ea5e9' },
  { key: 'faction', label: '势力组织', color: '#f59e0b' },
  { key: 'faction_relation', label: '势力关系', color: '#fb7185' },
  { key: 'location', label: '地点地图', color: '#14b8a6' },
  { key: 'item', label: '物品道具', color: '#a855f7' },
  { key: 'history_event', label: '历史事件', color: '#64748b' },
  { key: 'religion', label: '宗教信仰', color: '#c084fc' },
  { key: 'economy', label: '经济制度', color: '#22c55e' },
  { key: 'technology', label: '科技工艺', color: '#06b6d4' },
  { key: 'forbidden_rule', label: '规则禁忌', color: '#ef4444' },
  { key: 'setting', label: '通用设定', color: '#94a3b8' },
];

const STORY_BIBLE_TABS: Array<{ key: StoryBibleTabKey; label: string; color: string }> = [
  { key: 'all', label: '全部', color: '#38bdf8' },
  ...ENTRY_TYPE_TABS,
];

const EMPTY_FORM: LorebookFormData = {
  title: '',
  entryType: 'world_rule',
  content: '',
  summary: '',
  tags: [],
  priority: 50,
  status: 'active',
  metadata: {},
};

interface Props {
  selectedProject?: ProjectSummary;
  selectedProjectId: string;
}

export function StoryBiblePanel({ selectedProject, selectedProjectId }: Props) {
  const [activeType, setActiveType] = useState<StoryBibleTabKey>('all');
  const [editingEntry, setEditingEntry] = useState<LorebookEntry | null>(null);
  const [form, setForm] = useState<LorebookFormData>(EMPTY_FORM);
  const [metadataText, setMetadataText] = useState('{}');
  const [localError, setLocalError] = useState('');
  const { entries, loading, formLoading, error, setError, loadEntries, createEntry, updateEntry, deleteEntry } = useLorebookActions(selectedProjectId);

  const activeTab = useMemo(() => STORY_BIBLE_TABS.find((tab) => tab.key === activeType) ?? STORY_BIBLE_TABS[0], [activeType]);
  const filteredEntries = useMemo(
    () => activeType === 'all' ? entries : entries.filter((entry) => normalizeEntryTypeForForm(entry.entryType) === activeType),
    [activeType, entries],
  );
  const entryCounts = useMemo(() => {
    const counts = new Map<StoryBibleTabKey, number>([['all', entries.length]]);
    for (const tab of ENTRY_TYPE_TABS) counts.set(tab.key, 0);
    for (const entry of entries) {
      const key = normalizeEntryTypeForForm(entry.entryType);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [entries]);

  useEffect(() => {
    if (selectedProjectId) {
      void loadEntries();
    }
  }, [loadEntries, selectedProjectId]);

  const resetForm = (entryType: StoryBibleEntryType = activeType === 'all' ? 'world_rule' : activeType) => {
    setEditingEntry(null);
    setForm({ ...EMPTY_FORM, entryType });
    setMetadataText('{}');
    setLocalError('');
    setError('');
  };

  const openEdit = (entry: LorebookEntry) => {
    setEditingEntry(entry);
    setForm({
      title: entry.title,
      entryType: normalizeEntryTypeForForm(entry.entryType),
      content: entry.content,
      summary: entry.summary ?? '',
      tags: entry.tags ?? [],
      priority: entry.priority ?? 50,
      status: entry.status,
      metadata: entry.metadata ?? {},
    });
    setMetadataText(JSON.stringify(entry.metadata ?? {}, null, 2));
    setLocalError('');
    setError('');
  };

  const updateField = <K extends keyof LorebookFormData>(key: K, value: LorebookFormData[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = async () => {
    setLocalError('');
    const title = form.title.trim();
    const content = form.content.trim();
    if (!title || !content) {
      setLocalError('标题和正文不能为空。');
      return;
    }

    let metadata: Record<string, unknown>;
    try {
      metadata = parseJsonObject(metadataText);
    } catch (parseError) {
      setLocalError(parseError instanceof Error ? parseError.message : 'metadata 不是有效 JSON 对象。');
      return;
    }

    const payload: LorebookFormData = {
      ...form,
      title,
      content,
      summary: form.summary?.trim() || undefined,
      tags: normalizeTags(form.tags),
      priority: Number(form.priority) || 50,
      entryType: form.entryType,
      metadata,
    };

    const ok = editingEntry ? await updateEntry(editingEntry.id, payload) : await createEntry(payload);
    if (!ok) return;
    await loadEntries();
    resetForm(activeType === 'all' ? form.entryType : activeType);
  };

  const handleDelete = async (entry: LorebookEntry) => {
    const ok = window.confirm(`删除「${entry.title}」？`);
    if (!ok) return;
    const deleted = await deleteEntry(entry.id);
    if (deleted) {
      await loadEntries();
      if (editingEntry?.id === entry.id) resetForm(activeType === 'all' ? 'world_rule' : activeType);
    }
  };

  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      <header className="flex items-center justify-between shrink-0" style={{ height: '3.5rem', background: 'var(--bg-editor-header)', padding: '0 2rem', borderBottom: '1px solid var(--border-light)', backdropFilter: 'blur(12px)', zIndex: 10 }}>
        <div className="flex items-center gap-3">
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: activeTab.color, boxShadow: `0 0 10px ${activeTab.color}80` }} />
          <h1 className="text-lg font-bold text-heading">世界设定</h1>
          <span className="badge" style={{ background: `${activeTab.color}20`, color: activeTab.color, border: 'none' }}>Story Bible</span>
        </div>
        <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>{selectedProject?.title ?? '未选择项目'}</div>
      </header>

      <div className="flex shrink-0" style={{ borderBottom: '1px solid var(--border-dim)', padding: '0 2rem', background: 'var(--bg-card)', overflowX: 'auto' }}>
        {STORY_BIBLE_TABS.map((tab) => (
          <button key={tab.key} onClick={() => { setActiveType(tab.key); resetForm(tab.key === 'all' ? 'world_rule' : tab.key); }} style={{ padding: '0.65rem 1rem', fontSize: '0.8rem', fontWeight: activeType === tab.key ? 700 : 500, color: activeType === tab.key ? tab.color : 'var(--text-dim)', background: 'transparent', border: 'none', borderBottom: activeType === tab.key ? `2px solid ${tab.color}` : '2px solid transparent', cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: '-1px' }}>
            {tab.label}
            <span style={{ marginLeft: '0.35rem', opacity: 0.65 }}>{entryCounts.get(tab.key) ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="grid flex-1 min-h-0" style={{ gridTemplateColumns: 'minmax(18rem, 0.9fr) minmax(24rem, 1.1fr)', gap: '1rem', padding: '1.25rem 1.5rem', overflow: 'hidden' }}>
        <section className="panel flex flex-col min-h-0" style={{ overflow: 'hidden' }}>
          <div className="flex items-center justify-between shrink-0 p-4" style={{ borderBottom: '1px solid var(--border-dim)' }}>
            <div>
              <h2 className="text-base font-bold text-heading">{activeTab.label}</h2>
              <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{filteredEntries.length} 条</p>
            </div>
            <button className="btn-secondary" onClick={() => resetForm(activeType === 'all' ? 'world_rule' : activeType)} disabled={formLoading}>新建</button>
          </div>
          <div className="flex-1 min-h-0" style={{ overflowY: 'auto' }}>
            {loading ? (
              <div className="p-4 text-sm" style={{ color: 'var(--text-dim)' }}>加载中…</div>
            ) : filteredEntries.length === 0 ? (
              <div className="p-4 text-sm" style={{ color: 'var(--text-dim)' }}>暂无条目</div>
            ) : (
              <div className="space-y-2 p-3">
                {filteredEntries.map((entry) => (
                  <button key={entry.id} onClick={() => openEdit(entry)} className="w-full text-left" style={{ border: `1px solid ${editingEntry?.id === entry.id ? activeTab.color : 'var(--border-dim)'}`, background: editingEntry?.id === entry.id ? `${activeTab.color}12` : 'var(--bg-card)', borderRadius: '0.5rem', padding: '0.8rem', cursor: 'pointer' }}>
                    <div className="flex items-center justify-between gap-3">
                      <strong className="text-sm truncate" style={{ color: 'var(--text-main)' }}>{entry.title}</strong>
                      <span className="text-xs" style={{ color: entry.status === 'active' ? '#10b981' : '#f59e0b' }}>{entry.status}</span>
                    </div>
                    <p className="mt-1 text-xs line-clamp-2" style={{ color: 'var(--text-dim)' }}>{entry.summary || entry.content}</p>
                    {entry.tags?.length ? <div className="mt-2 flex flex-wrap gap-1">{entry.tags.slice(0, 4).map((tag) => <span key={tag} className="badge" style={{ fontSize: '0.65rem' }}>{tag}</span>)}</div> : null}
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="panel flex flex-col min-h-0" style={{ overflow: 'hidden' }}>
          <div className="flex items-center justify-between shrink-0 p-4" style={{ borderBottom: '1px solid var(--border-dim)' }}>
            <h2 className="text-base font-bold text-heading">{editingEntry ? '编辑条目' : '新建条目'}</h2>
            {editingEntry && <button className="btn-danger" onClick={() => handleDelete(editingEntry)} disabled={formLoading}>删除</button>}
          </div>
          <div className="flex-1 min-h-0 p-4 space-y-3" style={{ overflowY: 'auto' }}>
            <label className="block text-xs font-bold" style={{ color: 'var(--text-muted)' }}>分类</label>
            <select className="input-field" value={form.entryType} onChange={(event) => updateField('entryType', event.target.value as StoryBibleEntryType)}>
              {ENTRY_TYPE_TABS.map((tab) => (
                <option key={tab.key} value={tab.key}>{tab.label}</option>
              ))}
            </select>

            <label className="block text-xs font-bold" style={{ color: 'var(--text-muted)' }}>标题</label>
            <input className="input-field" value={form.title} onChange={(event) => updateField('title', event.target.value)} />

            <label className="block text-xs font-bold" style={{ color: 'var(--text-muted)' }}>摘要</label>
            <input className="input-field" value={form.summary ?? ''} onChange={(event) => updateField('summary', event.target.value)} />

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold mb-1" style={{ color: 'var(--text-muted)' }}>优先级</label>
                <input className="input-field" type="number" min={0} max={100} value={form.priority ?? 50} onChange={(event) => updateField('priority', Number(event.target.value))} />
              </div>
              <div>
                <label className="block text-xs font-bold mb-1" style={{ color: 'var(--text-muted)' }}>状态</label>
                <select className="input-field" value={form.status ?? 'active'} onChange={(event) => updateField('status', event.target.value)}>
                  <option value="active">active</option>
                  <option value="locked">locked</option>
                  <option value="pending_review">pending_review</option>
                  <option value="archived">archived</option>
                </select>
              </div>
            </div>

            <label className="block text-xs font-bold" style={{ color: 'var(--text-muted)' }}>标签</label>
            <input className="input-field" value={(form.tags ?? []).join(', ')} onChange={(event) => updateField('tags', event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean))} />

            <label className="block text-xs font-bold" style={{ color: 'var(--text-muted)' }}>正文</label>
            <textarea className="input-field" value={form.content} onChange={(event) => updateField('content', event.target.value)} style={{ minHeight: '12rem', resize: 'vertical', lineHeight: 1.6 }} />

            <label className="block text-xs font-bold" style={{ color: 'var(--text-muted)' }}>metadata JSON</label>
            <textarea className="input-field font-mono" value={metadataText} onChange={(event) => setMetadataText(event.target.value)} style={{ minHeight: '8rem', resize: 'vertical', fontSize: '0.78rem', lineHeight: 1.5 }} />

            {(localError || error) && <div className="text-xs" style={{ color: 'var(--status-err)', background: 'var(--status-err-bg)', borderRadius: '0.5rem', padding: '0.6rem' }}>{localError || error}</div>}
          </div>
          <div className="flex justify-end gap-3 shrink-0 p-4" style={{ borderTop: '1px solid var(--border-dim)' }}>
            <button className="btn-secondary" onClick={() => resetForm(activeType === 'all' ? 'world_rule' : activeType)} disabled={formLoading}>重置</button>
            <button className="btn" onClick={handleSubmit} disabled={formLoading}>{formLoading ? '保存中…' : '保存'}</button>
          </div>
        </section>
      </div>
    </article>
  );
}

function normalizeTags(tags?: string[]) {
  return Array.from(new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean)));
}

function normalizeEntryTypeForForm(value: string): StoryBibleEntryType {
  if (ENTRY_TYPE_TABS.some((tab) => tab.key === value)) return value as StoryBibleEntryType;
  const normalized = value.trim().replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (normalized === 'worldrule') return 'world_rule';
  if (normalized === 'powersystem') return 'power_system';
  if (normalized === 'factionrelation' || normalized === 'relationship') return 'faction_relation';
  if (normalized === 'historyevent' || normalized === 'history') return 'history_event';
  if (normalized === 'forbiddenrule' || normalized === 'rule') return 'forbidden_rule';
  if (normalized === 'place') return 'location';
  if (normalized === 'organization' || normalized === 'organisation') return 'faction';
  return 'setting';
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = value.trim() ? JSON.parse(value) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('metadata 必须是 JSON 对象。');
  }
  return parsed as Record<string, unknown>;
}
