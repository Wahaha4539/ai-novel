'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject, type SyntheticEvent } from 'react';
import {
  computePassagePopoverPosition,
  normalizeTextSelection,
  type PassagePopoverAnchorRect,
  type PassageSelectionSnapshot,
  type SelectedTextRange,
} from './passageSelection';

interface UsePassageSelectionOptions {
  textareaRef: RefObject<HTMLTextAreaElement>;
  text: string;
  enabled: boolean;
}

export function usePassageSelection({ textareaRef, text, enabled }: UsePassageSelectionOptions) {
  const [selection, setSelection] = useState<PassageSelectionSnapshot | null>(null);
  const captureFrameRef = useRef<number | null>(null);

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
      popoverPosition: getTextareaPopoverPosition(textarea, snapshot.selectedRange, text),
    });
  }, [enabled, text, textareaRef]);

  const scheduleCaptureSelection = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (captureFrameRef.current !== null) {
      window.cancelAnimationFrame(captureFrameRef.current);
    }
    captureFrameRef.current = window.requestAnimationFrame(() => {
      captureFrameRef.current = null;
      captureSelection();
    });
  }, [captureSelection]);

  useEffect(() => {
    if (!enabled) {
      setSelection(null);
      return;
    }

    setSelection((current) => {
      if (!current) return current;
      const next = normalizeTextSelection(current.selectedRange.start, current.selectedRange.end, text);
      const textarea = textareaRef.current;
      return next && next.selectedText === current.selectedText
        ? {
            ...current,
            selectedParagraphRange: next.selectedParagraphRange,
            popoverPosition: textarea
              ? getTextareaPopoverPosition(textarea, next.selectedRange, text)
              : current.popoverPosition,
          }
        : null;
    });
  }, [enabled, text, textareaRef]);

  useEffect(() => {
    if (!enabled) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    const handlePotentialSelectionChange = () => {
      if (document.activeElement !== textarea) return;
      scheduleCaptureSelection();
    };

    const handleViewportChange = () => {
      if (!selection) return;
      scheduleCaptureSelection();
    };

    document.addEventListener('selectionchange', handlePotentialSelectionChange);
    window.addEventListener('mouseup', handlePotentialSelectionChange, true);
    window.addEventListener('keyup', handlePotentialSelectionChange, true);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    textarea.addEventListener('scroll', handleViewportChange);

    return () => {
      document.removeEventListener('selectionchange', handlePotentialSelectionChange);
      window.removeEventListener('mouseup', handlePotentialSelectionChange, true);
      window.removeEventListener('keyup', handlePotentialSelectionChange, true);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
      textarea.removeEventListener('scroll', handleViewportChange);
    };
  }, [enabled, scheduleCaptureSelection, selection, textareaRef]);

  useEffect(() => {
    return () => {
      if (captureFrameRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(captureFrameRef.current);
      }
    };
  }, []);

  const textareaSelectionProps = useMemo(() => ({
    onSelect: (_event: SyntheticEvent<HTMLTextAreaElement>) => scheduleCaptureSelection(),
    onMouseUp: (_event: MouseEvent<HTMLTextAreaElement>) => scheduleCaptureSelection(),
    onKeyUp: (_event: KeyboardEvent<HTMLTextAreaElement>) => scheduleCaptureSelection(),
    onTouchEnd: () => scheduleCaptureSelection(),
  }), [scheduleCaptureSelection]);

  return {
    selection,
    captureSelection,
    clearSelection,
    textareaSelectionProps,
  };
}

function getTextareaPopoverPosition(
  textarea: HTMLTextAreaElement,
  selectedRange: SelectedTextRange,
  text: string,
) {
  const anchorRect = getTextareaSelectionAnchorRect(textarea, selectedRange, text) ?? rectToAnchor(textarea.getBoundingClientRect());
  return computePassagePopoverPosition(anchorRect, getPassagePopoverViewportRect(textarea));
}

