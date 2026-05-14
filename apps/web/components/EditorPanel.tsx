/**
 * EditorPanel — Chapter content editor with AI generation support.
 *
 * Features:
 *  - AI generate button in header (single chapter)
 *  - Auto-loads existing draft on chapter selection
 *  - Displays generation status (polling, progress)
 *  - Editable textarea for manual editing
 *  - Word count display
 */
'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { ProjectSummary, ChapterSummary, ChapterDraft, VolumeSummary } from '../types/dashboard';
import { useChapterGeneration } from '../hooks/useChapterGeneration';
import { PassageAgentPopover } from './editor/PassageAgentPopover';
import { usePassageSelection } from './editor/usePassageSelection';
import {
  buildPassageAgentContext,
  getPassageAgentDisabledReason,
  type PassageAgentContext,
} from './editor/passageSelection';

type DraftViewMode = 'draft' | 'polished';

interface Props {
  selectedProject?: ProjectSummary;
  selectedChapterId: string;
  chapters: ChapterSummary[];
  volumes?: VolumeSummary[];
  draftRefreshKey?: number;
  /** Refresh parent dashboard data after a chapter draft is generated so status badges update immediately. */
  onChapterGenerated?: (chapterId: string) => void | Promise<void>;
  /** Refresh parent dashboard data after manual draft edits are saved. */
  onChapterSaved?: (chapterId: string) => void | Promise<void>;
  /** Run chapter-scoped AI review/maintenance without changing the chapter completion status. */
  onRunAutoMaintenance?: (chapterIds?: string[]) => void | Promise<void>;
  /** Mark the current chapter as complete; this only updates chapter metadata for the sidebar status dot. */
  onMarkChapterComplete?: (chapterId: string) => void | Promise<void>;
  /** Submit a passage-scoped Agent request with exact draft/range context. */
  onSubmitPassageAgent?: (request: { message: string; context: PassageAgentContext }) => void | Promise<void>;
}

