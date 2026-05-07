import React, { useState } from 'react';
import { ChapterCraftBrief, GuidedChapterData, GuidedSupportingCharacterData } from '../../types/guided';

/** Chapter data per volume */
export type ChapterData = GuidedChapterData;

/** Supporting character generated alongside chapters */
export type SupportingCharacterData = GuidedSupportingCharacterData;
type ChapterTextField = 'title' | 'objective' | 'conflict' | 'outline';

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
  onGenerateForVolume: (volumeNo: number, chapterRange?: [number, number]) => void;
  onGenerateForChapter: (volumeNo: number, chapterNo: number) => void;
  onAutoSaveVolume: (volumeNo: number) => void;
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

const emptyCraftBrief = (): ChapterCraftBrief => ({
  visibleGoal: '',
  hiddenEmotion: '',
  coreConflict: '',
  mainlineTask: '',
  subplotTasks: [],
    actionBeats: [],
    sceneBeats: [],
    concreteClues: [],
    dialogueSubtext: '',
    characterShift: '',
    irreversibleConsequence: '',
    progressTypes: [],
    entryState: '',
    exitState: '',
    openLoops: [],
    closedLoops: [],
    handoffToNextChapter: '',
    continuityState: {
      characterPositions: [],
      activeThreats: [],
      ownedClues: [],
      relationshipChanges: [],
      nextImmediatePressure: '',
    },
});

const stringListToText = (value?: string[]) => Array.isArray(value) ? value.join('\n') : '';

const textToStringList = (value: string) => value
  .split(/\n+/)
  .map((line) => line.trim())
  .filter(Boolean);

const cluesToText = (value?: ChapterCraftBrief['concreteClues']) => Array.isArray(value)
  ? value.map((item) => [item.name, item.sensoryDetail, item.laterUse].filter(Boolean).join('；')).join('\n')
  : '';

const textToClues = (value: string): ChapterCraftBrief['concreteClues'] => textToStringList(value).map((line) => {
  const [name = '', sensoryDetail = '', laterUse = ''] = line.split(/[；;]/).map((item) => item.trim());
  return { name: name || line, sensoryDetail, laterUse };
});

const jsonToText = (value: unknown) => value === undefined ? '' : JSON.stringify(value, null, 2);

const parseJsonField = <T,>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

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

/** Parse volumeSupportingCharacters from chapter step data (keyed by volumeNo) */
function parseVolumeSupportChars(data: Record<string, unknown>): Record<number, SupportingCharacterData[]> {
  const raw = data?.volumeSupportingCharacters;
  if (!raw) return {};
  try {
    if (typeof raw === 'string') return JSON.parse(raw) as Record<number, SupportingCharacterData[]>;
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<number, SupportingCharacterData[]>;
  } catch { /* ignore */ }
  return {};
}

const ACCENT_COLOR = '#f97316';

