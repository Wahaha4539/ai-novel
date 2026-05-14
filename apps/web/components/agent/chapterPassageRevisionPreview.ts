export interface PassageTextRange {
  start: number;
  end: number;
}

export interface PassageParagraphRange {
  start: number;
  end: number;
  count: number;
}

export interface ChapterPassageRevisionPreviewView {
  previewId?: string;
  chapterId: string;
  draftId: string;
  draftVersion: number;
  selectedRange: PassageTextRange;
  selectedParagraphRange?: PassageParagraphRange;
  originalText: string;
  replacementText: string;
  editSummary: string;
  preservedFacts: string[];
  risks: string[];
  validation: {
    valid: boolean;
    issues: string[];
  };
}

export interface PassageDiffSegment {
  type: 'equal' | 'add' | 'remove';
  text: string;
}

const EXACT_DIFF_CELL_LIMIT = 120_000;

export function parseChapterPassageRevisionPreview(content: unknown): ChapterPassageRevisionPreviewView | null {
  const record = asRecord(content);
  const chapterId = requiredString(record.chapterId);
  const draftId = requiredString(record.draftId);
  const originalText = requiredString(record.originalText, { preserveWhitespace: true });
  const replacementText = requiredString(record.replacementText, { preserveWhitespace: true });
  const editSummary = requiredString(record.editSummary);
  const draftVersion = requiredPositiveInteger(record.draftVersion);
  const selectedRange = parseTextRange(record.selectedRange);
  const validation = parseValidation(record.validation);
  if (!chapterId || !draftId || !originalText || !replacementText || !editSummary || !draftVersion || !selectedRange || !validation) {
    return null;
  }

  const paragraphRange = parseParagraphRange(record.selectedParagraphRange);

  return {
    previewId: optionalString(record.previewId),
    chapterId,
    draftId,
    draftVersion,
    selectedRange,
    ...(paragraphRange ? { selectedParagraphRange: paragraphRange } : {}),
    originalText,
    replacementText,
    editSummary,
    preservedFacts: stringArray(record.preservedFacts),
    risks: stringArray(record.risks),
    validation,
  };
}

export function buildPassageDiffSegments(originalText: string, replacementText: string): PassageDiffSegment[] {
  if (!originalText && !replacementText) return [];
  if (originalText === replacementText) return [{ type: 'equal', text: originalText }];

  const before = Array.from(originalText);
  const after = Array.from(replacementText);
  const prefixLength = commonPrefixLength(before, after);
  const suffixLength = commonSuffixLength(before, after, prefixLength);
  const middleBefore = before.slice(prefixLength, before.length - suffixLength);
  const middleAfter = after.slice(prefixLength, after.length - suffixLength);

  const exactMiddle = middleBefore.length * middleAfter.length <= EXACT_DIFF_CELL_LIMIT
    ? buildExactDiffSegments(middleBefore, middleAfter)
    : compactReplaceSegments(middleBefore, middleAfter);

  return mergeSegments([
    ...(prefixLength ? [{ type: 'equal' as const, text: before.slice(0, prefixLength).join('') }] : []),
    ...exactMiddle,
    ...(suffixLength ? [{ type: 'equal' as const, text: before.slice(before.length - suffixLength).join('') }] : []),
  ]);
}

function buildExactDiffSegments(before: string[], after: string[]): PassageDiffSegment[] {
  if (!before.length && !after.length) return [];
  if (!before.length) return [{ type: 'add', text: after.join('') }];
  if (!after.length) return [{ type: 'remove', text: before.join('') }];

  const rows = before.length + 1;
  const cols = after.length + 1;
  const dp = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let beforeIndex = 1; beforeIndex < rows; beforeIndex += 1) {
    for (let afterIndex = 1; afterIndex < cols; afterIndex += 1) {
      dp[beforeIndex][afterIndex] = before[beforeIndex - 1] === after[afterIndex - 1]
        ? dp[beforeIndex - 1][afterIndex - 1] + 1
        : Math.max(dp[beforeIndex - 1][afterIndex], dp[beforeIndex][afterIndex - 1]);
    }
  }

  const tokens: Array<{ type: PassageDiffSegment['type']; text: string }> = [];
  let beforeIndex = before.length;
  let afterIndex = after.length;

  while (beforeIndex > 0 || afterIndex > 0) {
    if (beforeIndex > 0 && afterIndex > 0 && before[beforeIndex - 1] === after[afterIndex - 1]) {
      tokens.push({ type: 'equal', text: before[beforeIndex - 1] });
      beforeIndex -= 1;
      afterIndex -= 1;
      continue;
    }

    const left = afterIndex > 0 ? dp[beforeIndex][afterIndex - 1] : -1;
    const up = beforeIndex > 0 ? dp[beforeIndex - 1][afterIndex] : -1;
    if (afterIndex > 0 && left >= up) {
      tokens.push({ type: 'add', text: after[afterIndex - 1] });
      afterIndex -= 1;
    } else if (beforeIndex > 0) {
      tokens.push({ type: 'remove', text: before[beforeIndex - 1] });
      beforeIndex -= 1;
    }
  }

  return mergeSegments(tokens.reverse());
}

function compactReplaceSegments(before: string[], after: string[]): PassageDiffSegment[] {
  return mergeSegments([
    ...(before.length ? [{ type: 'remove' as const, text: before.join('') }] : []),
    ...(after.length ? [{ type: 'add' as const, text: after.join('') }] : []),
  ]);
}

function mergeSegments(segments: PassageDiffSegment[]): PassageDiffSegment[] {
  const merged: PassageDiffSegment[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const previous = merged[merged.length - 1];
    if (previous?.type === segment.type) {
      previous.text += segment.text;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

function commonPrefixLength(before: string[], after: string[]) {
  let index = 0;
  while (index < before.length && index < after.length && before[index] === after[index]) index += 1;
  return index;
}

function commonSuffixLength(before: string[], after: string[], prefixLength: number) {
  let count = 0;
  const beforeLimit = before.length - prefixLength;
  const afterLimit = after.length - prefixLength;
  while (count < beforeLimit && count < afterLimit) {
    if (before[before.length - 1 - count] !== after[after.length - 1 - count]) break;
    count += 1;
  }
  return count;
}

function parseTextRange(value: unknown): PassageTextRange | null {
  const record = asRecord(value);
  const start = requiredNonNegativeInteger(record.start);
  const end = requiredPositiveInteger(record.end);
  if (start === null || end === null || end < start) return null;
  return { start, end };
}

function parseParagraphRange(value: unknown): PassageParagraphRange | null {
  const record = asRecord(value);
  const start = requiredPositiveInteger(record.start);
  const end = requiredPositiveInteger(record.end);
  if (start === null || end === null || end < start) return null;
  const count = requiredPositiveInteger(record.count) ?? end - start + 1;
  return { start, end, count };
}

function parseValidation(value: unknown): ChapterPassageRevisionPreviewView['validation'] | null {
  const record = asRecord(value);
  if (typeof record.valid !== 'boolean') return null;
  return {
    valid: record.valid,
    issues: stringArray(record.issues),
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const text = requiredString(item);
    return text ? [text] : [];
  });
}

function requiredString(value: unknown, options: { preserveWhitespace?: boolean } = {}): string | null {
  if (typeof value !== 'string') return null;
  if (!value.trim()) return null;
  return options.preserveWhitespace ? value : value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredPositiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function requiredNonNegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