export function EditorPanel({ selectedProject, selectedChapterId, chapters, volumes = [], draftRefreshKey = 0, onChapterGenerated, onChapterSaved, onRunAutoMaintenance, onMarkChapterComplete, onSubmitPassageAgent }: Props) {
  const isGlobal = selectedChapterId === 'all';
  const chapter = chapters.find((c) => c.id === selectedChapterId);
  const gen = useChapterGeneration();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editorBodyRef = useRef<HTMLDivElement>(null);

  // Local content state for the editor textarea
  const [content, setContent] = useState('');
  const [draftVersions, setDraftVersions] = useState<ChapterDraft[]>([]);
  const [activeViewMode, setActiveViewMode] = useState<DraftViewMode>('draft');
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [isAutoMaintaining, setIsAutoMaintaining] = useState(false);
  const [isMarkingComplete, setIsMarkingComplete] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [savedDraftContent, setSavedDraftContent] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saveNotice, setSaveNotice] = useState('');
  const [isSubmittingPassageAgent, setIsSubmittingPassageAgent] = useState(false);
  const [passageAgentError, setPassageAgentError] = useState('');

  const title = isGlobal
    ? selectedProject?.title || '未选择项目'
    : `第${chapter?.chapterNo ?? '?'}章 · ${chapter?.title || '无标题'}`;

  // Compute word count from current content
  const wordCount = content.replace(/\s/g, '').length;

  const viewPair = buildDraftViewPair(draftVersions);
  const activeDraft = activeViewMode === 'polished' ? viewPair.polished : viewPair.draft;
  const hasUnsavedChanges = Boolean(activeDraft && content !== savedDraftContent);
  const canSaveDraft = Boolean(activeDraft && content.trim() && hasUnsavedChanges);
  const isGenerating = gen.state === 'generating' || gen.state === 'polling';
  const currentVolume = chapter?.volumeId ? volumes.find((item) => item.id === chapter.volumeId) : undefined;
  const passageSelection = usePassageSelection({
    textareaRef,
    overlayContainerRef: editorBodyRef,
    text: content,
    enabled: !isGlobal && Boolean(selectedProject?.id && chapter && activeDraft),
  });
  const passageAgentContext = selectedProject && chapter && activeDraft && passageSelection.selection
    ? buildPassageAgentContext({
        project: selectedProject,
        chapter,
        volume: currentVolume,
        draft: activeDraft,
        draftViewMode: activeViewMode,
        selection: passageSelection.selection,
      })
    : null;
  const passageAgentDisabledReason = getPassageAgentDisabledReason({
    hasProject: Boolean(selectedProject?.id),
    hasChapter: Boolean(!isGlobal && chapter),
    hasDraft: Boolean(activeDraft),
    hasSelection: Boolean(passageSelection.selection),
    hasUnsavedChanges,
    isGenerating,
    isAutoMaintaining,
    isSavingDraft,
    isMarkingComplete,
    hasSubmitHandler: Boolean(onSubmitPassageAgent),
  });
  const handleSubmitPassageAgent = useCallback(async (message: string, context: PassageAgentContext) => {
    if (!onSubmitPassageAgent || isSubmittingPassageAgent) return;
    setIsSubmittingPassageAgent(true);
    setPassageAgentError('');
    try {
      await onSubmitPassageAgent({ message, context });
      passageSelection.clearSelection();
    } catch (error) {
      setPassageAgentError(error instanceof Error ? error.message : '提交正文选区 Agent 任务失败');
    } finally {
      setIsSubmittingPassageAgent(false);
    }
  }, [isSubmittingPassageAgent, onSubmitPassageAgent, passageSelection]);

  // Auto-load draft when chapter selection changes. AI validation repair creates a
  // new current draft for the same chapter, so draftRefreshKey forces a reload.
  useEffect(() => {
    if (isGlobal || !selectedChapterId) {
      setContent('');
      setSavedDraftContent('');
      setDraftVersions([]);
      setActiveViewMode('draft');
      setDraftLoaded(false);
      setSaveError('');
      setSaveNotice('');
      return;
    }
    // Load existing drafts for this chapter. The version list lets us pair an
    // agent_polish result with its source draft via generationContext.originalDraftId.
    void gen.loadDraftVersions(selectedChapterId).then((versions) => {
      const pair = buildDraftViewPair(versions);
      const initialMode: DraftViewMode = pair.polished ? 'polished' : 'draft';
      const initialDraft = initialMode === 'polished' ? pair.polished : pair.draft;

      setDraftVersions(versions);
      setActiveViewMode(initialMode);
      setContent(initialDraft?.content ?? '');
      setSavedDraftContent(initialDraft?.content ?? '');
      setDraftLoaded(Boolean(initialDraft?.content));
      setSaveError('');
      setSaveNotice('');
    });
    // Reset generation state when switching chapters
    gen.reset();
  }, [selectedChapterId, draftRefreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // When generation completes, update editor content
  useEffect(() => {
    if (gen.state === 'completed' && gen.currentDraft?.content) {
      void gen.loadDraftVersions(gen.currentDraft.chapterId).then((versions) => {
        const pair = buildDraftViewPair(versions);
        const nextMode: DraftViewMode = pair.polished ? 'polished' : 'draft';
        const nextDraft = nextMode === 'polished' ? pair.polished : pair.draft;

        setDraftVersions(versions);
        setActiveViewMode(nextMode);
        setContent(nextDraft?.content ?? gen.currentDraft?.content ?? '');
        setSavedDraftContent(nextDraft?.content ?? gen.currentDraft?.content ?? '');
        setDraftLoaded(true);
        setSaveError('');
        setSaveNotice('');
      });
    }
  }, [gen.state, gen.currentDraft]);

  /** Switch the text area between the original generated draft and polished result. */
  const handleSwitchViewMode = useCallback((mode: DraftViewMode) => {
    if (mode === activeViewMode) return;
    if (hasUnsavedChanges && !window.confirm('当前版本有未保存修改，切换后会放弃这些修改。继续切换？')) {
      return;
    }

    const pair = buildDraftViewPair(draftVersions);
    const targetDraft = mode === 'polished' ? pair.polished : pair.draft;

    // A disabled tab should be inert; this also protects keyboard/programmatic clicks.
    if (!targetDraft) return;
    setActiveViewMode(mode);
    setContent(targetDraft.content);
    setSavedDraftContent(targetDraft.content);
    setSaveError('');
    setSaveNotice('');
  }, [activeViewMode, draftVersions, hasUnsavedChanges]);

  /** Persist manual edits into the active draft row; polished edits stay in the polished version. */
  const handleSaveDraft = useCallback(async () => {
    if (isGlobal || !selectedChapterId || !activeDraft || isSavingDraft || !content.trim()) return;

    setIsSavingDraft(true);
    setSaveError('');
    setSaveNotice('');
    try {
      const savedDraft = await gen.saveDraftContent(selectedChapterId, activeDraft.id, content);
      const versions = await gen.loadDraftVersions(selectedChapterId);
      const nextVersions = versions.length ? versions : [savedDraft];
      const nextDraft = nextVersions.find((item) => item.id === savedDraft.id) ?? savedDraft;

      setDraftVersions(nextVersions);
      setActiveViewMode(isPolishedDraft(nextDraft) ? 'polished' : 'draft');
      setContent(nextDraft.content);
      setSavedDraftContent(nextDraft.content);
      setDraftLoaded(true);
      setSaveNotice(isPolishedDraft(nextDraft) ? '已保存到润色版本，事实层待刷新。' : '已保存到草稿版本，事实层待刷新。');
      await onChapterSaved?.(selectedChapterId);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '保存正文失败');
    } finally {
      setIsSavingDraft(false);
    }
  }, [activeDraft, content, gen, isGlobal, isSavingDraft, onChapterSaved, selectedChapterId]);

  /** Trigger AI generation for the current chapter */
  const handleGenerate = useCallback(async () => {
    if (isGlobal || !selectedChapterId || gen.state === 'polling' || gen.state === 'generating') return;
    if (!selectedProject?.id) return;
    const draft = await gen.generateSingle(selectedProject.id, selectedChapterId);
    if (draft) {
      // 生成结果会先写入编辑器本地正文；随后刷新父级 dashboard，让侧栏状态和右侧事实面板同步更新。
      await onChapterGenerated?.(selectedChapterId);
    }
  }, [isGlobal, onChapterGenerated, selectedProject?.id, selectedChapterId, gen]);

  /** Trigger AI review/maintenance chain for the current detail page. */
  const handleRunAiReview = useCallback(async () => {
    if (isGlobal || !selectedChapterId || !onRunAutoMaintenance || isAutoMaintaining) return;

    setIsAutoMaintaining(true);
    try {
      // Limit the AI review chain to the current chapter so it never behaves like the batch generation page.
      await onRunAutoMaintenance([selectedChapterId]);
    } finally {
      setIsAutoMaintaining(false);
    }
  }, [isGlobal, isAutoMaintaining, onRunAutoMaintenance, selectedChapterId]);

  /** Mark the current chapter complete without invoking AI, rebuild, validation, or memory review. */
  const handleMarkComplete = useCallback(async () => {
    if (isGlobal || !selectedChapterId || !onMarkChapterComplete || isMarkingComplete) return;

    setIsMarkingComplete(true);
    try {
      await onMarkChapterComplete(selectedChapterId);
    } finally {
      setIsMarkingComplete(false);
    }
  }, [isGlobal, isMarkingComplete, onMarkChapterComplete, selectedChapterId]);

  const statusText = chapter?.status === 'drafted' ? '已生成' : (draftLoaded ? '有草稿' : '未生成');
  const showFloatingActions = !isGlobal && Boolean(selectedChapterId);

  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      {/* ── Header ── */}
      <header
        className="flex flex-col justify-center shrink-0"
        style={{
          height: '3.5rem',
          background: 'var(--bg-editor-header)',
          padding: '0 2rem',
          borderBottom: '1px solid var(--border-light)',
          backdropFilter: 'blur(12px)',
          zIndex: 10,
        }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1
              className="text-lg font-bold text-heading"
              style={{ textShadow: '0 2px 10px var(--accent-cyan-glow)' }}
            >
              {title}
            </h1>
            {!isGlobal && (
              <span
                className="badge"
                style={{
                  background: statusText === '已生成'
                    ? 'rgba(16,185,129,0.15)'
                    : 'var(--accent-cyan-bg)',
                  color: statusText === '已生成'
                    ? '#10b981'
                    : 'var(--accent-cyan)',
                  border: 'none',
                  boxShadow: 'inset 0 0 10px var(--accent-cyan-bg)',
                }}
              >
                {statusText}
              </span>
            )}
          </div>
          <div className="flex items-center gap-4">
            {/* Word count display */}
            <span className="text-xs font-medium text-slate-500">
              正文：{wordCount.toLocaleString()} 字
            </span>
          </div>
        </div>
      </header>

      {/* ── Generation status bar ── */}
      {isGenerating && (
        <div
          className="animate-fade-in"
          style={{
            padding: '0.6rem 2rem',
            background: 'var(--accent-cyan-bg)',
            borderBottom: '1px solid var(--border-light)',
            display: 'flex',
            alignItems: 'center',
            gap: '1rem',
          }}
        >
          <div
            className="animate-pulse"
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: 'var(--accent-cyan)',
              boxShadow: '0 0 8px var(--accent-cyan)',
            }}
          />
          <span className="text-xs" style={{ color: 'var(--accent-cyan)' }}>
            {gen.currentJob?.status === 'queued' && '⏳ 任务已创建，等待 API 同步处理…'}
            {gen.currentJob?.status === 'running' && '✍️ AI 正在撰写章节内容…'}
            {!gen.currentJob?.status && '🚀 正在提交生成请求…'}
          </span>
        </div>
      )}

      {/* ── Error display ── */}
      {gen.error && gen.state === 'failed' && (
        <div
          className="animate-fade-in"
          style={{
            padding: '0.6rem 2rem',
            background: 'rgba(239,68,68,0.08)',
            borderBottom: '1px solid rgba(239,68,68,0.2)',
            color: '#ef4444',
            fontSize: '0.8rem',
          }}
        >
          ❌ {gen.error}
        </div>
      )}

      {/* ── Editor body ── */}
      <div ref={editorBodyRef} className="flex-1 px-8 py-10" style={{ overflowY: 'auto', position: 'relative' }}>
        {isGlobal ? (
          <GlobalPlaceholder />
        ) : (
          <div className="animate-fade-in" style={{ maxWidth: '48rem', margin: '0 auto' }}>
            {chapter && <ChapterPlanningBrief chapter={chapter} />}
            <div className="editor-version-toolbar">
              <DraftVersionTabs
                activeMode={activeViewMode}
                draft={viewPair.draft}
                polished={viewPair.polished}
                onSwitch={handleSwitchViewMode}
              />
              <button
                type="button"
                onClick={handleSaveDraft}
                disabled={!canSaveDraft || isSavingDraft || isGenerating || isAutoMaintaining || isMarkingComplete}
                className="editor-inline-save-btn"
              >
                {isSavingDraft ? '保存中…' : activeViewMode === 'polished' ? '保存润色' : '保存草稿'}
              </button>
            </div>
            {(saveError || saveNotice || hasUnsavedChanges) && (
              <div
                className={`editor-save-status ${saveError ? 'editor-save-status--error' : saveNotice ? 'editor-save-status--ok' : ''}`}
                aria-live="polite"
              >
                {saveError || saveNotice || '当前版本有未保存修改'}
              </div>
            )}
            <textarea
              ref={textareaRef}
              className="editor-textarea"
              placeholder="在这里开始撰写属于你的章节故事…… 或点击「AI 生成」自动生成正文。"
              style={{ minHeight: '600px' }}
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setSaveError('');
                setSaveNotice('');
                setPassageAgentError('');
              }}
              onSelect={passageSelection.textareaSelectionProps.onSelect}
              onMouseUp={passageSelection.textareaSelectionProps.onMouseUp}
              onKeyUp={passageSelection.textareaSelectionProps.onKeyUp}
              onTouchEnd={passageSelection.textareaSelectionProps.onTouchEnd}
              disabled={isGenerating}
            />
            {passageAgentContext && passageSelection.selection && (
              <PassageAgentPopover
                context={passageAgentContext}
                position={passageSelection.selection.popoverPosition}
                disabledReason={passageAgentDisabledReason}
                submitting={isSubmittingPassageAgent}
                error={passageAgentError}
                onSubmit={handleSubmitPassageAgent}
                onClose={() => {
                  setPassageAgentError('');
                  passageSelection.clearSelection();
                }}
              />
            )}
          </div>
        )}
      </div>

      {/* 章节详情页右下角操作组：完成、AI审核、AI生成 合并为横向紧凑按钮条 */}
      {showFloatingActions && (
        <div
          className="editor-fab-group animate-fade-in"
          style={{
            position: 'absolute',
            right: '2rem',
            bottom: '1.5rem',
            zIndex: 30,
            display: 'flex',
            alignItems: 'center',
            gap: 0,
            borderRadius: '999px',
            border: '1px solid var(--border-light)',
            background: 'var(--bg-card)',
            backdropFilter: 'blur(20px)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.12), 0 0 0 1px var(--border-light)',
            overflow: 'hidden',
          }}
        >
          {/* 保存当前版本 */}
          <button
            type="button"
            onClick={handleSaveDraft}
            disabled={!canSaveDraft || isSavingDraft || isGenerating || isAutoMaintaining || isMarkingComplete}
            className="editor-fab-btn"
            style={{
              color: isSavingDraft ? 'var(--text-muted)' : 'var(--text-main)',
            }}
          >
            {isSavingDraft ? '保存中…' : activeViewMode === 'polished' ? '保存润色' : '保存草稿'}
          </button>
          {/* 分隔线 */}
          <span className="editor-fab-divider" />
          {/* 完成 */}
          <button
            type="button"
            onClick={handleMarkComplete}
            disabled={!onMarkChapterComplete || isMarkingComplete || isGenerating || isAutoMaintaining || isSavingDraft}
            className="editor-fab-btn"
            style={{
              color: isMarkingComplete ? 'var(--text-muted)' : '#10b981',
            }}
          >
            {isMarkingComplete ? '✅ 标记中…' : '✅ 完成'}
          </button>
          {/* 分隔线 */}
          <span className="editor-fab-divider" />
          {/* AI 审核 */}
          <button
            type="button"
            onClick={handleRunAiReview}
            disabled={!onRunAutoMaintenance || isAutoMaintaining || isGenerating || isMarkingComplete || isSavingDraft}
            className="editor-fab-btn"
            style={{
              color: isAutoMaintaining ? 'var(--text-muted)' : '#f59e0b',
            }}
          >
            {isAutoMaintaining ? '🤖 审核中…' : '🤖 AI审核'}
          </button>
          {/* 分隔线 */}
          <span className="editor-fab-divider" />
          {/* AI 生成 */}
          <button
            type="button"
            onClick={handleGenerate}
            disabled={isGenerating || isAutoMaintaining || isMarkingComplete || isSavingDraft}
            className="editor-fab-btn"
            style={{
              color: isGenerating ? 'var(--text-muted)' : 'var(--accent-cyan)',
            }}
          >
            {isGenerating ? '🤖 生成中…' : '🤖 AI生成'}
          </button>
        </div>
      )}
    </article>
  );
}

