import type { AgentPageContext, AgentRun } from '../../hooks/useAgentRun';
import { parseChapterPassageRevisionPreview, type ChapterPassageRevisionPreviewView } from '../agent/chapterPassageRevisionPreview';
import { buildPassageRevisionContextPatch, isPassageRevisionTaskType } from '../agent/passageRevisionSession';

type PassageRevisionRunLike = Pick<AgentRun, 'taskType' | 'artifacts' | 'input'>;

export function extractLatestPassageRevisionPreview(run: PassageRevisionRunLike | null): ChapterPassageRevisionPreviewView | null {
  if (!run || !isPassageRevisionTaskType(run.taskType)) return null;
  const latestPreview = [...(run.artifacts ?? [])]
    .reverse()
    .find((artifact) => artifact.artifactType === 'chapter_passage_revision_preview');
  return latestPreview ? parseChapterPassageRevisionPreview(latestPreview.content) : null;
}

export function buildInlinePassageRevisionContextPatch(run: PassageRevisionRunLike | null): AgentPageContext | undefined {
  return buildPassageRevisionContextPatch(run);
}
