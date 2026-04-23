import React, { useState } from 'react';

/** Chapter data per volume */
export interface ChapterData {
  chapterNo: number;
  title: string;
  objective: string;
  conflict: string;
  outline: string;
}

/** Volume info read from guided_volume step */
interface VolumeInfo {
  volumeNo: number;
  title: string;
  synopsis: string;
  objective: string;
}

/** Props for ChapterFields */
interface ChapterFieldsProps {
  data: Record<string, unknown>;
  volumeData: Record<string, unknown>;
  onChange: (field: string, value: string) => void;
  onGenerateForVolume: (volumeNo: number) => void;
  onSaveVolume: (volumeNo: number) => void;
  loading: boolean;
}

const emptyChapter = (chapterNo: number): ChapterData => ({
  chapterNo,
  title: '',
  objective: '',
  conflict: '',
  outline: '',
});

/** Parse volumes from guided_volume step data */
function parseVolumes(volumeData: Record<string, unknown>): VolumeInfo[] {
  const raw = volumeData?.volumes;
  if (!raw) return [];
  try {
    if (typeof raw === 'string') return JSON.parse(raw) as VolumeInfo[];
    if (Array.isArray(raw)) return raw as VolumeInfo[];
  } catch { /* ignore */ }
  return [];
}

/** Parse volumeChapters from chapter step data */
function parseVolumeChapters(data: Record<string, unknown>): Record<number, ChapterData[]> {
  const raw = data?.volumeChapters;
  if (!raw) return {};
  try {
    if (typeof raw === 'string') return JSON.parse(raw) as Record<number, ChapterData[]>;
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<number, ChapterData[]>;
  } catch { /* ignore */ }
  return {};
}

const ACCENT_COLOR = '#f97316';

export function ChapterFields({
  data,
  volumeData,
  onChange,
  onGenerateForVolume,
  onSaveVolume,
  loading,
}: ChapterFieldsProps) {
  const volumes = parseVolumes(volumeData);
  const volumeChapters = parseVolumeChapters(data);

  // Track collapsed state per volume
  const [collapsedVolumes, setCollapsedVolumes] = useState<Record<number, boolean>>({});

  const toggleVolume = (volumeNo: number) => {
    setCollapsedVolumes((prev) => ({ ...prev, [volumeNo]: !prev[volumeNo] }));
  };

  const updateChapter = (volumeNo: number, chapterIdx: number, key: keyof ChapterData, value: string) => {
    const current = { ...volumeChapters };
    const chapters = [...(current[volumeNo] ?? [])];
    chapters[chapterIdx] = { ...chapters[chapterIdx], [key]: value };
    current[volumeNo] = chapters;
    onChange('volumeChapters', JSON.stringify(current));
  };

  const addChapter = (volumeNo: number) => {
    const current = { ...volumeChapters };
    const chapters = [...(current[volumeNo] ?? [])];
    chapters.push(emptyChapter(chapters.length + 1));
    current[volumeNo] = chapters;
    onChange('volumeChapters', JSON.stringify(current));
  };

  const removeChapter = (volumeNo: number, chapterIdx: number) => {
    const current = { ...volumeChapters };
    const chapters = (current[volumeNo] ?? []).filter((_, i) => i !== chapterIdx)
      .map((ch, i) => ({ ...ch, chapterNo: i + 1 }));
    current[volumeNo] = chapters;
    onChange('volumeChapters', JSON.stringify(current));
  };

  if (volumes.length === 0) {
    return (
      <div
        style={{
          color: 'var(--text-dim)',
          fontSize: '0.82rem',
          textAlign: 'center',
          padding: '2rem 0',
          lineHeight: 1.8,
        }}
      >
        <span style={{ fontSize: '1.5rem', display: 'block', marginBottom: '0.5rem' }}>📁</span>
        请先完成「卷纲拆分」步骤并保存，<br />
        才能按卷生成章节细纲。
      </div>
    );
  }

  return (
    <div className="doc-section__fields">
      {volumes.map((vol) => {
        const chapters = volumeChapters[vol.volumeNo] ?? [];
        const isCollapsed = collapsedVolumes[vol.volumeNo] ?? false;
        const hasChapters = chapters.length > 0;

        return (
          <VolumeChapterPanel
            key={vol.volumeNo}
            volume={vol}
            chapters={chapters}
            isCollapsed={isCollapsed}
            hasChapters={hasChapters}
            loading={loading}
            onToggle={() => toggleVolume(vol.volumeNo)}
            onGenerateForVolume={() => onGenerateForVolume(vol.volumeNo)}
            onSaveVolume={() => onSaveVolume(vol.volumeNo)}
            onUpdateChapter={(idx, key, value) => updateChapter(vol.volumeNo, idx, key, value)}
            onAddChapter={() => addChapter(vol.volumeNo)}
            onRemoveChapter={(idx) => removeChapter(vol.volumeNo, idx)}
          />
        );
      })}
    </div>
  );
}

