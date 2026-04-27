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

import React, { useEffect, useState, useCallback } from 'react';
import { ProjectSummary, ChapterSummary } from '../types/dashboard';
import { useChapterGeneration } from '../hooks/useChapterGeneration';

interface Props {
  selectedProject?: ProjectSummary;
  selectedChapterId: string;
  chapters: ChapterSummary[];
  draftRefreshKey?: number;
  /** Run chapter-scoped AI review/maintenance without changing the chapter completion status. */
  onRunAutoMaintenance?: (chapterIds?: string[]) => void | Promise<void>;
  /** Mark the current chapter as complete; this only updates chapter metadata for the sidebar status dot. */
  onMarkChapterComplete?: (chapterId: string) => void | Promise<void>;
}

export function EditorPanel({ selectedProject, selectedChapterId, chapters, draftRefreshKey = 0, onRunAutoMaintenance, onMarkChapterComplete }: Props) {
  const isGlobal = selectedChapterId === 'all';
  const chapter = chapters.find((c) => c.id === selectedChapterId);
  const gen = useChapterGeneration();

  // Local content state for the editor textarea
  const [content, setContent] = useState('');
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [isAutoMaintaining, setIsAutoMaintaining] = useState(false);
  const [isMarkingComplete, setIsMarkingComplete] = useState(false);

  const title = isGlobal
    ? selectedProject?.title || '未选择项目'
    : `第${chapter?.chapterNo ?? '?'}章 · ${chapter?.title || '无标题'}`;

  // Compute word count from current content
  const wordCount = content.replace(/\s/g, '').length;

  // Auto-load draft when chapter selection changes. AI validation repair creates a
  // new current draft for the same chapter, so draftRefreshKey forces a reload.
  useEffect(() => {
    if (isGlobal || !selectedChapterId) {
      setContent('');
      setDraftLoaded(false);
      return;
    }
    // Load existing draft for this chapter
    gen.loadDraft(selectedChapterId).then((draft) => {
      if (draft?.content) {
        setContent(draft.content);
        setDraftLoaded(true);
      } else {
        setContent('');
        setDraftLoaded(false);
      }
    });
    // Reset generation state when switching chapters
    gen.reset();
  }, [selectedChapterId, draftRefreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // When generation completes, update editor content
  useEffect(() => {
    if (gen.state === 'completed' && gen.currentDraft?.content) {
      setContent(gen.currentDraft.content);
      setDraftLoaded(true);
    }
  }, [gen.state, gen.currentDraft]);

  /** Trigger AI generation for the current chapter */
  const handleGenerate = useCallback(async () => {
    if (isGlobal || !selectedChapterId || gen.state === 'polling' || gen.state === 'generating') return;
    if (!selectedProject?.id) return;
    await gen.generateSingle(selectedProject.id, selectedChapterId);
  }, [isGlobal, selectedProject?.id, selectedChapterId, gen]);

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

  const isGenerating = gen.state === 'generating' || gen.state === 'polling';
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
      <div className="flex-1 px-8 py-10" style={{ overflowY: 'auto', position: 'relative' }}>
        {isGlobal ? (
          <GlobalPlaceholder />
        ) : (
          <div className="animate-fade-in" style={{ maxWidth: '48rem', margin: '0 auto' }}>
            <textarea
              className="editor-textarea"
              placeholder="在这里开始撰写属于你的章节故事…… 或点击「AI 生成」自动生成正文。"
              style={{ minHeight: '600px' }}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={isGenerating}
            />
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
          {/* 完成 */}
          <button
            type="button"
            onClick={handleMarkComplete}
            disabled={!onMarkChapterComplete || isMarkingComplete || isGenerating || isAutoMaintaining}
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
            disabled={!onRunAutoMaintenance || isAutoMaintaining || isGenerating || isMarkingComplete}
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
            disabled={isGenerating || isAutoMaintaining || isMarkingComplete}
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