export function ChapterFields({
  data,
  volumeData,
  onChange,
  onGenerateForVolume,
  onGenerateForChapter,
  onAutoSaveVolume,
  onSaveVolume,
  loading,
}: ChapterFieldsProps) {
  const volumes = parseVolumes(volumeData);
  const volumeChapters = parseVolumeChapters(data);
  const volumeSupportChars = parseVolumeSupportChars(data);

  // Track collapsed state per volume
  const [collapsedVolumes, setCollapsedVolumes] = useState<Record<number, boolean>>({});
  // Track desired chapter count range per volume [min, max]
  const [chapterRanges, setChapterRanges] = useState<Record<number, [number, number]>>({});

  const toggleVolume = (volumeNo: number) => {
    setCollapsedVolumes((prev) => ({ ...prev, [volumeNo]: !prev[volumeNo] }));
  };

  const updateChapter = (volumeNo: number, chapterIdx: number, key: ChapterTextField, value: string) => {
    const current = { ...volumeChapters };
    const chapters = [...(current[volumeNo] ?? [])];
    chapters[chapterIdx] = { ...chapters[chapterIdx], [key]: value };
    current[volumeNo] = chapters;
    onChange('volumeChapters', JSON.stringify(current));
    onAutoSaveVolume(volumeNo);
  };

  const updateChapterCraftBrief = (volumeNo: number, chapterIdx: number, patch: Partial<ChapterCraftBrief>) => {
    const current = { ...volumeChapters };
    const chapters = [...(current[volumeNo] ?? [])];
    const existing = chapters[chapterIdx] ?? emptyChapter(chapterIdx + 1);
    chapters[chapterIdx] = {
      ...existing,
      craftBrief: {
        ...emptyCraftBrief(),
        ...(existing.craftBrief ?? {}),
        ...patch,
      },
    };
    current[volumeNo] = chapters;
    onChange('volumeChapters', JSON.stringify(current));
    onAutoSaveVolume(volumeNo);
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
        const supportChars = volumeSupportChars[vol.volumeNo] ?? [];
        const isCollapsed = collapsedVolumes[vol.volumeNo] ?? false;
        const hasChapters = chapters.length > 0;

        return (
          <VolumeChapterPanel
            key={vol.volumeNo}
            volume={vol}
            chapters={chapters}
            supportingCharacters={supportChars}
            isCollapsed={isCollapsed}
            hasChapters={hasChapters}
            loading={loading}
            chapterRange={chapterRanges[vol.volumeNo] ?? [15, 20]}
            onChapterRangeChange={(range) => setChapterRanges((prev) => ({ ...prev, [vol.volumeNo]: range }))}
            onToggle={() => toggleVolume(vol.volumeNo)}
            onGenerateForVolume={() => onGenerateForVolume(vol.volumeNo, chapterRanges[vol.volumeNo] ?? [15, 20])}
            onGenerateForChapter={(chapterNo) => onGenerateForChapter(vol.volumeNo, chapterNo)}
            onSaveVolume={() => onSaveVolume(vol.volumeNo)}
            onUpdateChapter={(idx, key, value) => updateChapter(vol.volumeNo, idx, key, value)}
            onUpdateCraftBrief={(idx, patch) => updateChapterCraftBrief(vol.volumeNo, idx, patch)}
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
  supportingCharacters,
  isCollapsed,
  hasChapters,
  loading,
  chapterRange,
  onChapterRangeChange,
  onToggle,
  onGenerateForVolume,
  onGenerateForChapter,
  onSaveVolume,
  onUpdateChapter,
  onUpdateCraftBrief,
  onAddChapter,
  onRemoveChapter,
}: {
  volume: VolumeInfo;
  chapters: ChapterData[];
  supportingCharacters: SupportingCharacterData[];
  isCollapsed: boolean;
  hasChapters: boolean;
  loading: boolean;
  chapterRange: [number, number];
  onChapterRangeChange: (range: [number, number]) => void;
  onToggle: () => void;
  onGenerateForVolume: () => void;
  onGenerateForChapter: (chapterNo: number) => void;
  onSaveVolume: () => void;
  onUpdateChapter: (idx: number, key: ChapterTextField, value: string) => void;
  onUpdateCraftBrief: (idx: number, patch: Partial<ChapterCraftBrief>) => void;
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
          <input
            type="number"
            className="input-field"
            min={3}
            max={30}
            value={chapterRange[0]}
            onChange={(e) => {
              const v = Math.max(3, Math.min(30, parseInt(e.target.value, 10) || 15));
              onChapterRangeChange([v, Math.max(v, chapterRange[1])]);
            }}
            title="最少章节数"
            style={{ width: '2.5rem', fontSize: '0.7rem', padding: '0.2rem 0.25rem', textAlign: 'center', borderRadius: '0.3rem' }}
          />
          <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>-</span>
          <input
            type="number"
            className="input-field"
            min={3}
            max={30}
            value={chapterRange[1]}
            onChange={(e) => {
              const v = Math.max(3, Math.min(30, parseInt(e.target.value, 10) || 20));
              onChapterRangeChange([Math.min(chapterRange[0], v), v]);
            }}
            title="最多章节数"
            style={{ width: '2.5rem', fontSize: '0.7rem', padding: '0.2rem 0.25rem', textAlign: 'center', borderRadius: '0.3rem' }}
          />
          <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>章</span>
          <button
            className="doc-section__btn doc-section__btn--ai"
            onClick={onGenerateForVolume}
            disabled={loading}
            style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}
          >
            ⚡ 生成本卷细纲
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
              暂无章节，点击「⚡ 生成本卷细纲」自动生成章节细纲
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {chapters.map((ch, idx) => (
                <ChapterCard
                  key={idx}
                  chapter={ch}
                  index={idx}
                  onUpdate={(key, value) => onUpdateChapter(idx, key, value)}
                  onUpdateCraftBrief={(patch) => onUpdateCraftBrief(idx, patch)}
                  onGenerateForChapter={() => onGenerateForChapter(ch.chapterNo)}
                  onRemove={() => onRemoveChapter(idx)}
                  canRemove={chapters.length > 1}
                  loading={loading}
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

          {/* Supporting characters for this volume */}
          {supportingCharacters.length > 0 && (
            <div style={{ marginTop: '0.75rem' }}>
              <div
                style={{
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  color: '#8b5cf6',
                  marginBottom: '0.4rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                }}
              >
                👤 本卷配角
                <span
                  style={{
                    fontSize: '0.62rem',
                    fontWeight: 500,
                    color: 'var(--text-dim)',
                    background: 'rgba(139,92,246,0.1)',
                    padding: '0.05rem 0.3rem',
                    borderRadius: '0.2rem',
                  }}
                >
                  {supportingCharacters.length} 人
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                {supportingCharacters.map((char, idx) => (
                  <SupportingCharacterCard key={idx} character={char} />
                ))}
              </div>
            </div>
          )}
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
  onUpdateCraftBrief,
  onGenerateForChapter,
  onRemove,
  canRemove,
  loading,
}: {
  chapter: ChapterData;
  index: number;
  onUpdate: (key: ChapterTextField, value: string) => void;
  onUpdateCraftBrief: (patch: Partial<ChapterCraftBrief>) => void;
  onGenerateForChapter: () => void;
  onRemove: () => void;
  canRemove: boolean;
  loading: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const craftBrief = chapter.craftBrief;
  const hasCraftBrief = Boolean(craftBrief && Object.keys(craftBrief).length > 0);

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
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', flexShrink: 0 }}>
          <button
            className="doc-section__btn doc-section__btn--ai"
            onClick={(e) => { e.stopPropagation(); onGenerateForChapter(); }}
            disabled={loading}
            style={{ fontSize: '0.65rem', padding: '0.16rem 0.4rem' }}
          >
            细化本章
          </button>
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
          {hasCraftBrief && (
            <div
              style={{
                borderTop: '1px solid var(--border-light)',
                paddingTop: '0.35rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.3rem',
              }}
            >
              <div style={{ fontSize: '0.7rem', fontWeight: 700, color: ACCENT_COLOR }}>
                结构化执行卡
              </div>
              <input
                className="input-field"
                value={craftBrief?.visibleGoal ?? ''}
                onChange={(e) => onUpdateCraftBrief({ visibleGoal: e.target.value })}
                placeholder="表层目标…"
                style={{ fontSize: '0.74rem' }}
              />
              <input
                className="input-field"
                value={craftBrief?.mainlineTask ?? ''}
                onChange={(e) => onUpdateCraftBrief({ mainlineTask: e.target.value })}
                placeholder="主线任务…"
                style={{ fontSize: '0.74rem' }}
              />
              <input
                className="input-field"
                value={craftBrief?.entryState ?? ''}
                onChange={(e) => onUpdateCraftBrief({ entryState: e.target.value })}
                placeholder="入场状态：接住上一章留下的压力…"
                style={{ fontSize: '0.74rem' }}
              />
              <textarea
                className="input-field"
                rows={3}
                value={stringListToText(craftBrief?.actionBeats)}
                onChange={(e) => onUpdateCraftBrief({ actionBeats: textToStringList(e.target.value) })}
                placeholder="行动链，每行一个节点…"
                style={{ fontSize: '0.74rem', lineHeight: 1.55, resize: 'vertical' }}
              />
              <textarea
                className="input-field"
                rows={5}
                value={jsonToText(craftBrief?.sceneBeats)}
                onChange={(e) => onUpdateCraftBrief({
                  sceneBeats: parseJsonField(e.target.value, craftBrief?.sceneBeats ?? []),
                })}
                placeholder="场景链 JSON：sceneArcId / scenePart / location / participants / visibleAction / partResult…"
                style={{ fontSize: '0.72rem', lineHeight: 1.45, resize: 'vertical', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
              />
              <textarea
                className="input-field"
                rows={2}
                value={cluesToText(craftBrief?.concreteClues)}
                onChange={(e) => onUpdateCraftBrief({ concreteClues: textToClues(e.target.value) })}
                placeholder="物证/线索，每行一个；可用“名称；感官细节；后续用途”…"
                style={{ fontSize: '0.74rem', lineHeight: 1.55, resize: 'vertical' }}
              />
              <textarea
                className="input-field"
                rows={2}
                value={craftBrief?.irreversibleConsequence ?? ''}
                onChange={(e) => onUpdateCraftBrief({ irreversibleConsequence: e.target.value })}
                placeholder="不可逆后果…"
                style={{ fontSize: '0.74rem', lineHeight: 1.55, resize: 'vertical' }}
              />
              <input
                className="input-field"
                value={craftBrief?.exitState ?? ''}
                onChange={(e) => onUpdateCraftBrief({ exitState: e.target.value })}
                placeholder="离场状态：本章结束后事实/关系/资源如何变化…"
                style={{ fontSize: '0.74rem' }}
              />
              <textarea
                className="input-field"
                rows={2}
                value={stringListToText(craftBrief?.openLoops)}
                onChange={(e) => onUpdateCraftBrief({ openLoops: textToStringList(e.target.value) })}
                placeholder="未解决问题，每行一个…"
                style={{ fontSize: '0.74rem', lineHeight: 1.55, resize: 'vertical' }}
              />
              <textarea
                className="input-field"
                rows={2}
                value={stringListToText(craftBrief?.closedLoops)}
                onChange={(e) => onUpdateCraftBrief({ closedLoops: textToStringList(e.target.value) })}
                placeholder="本章阶段性解决的问题，每行一个…"
                style={{ fontSize: '0.74rem', lineHeight: 1.55, resize: 'vertical' }}
              />
              <input
                className="input-field"
                value={craftBrief?.handoffToNextChapter ?? ''}
                onChange={(e) => onUpdateCraftBrief({ handoffToNextChapter: e.target.value })}
                placeholder="下一章交接：接续动作、地点、压力或未解决问题…"
                style={{ fontSize: '0.74rem' }}
              />
              <textarea
                className="input-field"
                rows={4}
                value={jsonToText(craftBrief?.continuityState)}
                onChange={(e) => onUpdateCraftBrief({
                  continuityState: parseJsonField(e.target.value, craftBrief?.continuityState ?? { nextImmediatePressure: '' }),
                })}
                placeholder="连续状态 JSON：characterPositions / activeThreats / ownedClues / relationshipChanges / nextImmediatePressure…"
                style={{ fontSize: '0.72rem', lineHeight: 1.45, resize: 'vertical', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Compact card displaying a supporting character's key info */
function SupportingCharacterCard({ character }: { character: SupportingCharacterData }) {
  const [expanded, setExpanded] = useState(false);
  const CHAR_COLOR = '#8b5cf6';

  return (
    <div
      style={{
        borderRadius: '0.5rem',
        border: `1px solid ${CHAR_COLOR}22`,
        background: `${CHAR_COLOR}08`,
        overflow: 'hidden',
      }}
    >
      {/* Character header */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.35rem 0.6rem',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
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
          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: CHAR_COLOR }}>
            {character.name}
          </span>
          <span
            style={{
              fontSize: '0.62rem',
              color: 'var(--text-dim)',
              background: `${CHAR_COLOR}15`,
              padding: '0.05rem 0.3rem',
              borderRadius: '0.15rem',
            }}
          >
            {character.roleType}
          </span>
          {character.firstAppearChapter && (
            <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>
              第{character.firstAppearChapter}章登场
            </span>
          )}
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div
          style={{
            padding: '0.35rem 0.6rem 0.5rem',
            borderTop: `1px solid ${CHAR_COLOR}15`,
            fontSize: '0.75rem',
            lineHeight: 1.7,
            color: 'var(--text-muted)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.25rem',
          }}
        >
          <div>
            <span style={{ fontWeight: 600, color: CHAR_COLOR, marginRight: '0.3rem' }}>性格：</span>
            {character.personalityCore}
          </div>
          <div>
            <span style={{ fontWeight: 600, color: CHAR_COLOR, marginRight: '0.3rem' }}>动机：</span>
            {character.motivation}
          </div>
        </div>
      )}
    </div>
  );
}
