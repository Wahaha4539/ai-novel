/**
 * VolumeChapterTree — Sidebar tree for navigating volumes and chapters.
 *
 * Features:
 *  - Visual connector lines showing parent→child hierarchy
 *  - Smooth animated expand/collapse transitions
 *  - Status dots on chapters (drafted vs pending)
 *  - Volume progress bar showing drafted/total ratio
 *  - Refined typography with chapter number badges
 *  - Premium hover/active states with subtle glow effects
 */
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { ChapterSummary, VolumeSummary } from '../types/dashboard';

interface Props {
  volumes: VolumeSummary[];
  chapters: ChapterSummary[];
  selectedChapterId: string;
  selectedVolumeId: string;
  onSelectChapter: (id: string) => void;
  onSelectVolume: (id: string) => void;
  onDeleteChapters: (chapterIds: string[]) => Promise<boolean>;
}

/** Map of volume-specific accent colors for visual differentiation */
const VOLUME_COLORS = [
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#10b981', // emerald
  '#f97316', // orange
  '#6366f1', // indigo
  '#14b8a6', // teal
  '#e11d48', // rose
  '#84cc16', // lime
];

/**
 * Returns a deterministic accent color for a volume based on its index.
 * Cycles through VOLUME_COLORS palette to ensure visual variety.
 */
const getVolumeColor = (index: number): string =>
  VOLUME_COLORS[index % VOLUME_COLORS.length];

