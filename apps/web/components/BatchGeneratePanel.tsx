/**
 * BatchGeneratePanel — Unified AI chapter content generation hub.
 *
 * Supports three generation modes:
 *  - 单章生成 (single): shows all chapters with per-chapter generate buttons
 *  - 按卷生成 (volume): select volumes to generate sequentially
 *  - 全书生成 (book): generate all planned chapters at once
 *
 * Displays real-time progress with a visual progress bar.
 * Each chapter is generated sequentially to ensure context continuity.
 */
'use client';

import React, { useState, useCallback, useMemo } from 'react';
import { ChapterSummary, VolumeSummary } from '../types/dashboard';
import { useChapterGeneration, GenerationState } from '../hooks/useChapterGeneration';

// ─── Types ──────────────────────────────────────────────

interface Props {
  projectId: string;
  volumes: VolumeSummary[];
  chapters: ChapterSummary[];
  onComplete?: (chapterIds?: string[]) => void | Promise<void>;
}

type GenerateMode = 'single' | 'volume' | 'book';

type ChapterGenerateTarget = {
  id: string;
  chapterNo: number;
  title: string;
  status?: ChapterSummary['status'];
};

// ─── Component ──────────────────────────────────────────

export function BatchGeneratePanel({ projectId, volumes, chapters, onComplete }: Props) {
  const gen = useChapterGeneration();
  const [selectedVolumeIds, setSelectedVolumeIds] = useState<Set<string>>(new Set());
  // Default mode is 'single' — chapter-level multi-select generation
  const [mode, setMode] = useState<GenerateMode>('single');
  // Multi-select: tracks which individual chapters are checked for generation
  const [selectedChapterIds, setSelectedChapterIds] = useState<Set<string>>(new Set());
  // Polish state: tracks which chapter is currently being polished
  const [polishingChapterId, setPolishingChapterId] = useState<string | null>(null);
  // 用站内确认卡片替代浏览器原生 confirm，避免阻塞式 Alert 弹窗打断暗色界面体验。
  const [pendingOverwriteTargets, setPendingOverwriteTargets] = useState<ChapterGenerateTarget[] | null>(null);
  // 生成后续章节可能过期时，在页面内展示提醒，替代 window.alert。
  const [staleChapterWarning, setStaleChapterWarning] = useState<ChapterSummary[] | null>(null);

  /** Group ALL chapters by volume for the single-chapter view */
  const allChaptersByVolume = useMemo(() => {
    const map = new Map<string, { volume: VolumeSummary | null; chapters: ChapterSummary[] }>();
    // Initialize with all volumes
    for (const vol of volumes) {
      map.set(vol.id, { volume: vol, chapters: [] });
    }
    // Assign chapters to their volumes
    for (const ch of chapters) {
      const vid = ch.volumeId || '__unassigned__';
      if (!map.has(vid)) {
        map.set(vid, { volume: null, chapters: [] });
      }
      map.get(vid)!.chapters.push(ch);
    }
    // Sort chapters within each volume by chapterNo
    for (const [, group] of map) {
      group.chapters.sort((a, b) => a.chapterNo - b.chapterNo);
    }
    return map;
  }, [volumes, chapters]);

  /** Group chapters by volume, only include 'planned' status chapters (for batch modes) */
  const volumeChapterMap = useMemo(() => {
    const map = new Map<string, ChapterSummary[]>();
    for (const ch of chapters) {
      if (ch.status !== 'planned' && ch.status !== undefined) continue;
      const vid = ch.volumeId || '__unassigned__';
      if (!map.has(vid)) map.set(vid, []);
      map.get(vid)!.push(ch);
    }
    // Sort chapters within each volume by chapterNo
    for (const [, chs] of map) {
      chs.sort((a, b) => a.chapterNo - b.chapterNo);
    }
    return map;
  }, [chapters]);

  /** Compute total planned chapters count */
  const totalPlanned = useMemo(() => {
    let count = 0;
    for (const [, chs] of volumeChapterMap) count += chs.length;
    return count;
  }, [volumeChapterMap]);

  /** Toggle volume selection */
  const toggleVolume = useCallback((volumeId: string) => {
    setSelectedVolumeIds((prev) => {
      const next = new Set(prev);
      if (next.has(volumeId)) next.delete(volumeId);
      else next.add(volumeId);
      return next;
    });
  }, []);

  /** Select all volumes */
  const selectAll = useCallback(() => {
    setSelectedVolumeIds(new Set(volumes.map((v) => v.id)));
    setMode('book');
  }, [volumes]);

  /** Get chapters to generate based on current selection (batch modes only) */
  const getTargetChapters = useCallback(() => {
    if (mode === 'book') {
      return chapters
        .filter((ch) => !ch.status || ch.status === 'planned')
        .sort((a, b) => a.chapterNo - b.chapterNo);
    }
    const result: ChapterSummary[] = [];
    for (const vid of selectedVolumeIds) {
      const vChapters = volumeChapterMap.get(vid) || [];
      result.push(...vChapters);
    }
    return result.sort((a, b) => a.chapterNo - b.chapterNo);
  }, [mode, selectedVolumeIds, chapters, volumeChapterMap]);

  /** Toggle a single chapter's selection */
  const toggleChapter = useCallback((chapterId: string) => {
    setSelectedChapterIds((prev) => {
      const next = new Set(prev);
      if (next.has(chapterId)) next.delete(chapterId);
      else next.add(chapterId);
      return next;
    });
  }, []);

  /** Toggle all chapters within a specific volume */
  const toggleVolumeChapters = useCallback((volumeChapters: ChapterSummary[]) => {
    setSelectedChapterIds((prev) => {
      const next = new Set(prev);
      const allSelected = volumeChapters.every((ch) => prev.has(ch.id));
      // If all are selected, deselect all; otherwise select all
      for (const ch of volumeChapters) {
        if (allSelected) next.delete(ch.id);
        else next.add(ch.id);
      }
      return next;
    });
  }, []);

  /** 执行按章生成，并在完成后用页面内提示标记可能过期的后续章节。 */
  const runChapterBatchGenerate = useCallback(async (targets: ChapterGenerateTarget[]) => {
    setPendingOverwriteTargets(null);
    setStaleChapterWarning(null);
    await gen.generateSequential(projectId, targets, () => {});

    // 生成完成后，检查后续是否有已生成章节可能受影响
    const maxGeneratedNo = Math.max(...targets.map((t) => t.chapterNo));
    const staleChapters = chapters.filter(
      (ch) => ch.chapterNo > maxGeneratedNo && ch.status === 'drafted',
    );
    setStaleChapterWarning(staleChapters.length > 0 ? staleChapters : null);

    await onComplete?.(targets.map((target) => target.id));
  }, [projectId, chapters, gen, onComplete]);

  /** Start batch generation for selected chapters (chapter mode) */
  const handleChapterBatchGenerate = useCallback(async () => {
    if (selectedChapterIds.size === 0) return;
    // Build sorted target list from selected IDs
    const targets = chapters
      .filter((ch) => selectedChapterIds.has(ch.id))
      .sort((a, b) => a.chapterNo - b.chapterNo)
      .map((ch) => ({
        id: ch.id,
        chapterNo: ch.chapterNo,
        title: ch.title || `第${ch.chapterNo}章`,
        status: ch.status,
      }));

    // 已生成章节需要二次确认，但使用自定义卡片，避免浏览器原生 Alert/Confirm。
    if (targets.some((t) => t.status === 'drafted')) {
      setPendingOverwriteTargets(targets);
      return;
    }

    await runChapterBatchGenerate(targets);
  }, [selectedChapterIds, chapters, runChapterBatchGenerate]);

  /** Start batch generation (volume/book modes) */
  const handleStart = useCallback(async () => {
    const targets = getTargetChapters();
    if (targets.length === 0) return;
    await gen.generateSequential(
      projectId,
      targets.map((ch) => ({
        id: ch.id,
        chapterNo: ch.chapterNo,
        title: ch.title || `第${ch.chapterNo}章`,
      })),
      () => {
        // Optional: callback per chapter completion
      },
    );
    await onComplete?.(targets.map((target) => target.id));
  }, [projectId, getTargetChapters, gen, onComplete]);

  const isActive = gen.state === 'generating' || gen.state === 'polling';
  const targetCount = mode === 'single' ? selectedChapterIds.size : getTargetChapters().length;

  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)', position: 'relative' }}>
      {/* ── Page Header ── */}
      <header
        className="shrink-0 flex items-center justify-between"
        style={{
          height: '3.5rem',
          padding: '0 2rem',
          background: 'var(--bg-editor-header)',
          borderBottom: '1px solid var(--border-light)',
          backdropFilter: 'blur(12px)',
        }}
      >
        <h1
          className="text-lg font-bold text-heading"
          style={{ textShadow: '0 2px 10px var(--accent-cyan-glow)' }}
        >
          🤖 AI 生成
        </h1>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          共 {chapters.length} 章 · {totalPlanned} 章待生成
        </span>
      </header>

      {/* ── Scrollable Content Area ── */}
      <div className="flex-1" style={{ overflowY: 'auto', padding: '1.5rem 2rem' }}>
        {/* ── Chapter Mode: multi-select with batch generation ── */}
        {mode === 'single' && (
          <ChapterSelectList
            allChaptersByVolume={allChaptersByVolume}
            selectedChapterIds={selectedChapterIds}
            onToggleChapter={toggleChapter}
            onToggleVolume={toggleVolumeChapters}
            genProgress={gen.progress}
            genState={gen.state}
            generationError={gen.error}
            isActive={isActive}
            polishingChapterId={polishingChapterId}
            onPolish={async (chapterId: string) => {
              setPolishingChapterId(chapterId);
              await gen.polishSingle(chapterId);
              setPolishingChapterId(null);
            }}
          />
        )}

        {/* ── Volume Mode: select volumes ── */}
        {mode === 'volume' && !isActive && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: '48rem' }}>
            {volumes.map((vol) => {
              const planned = volumeChapterMap.get(vol.id)?.length ?? 0;
              const isSelected = selectedVolumeIds.has(vol.id);
              return (
                <label
                  key={vol.id}
                  className="flex items-center gap-3"
                  style={{
                    padding: '0.6rem 1rem',
                    borderRadius: '0.5rem',
                    background: isSelected ? 'rgba(6,182,212,0.08)' : 'var(--bg-card)',
                    border: `1px solid ${isSelected ? 'var(--accent-cyan)' : 'var(--border-light)'}`,
                    cursor: planned > 0 ? 'pointer' : 'not-allowed',
                    opacity: planned > 0 ? 1 : 0.5,
                    transition: 'all 0.2s ease',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleVolume(vol.id)}
                    disabled={planned === 0}
                    style={{ accentColor: 'var(--accent-cyan)' }}
                  />
                  <span className="text-sm font-medium">
                    第{vol.volumeNo}卷「{vol.title || '未命名'}」
                  </span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)', marginLeft: 'auto' }}>
                    {planned} 章待生成
                  </span>
                </label>
              );
            })}
          </div>
        )}

        {/* ── Progress display (batch modes) ── */}
        {isActive && gen.progress && (
          <ProgressDisplay state={gen.state} progress={gen.progress} />
        )}

        {/* ── Completion message (batch modes) ── */}
        {gen.state === 'completed' && gen.progress && (
          <div
            className="animate-fade-in"
            style={{
              padding: '1rem',
              borderRadius: '0.5rem',
              background: 'rgba(16,185,129,0.08)',
              border: '1px solid rgba(16,185,129,0.3)',
              color: '#10b981',
              fontSize: '0.85rem',
              textAlign: 'center',
              maxWidth: '48rem',
            }}
          >
            ✅ 全部完成！共生成 {gen.progress.completedIds.length} 章
            {gen.progress.failedIds.length > 0 && (
              <span style={{ color: '#ef4444' }}>
                ，{gen.progress.failedIds.length} 章失败
              </span>
            )}
          </div>
        )}

        {/* ── Error message (batch modes) ── */}
        {gen.state === 'failed' && gen.error && (
          <div
            className="animate-fade-in"
            style={{
              padding: '0.8rem 1rem',
              borderRadius: '0.5rem',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.2)',
              color: '#ef4444',
              fontSize: '0.85rem',
              maxWidth: '48rem',
            }}
          >
            ❌ {gen.error}
              <div style={{ marginTop: '0.45rem', color: '#fecaca', lineHeight: 1.6 }}>
                已停在当前章节。请处理失败原因后点击“重置”，再继续生成。
              </div>
          </div>
        )}
      </div>

      {pendingOverwriteTargets && !isActive && (
        <OverwriteConfirmCard
          targets={pendingOverwriteTargets.filter((target) => target.status === 'drafted')}
          onCancel={() => setPendingOverwriteTargets(null)}
          onConfirm={() => runChapterBatchGenerate(pendingOverwriteTargets)}
        />
      )}

      {staleChapterWarning && !isActive && (
        <StaleChapterNotice
          chapters={staleChapterWarning}
          onDismiss={() => setStaleChapterWarning(null)}
        />
      )}

      {/* ── Floating Action Panel (always visible) ── */}
      <div
        style={{
          position: 'absolute',
          bottom: '1.5rem',
          right: '2rem',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: '0.6rem',
          zIndex: 20,
        }}
      >
        {/* Mode tabs — hidden during generation */}
        {!isActive && (
          <div
            style={{
              display: 'flex',
              gap: '0.4rem',
              padding: '0.4rem',
              borderRadius: '2rem',
              background: 'rgba(15,23,42,0.85)',
              backdropFilter: 'blur(16px)',
              border: '1px solid var(--border-light)',
              boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            }}
          >
            <ModeButton label="按章" active={mode === 'single'} onClick={() => setMode('single')} />
            <ModeButton label="按卷" active={mode === 'volume'} onClick={() => setMode('volume')} />
            <ModeButton label="全书" active={mode === 'book'} onClick={() => { setMode('book'); selectAll(); }} />
          </div>
        )}
        {/* Reset button — shown after completion/failure */}
        {(gen.state === 'completed' || gen.state === 'failed') && (
          <button
            onClick={gen.reset}
            className="animate-fade-in"
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '2rem',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: 'pointer',
              border: '1px solid var(--border-light)',
              background: 'var(--bg-card)',
              color: 'var(--text-muted)',
              backdropFilter: 'blur(12px)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
            }}
          >
            🔄 重置
          </button>
        )}
        {/* Main action button — generate or cancel */}
        {!isActive ? (
          <button
            disabled={targetCount === 0}
            onClick={mode === 'single' ? handleChapterBatchGenerate : handleStart}
            style={{
              padding: '0.8rem 1.8rem',
              borderRadius: '2rem',
              fontSize: '0.95rem',
              fontWeight: 700,
              cursor: targetCount > 0 ? 'pointer' : 'not-allowed',
              border: 'none',
              background: targetCount > 0
                ? 'linear-gradient(135deg, rgba(6,182,212,0.9), rgba(139,92,246,0.8))'
                : 'var(--bg-card)',
              color: targetCount > 0 ? '#fff' : 'var(--text-muted)',
              boxShadow: targetCount > 0
                ? '0 4px 24px rgba(6,182,212,0.4), 0 0 48px rgba(139,92,246,0.15)'
                : '0 4px 16px rgba(0,0,0,0.3)',
              backdropFilter: 'blur(12px)',
              transition: 'all 0.25s ease',
              letterSpacing: '0.02em',
            }}
          >
            🤖 开始生成（{targetCount} 章）
          </button>
        ) : (
          <button
            onClick={gen.cancel}
            className="animate-pulse"
            style={{
              padding: '0.8rem 1.8rem',
              borderRadius: '2rem',
              fontSize: '0.95rem',
              fontWeight: 600,
              cursor: 'pointer',
              border: '1px solid rgba(239,68,68,0.4)',
              background: 'rgba(239,68,68,0.85)',
              color: '#fff',
              boxShadow: '0 4px 24px rgba(239,68,68,0.3)',
              backdropFilter: 'blur(12px)',
              transition: 'all 0.25s ease',
            }}
          >
            ⏹ 取消生成
          </button>
        )}
      </div>
    </article>
  );
}

