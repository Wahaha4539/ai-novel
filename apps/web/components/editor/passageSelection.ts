import type { AgentPageContext } from '../../hooks/useAgentRun';
import type { ChapterDraft, ChapterSummary, ProjectSummary, VolumeSummary } from '../../types/dashboard';

export type DraftViewMode = 'draft' | 'polished';

export type PassageRevisionIntent =
  | 'polish'
  | 'compress_pacing'
  | 'intensify_emotion'
  | 'adjust_voice'
  | 'reduce_exposition'
  | 'rewrite_expression';

export type SelectedTextRange = {
  start: number;
  end: number;
};

export type SelectedParagraphRange = {
  start: number;
  end: number;
  count: number;
};

export type PassageSelectionSnapshot = {
  selectedRange: SelectedTextRange;
  selectedParagraphRange: SelectedParagraphRange;
  selectedText: string;
  popoverPosition?: { top: number; left: number };
};

export type PassagePopoverAnchorRect = {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
};

export type PassagePopoverViewportRect = {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
  width: number;
  height: number;
};

export interface PassageAgentContext extends AgentPageContext {
  sourcePage: 'editor_passage_agent';
  selectionIntent: 'chapter_passage_revision';

  currentProjectId: string;
  currentVolumeId?: string;
  currentVolumeNo?: number;
  currentVolumeTitle?: string;

  currentChapterId: string;
  currentChapterNo: number;
  currentChapterTitle?: string;

  currentDraftId: string;
  currentDraftVersion: number;
  currentDraftViewMode?: DraftViewMode;

  selectedRange: SelectedTextRange;
  selectedParagraphRange: SelectedParagraphRange;
  selectedText: string;
}

export const PASSAGE_QUICK_INTENTS: Array<{ id: PassageRevisionIntent; label: string; instruction: string }> = [
  { id: 'polish', label: '局部润色', instruction: '请只润色选中文本，提升句子流畅度、画面感和衔接，不改变事实与情节结果。' },
  { id: 'compress_pacing', label: '压缩节奏', instruction: '请只改写选中文本，压缩解释和停顿，让节奏更紧，但保留关键事实。' },
  { id: 'intensify_emotion', label: '增强情绪', instruction: '请只改写选中文本，增强人物当下情绪和可见反应，不新增未铺垫的剧情事实。' },
  { id: 'adjust_voice', label: '调整口吻', instruction: '请只改写选中文本，让角色口吻更贴合当前人物状态，并保留原本事件。' },
  { id: 'reduce_exposition', label: '降低解释感', instruction: '请只改写选中文本，减少说明腔，把信息尽量落到动作、对话或感官细节里。' },
  { id: 'rewrite_expression', label: '保留事件重写表达', instruction: '请只重写选中文本的表达方式，保留事件、人物关系、因果和结果。' },
];

export function normalizeTextSelection(
  selectionStart: number | null | undefined,
  selectionEnd: number | null | undefined,
  content: string,
): PassageSelectionSnapshot | null {
  if (!Number.isFinite(selectionStart) || !Number.isFinite(selectionEnd)) return null;

  const rawStart = Math.trunc(selectionStart ?? 0);
  const rawEnd = Math.trunc(selectionEnd ?? 0);
  const start = clampNumber(Math.min(rawStart, rawEnd), 0, content.length);
  const end = clampNumber(Math.max(rawStart, rawEnd), 0, content.length);
  if (end <= start) return null;

  const selectedText = content.slice(start, end);
  if (!selectedText.trim()) return null;

  const selectedRange = { start, end };
  return {
    selectedRange,
    selectedParagraphRange: computeSelectedParagraphRange(content, selectedRange),
    selectedText,
  };
}

export function computeSelectedParagraphRange(content: string, selectedRange: SelectedTextRange): SelectedParagraphRange {
  const spans = buildNonEmptyParagraphSpans(content);
  if (!spans.length) return { start: 1, end: 1, count: 1 };

  const selected = spans.filter((span) => span.end > selectedRange.start && span.start < selectedRange.end);
  if (selected.length) {
    const start = selected[0].paragraphNo;
    const end = selected[selected.length - 1].paragraphNo;
    return { start, end, count: end - start + 1 };
  }

  const previous = [...spans].reverse().find((span) => span.start <= selectedRange.start);
  const next = spans.find((span) => span.start >= selectedRange.start);
  const paragraphNo = previous?.paragraphNo ?? next?.paragraphNo ?? 1;
  return { start: paragraphNo, end: paragraphNo, count: 1 };
}

export function formatParagraphRangeLabel(range: SelectedParagraphRange) {
  return range.start === range.end ? `第 ${range.start} 段` : `第 ${range.start}-${range.end} 段`;
}