function ChapterPlanningBrief({ chapter }: { chapter: ChapterSummary }) {
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
          return typeof record.name === 'string' ? record.name.trim() : '';
        })
        .filter(Boolean)
    : [];
  const progressTypes = Array.isArray(craftBrief.progressTypes)
    ? craftBrief.progressTypes.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const subplotTasks = Array.isArray(craftBrief.subplotTasks)
    ? craftBrief.subplotTasks.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const storyUnit = asObjectRecord(craftBrief.storyUnit);
  const storyUnitRange = asObjectRecord(storyUnit?.chapterRange);
  const storyUnitRangeText = typeof storyUnitRange?.start === 'number' && typeof storyUnitRange?.end === 'number'
    ? `第${storyUnitRange.start}-${storyUnitRange.end}章`
    : '';
  const storyUnitFunctions = Array.isArray(storyUnit?.serviceFunctions)
    ? storyUnit.serviceFunctions.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const storyUnitTitle = textValue(storyUnit?.title);

  const hasPlanningData = Boolean(
    chapter.objective?.trim()
    || chapter.conflict?.trim()
    || chapter.outline?.trim()
    || storyUnitTitle
    || actionBeats.length
    || concreteClues.length
    || progressTypes.length
    || Boolean(characterExecutionSummary),
  );

  if (!hasPlanningData) return null;

  return (
    <section
      className="mb-5"
      style={{
        border: '1px solid var(--border-light)',
        borderRadius: '0.5rem',
        background: 'var(--bg-card)',
        overflow: 'hidden',
      }}
    >
      <div
        className="px-4 py-3 flex items-center justify-between gap-3"
        style={{ borderBottom: '1px solid var(--border-dim)' }}
      >
        <div>
          <div className="text-xs font-bold" style={{ color: 'var(--accent-cyan)' }}>章节细纲</div>
          <div className="text-[0.68rem]" style={{ color: 'var(--text-dim)' }}>
            正文生成会优先参考这些目标、冲突和执行要点。
          </div>
        </div>
        <span className="text-[0.68rem]" style={{ color: 'var(--text-muted)' }}>
          第{chapter.chapterNo}章
        </span>
      </div>
      <div className="px-4 py-3">
        <PlanningField label="目标" value={chapter.objective} />
        <PlanningField label="冲突" value={chapter.conflict} />
        <PlanningField label="大纲" value={chapter.outline} multiline />
        <PlanningField label="可见目标" value={textValue(craftBrief.visibleGoal)} />
        <PlanningField label="隐性情绪" value={textValue(craftBrief.hiddenEmotion)} />
        <PlanningField label="执行卡冲突" value={textValue(craftBrief.coreConflict)} multiline />
        <PlanningField label="主线任务" value={textValue(craftBrief.mainlineTask)} />
        <PlanningField label="支线任务" value={subplotTasks.slice(0, 5).join('；')} multiline />
        <PlanningField label="单元故事" value={[storyUnitTitle, storyUnitRangeText, textValue(storyUnit?.chapterRole)].filter(Boolean).join(' · ')} />
        <PlanningField label="单元目标" value={textValue(storyUnit?.localGoal)} multiline />
        <PlanningField label="单元阻力" value={textValue(storyUnit?.localConflict)} multiline />
        <PlanningField label="本章服务" value={[
          textValue(storyUnit?.mainlineContribution),
          textValue(storyUnit?.characterContribution),
          textValue(storyUnit?.relationshipContribution),
          textValue(storyUnit?.worldOrThemeContribution),
        ].filter(Boolean).join('；')} multiline />
        <PlanningField label="单元功能" value={storyUnitFunctions.join('、')} />
        <PlanningField label="单元结局" value={textValue(storyUnit?.unitPayoff)} multiline />
        <PlanningField label="行动链" value={actionBeats.slice(0, 6).join('；')} multiline />
        <ChapterCharacterExecutionBrief summary={characterExecutionSummary} />
        <PlanningField label="线索" value={concreteClues.slice(0, 8).join('、')} />
        <PlanningField label="潜台词" value={textValue(craftBrief.dialogueSubtext)} multiline />
        <PlanningField label="人物变化" value={textValue(craftBrief.characterShift)} multiline />
        <PlanningField label="不可逆后果" value={textValue(craftBrief.irreversibleConsequence)} multiline />
        <PlanningField label="推进类型" value={progressTypes.join('、')} />
      </div>
    </section>
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
      className="mt-2 rounded-md border px-3 py-2 text-xs leading-5"
      style={{
        borderColor: 'rgba(20,184,166,0.24)',
        background: 'rgba(20,184,166,0.06)',
        color: 'var(--text-muted)',
      }}
    >
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {summary.pov && <span><b style={{ color: 'var(--text-dim)' }}>POV</b>：{summary.pov}</span>}
        {summary.cast.length > 0 && <span><b style={{ color: 'var(--text-dim)' }}>角色</b>：{summary.cast.slice(0, 4).join('；')}</span>}
        {summary.relationshipChanges.length > 0 && <span><b style={{ color: 'var(--text-dim)' }}>关系</b>：{summary.relationshipChanges.slice(0, 3).join('；')}</span>}
        {summary.temporaryCharacterCount > 0 && (
          <span>
            <b style={{ color: 'var(--text-dim)' }}>临时</b>：
            {summary.temporaryCharacterCount}
            {summary.temporaryCharacters.length > 0 ? ` ${summary.temporaryCharacters.slice(0, 3).join('；')}` : ''}
          </span>
        )}
      </div>
    </div>
  );
}