export function VolumeChapterTree({
  volumes,
  chapters,
  selectedChapterId,
  selectedVolumeId,
  onSelectChapter,
  onSelectVolume,
  onDeleteChapters,
}: Props) {
  const [collapsedVolumes, setCollapsedVolumes] = useState<Set<string>>(new Set());
  const [checkedChapterIds, setCheckedChapterIds] = useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = useState(false);

  /** Group chapters by volumeId for efficient lookup */
  const { volumeChapterMap, unassignedChapters } = useMemo(() => {
    const map = new Map<string, ChapterSummary[]>();
    const unassigned: ChapterSummary[] = [];

    for (const chapter of chapters) {
      if (chapter.volumeId) {
        const existing = map.get(chapter.volumeId) ?? [];
        existing.push(chapter);
        map.set(chapter.volumeId, existing);
      } else {
        unassigned.push(chapter);
      }
    }

    return { volumeChapterMap: map, unassignedChapters: unassigned };
  }, [chapters]);

  const selectedCount = checkedChapterIds.size;
  const allChecked = chapters.length > 0 && selectedCount === chapters.length;

  useEffect(() => {
    const validChapterIds = new Set(chapters.map((chapter) => chapter.id));
    setCheckedChapterIds((prev) => {
      const next = new Set([...prev].filter((id) => validChapterIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [chapters]);

  /** Toggle volume collapsed state */
  const toggleCollapse = (volumeId: string) => {
    setCollapsedVolumes((prev) => {
      const next = new Set(prev);
      if (next.has(volumeId)) {
        next.delete(volumeId);
      } else {
        next.add(volumeId);
      }
      return next;
    });
  };

  const toggleChapterChecked = (chapterId: string) => {
    setCheckedChapterIds((prev) => {
      const next = new Set(prev);
      if (next.has(chapterId)) {
        next.delete(chapterId);
      } else {
        next.add(chapterId);
      }
      return next;
    });
  };

  const toggleAllChecked = () => {
    setCheckedChapterIds(allChecked ? new Set() : new Set(chapters.map((chapter) => chapter.id)));
  };

  const handleDeleteChapters = async (chapterIds: string[]) => {
    const uniqueChapterIds = Array.from(new Set(chapterIds.filter(Boolean)));
    if (!uniqueChapterIds.length || isDeleting) return;

    const targetChapter = chapters.find((chapter) => chapter.id === uniqueChapterIds[0]);
    const targetLabel = uniqueChapterIds.length === 1
      ? formatChapterLabel(targetChapter)
      : `${uniqueChapterIds.length} 个章节`;
    const confirmed = window.confirm(`确认删除 ${targetLabel}？\n删除后无法恢复，相关草稿、事实、校验和场景资料会一并清理。`);
    if (!confirmed) return;

    setIsDeleting(true);
    try {
      const deleted = await onDeleteChapters(uniqueChapterIds);
      if (deleted) {
        setCheckedChapterIds((prev) => {
          const next = new Set(prev);
          uniqueChapterIds.forEach((id) => next.delete(id));
          return next;
        });
      }
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div>
      {/* Section Header */}
      <div className="chapter-tree__header">
        <span>作品目录</span>
        <span className="chapter-tree__count">{chapters.length}章</span>
      </div>

      {chapters.length > 0 && (
        <div className="chapter-tree__bulkbar">
          <button
            type="button"
            className="chapter-tree__bulk-toggle"
            onClick={toggleAllChecked}
            disabled={isDeleting}
          >
            <span className={`chapter-tree__bulk-check ${allChecked ? 'chapter-tree__bulk-check--checked' : ''}`}>
              {allChecked && (
                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </span>
            {allChecked ? '取消全选' : '全选'}
          </button>
          <button
            type="button"
            className="chapter-tree__bulk-delete"
            onClick={() => void handleDeleteChapters(Array.from(checkedChapterIds))}
            disabled={selectedCount === 0 || isDeleting}
          >
            {isDeleting ? '删除中…' : `删除选中${selectedCount ? ` (${selectedCount})` : ''}`}
          </button>
        </div>
      )}

      <ul className="chapter-tree__list">
        {/* All-scope button */}
        <li>
          <AllScopeButton
            isActive={selectedChapterId === 'all' && !selectedVolumeId}
            onClick={() => onSelectChapter('all')}
          />
        </li>

        {/* Volumes with chapters */}
        {volumes.map((volume, index) => {
          const volumeChapters = volumeChapterMap.get(volume.id) ?? [];
          const isCollapsed = collapsedVolumes.has(volume.id);
          const isVolumeSelected = selectedVolumeId === volume.id;
          const chapterCount = volume._count?.chapters ?? volumeChapters.length;
          const accentColor = getVolumeColor(index);

          return (
            <li key={volume.id} className="chapter-tree__volume-group">
              {/* Volume header row */}
              <VolumeHeader
                volume={volume}
                accentColor={accentColor}
                isCollapsed={isCollapsed}
                isSelected={isVolumeSelected}
                chapterCount={chapterCount}
                volumeChapters={volumeChapters}
                onToggle={() => toggleCollapse(volume.id)}
                onSelect={() => onSelectVolume(volume.id)}
              />

              {/* Volume chapters — animated collapsible section */}
              <AnimatedCollapse isOpen={!isCollapsed && volumeChapters.length > 0}>
                <ul className="chapter-tree__chapter-list">
                  {volumeChapters.map((chapter, chIdx) => (
                    <ChapterItem
                      key={chapter.id}
                      chapter={chapter}
                      accentColor={accentColor}
                      isActive={selectedChapterId === chapter.id}
                      isChecked={checkedChapterIds.has(chapter.id)}
                      isLast={chIdx === volumeChapters.length - 1}
                      disabled={isDeleting}
                      onClick={() => onSelectChapter(chapter.id)}
                      onToggleChecked={() => toggleChapterChecked(chapter.id)}
                      onDelete={() => void handleDeleteChapters([chapter.id])}
                    />
                  ))}
                </ul>
              </AnimatedCollapse>
            </li>
          );
        })}

        {/* Unassigned chapters */}
        {unassignedChapters.length > 0 && (
          <li className="chapter-tree__unassigned">
            <div className="chapter-tree__unassigned-label">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ opacity: 0.5 }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              未分卷章节
            </div>
            <ul className="chapter-tree__chapter-list">
              {unassignedChapters.map((chapter, chIdx) => (
                <ChapterItem
                  key={chapter.id}
                  chapter={chapter}
                  accentColor="var(--text-dim)"
                  isActive={selectedChapterId === chapter.id}
                  isChecked={checkedChapterIds.has(chapter.id)}
                  isLast={chIdx === unassignedChapters.length - 1}
                  disabled={isDeleting}
                  onClick={() => onSelectChapter(chapter.id)}
                  onToggleChecked={() => toggleChapterChecked(chapter.id)}
                  onDelete={() => void handleDeleteChapters([chapter.id])}
                />
              ))}
            </ul>
          </li>
        )}
      </ul>
    </div>
  );
}

/* ─── Sub-components ─── */

/** "全书范围" toggle at the top of the tree */
function AllScopeButton({ isActive, onClick }: { isActive: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`chapter-tree__all-scope ${isActive ? 'chapter-tree__all-scope--active' : ''}`}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ opacity: 0.7, flexShrink: 0 }}>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
      </svg>
      全书范围
    </button>
  );
}

/** Collapsible volume header with chevron, icon, title, and chapter count */
function VolumeHeader({
  volume,
  accentColor,
  isCollapsed,
  isSelected,
  chapterCount,
  volumeChapters,
  onToggle,
  onSelect,
}: {
  volume: VolumeSummary;
  accentColor: string;
  isCollapsed: boolean;
  isSelected: boolean;
  chapterCount: number;
  volumeChapters: ChapterSummary[];
  onToggle: () => void;
  onSelect: () => void;
}) {
  /** Count drafted chapters to show progress */
  const draftedCount = volumeChapters.filter((c) => c.status === 'drafted').length;
  const progressRatio = chapterCount > 0 ? draftedCount / chapterCount : 0;

  return (
    <div className="chapter-tree__volume-header">
      {/* Collapse toggle chevron */}
      <button
        onClick={onToggle}
        className="chapter-tree__chevron"
        aria-label={isCollapsed ? '展开' : '折叠'}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="currentColor"
          style={{
            transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
            transition: 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </button>

      {/* Volume title — click to select */}
      <button
        onClick={onSelect}
        className={`chapter-tree__volume-btn ${isSelected ? 'chapter-tree__volume-btn--active' : ''}`}
        style={{
          '--volume-color': accentColor,
          '--volume-color-bg': `${accentColor}15`,
          '--volume-color-glow': `${accentColor}40`,
        } as React.CSSProperties}
      >
        {/* Color-coded dot indicator */}
        <span
          className="chapter-tree__volume-dot"
          style={{
            background: accentColor,
            boxShadow: isSelected ? `0 0 8px ${accentColor}80` : 'none',
          }}
        />
        <span className="chapter-tree__volume-title truncate">
          {volume.title || `第${volume.volumeNo}卷`}
        </span>

        {/* Chapter count badge + progress bar */}
        <span className="chapter-tree__volume-meta">
          <span className="chapter-tree__volume-badge">{chapterCount}</span>
          {/* Micro progress bar showing drafted ratio */}
          {chapterCount > 0 && (
            <span className="chapter-tree__progress-track">
              <span
                className="chapter-tree__progress-fill"
                style={{
                  width: `${progressRatio * 100}%`,
                  background: accentColor,
                }}
              />
            </span>
          )}
        </span>
      </button>
    </div>
  );
}

/** Single chapter row with connector line, status dot, and number badge */
function ChapterItem({
  chapter,
  accentColor,
  isActive,
  isChecked,
  isLast,
  disabled,
  onClick,
  onToggleChecked,
  onDelete,
}: {
  chapter: ChapterSummary;
  accentColor: string;
  isActive: boolean;
  isChecked: boolean;
  isLast: boolean;
  disabled: boolean;
  onClick: () => void;
  onToggleChecked: () => void;
  onDelete: () => void;
}) {
  const isDrafted = chapter.status === 'drafted';

  return (
    <li className={`chapter-tree__chapter-item ${isChecked ? 'chapter-tree__chapter-item--checked' : ''}`}>
      {/* Visual connector line from volume to chapter */}
      <span className="chapter-tree__connector">
        {/* Vertical line — extends full height except for last item */}
        <span
          className="chapter-tree__connector-vert"
          style={{ height: isLast ? '50%' : '100%' }}
        />
        {/* Horizontal branch line */}
        <span className="chapter-tree__connector-horiz" />
      </span>

      <div className="chapter-tree__chapter-row">
        <label className="chapter-tree__chapter-check" title={`勾选${formatChapterLabel(chapter)}`}>
          <input
            type="checkbox"
            checked={isChecked}
            disabled={disabled}
            aria-label={`勾选${formatChapterLabel(chapter)}`}
            onChange={onToggleChecked}
            onClick={(event) => event.stopPropagation()}
          />
        </label>

        <button
          onClick={onClick}
          className={`chapter-tree__chapter-btn ${isActive ? 'chapter-tree__chapter-btn--active' : ''}`}
          style={{
            '--ch-accent': isActive ? accentColor : 'var(--text-muted)',
          } as React.CSSProperties}
        >
          {/* Status dot — green for drafted, dim for pending */}
          <span
            className="chapter-tree__status-dot"
            style={{
              background: isDrafted ? '#10b981' : 'var(--border-light)',
              boxShadow: isDrafted ? '0 0 6px rgba(16,185,129,0.5)' : 'none',
            }}
            title={isDrafted ? '已生成' : '未生成'}
          />

          {/* Chapter number badge */}
          <span className="chapter-tree__ch-no">
            {chapter.chapterNo}
          </span>

          {/* Chapter title */}
          <span className="chapter-tree__ch-title truncate">
            {chapter.title || '未命名章节'}
          </span>
        </button>

        <button
          type="button"
          className="chapter-tree__chapter-delete"
          title={`删除${formatChapterLabel(chapter)}`}
          aria-label={`删除${formatChapterLabel(chapter)}`}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M6 7h12m-9 0V5.8C9 4.8 9.8 4 10.8 4h2.4c1 0 1.8.8 1.8 1.8V7m-7.5 0 .6 11.1c.1 1 .9 1.9 2 1.9h3.8c1.1 0 1.9-.8 2-1.9L16.5 7" />
          </svg>
        </button>
      </div>
    </li>
  );
}

/**
 * Animated collapse wrapper using max-height transition.
 * Measures actual content height for smooth animation instead of arbitrary max-height.
 */
function AnimatedCollapse({
  isOpen,
  children,
}: {
  isOpen: boolean;
  children: React.ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);

  // Measure content height whenever children or open state changes
  useEffect(() => {
    if (contentRef.current) {
      setHeight(contentRef.current.scrollHeight);
    }
  }, [isOpen, children]);

  return (
    <div
      className="chapter-tree__collapse-wrapper"
      style={{
        maxHeight: isOpen ? (height ?? 9999) : 0,
        opacity: isOpen ? 1 : 0,
        transition: 'max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s ease',
        overflow: 'hidden',
      }}
    >
      <div ref={contentRef}>{children}</div>
    </div>
  );
}

function formatChapterLabel(chapter?: ChapterSummary) {
  if (!chapter) return '该章节';
  return `第${chapter.chapterNo}章「${chapter.title || '未命名章节'}」`;
}
