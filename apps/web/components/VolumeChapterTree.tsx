import React, { useState, useMemo } from 'react';
import { ChapterSummary, VolumeSummary } from '../types/dashboard';

interface Props {
  volumes: VolumeSummary[];
  chapters: ChapterSummary[];
  selectedChapterId: string;
  selectedVolumeId: string;
  onSelectChapter: (id: string) => void;
  onSelectVolume: (id: string) => void;
}

export function VolumeChapterTree({
  volumes,
  chapters,
  selectedChapterId,
  selectedVolumeId,
  onSelectChapter,
  onSelectVolume,
}: Props) {
  const [collapsedVolumes, setCollapsedVolumes] = useState<Set<string>>(new Set());

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

  const renderChapterButton = (chapter: ChapterSummary, indent: boolean) => {
    const isActive = selectedChapterId === chapter.id;
    return (
      <li key={chapter.id}>
        <button
          onClick={() => onSelectChapter(chapter.id)}
          className="w-full flex items-center gap-2 text-sm p-2"
          style={{
            paddingLeft: indent ? '2rem' : '0.5rem',
            borderRadius: '0.5rem',
            transition: 'all 0.3s ease',
            background: isActive ? 'var(--accent-cyan-bg)' : 'transparent',
            color: isActive ? 'var(--accent-cyan)' : 'var(--text-muted)',
            boxShadow: isActive ? 'inset 2px 0 0 var(--accent-cyan)' : 'none',
            fontWeight: isActive ? 500 : 400,
          }}
          onMouseEnter={(e) => {
            if (!isActive) {
              e.currentTarget.style.background = 'var(--bg-hover-subtle)';
              e.currentTarget.style.color = 'var(--text-main)';
            }
          }}
          onMouseLeave={(e) => {
            if (!isActive) {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--text-muted)';
            }
          }}
        >
          <span className="truncate">
            <span style={{ opacity: 0.5, marginRight: '4px', fontSize: '0.7rem' }}>
              #{chapter.chapterNo}
            </span>
            {chapter.title || '未命名章节'}
          </span>
        </button>
      </li>
    );
  };

  return (
    <div>
      {/* Section Header */}
      <div
        className="px-3 mb-2 font-bold text-slate-500 flex justify-between items-center"
        style={{ fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.2em' }}
      >
        <span>作品目录</span>
        <span
          style={{
            fontSize: '10px',
            background: 'var(--bg-hover-subtle)',
            padding: '2px 6px',
            borderRadius: '4px',
          }}
        >
          {chapters.length}章
        </span>
      </div>

      <ul className="space-y-0.5">
        {/* All-scope button */}
        <li>
          <button
            onClick={() => onSelectChapter('all')}
            className="w-full flex items-center gap-3 text-sm p-2"
            style={{
              borderRadius: '0.5rem',
              transition: 'all 0.3s ease',
              background: selectedChapterId === 'all' && !selectedVolumeId ? 'var(--accent-cyan-bg)' : 'transparent',
              color: selectedChapterId === 'all' && !selectedVolumeId ? 'var(--accent-cyan)' : 'var(--text-muted)',
              boxShadow: selectedChapterId === 'all' && !selectedVolumeId ? 'inset 2px 0 0 var(--accent-cyan)' : 'none',
              fontWeight: selectedChapterId === 'all' && !selectedVolumeId ? 500 : 400,
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ opacity: 0.7, flexShrink: 0 }}>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
            全书范围
          </button>
        </li>

        {/* Volumes with chapters */}
        {volumes.map((volume) => {
          const volumeChapters = volumeChapterMap.get(volume.id) ?? [];
          const isCollapsed = collapsedVolumes.has(volume.id);
          const isVolumeSelected = selectedVolumeId === volume.id;
          const chapterCountDisplay = volume._count?.chapters ?? volumeChapters.length;

          return (
            <li key={volume.id}>
              {/* Volume header */}
              <div className="flex items-center gap-1" style={{ marginTop: '0.25rem' }}>
                {/* Collapse toggle */}
                <button
                  onClick={() => toggleCollapse(volume.id)}
                  style={{
                    width: '20px',
                    height: '20px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '4px',
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--text-dim)',
                    cursor: 'pointer',
                    flexShrink: 0,
                    transition: 'all 0.2s ease',
                  }}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    style={{
                      transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                      transition: 'transform 0.2s ease',
                    }}
                  >
                    <path d="M7 10l5 5 5-5z" />
                  </svg>
                </button>

                {/* Volume title — click to select volume */}
                <button
                  onClick={() => onSelectVolume(volume.id)}
                  className="flex-1 flex items-center gap-2 text-sm p-1.5"
                  style={{
                    borderRadius: '0.5rem',
                    transition: 'all 0.3s ease',
                    background: isVolumeSelected ? 'rgba(245,158,11,0.1)' : 'transparent',
                    color: isVolumeSelected ? '#f59e0b' : 'var(--text-muted)',
                    boxShadow: isVolumeSelected ? 'inset 2px 0 0 #f59e0b' : 'none',
                    fontWeight: isVolumeSelected ? 600 : 500,
                    fontSize: '0.8rem',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                  onMouseEnter={(e) => {
                    if (!isVolumeSelected) {
                      e.currentTarget.style.background = 'var(--bg-hover-subtle)';
                      e.currentTarget.style.color = 'var(--text-main)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isVolumeSelected) {
                      e.currentTarget.style.background = 'transparent';
                      e.currentTarget.style.color = 'var(--text-muted)';
                    }
                  }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ opacity: 0.7, flexShrink: 0 }}>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  <span className="truncate">
                    {volume.title || `第${volume.volumeNo}卷`}
                  </span>
                  <span
                    style={{
                      fontSize: '0.6rem',
                      background: 'var(--bg-hover-subtle)',
                      padding: '1px 5px',
                      borderRadius: '3px',
                      color: 'var(--text-dim)',
                      marginLeft: 'auto',
                      flexShrink: 0,
                    }}
                  >
                    {chapterCountDisplay}
                  </span>
                </button>
              </div>

              {/* Volume chapters (collapsible) */}
              {!isCollapsed && volumeChapters.length > 0 && (
                <ul className="space-y-0.5" style={{ marginTop: '2px' }}>
                  {volumeChapters.map((chapter) => renderChapterButton(chapter, true))}
                </ul>
              )}
            </li>
          );
        })}

        {/* Unassigned chapters */}
        {unassignedChapters.length > 0 && (
          <li style={{ marginTop: '0.5rem' }}>
            <div
              className="px-2 py-1 flex items-center gap-2 text-xs"
              style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ opacity: 0.5 }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              未分卷章节
            </div>
            <ul className="space-y-0.5">
              {unassignedChapters.map((chapter) => renderChapterButton(chapter, false))}
            </ul>
          </li>
        )}
      </ul>
    </div>
  );
}
