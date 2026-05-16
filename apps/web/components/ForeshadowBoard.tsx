import React, { useState, useMemo } from 'react';
import { ProjectSummary, ForeshadowItem } from '../types/dashboard';

interface Props {
  selectedProject?: ProjectSummary;
  selectedProjectId: string;
  foreshadowTracks: ForeshadowItem[];
  onRefresh: () => void;
}

const STATUS_COLUMNS = [
  { key: 'planned', label: '已规划', color: '#f59e0b', icon: '📌' },
  { key: 'planted', label: '已埋设', color: '#0ea5e9', icon: '🌱' },
  { key: 'triggered', label: '已触发', color: '#10b981', icon: '⚡' },
  { key: 'resolved', label: '已揭示', color: '#6366f1', icon: '✅' },
];

const SCOPE_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'book', label: '全书' },
  { value: 'cross_volume', label: '跨卷' },
  { value: 'volume', label: '卷内' },
  { value: 'cross_chapter', label: '跨章节' },
  { value: 'chapter', label: '章节内' },
];

const SCOPE_INFO: Record<string, { label: string; color: string }> = {
  book: { label: '全书', color: '#ec4899' },
  cross_volume: { label: '跨卷', color: '#8b5cf6' },
  volume: { label: '卷内', color: '#14b8a6' },
  cross_chapter: { label: '跨章节', color: '#0ea5e9' },
  chapter: { label: '章节内', color: '#f97316' },
};

const SCOPE_ALIASES: Record<string, string> = {
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
  guided: '引导生成',
  auto_extracted: '自动提取',
  manual: '手动添加',
};

function normalizeScope(scope?: string | null) {
  if (!scope) return 'chapter';
  return SCOPE_ALIASES[scope] ?? scope;
}

export function ForeshadowBoard({ selectedProject, selectedProjectId, foreshadowTracks, onRefresh }: Props) {
  const [filterScope, setFilterScope] = useState<string>('');

  const filtered = useMemo(() => {
    if (!filterScope) return foreshadowTracks;
    return foreshadowTracks.filter((t) => normalizeScope(t.scope) === filterScope);
  }, [foreshadowTracks, filterScope]);

  // Group by status
  const columns = useMemo(() => {
    const map = new Map<string, ForeshadowItem[]>();
    for (const col of STATUS_COLUMNS) {
      map.set(col.key, []);
    }
    for (const track of filtered) {
      const col = map.get(track.status) ?? map.get('planned')!;
      col.push(track);
    }
    return map;
  }, [filtered]);

  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      {/* Header */}
      <header
        className="flex items-center justify-between shrink-0"
        style={{
          height: '3.5rem',
          background: 'var(--bg-editor-header)',
          padding: '0 2rem',
          borderBottom: '1px solid var(--border-light)',
          backdropFilter: 'blur(12px)',
          zIndex: 10,
        }}
      >
        <div className="flex items-center gap-3">
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ec4899', boxShadow: '0 0 10px rgba(236,72,153,0.5)' }} />
          <h1 className="text-lg font-bold text-heading" style={{ textShadow: '0 2px 10px var(--accent-cyan-glow)' }}>
            伏笔看板
          </h1>
          <span className="badge" style={{ background: 'rgba(236,72,153,0.12)', color: '#ec4899', border: 'none' }}>Foreshadow</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>{selectedProject?.title ?? '未选择项目'}</div>
          <button className="btn-secondary" onClick={onRefresh} style={{ fontSize: '0.7rem' }}>刷新</button>
        </div>
      </header>

      {/* Filter & stats */}
      <div
        className="flex items-center justify-between shrink-0"
        style={{ padding: '0.75rem 2rem', borderBottom: '1px solid var(--border-dim)', background: 'var(--bg-card)' }}
      >
        <div className="flex items-center gap-2">
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
        <div className="text-xs" style={{ color: 'var(--text-dim)' }}>
          共 {filtered.length} 条伏笔
        </div>
      </div>

      {/* Kanban board */}
      <div className="flex-1 flex gap-4 p-6" style={{ overflowX: 'auto', minHeight: 0 }}>
        {!selectedProjectId ? (
          <div className="flex items-center justify-center w-full text-sm" style={{ color: 'var(--text-dim)' }}>
            请先选择一个项目
          </div>
        ) : (
          STATUS_COLUMNS.map((col) => {
            const items = columns.get(col.key) ?? [];
            return (
              <div
                key={col.key}
                className="flex flex-col shrink-0"
                style={{ width: '18rem', minHeight: 0 }}
              >
                {/* Column header */}
                <div
                  className="flex items-center justify-between mb-3"
                  style={{
                    padding: '0.5rem 0.75rem',
                    borderRadius: '0.5rem',
                    background: `${col.color}12`,
                    border: `1px solid ${col.color}30`,
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span>{col.icon}</span>
                    <span className="text-sm font-bold" style={{ color: col.color }}>{col.label}</span>
                  </div>
                  <span
                    style={{
                      fontSize: '0.65rem',
                      background: `${col.color}20`,
                      color: col.color,
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontWeight: 600,
                    }}
                  >
                    {items.length}
                  </span>
                </div>

                {/* Column cards */}
                <div className="flex-1 space-y-2" style={{ overflowY: 'auto' }}>
                  {items.length === 0 ? (
                    <div className="text-xs text-center py-8" style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>
                      暂无
                    </div>
                  ) : (
                    items.map((track) => (
                      <ForeshadowCard key={track.id} track={track} />
                    ))
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </article>
  );
}

function ForeshadowCard({ track }: { track: ForeshadowItem }) {
  const normalizedScope = normalizeScope(track.scope);
  const scopeInfo = SCOPE_INFO[normalizedScope];
  const scopeColor = scopeInfo?.color ?? '#f97316';
  const sourceLabel = SOURCE_LABELS[track.source ?? 'manual'] ?? '手动';

  return (
    <div
      className="panel p-3 animate-fade-in"
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-light)',
        cursor: 'default',
      }}
    >
      <h4 className="text-xs font-bold mb-1.5" style={{ color: 'var(--text-main)', lineHeight: 1.4 }}>
        {track.title}
      </h4>

      {track.detail && (
        <p className="text-xs mb-2" style={{ color: 'var(--text-muted)', lineHeight: 1.5, maxHeight: '3rem', overflow: 'hidden' }}>
          {track.detail}
        </p>
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        {track.scope && (
          <span
            className="badge"
            style={{
              background: `${scopeColor}15`,
              color: scopeColor,
              border: 'none',
              fontSize: '0.55rem',
              padding: '1px 5px',
            }}
          >
            {scopeInfo?.label ?? track.scope}
          </span>
        )}
        <span
          className="badge"
          style={{
            background: 'var(--bg-hover-subtle)',
            color: 'var(--text-dim)',
            border: 'none',
            fontSize: '0.55rem',
            padding: '1px 5px',
          }}
        >
          {sourceLabel}
        </span>
        {track.firstSeenChapterNo != null && (
          <span className="text-xs" style={{ color: 'var(--text-dim)', fontSize: '0.55rem' }}>
            Ch.{track.firstSeenChapterNo}
            {track.lastSeenChapterNo != null && track.lastSeenChapterNo !== track.firstSeenChapterNo
              ? `→${track.lastSeenChapterNo}`
              : ''}
          </span>
        )}
      </div>
    </div>
  );
}
