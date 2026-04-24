/**
 * useChapterGeneration — Core hook for AI chapter content generation.
 *
 * Handles the full lifecycle:
 *  1. Trigger generation (POST /chapters/:id/generate)
 *  2. Poll job status (GET /jobs/:id) until completed/failed
 *  3. Load draft content (GET /chapters/:id/drafts)
 *  4. Run the required post-process chain: polish → rebuild memory → validate → AI memory review
 *  5. Sequential batch generation (one fully processed chapter at a time)
 *
 * Supports: single chapter, multi-chapter, volume, multi-volume, whole-book.
 */
import { useState, useCallback, useRef } from 'react';
import { ChapterDraft, GenerationJob } from '../types/dashboard';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3001/api';

/** Poll interval in milliseconds */
const POLL_INTERVAL = 3000;
/** Maximum number of poll attempts before timeout */
const MAX_POLL_ATTEMPTS = 200;

// ─── Types ──────────────────────────────────────────────

export type GenerationState = 'idle' | 'generating' | 'polling' | 'completed' | 'failed';

export type BatchProgress = {
  current: number;
  total: number;
  currentChapterId: string;
  currentChapterTitle: string;
  completedIds: string[];
  failedIds: string[];
};

type ChapterTarget = {
  id: string;
  chapterNo: number;
  title: string;
};

// ─── API helpers ────────────────────────────────────────

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `请求失败: ${response.status}`);
  }
  return (await response.json()) as T;
}

/** Trigger AI generation for a single chapter */
async function requestGenerate(chapterId: string): Promise<GenerationJob> {
  return apiFetch<GenerationJob>(`/chapters/${chapterId}/generate`, {
    method: 'POST',
    body: JSON.stringify({
      mode: 'draft',
      includeLorebook: true,
      includeMemory: true,
      validateBeforeWrite: true,
      validateAfterWrite: true,
    }),
  });
}

/** Poll a job until it reaches a terminal state */
async function pollUntilDone(
  jobId: string,
  onUpdate?: (job: GenerationJob) => void,
  abortSignal?: AbortSignal,
): Promise<GenerationJob> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    if (abortSignal?.aborted) {
      throw new Error('generation_cancelled');
    }
    const job = await apiFetch<GenerationJob>(`/jobs/${jobId}`);
    onUpdate?.(job);

    if (job.status === 'completed' || job.status === 'failed') {
      return job;
    }
    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
  throw new Error('generation_timeout');
}

/** Request polish for a single chapter */
async function requestPolish(chapterId: string, userInstruction?: string): Promise<{ polishedText: string; polishedWordCount: number }> {
  return apiFetch(`/chapters/${chapterId}/polish`, {
    method: 'POST',
    body: JSON.stringify({ userInstruction }),
  });
}

/** Fetch the latest current draft for a chapter */
async function fetchLatestDraft(chapterId: string): Promise<ChapterDraft | null> {
  try {
    const result = await apiFetch<ChapterDraft | null>(`/chapters/${chapterId}/drafts`);
    return result;
  } catch {
    return null;
  }
}

/** Run the mandatory post-generation chain so the next chapter sees final-text facts. */
async function runChapterPostProcess(projectId: string, chapterId: string): Promise<void> {
  // 润色必须先于重建记忆执行；否则事实层会基于初稿而不是最终稿。
  await requestPolish(
    chapterId,
    '请在不改变剧情事实、人物关系和章节主线结果的前提下，润色当前章节正文：提升句子流畅度、画面感、节奏和衔接，修正明显语病与重复表达。直接输出润色后的完整章节正文，不要添加说明。',
  );

  await apiFetch(`/projects/${projectId}/memory/rebuild?chapterId=${encodeURIComponent(chapterId)}&dryRun=false`, {
    method: 'POST',
  });

  await apiFetch(`/projects/${projectId}/validation/run?chapterId=${encodeURIComponent(chapterId)}`, {
    method: 'POST',
  });

  await apiFetch(`/projects/${projectId}/memory/reviews/ai-resolve`, {
    method: 'POST',
    body: JSON.stringify({ chapterId }),
  });
}

// ─── Hook ───────────────────────────────────────────────