function getTextareaSelectionAnchorRect(
  textarea: HTMLTextAreaElement,
  selectedRange: SelectedTextRange,
  text: string,
): PassagePopoverAnchorRect | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;

  const selectionText = text.slice(selectedRange.start, selectedRange.end) || ' ';
  const textareaRect = textarea.getBoundingClientRect();
  const computedStyle = window.getComputedStyle(textarea);
  const mirror = document.createElement('div');
  const span = document.createElement('span');

  mirror.setAttribute('aria-hidden', 'true');
  mirror.style.position = 'fixed';
  mirror.style.left = `${textareaRect.left}px`;
  mirror.style.top = `${textareaRect.top}px`;
  mirror.style.width = `${textareaRect.width}px`;
  mirror.style.height = `${textareaRect.height}px`;
  mirror.style.visibility = 'hidden';
  mirror.style.pointerEvents = 'none';
  mirror.style.overflow = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordBreak = 'break-word';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.boxSizing = computedStyle.boxSizing;
  mirror.style.borderTopWidth = computedStyle.borderTopWidth;
  mirror.style.borderRightWidth = computedStyle.borderRightWidth;
  mirror.style.borderBottomWidth = computedStyle.borderBottomWidth;
  mirror.style.borderLeftWidth = computedStyle.borderLeftWidth;
  mirror.style.borderTopStyle = computedStyle.borderTopStyle;
  mirror.style.borderRightStyle = computedStyle.borderRightStyle;
  mirror.style.borderBottomStyle = computedStyle.borderBottomStyle;
  mirror.style.borderLeftStyle = computedStyle.borderLeftStyle;
  mirror.style.paddingTop = computedStyle.paddingTop;
  mirror.style.paddingRight = computedStyle.paddingRight;
  mirror.style.paddingBottom = computedStyle.paddingBottom;
  mirror.style.paddingLeft = computedStyle.paddingLeft;
  mirror.style.fontFamily = computedStyle.fontFamily;
  mirror.style.fontSize = computedStyle.fontSize;
  mirror.style.fontWeight = computedStyle.fontWeight;
  mirror.style.fontStyle = computedStyle.fontStyle;
  mirror.style.fontVariant = computedStyle.fontVariant;
  mirror.style.letterSpacing = computedStyle.letterSpacing;
  mirror.style.lineHeight = computedStyle.lineHeight;
  mirror.style.textAlign = computedStyle.textAlign;
  mirror.style.textTransform = computedStyle.textTransform;
  mirror.style.textIndent = computedStyle.textIndent;
  mirror.style.tabSize = computedStyle.tabSize;
  mirror.style.direction = computedStyle.direction;

  mirror.textContent = text.slice(0, selectedRange.start);
  span.textContent = selectionText;
  mirror.appendChild(span);
  mirror.appendChild(document.createTextNode(text.slice(selectedRange.end) || ' '));
  document.body.appendChild(mirror);

  mirror.scrollTop = textarea.scrollTop;
  mirror.scrollLeft = textarea.scrollLeft;

  const firstVisibleRect = Array.from(span.getClientRects()).find((rect) => rect.width > 0 || rect.height > 0);
  const fallbackRect = span.getBoundingClientRect();
  mirror.remove();

  if (!firstVisibleRect && (!fallbackRect.width || !fallbackRect.height)) {
    return null;
  }

  return rectToAnchor(firstVisibleRect ?? fallbackRect);
}

function rectToAnchor(rect: DOMRect | PassagePopoverAnchorRect): PassagePopoverAnchorRect {
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

function getPassagePopoverViewportRect(textarea: HTMLTextAreaElement) {
  const workspaceMain = textarea.closest('.workspace-main');
  if (workspaceMain instanceof HTMLElement) {
    const rect = workspaceMain.getBoundingClientRect();
    return {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    };
  }

  return {
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
    left: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  };
}
