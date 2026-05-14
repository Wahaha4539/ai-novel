import type { AgentPageContext, AgentRun } from '../../hooks/useAgentRun';
import { parseChapterPassageRevisionPreview } from './chapterPassageRevisionPreview';

type PassageRevisionRunLike = Pick<AgentRun, 'taskType' | 'input' | 'artifacts'>;

export function isPassageRevisionTaskType(taskType?: string | null) {
  return taskType === 'chapter_passage_revision' || taskType === 'passage_revision';
}

export function buildPassageRevisionContextPatch(run: PassageRevisionRunLike | null): AgentPageContext | undefined {
  if (!run || !isPassageRevisionTaskType(run.taskType)) return undefined;

  const inputContext = asRecord(asRecord(run.input).context);
  const selectedText = stringValue(inputContext.selectedText);
  const selectedRange = textRangeValue(inputContext.selectedRange);
  const currentDraftId = stringValue(inputContext.currentDraftId);
  const currentDraftVersion = numberValue(inputContext.currentDraftVersion);
  if (!selectedText || !selectedRange || !currentDraftId || currentDraftVersion === undefined) return undefined;

  const selectedParagraphRange = paragraphRangeValue(inputContext.selectedParagraphRange);
  const latestPreview = [...(run.artifacts ?? [])]
    .reverse()
    .find((artifact) => artifact.artifactType === 'chapter_passage_revision_preview');
  const preview = latestPreview ? parseChapterPassageRevisionPreview(latestPreview.content) : null;

  return {
    ...(stringValue(inputContext.currentProjectId) ? { currentProjectId: stringValue(inputContext.currentProjectId) } : {}),
    ...(stringValue(inputContext.currentVolumeId) ? { currentVolumeId: stringValue(inputContext.currentVolumeId) } : {}),
    ...(stringValue(inputContext.currentChapterId) ? { currentChapterId: stringValue(inputContext.currentChapterId) } : {}),
    ...(stringValue(inputContext.currentChapterTitle) ? { currentChapterTitle: stringValue(inputContext.currentChapterTitle) } : {}),
    ...(numberValue(inputContext.currentChapterIndex) !== undefined ? { currentChapterIndex: numberValue(inputContext.currentChapterIndex) } : {}),
    currentDraftId,
    currentDraftVersion,
    selectedText,
    selectedRange,
    ...(selectedParagraphRange ? { selectedParagraphRange } : {}),
    selectionIntent: 'chapter_passage_revision',
    sourcePage: 'editor_passage_agent',
    ...(preview
      ? {
          passageRevision: {
            ...(preview.previewId ? { previewId: preview.previewId } : {}),
            previousReplacementText: preview.replacementText,
            previousEditSummary: preview.editSummary,
            ...(preview.risks.length ? { previousRisks: preview.risks } : {}),
          },
        }
      : {}),
  };
}

function textRangeValue(value: unknown): { start: number; end: number } | undefined {
  const record = asRecord(value);
  const start = numberValue(record.start);
  const end = numberValue(record.end);
  if (start === undefined || end === undefined) return undefined;
  return { start, end };
}

function paragraphRangeValue(value: unknown): { start: number; end: number; count?: number } | undefined {
  const record = asRecord(value);
  const start = numberValue(record.start);
  const end = numberValue(record.end);
  if (start === undefined || end === undefined) return undefined;
  const count = numberValue(record.count);
  return {
    start,
    end,
    ...(count === undefined ? {} : { count }),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