/** Individual volume panel with its chapters */
function VolumeChapterPanel({
  volume,
  chapters,
  isCollapsed,
  hasChapters,
  loading,
  onToggle,
  onGenerateForVolume,
  onUpdateChapter,
  onAddChapter,
  onRemoveChapter,
}: {
  volume: VolumeInfo;
  chapters: ChapterData[];
  isCollapsed: boolean;
  hasChapters: boolean;
  loading: boolean;
  onToggle: () => void;
  onGenerateForVolume: () => void;
  onSaveVolume: () => void;
  onUpdateChapter: (idx: number, key: keyof ChapterData, value: string) => void;
  onAddChapter: () => void;
  onRemoveChapter: (idx: number) => void;
}) {
  return (
    <div
      style={{
        borderRadius: '0.75rem',
        border: `1px solid ${ACCENT_COLOR}33`,
        background: `${ACCENT_COLOR}06`,
        overflow: 'hidden',
      }}
    >
      {/* Volume Header */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.6rem 0.75rem',
          cursor: 'pointer',
          userSelect: 'none',
          borderBottom: isCollapsed ? 'none' : `1px solid ${ACCENT_COLOR}1a`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span
            style={{
              fontSize: '0.65rem',
              color: 'var(--text-dim)',
              transition: 'transform 0.2s ease',
              transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
              display: 'inline-block',
            }}
          >
            ▼
          </span>
          <span
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: hasChapters ? '#34d399' : ACCENT_COLOR,
              boxShadow: `0 0 6px ${hasChapters ? '#34d39966' : `${ACCENT_COLOR}66`}`,
              display: 'inline-block',
            }}
          />
          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: ACCENT_COLOR }}>
            第 {volume.volumeNo} 卷
          </span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-main)', fontWeight: 500 }}>
            {volume.title || '未命名'}
          </span>
          {hasChapters && (
            <span
              style={{
                fontSize: '0.65rem',
                color: '#34d399',
                background: 'rgba(16,185,129,0.1)',
                padding: '0.05rem 0.35rem',
                borderRadius: '0.2rem',
                fontWeight: 600,
              }}
            >
              {chapters.length} 章
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }} onClick={(e) => e.stopPropagation()}>
          <button
            className="doc-section__btn doc-section__btn--ai"
            onClick={onGenerateForVolume}
            disabled={loading}
            style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}
          >
            ⚡ 生成本卷
          </button>
          {hasChapters && (
            <button
              className="doc-section__btn doc-section__btn--save"
              onClick={onSaveVolume}
              disabled={loading}
              style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}
            >
              💾 保存本卷
            </button>
          )}
        </div>
      </div>

      {/* Volume Synopsis (read-only summary) */}
      {!isCollapsed && volume.synopsis && (
        <div
          style={{
            padding: '0.4rem 0.75rem',
            fontSize: '0.72rem',
            color: 'var(--text-dim)',
            lineHeight: 1.6,
            background: `${ACCENT_COLOR}08`,
            borderBottom: `1px solid ${ACCENT_COLOR}12`,
          }}
        >
          <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>卷概要：</span>
          {volume.synopsis.length > 120 ? volume.synopsis.slice(0, 120) + '…' : volume.synopsis}
        </div>
      )}

      {/* Chapters */}
      {!isCollapsed && (
        <div style={{ padding: '0.5rem 0.75rem' }}>
          {chapters.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '1rem 0',
                color: 'var(--text-dim)',
                fontSize: '0.78rem',
              }}
            >
              暂无章节，点击「⚡ 生成本卷」自动生成
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {chapters.map((ch, idx) => (
                <ChapterCard
                  key={idx}
                  chapter={ch}
                  index={idx}
                  onUpdate={(key, value) => onUpdateChapter(idx, key, value)}
                  onRemove={() => onRemoveChapter(idx)}
                  canRemove={chapters.length > 1}
                />
              ))}
            </div>
          )}

          <button
            onClick={onAddChapter}
            style={{
              width: '100%',
              padding: '0.45rem',
              marginTop: '0.4rem',
              borderRadius: '0.4rem',
              border: '1px dashed var(--border-light)',
              background: 'transparent',
              color: ACCENT_COLOR,
              fontSize: '0.75rem',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = `${ACCENT_COLOR}0d`; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            + 添加章节
          </button>
        </div>
      )}
    </div>
  );
}