function PlanningField({ label, value, multiline = false }: { label: string; value?: string | null; multiline?: boolean }) {
  if (!value?.trim()) return null;

  return (
    <p
      className="text-xs"
      style={{
        color: 'var(--text-muted)',
        lineHeight: 1.6,
        marginTop: '0.35rem',
        display: multiline ? 'block' : 'flex',
        gap: '0.4rem',
      }}
    >
      <span style={{ color: 'var(--text-dim)', fontWeight: 600, flexShrink: 0 }}>{label}：</span>
      <span>{value}</span>
    </p>
  );
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

function textValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
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

/**
 * Resolve the two-version view model for the editor.
 *
 * The polish pipeline writes a new current ChapterDraft whose generationContext
 * stores originalDraftId. That pointer is more reliable than simply taking the
 * previous version because postprocess/repair flows may also create drafts.
 */
function buildDraftViewPair(versions: ChapterDraft[]) {
  const sorted = [...versions].sort((a, b) => b.versionNo - a.versionNo);
  const current = sorted.find((item) => item.isCurrent) ?? sorted[0];
  const latestPolished = sorted.find(isPolishedDraft);
  const polished = current && isPolishedDraft(current) ? current : latestPolished;
  const originalDraftId = typeof polished?.generationContext?.originalDraftId === 'string'
    ? polished.generationContext.originalDraftId
    : undefined;

  return {
    draft: originalDraftId
      ? sorted.find((item) => item.id === originalDraftId) ?? sorted.find((item) => !isPolishedDraft(item)) ?? current
      : sorted.find((item) => !isPolishedDraft(item)) ?? current,
    polished,
  };
}

/** A draft is considered polished when it was created by the polish pipeline. */
function isPolishedDraft(draft: ChapterDraft) {
  return draft.source === 'agent_polish' || draft.generationContext?.type === 'polish';
}

function countDraftWords(draft?: ChapterDraft) {
  return draft?.content.replace(/\s/g, '').length ?? 0;
}

/** Compact tabs shown above the manuscript, matching the user's 草稿 / 润色 sketch. */
function DraftVersionTabs({
  activeMode,
  draft,
  polished,
  onSwitch,
}: {
  activeMode: DraftViewMode;
  draft?: ChapterDraft;
  polished?: ChapterDraft;
  onSwitch: (mode: DraftViewMode) => void;
}) {
  return (
    <div className="draft-version-tabs" role="tablist" aria-label="章节正文版本">
      <DraftVersionTab
        mode="draft"
        label="草稿"
        hint="原稿"
        active={activeMode === 'draft'}
        draft={draft}
        onSwitch={onSwitch}
      />
      <DraftVersionTab
        mode="polished"
        label="润色"
        hint="AI润色后"
        active={activeMode === 'polished'}
        draft={polished}
        onSwitch={onSwitch}
      />
    </div>
  );
}

function DraftVersionTab({
  mode,
  label,
  hint,
  active,
  draft,
  onSwitch,
}: {
  mode: DraftViewMode;
  label: string;
  hint: string;
  active: boolean;
  draft?: ChapterDraft;
  onSwitch: (mode: DraftViewMode) => void;
}) {
  const disabled = !draft;

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      disabled={disabled}
      className={`draft-version-tab ${active ? 'draft-version-tab--active' : ''}`}
      onClick={() => onSwitch(mode)}
      title={disabled ? `暂无${label}版本` : `${hint} · v${draft.versionNo}`}
    >
      <span className="draft-version-tab__label">{label}</span>
      <span className="draft-version-tab__meta">
        {draft ? `v${draft.versionNo} · ${countDraftWords(draft).toLocaleString()}字` : '暂无'}
      </span>
    </button>
  );
}

/** Placeholder shown when no specific chapter is selected */
function GlobalPlaceholder() {
  return (
    <div
      className="flex flex-col items-center justify-center h-full space-y-4"
      style={{ maxWidth: '56rem', margin: '0 auto', opacity: 0.6 }}
    >
      <div
        className="flex items-center justify-center animate-pulse-glow"
        style={{
          width: '4rem',
          height: '4rem',
          borderRadius: '1rem',
          background: 'var(--bg-card)',
          color: 'var(--accent-cyan)',
          border: '1px solid var(--border-light)',
          transform: 'rotate(5deg)',
        }}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
        </svg>
      </div>
      <p className="text-sm">请在左侧选择具体的章节进入撰写，或使用「AI 生成」自动生成正文。</p>
    </div>
  );
}
