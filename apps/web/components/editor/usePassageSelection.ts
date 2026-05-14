'use client';

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent, type RefObject, type SyntheticEvent } from 'react';
import { normalizeTextSelection, type PassageSelectionSnapshot } from './passageSelection';

interface UsePassageSelectionOptions {
  textareaRef: RefObject<HTMLTextAreaElement>;
  text: string;
  enabled: boolean;
}

export function usePassageSelection({ textareaRef, text, enabled }: UsePassageSelectionOptions) {
  const [selection, setSelection] = useState<PassageSelectionSnapshot | null>(null);

  const clearSelection = useCallback(() => {
    setSelection(null);
  }, []);

  const captureSelection = useCallback(() => {
    if (!enabled) {
      setSelection(null);
      return;
    }

    const textarea = textareaRef.current;
    if (!textarea) {
      setSelection(null);
      return;
    }

    const snapshot = normalizeTextSelection(textarea.selectionStart, textarea.selectionEnd, text);
    if (!snapshot) {
      setSelection(null);
      return;
    }

    setSelection({
      ...snapshot,
      popoverPosition: getTextareaPopoverPosition(textarea),
    });
  }, [enabled, text, textareaRef]);

  useEffect(() => {
    if (!enabled) {
      setSelection(null);
      return;
    }

    setSelection((current) => {
      if (!current) return current;
      const next = normalizeTextSelection(current.selectedRange.start, current.selectedRange.end, text);
      return next && next.selectedText === current.selectedText
        ? { ...current, selectedParagraphRange: next.selectedParagraphRange }
        : null;
    });
  }, [enabled, text]);

  const textareaSelectionProps = useMemo(() => ({
    onSelect: (_event: SyntheticEvent<HTMLTextAreaElement>) => captureSelection(),
    onMouseUp: (_event: MouseEvent<HTMLTextAreaElement>) => captureSelection(),
    onKeyUp: (_event: KeyboardEvent<HTMLTextAreaElement>) => captureSelection(),
  }), [captureSelection]);

  return {
    selection,
    captureSelection,
    clearSelection,
    textareaSelectionProps,
  };
}

function getTextareaPopoverPosition(textarea: HTMLTextAreaElement) {
  const rect = textarea.getBoundingClientRect();
  const width = 336;
  const top = clamp(rect.top + 56, 16, Math.max(16, window.innerHeight - 220));
  const left = clamp(rect.right - width - 16, 16, Math.max(16, window.innerWidth - width - 16));
  return { top, left };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