export function useChapterGeneration() {
  const [state, setState] = useState<GenerationState>('idle');
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [currentDraft, setCurrentDraft] = useState<ChapterDraft | null>(null);
  const [error, setError] = useState<string>('');
  const [currentJob, setCurrentJob] = useState<GenerationJob | null>(null);
  // Abort controller for cancellation support
  const abortRef = useRef<AbortController | null>(null);

  /**
   * Generate content for a single chapter.
   * Full lifecycle: trigger → poll → load draft.
   */
  const generateSingle = useCallback(async (projectId: string, chapterId: string): Promise<ChapterDraft | null> => {
    setState('generating');
    setError('');
    setCurrentJob(null);

    try {
      // Step 1: Trigger generation
      const job = await requestGenerate(chapterId);
      setCurrentJob(job);
      setState('polling');

      // Step 2: Poll until complete
      const completedJob = await pollUntilDone(
        job.id,
        (updatedJob) => setCurrentJob(updatedJob),
        abortRef.current?.signal,
      );

      if (completedJob.status === 'failed') {
        const errMsg = completedJob.errorMessage || '生成失败';
        setError(errMsg);
        setState('failed');
        return null;
      }

      // Step 3: Polish final text, rebuild facts, validate, and confirm memory before exposing completion.
      await runChapterPostProcess(projectId, chapterId);

      // Step 4: Load the final current draft after polishing
      const draft = await fetchLatestDraft(chapterId);
      setCurrentDraft(draft);
      setState('completed');
      return draft;
    } catch (err) {
      const message = err instanceof Error ? err.message : '生成失败';
      setError(message);
      setState('failed');
      return null;
    }
  }, []);

  /**
   * Generate content for multiple chapters sequentially.
   * Each chapter's worker must finish before starting the next.
   * This ensures consistent context (previous chapters' text is available).
   */
  const generateSequential = useCallback(async (
    projectId: string,
    chapters: ChapterTarget[],
    onChapterComplete?: (chapterId: string, index: number) => void,
  ) => {
    if (chapters.length === 0) return;

    // Create abort controller for this batch
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    const batchProgress: BatchProgress = {
      current: 0,
      total: chapters.length,
      currentChapterId: '',
      currentChapterTitle: '',
      completedIds: [],
      failedIds: [],
    };

    setState('generating');
    setError('');

    try {
      for (let i = 0; i < chapters.length; i++) {
        if (signal.aborted) {
          throw new Error('generation_cancelled');
        }

        const chapter = chapters[i];
        // Update progress
        batchProgress.current = i + 1;
        batchProgress.currentChapterId = chapter.id;
        batchProgress.currentChapterTitle = chapter.title || `第${chapter.chapterNo}章`;
        setProgress({ ...batchProgress });

        // Step 1: Trigger generation for this chapter
        const job = await requestGenerate(chapter.id);
        setCurrentJob(job);
        setState('polling');

        // Step 2: Poll until complete
        const completedJob = await pollUntilDone(
          job.id,
          (updatedJob) => setCurrentJob(updatedJob),
          signal,
        );

        if (completedJob.status === 'failed') {
          batchProgress.failedIds.push(chapter.id);
          // Continue to next chapter on failure (don't block the batch)
          continue;
        }

        // Step 3: Complete the chapter lifecycle before starting the next chapter.
        // This guarantees subsequent chapters retrieve polished text and refreshed facts/memory.
        await runChapterPostProcess(projectId, chapter.id);

        batchProgress.completedIds.push(chapter.id);
        onChapterComplete?.(chapter.id, i);
      }

      // Final progress update
      setProgress({ ...batchProgress });
      setState(batchProgress.failedIds.length > 0 ? 'failed' : 'completed');

      if (batchProgress.failedIds.length > 0) {
        setError(`${batchProgress.failedIds.length} 章生成失败`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '批量生成失败';
      setError(message);
      setState('failed');
    }
  }, []);

  /** Cancel ongoing generation */
  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState('idle');
    setProgress(null);
    setError('已取消生成');
  }, []);

  /** Reset state to idle */
  const reset = useCallback(() => {
    setState('idle');
    setProgress(null);
    setCurrentDraft(null);
    setCurrentJob(null);
    setError('');
  }, []);

  /** Load an existing draft for display */
  const loadDraft = useCallback(async (chapterId: string) => {
    const draft = await fetchLatestDraft(chapterId);
    setCurrentDraft(draft);
    return draft;
  }, []);

  /**
   * Polish an existing chapter draft.
   * Calls the polish endpoint and returns the polished text.
   */
  const polishSingle = useCallback(async (chapterId: string, userInstruction?: string) => {
    setState('generating');
    setError('');
    try {
      const result = await requestPolish(chapterId, userInstruction);
      setState('completed');
      // Reload the latest draft after polishing
      await loadDraft(chapterId);
      return result;
    } catch (err) {
      setState('failed');
      setError(err instanceof Error ? err.message : '润色失败');
      return null;
    }
  }, [loadDraft]);

  return {
    state,
    progress,
    currentDraft,
    currentJob,
    error,
    generateSingle,
    generateSequential,
    polishSingle,
    cancel,
    reset,
    loadDraft,
  };
}
