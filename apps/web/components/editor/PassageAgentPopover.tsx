'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChapterPassageRevisionPreviewView } from '../agent/chapterPassageRevisionPreview';
import {
  PASSAGE_QUICK_INTENTS,
  formatParagraphRangeLabel,
  type PassageAgentContext,
  type PassagePopoverPosition,
} from './passageSelection';

interface PassageAgentPopoverProps {
  context: PassageAgentContext;
  position?: PassagePopoverPosition;
  disabledReason?: string;
  submitting?: boolean;
  applying?: boolean;
  error?: string;
  statusMessage?: string;
  preview?: ChapterPassageRevisionPreviewView | null;
  canApplyPreview?: boolean;
  onSubmit: (message: string, context: PassageAgentContext) => void | Promise<void>;
  onApplyPreview?: () => void | Promise<void>;
  onSizeChange?: (size: { width: number; height: number }) => void;
  onClose: () => void;
}

export function PassageAgentPopover({
  context,
  position,
  disabledReason,
  submitting = false,
  applying = false,
  error,
  statusMessage,
  preview,
  canApplyPreview = false,
  onSubmit,
  onApplyPreview,
  onSizeChange,
  onClose,
}: PassageAgentPopoverProps) {
  const [instruction, setInstruction] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);

  const paragraphLabel = formatParagraphRangeLabel(context.selectedParagraphRange);
  const selectedTextPreview = useMemo(() => context.selectedText.trim(), [context.selectedText]);
  const canSubmit = Boolean(instruction.trim()) && !disabledReason && !submitting && !applying;
  const hasPreview = Boolean(preview);
  const submitLabel = hasPreview ? '继续调整' : '生成局部预览';
  const summaryText = preview?.editSummary?.trim();
  const previewText = preview?.replacementText?.trim();
  const riskItems = [...(preview?.risks ?? []), ...(preview?.validation.issues ?? [])];
  const draftViewModeLabel = context.currentDraftViewMode === 'polished'
    ? 'AI润色稿'
    : context.currentDraftViewMode === 'draft'
      ? '当前稿'
      : '';
  const volumeLabel = context.currentVolumeNo ? `第 ${context.currentVolumeNo} 卷` : '未分卷';
  const chapterLabel = `第 ${context.currentChapterNo} 章`;

  useEffect(() => {
    setInstruction('');
  }, [context.currentDraftId, context.currentDraftVersion, context.selectedRange.start, context.selectedRange.end]);

  useEffect(() => {
    if (!onSizeChange || typeof window === 'undefined') return undefined;

    const element = popoverRef.current;
    if (!element) return undefined;

    const emitSize = () => {
      const rect = element.getBoundingClientRect();
      onSizeChange({ width: rect.width, height: rect.height });
    };

    emitSize();

    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      emitSize();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onSizeChange]);

  const submit = async () => {
    if (!canSubmit) return;
    await onSubmit(instruction.trim(), context);
  };

  return (
    <div
      ref={popoverRef}
      className="passage-agent-popover animate-fade-in"
      style={position ? { position: position.strategy, top: position.top, left: position.left } : undefined}
      role="dialog"
      aria-label="正文选区 Agent"
    >
      <div className="passage-agent-popover__header">
        <div>
          <div className="passage-agent-popover__eyebrow">AI · {paragraphLabel}</div>
          <div className="passage-agent-popover__title">正文局部修订</div>
        </div>
        <button type="button" className="passage-agent-popover__close" onClick={onClose} aria-label="关闭正文选区 Agent">
          ×
        </button>
      </div>

      <dl className="passage-agent-popover__meta">
        <div>
          <dt>卷</dt>
          <dd>
            {volumeLabel}
            {context.currentVolumeTitle ? ` · ${context.currentVolumeTitle}` : ''}
          </dd>
        </div>
        <div>
          <dt>章</dt>
          <dd>
            {chapterLabel}
            {context.currentChapterTitle ? ` · ${context.currentChapterTitle}` : ''}
          </dd>
        </div>
        <div>
          <dt>版本</dt>
          <dd>
            v{context.currentDraftVersion}
            {draftViewModeLabel ? ` · ${draftViewModeLabel}` : ''}
          </dd>
        </div>
      </dl>

      <blockquote className="passage-agent-popover__quote">{selectedTextPreview}</blockquote>

      {hasPreview && (
        <div className="passage-agent-popover__preview">
          <div className="passage-agent-popover__preview-head">
            <span>修订预览</span>
            <strong>{previewText?.length ?? 0} 字</strong>
          </div>
          {summaryText && <div className="passage-agent-popover__summary">{summaryText}</div>}
          {previewText && <div className="passage-agent-popover__preview-text">{previewText}</div>}
          {riskItems.length > 0 && (
            <div className="passage-agent-popover__risk-list">
              {riskItems.map((item, index) => (
                <span key={`${item}-${index}`} className="passage-agent-popover__risk-chip">
                  {item}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="passage-agent-popover__quick" aria-label="快捷修订意图">
        {PASSAGE_QUICK_INTENTS.map((intent) => (
          <button
            key={intent.id}
            type="button"
            className={instruction === intent.instruction ? 'passage-agent-popover__chip passage-agent-popover__chip--active' : 'passage-agent-popover__chip'}
            onClick={() => setInstruction(intent.instruction)}
            disabled={submitting || applying}
          >
            {intent.label}
          </button>
        ))}
      </div>

      <textarea
        className="passage-agent-popover__input"
        rows={hasPreview ? 2 : 3}
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        placeholder={hasPreview ? '继续告诉 Agent 这段还要怎么调。' : '告诉 Agent 这段要怎么改。'}
        disabled={submitting || applying}
      />

      {(disabledReason || error || statusMessage) && (
        <div className={error ? 'passage-agent-popover__notice passage-agent-popover__notice--error' : 'passage-agent-popover__notice'}>
          {error || disabledReason || statusMessage}
        </div>
      )}

      <div className="passage-agent-popover__actions">
        <button
          type="button"
          className="passage-agent-popover__submit"
          onClick={() => {
            void submit();
          }}
          disabled={!canSubmit}
        >
          {submitting ? '生成中...' : submitLabel}
        </button>
        {hasPreview && (
          <button
            type="button"
            className="passage-agent-popover__apply"
            onClick={() => {
              void onApplyPreview?.();
            }}
            disabled={!canApplyPreview || applying || submitting}
          >
            {applying ? '保存中...' : '保存到正文'}
          </button>
        )}
      </div>
    </div>
  );
}