export function computePassagePopoverPosition(
  anchorRect: PassagePopoverAnchorRect,
  viewport: PassagePopoverViewportRect,
  options?: {
    popoverWidth?: number;
    popoverHeight?: number;
    viewportPadding?: number;
    anchorGap?: number;
  },
) {
  const popoverWidth = options?.popoverWidth ?? 336;
  const popoverHeight = options?.popoverHeight ?? 320;
  const viewportPadding = options?.viewportPadding ?? 16;
  const anchorGap = options?.anchorGap ?? 12;
  const viewportLeft = viewport.left ?? 0;
  const viewportTop = viewport.top ?? 0;
  const viewportRight = viewport.right ?? (viewportLeft + viewport.width);
  const viewportBottom = viewport.bottom ?? (viewportTop + viewport.height);

  const minLeft = viewportLeft + viewportPadding;
  const maxLeft = Math.max(minLeft, viewportRight - popoverWidth - viewportPadding);
  const left = clampNumber(
    anchorRect.left + (anchorRect.width / 2) - (popoverWidth / 2),
    minLeft,
    maxLeft,
  );

  const preferredTop = anchorRect.top - popoverHeight - anchorGap;
  const fallbackTop = anchorRect.bottom + anchorGap;
  const minTop = viewportTop + viewportPadding;
  const maxTop = Math.max(minTop, viewportBottom - popoverHeight - viewportPadding);
  const fitsAbove = preferredTop >= minTop;
  const fitsBelow = fallbackTop + popoverHeight <= viewportBottom - viewportPadding;
  const top = fitsAbove || !fitsBelow
    ? clampNumber(preferredTop, minTop, maxTop)
    : clampNumber(fallbackTop, minTop, maxTop);

  return { top, left };
}

export function buildPassageAgentContext(input: {
  project: ProjectSummary;
  chapter: ChapterSummary;
  draft: ChapterDraft;
  selection: PassageSelectionSnapshot;
  volume?: VolumeSummary;
  draftViewMode?: DraftViewMode;
}): PassageAgentContext {
  return {
    currentProjectId: input.project.id,
    currentVolumeId: input.volume?.id ?? input.chapter.volumeId ?? undefined,
    currentVolumeNo: input.volume?.volumeNo,
    currentVolumeTitle: input.volume?.title ?? undefined,
    currentChapterId: input.chapter.id,
    currentChapterNo: input.chapter.chapterNo,
    currentChapterTitle: input.chapter.title ?? undefined,
    currentDraftId: input.draft.id,
    currentDraftVersion: input.draft.versionNo,
    currentDraftViewMode: input.draftViewMode,
    selectedRange: input.selection.selectedRange,
    selectedParagraphRange: input.selection.selectedParagraphRange,
    selectedText: input.selection.selectedText,
    selectionIntent: 'chapter_passage_revision',
    sourcePage: 'editor_passage_agent',
  };
}

export function getPassageAgentDisabledReason(input: {
  hasProject: boolean;
  hasChapter: boolean;
  hasDraft: boolean;
  hasSelection: boolean;
  hasUnsavedChanges: boolean;
  isGenerating: boolean;
  isAutoMaintaining: boolean;
  isSavingDraft: boolean;
  isMarkingComplete: boolean;
  hasSubmitHandler: boolean;
}) {
  if (!input.hasProject) return '请先选择项目。';
  if (!input.hasChapter) return '请先选择具体章节。';
  if (!input.hasDraft) return '当前章节还没有可修订的草稿。';
  if (!input.hasSelection) return '请先在正文中划选需要修订的文本。';
  if (input.hasUnsavedChanges) return '当前正文有未保存修改，请先保存后再发起局部修订。';
  if (input.isGenerating) return '正文生成中，暂时不能发起局部修订。';
  if (input.isAutoMaintaining) return 'AI 审核维护中，暂时不能发起局部修订。';
  if (input.isSavingDraft) return '草稿保存中，请稍后再试。';
  if (input.isMarkingComplete) return '章节状态更新中，请稍后再试。';
  if (!input.hasSubmitHandler) return 'Agent 入口尚未就绪。';
  return '';
}

function buildNonEmptyParagraphSpans(content: string) {
  const spans: Array<{ paragraphNo: number; start: number; end: number }> = [];
  let cursor = 0;
  let paragraphNo = 0;

  for (const line of content.split('\n')) {
    const lineStart = cursor;
    const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line;
    const lineEnd = lineStart + normalizedLine.length;
    if (normalizedLine.trim()) {
      paragraphNo += 1;
      spans.push({ paragraphNo, start: lineStart, end: lineEnd });
    }
    cursor += line.length + 1;
  }

  return spans;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
