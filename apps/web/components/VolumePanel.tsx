import React, { useState, useEffect, useMemo } from 'react';
import { ProjectSummary, VolumeSummary, ChapterSummary } from '../types/dashboard';
import { useVolumeActions, VolumeFormData } from '../hooks/useVolumeActions';
import { BatchGeneratePanel } from './BatchGeneratePanel';

interface Props {
  selectedProject?: ProjectSummary;
  selectedProjectId: string;
  chapters?: ChapterSummary[];
}

export function VolumePanel({ selectedProject, selectedProjectId, chapters = [] }: Props) {
  const {
    volumes,
    loading,
    error,
    setError,
    loadVolumes,
    createVolume,
    updateVolume,
    deleteVolume,
  } = useVolumeActions(selectedProjectId);

  const [editingVolume, setEditingVolume] = useState<VolumeSummary | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showBatchPanel, setShowBatchPanel] = useState(false);
  const chaptersByVolume = useMemo(() => {
    const map = new Map<string, ChapterSummary[]>();
    for (const chapter of chapters) {
      if (!chapter.volumeId) continue;
      const existing = map.get(chapter.volumeId) ?? [];
      existing.push(chapter);
      map.set(chapter.volumeId, existing);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.chapterNo - b.chapterNo);
    }
    return map;
  }, [chapters]);

  useEffect(() => {
    if (selectedProjectId) {
      loadVolumes();
    }
  }, [selectedProjectId, loadVolumes, chapters.length]);

  const handleCreate = async (data: VolumeFormData) => {
    const ok = await createVolume(data);
    if (ok) setShowCreateForm(false);
  };

  const handleSaveSynopsis = async (volumeId: string, synopsis: string) => {
    await updateVolume(volumeId, { synopsis });
  };

  const handleDelete = async (volumeId: string) => {
    await deleteVolume(volumeId);
    if (editingVolume?.id === volumeId) {
      setEditingVolume(null);
    }
  };

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
          <div
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: '#14b8a6',
              boxShadow: '0 0 10px rgba(20,184,166,0.5)',
            }}
          />
          <h1
            className="text-lg font-bold text-heading"
            style={{ textShadow: '0 2px 10px var(--accent-cyan-glow)' }}
          >
            卷管理
          </h1>
          <span
            className="badge"
            style={{
              background: 'rgba(20,184,166,0.12)',
              color: '#14b8a6',
              border: 'none',
            }}
          >
            Volumes
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>
            {selectedProject?.title ?? '未选择项目'}
          </div>
          {selectedProjectId && (
            <>
              {/* Batch AI generate button */}
              <button
                onClick={() => setShowBatchPanel((prev) => !prev)}
                style={{
                  fontSize: '0.75rem',
                  padding: '0.35rem 0.85rem',
                  borderRadius: '0.4rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  border: `1px solid ${showBatchPanel ? 'var(--accent-cyan)' : 'var(--border-light)'}`,
                  background: showBatchPanel
                    ? 'rgba(6,182,212,0.12)'
                    : 'linear-gradient(135deg, rgba(6,182,212,0.1), rgba(139,92,246,0.1))',
                  color: showBatchPanel ? 'var(--accent-cyan)' : 'var(--text-muted)',
                  transition: 'all 0.2s ease',
                }}
              >
                🤖 {showBatchPanel ? '关闭批量生成' : '批量生成正文'}
              </button>
              <button
                className="btn-primary"
                style={{ fontSize: '0.75rem', padding: '0.35rem 0.85rem' }}
                onClick={() => {
                  setShowCreateForm(true);
                  setError('');
                }}
              >
                + 新增卷
              </button>
            </>
          )}
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 px-8 py-6" style={{ overflowY: 'auto' }}>
        {!selectedProjectId ? (
          <EmptyState message="请先选择一个项目" />
        ) : loading && volumes.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm" style={{ color: 'var(--text-dim)' }}>
            加载中…
          </div>
        ) : (
          <div className="space-y-4">
            {error && (
              <div className="text-xs" style={{ color: 'var(--status-err)', padding: '0.5rem', background: 'var(--status-err-bg)', borderRadius: '8px' }}>
                {error}
              </div>
            )}

            {/* Batch generate panel */}
            {showBatchPanel && (
              <div
                className="animate-fade-in panel"
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--accent-cyan)',
                  borderRadius: '0.75rem',
                  overflow: 'hidden',
                }}
              >
                <BatchGeneratePanel
                  projectId={selectedProjectId}
                  volumes={volumes}
                  chapters={chapters}
                  onComplete={() => loadVolumes()}
                />
              </div>
            )}

            {/* Create form */}
            {showCreateForm && (
              <VolumeCreateForm
                nextVolumeNo={volumes.length + 1}
                onSubmit={handleCreate}
                onCancel={() => setShowCreateForm(false)}
              />
            )}

            {/* Volume list */}
            {volumes.length === 0 && !showCreateForm ? (
              <EmptyState message="尚未创建任何卷。点击「新增卷」开始规划你的故事结构。" />
            ) : (
              <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(22rem, 1fr))' }}>
                {volumes.map((volume) => (
                  <VolumeCard
                    key={volume.id}
                    volume={volume}
                    chapters={chaptersByVolume.get(volume.id) ?? []}
                    isEditing={editingVolume?.id === volume.id}
                    onEdit={() => setEditingVolume(volume)}
                    onSaveSynopsis={(synopsis) => handleSaveSynopsis(volume.id, synopsis)}
                    onDelete={() => handleDelete(volume.id)}
                    onCancelEdit={() => setEditingVolume(null)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

/* ─── Sub-components (kept local since they're small and panel-specific) ─── */

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full animate-fade-in" style={{ opacity: 0.7 }}>
      <div
        className="flex items-center justify-center animate-pulse-glow"
        style={{
          width: '5rem',
          height: '5rem',
          borderRadius: '1.25rem',
          background: 'var(--bg-card)',
          border: '1px solid var(--border-light)',
          color: '#14b8a6',
          marginBottom: '1.5rem',
        }}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
      </div>
      <p className="text-sm text-center" style={{ color: 'var(--text-dim)', maxWidth: '24rem', lineHeight: 1.6 }}>
        {message}
      </p>
    </div>
  );
}

function VolumeCreateForm({
  nextVolumeNo,
  onSubmit,
  onCancel,
}: {
  nextVolumeNo: number;
  onSubmit: (data: VolumeFormData) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');

  const handleSubmit = () => {
    onSubmit({
      volumeNo: nextVolumeNo,
      title: title || undefined,
      objective: objective || undefined,
    });
  };

  return (
    <div
      className="panel p-5 animate-fade-in"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-light)' }}
    >
      <h3 className="text-sm font-bold mb-3" style={{ color: '#14b8a6' }}>新增第 {nextVolumeNo} 卷</h3>
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-dim)' }}>卷标题</label>
          <input
            className="input-field"
            placeholder={`第${nextVolumeNo}卷`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-dim)' }}>本卷目标</label>
          <textarea
            className="input-field"
            rows={2}
            placeholder="描述这一卷的叙事目标…"
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
          />
        </div>
        <div className="flex gap-3 justify-end">
          <button className="btn-secondary" onClick={onCancel}>取消</button>
          <button className="btn-primary" onClick={handleSubmit}>创建</button>
        </div>
      </div>
    </div>
  );
}

function VolumeCard({
  volume,
  chapters,
  isEditing,
  onEdit,
  onSaveSynopsis,
  onDelete,
  onCancelEdit,
}: {
  volume: VolumeSummary;
  chapters: ChapterSummary[];
  isEditing: boolean;
  onEdit: () => void;
  onSaveSynopsis: (synopsis: string) => void;
  onDelete: () => void;
  onCancelEdit: () => void;
}) {
  const [synopsis, setSynopsis] = useState(volume.synopsis ?? '');
  const [showChapterOutlines, setShowChapterOutlines] = useState(false);
  const chapterCount = volume._count?.chapters ?? chapters.length;
  const storyUnits = storyUnitsFromPlan(volume.narrativePlan);

  useEffect(() => {
    setSynopsis(volume.synopsis ?? '');
  }, [volume.synopsis]);

  const statusLabel: Record<string, { text: string; color: string }> = {
    planned: { text: '规划中', color: '#f59e0b' },
    active: { text: '进行中', color: '#10b981' },
    completed: { text: '已完成', color: '#6366f1' },
  };
  const statusInfo = statusLabel[volume.status] ?? statusLabel.planned;

  return (
    <div
      className="panel p-5 animate-fade-in"
      style={{
        background: 'var(--bg-card)',
        border: `1px solid ${isEditing ? '#14b8a6' : 'var(--border-light)'}`,
        transition: 'border-color 0.3s ease',
      }}
    >
      {/* Card header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold" style={{ color: 'var(--text-main)' }}>
            {volume.title || `第${volume.volumeNo}卷`}
          </span>
          <span
            className="badge"
            style={{
              background: `${statusInfo.color}20`,
              color: statusInfo.color,
              border: 'none',
              fontSize: '0.65rem',
            }}
          >
            {statusInfo.text}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
            {chapterCount} 章
          </span>
        </div>
      </div>

      {/* Objective */}
      {volume.objective && (
        <p className="text-xs mb-3" style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>
          <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>目标：</span>
          {volume.objective}
        </p>
      )}

      {/* Synopsis editor */}
      {isEditing ? (
        <div className="space-y-2">
          <label className="text-xs font-medium block" style={{ color: 'var(--text-dim)' }}>卷纲</label>
          <textarea
            className="input-field"
            rows={5}
            value={synopsis}
            onChange={(e) => setSynopsis(e.target.value)}
            placeholder="编写这一卷的详细剧情大纲…"
          />
          <div className="flex gap-2 justify-end">
            <button className="btn-secondary" onClick={onCancelEdit} style={{ fontSize: '0.75rem' }}>取消</button>
            <button className="btn-primary" onClick={() => onSaveSynopsis(synopsis)} style={{ fontSize: '0.75rem' }}>保存卷纲</button>
          </div>
        </div>
      ) : (
        <>
          {volume.synopsis ? (
            <p className="text-xs mb-3" style={{ color: 'var(--text-muted)', lineHeight: 1.6, maxHeight: '6rem', overflow: 'hidden' }}>
              {volume.synopsis}
            </p>
          ) : (
            <p className="text-xs mb-3" style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>
              尚未编写卷纲
            </p>
          )}
        </>
      )}

      {!isEditing && storyUnits.length > 0 && (
        <div className="mb-3 space-y-1">
          <div className="text-[0.68rem] font-semibold" style={{ color: '#14b8a6' }}>单元故事</div>
          {storyUnits.slice(0, 4).map((unit, index) => {
            const range = asObjectRecord(unit.chapterRange);
            const rangeText = typeof range?.start === 'number' && typeof range?.end === 'number'
              ? `第${range.start}-${range.end}章`
              : '';
            const functions = Array.isArray(unit.serviceFunctions)
              ? unit.serviceFunctions.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
              : [];
            return (
              <div key={textValue(unit.unitId) || index} className="text-[0.68rem] leading-5" style={{ color: 'var(--text-muted)' }}>
                <b style={{ color: 'var(--text-main)' }}>{textValue(unit.title, '未命名单元')}</b>
                {rangeText ? ` · ${rangeText}` : ''}
                {functions.length ? ` · ${functions.slice(0, 3).join(' / ')}` : ''}
              </div>
            );
          })}
        </div>
      )}

      <ChapterOutlineSection
        chapters={chapters}
        expectedCount={chapterCount}
        expanded={showChapterOutlines}
        onToggle={() => setShowChapterOutlines((prev) => !prev)}
      />

      {/* Card actions */}
      {!isEditing && (
        <div className="flex gap-2 mt-3 pt-3" style={{ borderTop: '1px solid var(--border-dim)' }}>
          <button className="btn-secondary" onClick={onEdit} style={{ fontSize: '0.7rem' }}>编辑卷纲</button>
          <button
            className="btn-secondary"
            onClick={onDelete}
            style={{ fontSize: '0.7rem', color: 'var(--status-err)' }}
          >
            删除
          </button>
        </div>
      )}
    </div>
  );
}

function ChapterOutlineSection({
  chapters,
  expectedCount,
  expanded,
  onToggle,
}: {
  chapters: ChapterSummary[];
  expectedCount: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasChapters = chapters.length > 0;
  const buttonLabel = expanded ? '收起章节细纲' : `查看章节细纲${expectedCount ? ` (${expectedCount})` : ''}`;
  const craftBriefCount = chapters.filter((chapter) => Object.keys(asCraftBriefRecord(chapter.craftBrief)).length > 0).length;

  return (
    <section className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-dim)' }}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>章节细纲</div>
          <div className="text-[0.68rem]" style={{ color: 'var(--text-muted)' }}>
            {hasChapters
              ? `已写入 ${chapters.length} 章，执行卡 ${craftBriefCount}/${chapters.length}，可展开查看目标、冲突、行动链和线索。`
              : expectedCount > 0
                ? `本卷记录 ${expectedCount} 章，但当前列表尚未加载章节明细。`
                : '本卷还没有章节细纲。'}
          </div>
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={onToggle}
          disabled={!hasChapters}
          style={{
            fontSize: '0.7rem',
            whiteSpace: 'nowrap',
            opacity: hasChapters ? 1 : 0.55,
            cursor: hasChapters ? 'pointer' : 'not-allowed',
          }}
        >
          {buttonLabel}
        </button>
      </div>

      {expanded && hasChapters && (
        <div
          className="mt-3"
          style={{
            maxHeight: '26rem',
            overflowY: 'auto',
            border: '1px solid var(--border-dim)',
            borderRadius: '0.5rem',
          }}
        >
          {chapters.map((chapter) => (
            <ChapterOutlineRow key={chapter.id} chapter={chapter} />
          ))}
        </div>
      )}
    </section>
  );
}

function ChapterOutlineRow({ chapter }: { chapter: ChapterSummary }) {
  const craftBrief = asCraftBriefRecord(chapter.craftBrief);
  const characterExecutionSummary = buildCharacterExecutionSummary(craftBrief.characterExecution);
  const actionBeats = Array.isArray(craftBrief.actionBeats)
    ? craftBrief.actionBeats.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const concreteClues = Array.isArray(craftBrief.concreteClues)
    ? craftBrief.concreteClues
        .map((item) => {
          if (!item || typeof item !== 'object') return '';
          const record = item as Record<string, unknown>;
          const name = textValue(record.name);
          const laterUse = textValue(record.laterUse);
          return laterUse ? `${name}（${laterUse}）` : name;
        })
        .filter(Boolean)
    : [];
  const visibleGoal = textValue(craftBrief.visibleGoal);
  const coreConflict = textValue(craftBrief.coreConflict);
  const mainlineTask = textValue(craftBrief.mainlineTask);
  const consequence = textValue(craftBrief.irreversibleConsequence);
  const characterShift = textValue(craftBrief.characterShift);
  const storyUnit = asObjectRecord(craftBrief.storyUnit);
  const storyUnitRange = asObjectRecord(storyUnit?.chapterRange);
  const storyUnitRangeText = typeof storyUnitRange?.start === 'number' && typeof storyUnitRange?.end === 'number'
    ? `第${storyUnitRange.start}-${storyUnitRange.end}章`
    : '';
  const storyUnitFunctions = Array.isArray(storyUnit?.serviceFunctions)
    ? storyUnit.serviceFunctions.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const storyUnitTitle = textValue(storyUnit?.title);

  return (
    <article
      className="px-3 py-3"
      style={{
        borderTop: '1px solid var(--border-dim)',
      }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span
          className="text-[0.68rem] font-bold"
          style={{
            color: '#14b8a6',
            minWidth: '2.2rem',
          }}
        >
          第{chapter.chapterNo}章
        </span>
        <span className="text-xs font-semibold truncate" style={{ color: 'var(--text-main)' }}>
          {chapter.title || '未命名章节'}
        </span>
        {chapter.status && (
          <span className="badge" style={{ fontSize: '0.62rem', border: 'none', color: 'var(--text-dim)', background: 'var(--bg-hover-subtle)' }}>
            {chapter.status}
          </span>
        )}
      </div>
      <ChapterField label="目标" value={chapter.objective} />
      <ChapterField label="冲突" value={chapter.conflict} />
      <ChapterField label="大纲" value={chapter.outline} multiline />
      {visibleGoal && <ChapterField label="可见目标" value={visibleGoal} />}
      {mainlineTask && <ChapterField label="主线任务" value={mainlineTask} />}
      {coreConflict && <ChapterField label="执行卡冲突" value={coreConflict} multiline />}
      {storyUnitTitle && <ChapterField label="单元故事" value={[storyUnitTitle, storyUnitRangeText, textValue(storyUnit?.chapterRole)].filter(Boolean).join(' · ')} />}
      {textValue(storyUnit?.localGoal) && <ChapterField label="单元目标" value={textValue(storyUnit?.localGoal)} multiline />}
      {storyUnitFunctions.length > 0 && <ChapterField label="单元功能" value={storyUnitFunctions.slice(0, 5).join('、')} />}
      {textValue(storyUnit?.unitPayoff) && <ChapterField label="单元结局" value={textValue(storyUnit?.unitPayoff)} multiline />}
      {actionBeats.length > 0 && <ChapterField label="行动链" value={actionBeats.slice(0, 5).join('；')} multiline />}
      <ChapterCharacterExecutionBrief summary={characterExecutionSummary} />
      {concreteClues.length > 0 && <ChapterField label="线索" value={concreteClues.slice(0, 4).join('；')} multiline />}
      {characterShift && <ChapterField label="人物变化" value={characterShift} multiline />}
      {consequence && <ChapterField label="后果" value={consequence} multiline />}
    </article>
  );
}

interface CharacterExecutionSummary {
  pov: string;
  cast: string[];
  relationshipChanges: string[];
  temporaryCharacterCount: number;
  temporaryCharacters: string[];
}

function ChapterCharacterExecutionBrief({ summary }: { summary: CharacterExecutionSummary | null }) {
  if (!summary) return null;

  return (
    <div
      className="mt-2 rounded-md border px-2 py-2 text-[0.68rem] leading-5"
      style={{
        borderColor: 'rgba(20,184,166,0.22)',
        background: 'rgba(20,184,166,0.06)',
        color: 'var(--text-muted)',
      }}
    >
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {summary.pov && <span><b style={{ color: 'var(--text-dim)' }}>POV</b>：{summary.pov}</span>}
        {summary.cast.length > 0 && <span><b style={{ color: 'var(--text-dim)' }}>角色</b>：{summary.cast.slice(0, 3).join('；')}</span>}
        {summary.relationshipChanges.length > 0 && <span><b style={{ color: 'var(--text-dim)' }}>关系</b>：{summary.relationshipChanges.slice(0, 2).join('；')}</span>}
        {summary.temporaryCharacterCount > 0 && (
          <span>
            <b style={{ color: 'var(--text-dim)' }}>临时</b>：
            {summary.temporaryCharacterCount}
            {summary.temporaryCharacters.length > 0 ? ` ${summary.temporaryCharacters.slice(0, 2).join('；')}` : ''}
          </span>
        )}
      </div>
    </div>
  );
}

function ChapterField({ label, value, multiline = false }: { label: string; value?: string | null; multiline?: boolean }) {
  if (!value?.trim()) return null;

  return (
    <p
      className="text-[0.68rem]"
      style={{
        color: 'var(--text-muted)',
        lineHeight: 1.55,
        marginTop: '0.25rem',
        display: multiline ? 'block' : 'flex',
        gap: '0.35rem',
      }}
    >
      <span style={{ color: 'var(--text-dim)', fontWeight: 600, flexShrink: 0 }}>{label}：</span>
      <span>{value}</span>
    </p>
  );
}

function storyUnitsFromPlan(value: VolumeSummary['narrativePlan']): Record<string, unknown>[] {
  const plan = asObjectRecord(value);
  const units = Array.isArray(plan?.storyUnits) ? plan.storyUnits : [];
  return units
    .map((item) => asObjectRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function asCraftBriefRecord(value: ChapterSummary['craftBrief']): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } as Record<string, unknown> : {};
}

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function recordList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.map((item) => asObjectRecord(item)).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : [];
}

function textValue(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function buildCharacterExecutionSummary(value: unknown): CharacterExecutionSummary | null {
  const execution = asObjectRecord(value);
  if (!execution) return null;

  const cast = recordList(execution.cast).map(formatCastMember).filter(Boolean);
  const relationshipChanges = recordList(execution.relationshipBeats).map(formatRelationshipBeat).filter(Boolean);
  const temporaryCharacters = recordList(execution.newMinorCharacters).map(formatMinorCharacter).filter(Boolean);
  const temporaryCharacterCount = recordList(execution.newMinorCharacters).length;
  const pov = textValue(execution.povCharacter);

  if (!pov && !cast.length && !relationshipChanges.length && temporaryCharacterCount === 0) return null;
  return { pov, cast, relationshipChanges, temporaryCharacterCount, temporaryCharacters };
}

function formatCastMember(member: Record<string, unknown>) {
  const name = textValue(member.characterName);
  if (!name) return '';
  const source = characterSourceLabel(member.source);
  const goal = textValue(member.visibleGoal ?? member.functionInChapter);
  return `${name}${source ? `/${source}` : ''}${goal ? `：${goal}` : ''}`;
}

function formatRelationshipBeat(beat: Record<string, unknown>) {
  const participants = stringList(beat.participants).join('/');
  const shift = textValue(beat.shift ?? beat.publicStateAfter ?? beat.trigger);
  if (!participants && !shift) return '';
  return [participants, shift].filter(Boolean).join('：');
}

function formatMinorCharacter(character: Record<string, unknown>) {
  return textValue(character.nameOrLabel);
}

function characterSourceLabel(value: unknown) {
  const source = textValue(value);
  if (source === 'existing') return '既有';
  if (source === 'volume_candidate') return '候选';
  if (source === 'minor_temporary') return '临时';
  return source;
}
