'use client';

import { useEffect, useMemo, useState } from 'react';
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
  error?: string;
  onSubmit: (message: string, context: PassageAgentContext) => void | Promise<void>;
  onClose: () => void;
}

export function PassageAgentPopover({
  context,
  position,
  disabledReason,
  submitting = false,
  error,
  onSubmit,
  onClose,
}: PassageAgentPopoverProps) {
  const [instruction, setInstruction] = useState('');
  const paragraphLabel = formatParagraphRangeLabel(context.selectedParagraphRange);
  const selectedTextPreview = useMemo(() => context.selectedText.trim(), [context.selectedText]);
  const canSubmit = Boolean(instruction.trim()) && !disabledReason && !submitting;

  useEffect(() => {
    setInstruction('');
  }, [context.currentDraftId, context.currentDraftVersion, context.selectedRange.start, context.selectedRange.end]);

  const submit = async () => {
    if (!canSubmit) return;
    await onSubmit(instruction.trim(), context);
  };

  return (
    <div
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
          <dd>{context.currentVolumeNo ? `第 ${context.currentVolumeNo} 卷` : '未分卷'}{context.currentVolumeTitle ? ` · ${context.currentVolumeTitle}` : ''}</dd>
        </div>
        <div>
          <dt>章</dt>
          <dd>第 {context.currentChapterNo} 章{context.currentChapterTitle ? ` · ${context.currentChapterTitle}` : ''}</dd>
        </div>
        <div>
          <dt>草稿</dt>
          <dd>v{context.currentDraftVersion}{context.currentDraftViewMode ? ` · ${context.currentDraftViewMode}` : ''}</dd>
        </div>
      </dl>

      <blockquote className="passage-agent-popover__quote">{selectedTextPreview}</blockquote>

      <div className="passage-agent-popover__quick" aria-label="快捷修订意图">
        {PASSAGE_QUICK_INTENTS.map((intent) => (
          <button
            key={intent.id}
            type="button"
            className={instruction === intent.instruction ? 'passage-agent-popover__chip passage-agent-popover__chip--active' : 'passage-agent-popover__chip'}
            onClick={() => setInstruction(intent.instruction)}
            disabled={submitting}
          >
            {intent.label}
          </button>
        ))}
      </div>

      <textarea
        className="passage-agent-popover__input"
        rows={3}
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        placeholder="告诉 Agent 这段要怎么改。"
        disabled={submitting}
      />

      {(disabledReason || error) && (
        <div className={error ? 'passage-agent-popover__notice passage-agent-popover__notice--error' : 'passage-agent-popover__notice'}>
          {error || disabledReason}
        </div>
      )}

      <button
        type="button"
        className="passage-agent-popover__submit"
        onClick={() => { void submit(); }}
        disabled={!canSubmit}
      >
        {submitting ? '提交中…' : '发送给 Agent'}
      </button>
    </div>
  );
}
