import type { ChapterDraft } from '../../types/dashboard';

export type DraftViewMode = 'draft' | 'polished';

export function isPolishedDraft(draft?: ChapterDraft | null) {
  return draft?.source === 'agent_polish' || draft?.generationContext?.type === 'polish';
}

/**
 * Resolve the editor's version pairing from the full ChapterDraft history.
 *
 * `current` always reflects the database current draft. `draft` is the primary
 * editable manuscript surface, while `polished` is only the AI-polish branch.
 */
export function buildDraftViewPair(versions: ChapterDraft[]) {
  const sorted = [...versions].sort((a, b) => b.versionNo - a.versionNo);
  const current = sorted.find((item) => item.isCurrent) ?? sorted[0];
  const latestPolished = sorted.find(isPolishedDraft);
  const polished = current && isPolishedDraft(current) ? current : latestPolished;
  const originalDraftId = typeof polished?.generationContext?.originalDraftId === 'string'
    ? polished.generationContext.originalDraftId
    : undefined;

  return {
    current,
    draft: originalDraftId
      ? sorted.find((item) => item.id === originalDraftId) ?? sorted.find((item) => !isPolishedDraft(item)) ?? current
      : sorted.find((item) => !isPolishedDraft(item)) ?? current,
    polished,
  };
}

/**
 * The editor should open on the actual current draft unless the current row is
 * itself an AI-polished result.
 */
export function resolvePreferredDraftViewMode(pair: ReturnType<typeof buildDraftViewPair>): DraftViewMode {
  return pair.current && isPolishedDraft(pair.current) ? 'polished' : 'draft';
}