// ─── Sub-components ─────────────────────────────────────

/**
 * OverwriteConfirmCard — In-page replacement for native confirm dialogs.
 * Shows which drafted chapters will be overwritten and lets the user continue or cancel.
 */
function OverwriteConfirmCard({
  targets,
  onConfirm,
  onCancel,
}: {
  targets: ChapterGenerateTarget[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const previewTargets = targets.slice(0, 6);

  return (
    <div
      className="animate-fade-in"
      style={{
        position: 'absolute',
        right: '2rem',
        bottom: '7.6rem',
        width: 'min(28rem, calc(100% - 4rem))',
        padding: '1rem',
        borderRadius: '1rem',
        background: 'linear-gradient(180deg, rgba(15,23,42,0.96), rgba(8,13,24,0.96))',
        border: '1px solid rgba(245,158,11,0.35)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.55), 0 0 32px rgba(245,158,11,0.08)',
        backdropFilter: 'blur(18px)',
        zIndex: 30,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.7rem' }}>
        <span style={{ fontSize: '1.1rem' }}>⚠️</span>
        <strong style={{ color: '#fbbf24', fontSize: '0.95rem' }}>确认覆盖已有草稿</strong>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', lineHeight: 1.7, marginBottom: '0.75rem' }}>
        以下 {targets.length} 章已有生成内容，继续生成将覆盖现有草稿：
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginBottom: '0.85rem' }}>
        {previewTargets.map((target) => (
          <span key={target.id} style={{ color: 'var(--text-main)', fontSize: '0.82rem' }}>
            #{target.chapterNo} {target.title}
          </span>
        ))}
        {targets.length > previewTargets.length && (
          <span style={{ color: 'var(--text-dim)', fontSize: '0.78rem' }}>…等共 {targets.length} 章</span>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
        <button type="button" onClick={onCancel} style={secondaryActionStyle}>取消</button>
        <button type="button" onClick={onConfirm} style={dangerActionStyle}>确认覆盖</button>
      </div>
    </div>
  );
}

/**
 * StaleChapterNotice — Non-blocking warning shown after generation changes earlier chapters.
 * It avoids window.alert while still preserving the stale-content reminder.
 */
function StaleChapterNotice({ chapters, onDismiss }: { chapters: ChapterSummary[]; onDismiss: () => void }) {
  const previewChapters = chapters.slice(0, 10);

  return (
    <div
      className="animate-fade-in"
      style={{
        position: 'absolute',
        left: '2rem',
        bottom: '1.5rem',
        width: 'min(34rem, calc(100% - 24rem))',
        padding: '0.9rem 1rem',
        borderRadius: '0.9rem',
        background: 'rgba(8,13,24,0.94)',
        border: '1px solid rgba(6,182,212,0.28)',
        boxShadow: '0 16px 46px rgba(0,0,0,0.45)',
        backdropFilter: 'blur(18px)',
        zIndex: 25,
      }}
    >
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
        <span>💡</span>
        <div style={{ flex: 1 }}>
          <strong style={{ color: 'var(--accent-cyan)', fontSize: '0.88rem' }}>后续章节可能需要重新生成</strong>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', lineHeight: 1.7, marginTop: '0.35rem' }}>
            以下章节基于旧版角色状态/剧情生成，建议按顺序重新生成。
          </p>
          <p style={{ color: 'var(--text-dim)', fontSize: '0.76rem', lineHeight: 1.6, marginTop: '0.45rem' }}>
            {previewChapters.map((chapter) => `#${chapter.chapterNo} ${chapter.title || '未命名'}`).join('、')}
            {chapters.length > previewChapters.length ? `…等共 ${chapters.length} 章` : ''}
          </p>
        </div>
        <button type="button" onClick={onDismiss} aria-label="关闭提醒" style={closeButtonStyle}>×</button>
      </div>
    </div>
  );
}

const secondaryActionStyle: React.CSSProperties = {
  padding: '0.45rem 0.85rem',
  borderRadius: '0.65rem',
  border: '1px solid var(--border-light)',
  background: 'rgba(148,163,184,0.08)',
  color: 'var(--text-muted)',
  cursor: 'pointer',
};

const dangerActionStyle: React.CSSProperties = {
  padding: '0.45rem 0.85rem',
  borderRadius: '0.65rem',
  border: '1px solid rgba(245,158,11,0.45)',
  background: 'rgba(245,158,11,0.16)',
  color: '#fbbf24',
  fontWeight: 700,
  cursor: 'pointer',
};

const closeButtonStyle: React.CSSProperties = {
  width: '1.65rem',
  height: '1.65rem',
  borderRadius: '999px',
  border: '1px solid var(--border-light)',
  background: 'rgba(15,23,42,0.75)',
  color: 'var(--text-muted)',
  cursor: 'pointer',
};

/**
 * ChapterSelectList — Multi-select chapter list grouped by volume.
 * Each chapter has a checkbox; volume headers have a "toggle all" control.
 * During generation, in-progress and completed chapters are visually highlighted.
 */
function ChapterSelectList({
  allChaptersByVolume,
  selectedChapterIds,
  onToggleChapter,
  onToggleVolume,
  genProgress,
  genState,
  generationError,
  isActive,
  polishingChapterId,
  onPolish,
}: {
  allChaptersByVolume: Map<string, { volume: VolumeSummary | null; chapters: ChapterSummary[] }>;
  selectedChapterIds: Set<string>;
  onToggleChapter: (chapterId: string) => void;
  onToggleVolume: (chapters: ChapterSummary[]) => void;
  genProgress: ReturnType<typeof useChapterGeneration>['progress'];
  genState: GenerationState;
  generationError: string;
  isActive: boolean;
  polishingChapterId: string | null;
  onPolish: (chapterId: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: '48rem' }}>
      {Array.from(allChaptersByVolume.entries()).map(([volumeId, { volume, chapters: volChapters }]) => {
        if (volChapters.length === 0) return null;
        const allChecked = volChapters.every((ch) => selectedChapterIds.has(ch.id));
        const someChecked = volChapters.some((ch) => selectedChapterIds.has(ch.id));

        return (
          <div key={volumeId}>
            {/* Volume header with toggle-all checkbox */}
            <div
              className="flex items-center gap-2"
              style={{
                padding: '0.4rem 0',
                marginBottom: '0.5rem',
                borderBottom: '1px solid var(--border-dim)',
              }}
            >
              <input
                type="checkbox"
                checked={allChecked}
                ref={(el) => { if (el) el.indeterminate = someChecked && !allChecked; }}
                onChange={() => onToggleVolume(volChapters)}
                disabled={isActive}
                style={{ accentColor: 'var(--accent-cyan)', cursor: isActive ? 'not-allowed' : 'pointer' }}
              />
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-main)' }}>
                📁 {volume ? `第${volume.volumeNo}卷「${volume.title || '未命名'}」` : '未分卷章节'}
              </span>
              <span className="text-xs" style={{ color: 'var(--text-dim)', marginLeft: 'auto' }}>
                {volChapters.length} 章
              </span>
            </div>
            {/* Chapter list with checkboxes */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              {volChapters.map((ch) => {
                const isChecked = selectedChapterIds.has(ch.id);
                // Determine generation state for this chapter during batch run
                const isCompleted = genProgress?.completedIds.includes(ch.id);
                const isFailed = genProgress?.failedIds.includes(ch.id);
                const isCurrentlyGenerating = isActive && genProgress?.currentChapterId === ch.id;
                const shouldShowFailureReason = isFailed && genState === 'failed' && Boolean(generationError);
                // Status display
                const statusLabel = ch.status === 'drafted' ? '已生成' : '待生成';
                const statusColor = ch.status === 'drafted' ? '#10b981' : 'var(--text-dim)';

                return (
                  <div
                    key={ch.id}
                    style={{
                      padding: shouldShowFailureReason ? '0.5rem 0.8rem 0.65rem' : '0.5rem 0.8rem',
                      borderRadius: '0.5rem',
                      cursor: isActive ? 'default' : 'pointer',
                      background: isCurrentlyGenerating
                        ? 'rgba(6,182,212,0.06)'
                        : isCompleted
                          ? 'rgba(16,185,129,0.06)'
                          : isFailed
                            ? 'rgba(239,68,68,0.06)'
                            : isChecked
                              ? 'rgba(6,182,212,0.04)'
                              : 'var(--bg-card)',
                      border: `1px solid ${
                        isCurrentlyGenerating ? 'var(--accent-cyan)'
                        : isChecked ? 'rgba(6,182,212,0.3)'
                        : isFailed ? 'rgba(239,68,68,0.3)'
                        : 'var(--border-light)'
                      }`,
                      transition: 'all 0.2s ease',
                    }}
                  >
                    <label className="flex items-center gap-3" style={{ cursor: isActive ? 'default' : 'pointer' }}>
                      {/* Checkbox */}
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => onToggleChapter(ch.id)}
                        disabled={isActive}
                        style={{ accentColor: 'var(--accent-cyan)', cursor: isActive ? 'not-allowed' : 'pointer' }}
                      />
                      {/* Chapter number */}
                      <span
                        className="shrink-0 text-xs font-medium"
                        style={{ color: 'var(--text-dim)', width: '3rem', textAlign: 'right' }}
                      >
                        #{ch.chapterNo}
                      </span>
                      {/* Chapter title */}
                      <span className="flex-1 text-sm truncate" style={{ color: 'var(--text-main)' }}>
                        {ch.title || '未命名章节'}
                      </span>
                      {/* Status / progress indicator */}
                      <span
                        className="shrink-0 text-xs"
                        style={{
                          color: isCurrentlyGenerating ? 'var(--accent-cyan)'
                            : isCompleted ? '#10b981'
                            : isFailed ? '#ef4444'
                            : statusColor,
                          padding: '0.15rem 0.4rem',
                          borderRadius: '0.25rem',
                          background: isCompleted ? 'rgba(16,185,129,0.1)'
                            : isFailed ? 'rgba(239,68,68,0.1)'
                            : ch.status === 'drafted' ? 'rgba(16,185,129,0.1)'
                            : 'transparent',
                        }}
                      >
                        {isCurrentlyGenerating ? '✍️ 生成中…'
                          : isCompleted ? '✅ 完成'
                          : isFailed ? '❌ 失败'
                          : statusLabel}
                      </span>
                      {/* Polish button — only shown for drafted chapters when not generating */}
                      {ch.status === 'drafted' && !isActive && (
                        <button
                          disabled={polishingChapterId !== null}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPolish(ch.id); }}
                          style={{
                            padding: '0.15rem 0.5rem',
                            borderRadius: '0.3rem',
                            fontSize: '0.7rem',
                            fontWeight: 600,
                            cursor: polishingChapterId ? 'not-allowed' : 'pointer',
                            border: '1px solid rgba(139,92,246,0.3)',
                            background: polishingChapterId === ch.id
                              ? 'rgba(139,92,246,0.2)'
                              : 'rgba(139,92,246,0.08)',
                            color: polishingChapterId === ch.id ? '#c4b5fd' : '#a78bfa',
                            transition: 'all 0.2s ease',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {polishingChapterId === ch.id ? '✨ 润色中…' : '✨ 润色'}
                        </button>
                      )}
                    </label>
                    {shouldShowFailureReason ? (
                      <div style={{ marginLeft: '4.9rem', marginTop: '0.45rem', color: '#ef4444', fontSize: '0.78rem', lineHeight: 1.65 }}>
                        失败原因：{generationError}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Mode selection button */
function ModeButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '0.4rem 1rem',
        borderRadius: '0.5rem',
        fontSize: '0.8rem',
        fontWeight: active ? 700 : 500,
        cursor: 'pointer',
        border: `1px solid ${active ? 'var(--accent-cyan)' : 'var(--border-light)'}`,
        background: active ? 'rgba(6,182,212,0.12)' : 'transparent',
        color: active ? 'var(--accent-cyan)' : 'var(--text-muted)',
        transition: 'all 0.2s ease',
      }}
    >
      {label}
    </button>
  );
}

/** Real-time progress display with visual progress bar */
function ProgressDisplay({ state, progress }: { state: GenerationState; progress: NonNullable<ReturnType<typeof useChapterGeneration>['progress']> }) {
  const pct = progress.total > 0
    ? Math.round(((progress.current - 1 + (state === 'polling' ? 0.5 : 0)) / progress.total) * 100)
    : 0;

  return (
    <div
      className="animate-fade-in"
      style={{
        padding: '1rem',
        borderRadius: '0.5rem',
        background: 'var(--bg-card)',
        border: '1px solid var(--border-light)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.6rem',
        maxWidth: '48rem',
      }}
    >
      {/* Progress bar */}
      <div style={{ height: '6px', borderRadius: '3px', background: 'var(--bg-deep)', overflow: 'hidden' }}>
        <div
          className="animate-pulse"
          style={{
            height: '100%',
            width: `${pct}%`,
            borderRadius: '3px',
            background: 'linear-gradient(90deg, var(--accent-cyan), var(--accent-purple))',
            transition: 'width 0.5s ease',
          }}
        />
      </div>
      {/* Status text */}
      <div className="flex items-center justify-between text-xs">
        <span style={{ color: 'var(--accent-cyan)', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span>✍️ 正在处理：{progress.currentChapterTitle}</span>
          {progress.currentStep ? (
            <span style={{ color: 'var(--text-muted)' }}>当前步骤：{progress.currentStep}</span>
          ) : null}
        </span>
        <span style={{ color: 'var(--text-muted)' }}>
          {progress.current}/{progress.total}
        </span>
      </div>
      {/* Stats */}
      <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
        <span>✅ {progress.completedIds.length} 完成</span>
        {progress.failedIds.length > 0 && (
          <span style={{ color: '#ef4444' }}>❌ {progress.failedIds.length} 失败</span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          预计剩余：约 {Math.max(1, Math.round((progress.total - progress.current + 1) * 1.5))} 分钟
        </span>
      </div>
    </div>
  );
}
