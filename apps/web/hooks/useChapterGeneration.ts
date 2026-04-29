/**
 * useChapterGeneration — Core hook for AI chapter content generation.
 *
 * Handles the full lifecycle:
 *  1. Trigger generation (POST /chapters/:id/generate)
 *  2. Poll job status (GET /jobs/:id) until the API 内同步生成链路完成生成 + 后处理
 *  3. Load draft content (GET /chapters/:id/drafts)
 *  4. Sequential batch generation (one fully processed chapter at a time)
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
/** 单个前端 API 请求最长等待 20 分钟，覆盖生成后处理中的长耗时 LLM/重建/校验请求。 */
const API_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

// ─── Types ──────────────────────────────────────────────

export type GenerationState = 'idle' | 'generating' | 'polling' | 'completed' | 'failed';

export type BatchProgress = {
  current: number;
  total: number;
  currentChapterId: string;
  currentChapterTitle: string;
  currentStep?: string;
  completedIds: string[];
  failedIds: string[];
};

type ChapterTarget = {
  id: string;
  chapterNo: number;
  title: string;
};

type GenerationLogContext = {
  jobId?: string;
  projectId: string;
  chapterId: string;
  chapterNo?: number;
  chapterTitle?: string;
};

type GenerationStepReporter = (stepLabel: string) => void;

// ─── API helpers ────────────────────────────────────────

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);

  // 如果调用方已经传入取消信号，需要联动到本地 controller，避免用户点击取消后还等 20 分钟。
  const abortFromCaller = () => controller.abort();
  init?.signal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `请求失败: ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError' && !init?.signal?.aborted) {
      throw new Error('请求超时：单个任务超过 20 分钟未返回');
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    init?.signal?.removeEventListener('abort', abortFromCaller);
  }
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

/** Fetch all draft versions so the editor can show original vs polished text. */
async function fetchDraftVersions(chapterId: string): Promise<ChapterDraft[]> {
  try {
    return await apiFetch<ChapterDraft[]>(`/chapters/${chapterId}/drafts/all`);
  } catch {
    return [];
  }
}

/** 输出带 jobId 和步骤名的调试日志，便于定位批量生成在哪一章/哪一步中断。 */
function logGenerationStep(step: string, context: GenerationLogContext, extra?: Record<string, unknown>) {
  console.info('[chapter-generation]', {
    step,
    jobId: context.jobId ?? null,
    projectId: context.projectId,
    chapterId: context.chapterId,
    chapterNo: context.chapterNo ?? null,
    chapterTitle: context.chapterTitle ?? null,
    ...(extra ?? {}),
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

        // Step 3: API 同步任务完成后，生成、后处理、事实抽取、校验和记忆维护都已落库。
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
   * Each chapter's API-side generation lifecycle must finish before starting the next.
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
        batchProgress.currentStep = '提交生成任务';
        setProgress({ ...batchProgress });

        // Step 1: Trigger generation for this chapter
        const job = await requestGenerate(chapter.id);
        const logContext = {
          jobId: job.id,
          projectId,
          chapterId: chapter.id,
          chapterNo: chapter.chapterNo,
          chapterTitle: chapter.title,
        };
        logGenerationStep('chapter.generate.requested', logContext);
        setCurrentJob(job);
        setState('polling');
        batchProgress.currentStep = '等待 API 生成与后处理';
        setProgress({ ...batchProgress });

        // Step 2: Poll until complete
        const completedJob = await pollUntilDone(
          job.id,
          (updatedJob) => setCurrentJob(updatedJob),
          signal,
        );

        if (completedJob.status === 'failed') {
          batchProgress.failedIds.push(chapter.id);
          // 失败章节同样会破坏连续生成上下文，必须停在当前章等待用户处理。
          throw new Error(`第 ${chapter.chapterNo} 章生成失败：${completedJob.errorMessage || '未知错误'}`);
        }

        // Step 3: Job completion means API-side generation lifecycle has finished.
        logGenerationStep('chapter.generate.completed_with_postprocess', logContext);
        batchProgress.completedIds.push(chapter.id);
        batchProgress.currentStep = '当前章节完成';
        setProgress({ ...batchProgress });
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

  /** Load all draft versions for comparison UI such as 草稿/润色 switching. */
  const loadDraftVersions = useCallback(async (chapterId: string) => {
    return fetchDraftVersions(chapterId);
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
    loadDraftVersions,
  };
}