/** Individual chapter editing card */
function ChapterCard({
  chapter,
  index,
  onUpdate,
  onRemove,
  canRemove,
}: {
  chapter: ChapterData;
  index: number;
  onUpdate: (key: keyof ChapterData, value: string) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        borderRadius: '0.5rem',
        border: '1px solid var(--border-light)',
        background: 'var(--bg-editor)',
        overflow: 'hidden',
      }}
    >
      {/* Chapter header — always visible */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.4rem 0.6rem',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flex: 1, minWidth: 0 }}>
          <span
            style={{
              fontSize: '0.6rem',
              color: 'var(--text-dim)',
              transition: 'transform 0.15s ease',
              transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
              display: 'inline-block',
            }}
          >
            ▼
          </span>
          <span
            style={{
              fontSize: '0.68rem',
              fontWeight: 700,
              color: ACCENT_COLOR,
              flexShrink: 0,
            }}
          >
            第{chapter.chapterNo}章
          </span>
          <span
            style={{
              fontSize: '0.78rem',
              color: 'var(--text-main)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {chapter.title || '未命名章节'}
          </span>
        </div>
        {canRemove && (
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-dim)',
              fontSize: '0.65rem',
              cursor: 'pointer',
              padding: '0.1rem 0.3rem',
              borderRadius: '0.2rem',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#ef4444'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-dim)'; }}
          >
            ✕
          </button>
        )}
      </div>

      {/* Expanded editing fields */}
      {expanded && (
        <div
          style={{
            padding: '0.4rem 0.6rem 0.6rem',
            borderTop: '1px solid var(--border-light)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.35rem',
          }}
        >
          <input
            className="input-field"
            value={chapter.title}
            onChange={(e) => onUpdate('title', e.target.value)}
            placeholder="章节标题…"
            style={{ fontSize: '0.78rem' }}
          />
          <input
            className="input-field"
            value={chapter.objective}
            onChange={(e) => onUpdate('objective', e.target.value)}
            placeholder="本章目标…"
            style={{ fontSize: '0.78rem' }}
          />
          <input
            className="input-field"
            value={chapter.conflict}
            onChange={(e) => onUpdate('conflict', e.target.value)}
            placeholder="核心冲突…"
            style={{ fontSize: '0.78rem' }}
          />
          <textarea
            className="input-field"
            rows={3}
            value={chapter.outline}
            onChange={(e) => onUpdate('outline', e.target.value)}
            placeholder="章节大纲…"
            style={{ fontSize: '0.78rem', lineHeight: 1.6, resize: 'vertical' }}
          />
        </div>
      )}
    </div>
  );
}
