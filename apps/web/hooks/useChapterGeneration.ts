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
import { ChapterDraft, GenerationJob, ValidationIssue, ValidationRunResult } from '../types/dashboard';

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

/** 自动修复最多循环 3 次；每次都会生成修复稿、重建事实层并复检，仍失败才停下给用户处理。 */
const MAX_AUTO_FIX_ATTEMPTS = 3;

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

/** 查询当前章节仍处于 open 状态的校验问题；批量生成必须据此决定是否继续下一章。 */
async function fetchOpenValidationIssues(chapterId: string): Promise<ValidationIssue[]> {
  return apiFetch<ValidationIssue[]>(`/chapters/${chapterId}/validation-issues`);
}

/** 构造批量修复指令，要求 LLM 一次性处理当前章节所有校验问题，避免逐条修复导致剧情反复漂移。 */
function buildValidationFixInstruction(issues: ValidationIssue[]) {
  const issueLines = issues.map((issue, index) => [
    `问题 ${index + 1}`,
    `- 类型：${issue.issueType}`,
    `- 严重程度：${issue.severity}`,
    `- 详情：${issue.message}`,
    issue.suggestion ? `- 已有建议：${issue.suggestion}` : '',
  ].filter(Boolean).join('\n'));

  return [
    '请一次性修复以下全部结构化事实校验问题，不要逐条孤立改写，不要重写整章，不要改变主线结果。',
    '修复方式：合并考虑所有问题，在相关段落补充必要过渡、空间移动、时间衔接或事实澄清；保持原有叙事视角、语气和人物关系。',
    issueLines.join('\n\n'),
    '输出要求：直接输出修复后的完整章节正文，不要添加说明、标题、diff 或分析。',
  ].filter(Boolean).join('\n');
}

/** 自动修复当前章节 open 校验问题，并完成事实层重建与复检。返回复检后仍未解决的问题。 */
async function autoFixValidationIssues(
  projectId: string,
  chapterId: string,
  issues: ValidationIssue[],
  logContext: GenerationLogContext,
  reportStep?: GenerationStepReporter,
): Promise<ValidationIssue[]> {
  let remainingIssues = issues;

  for (let attempt = 1; attempt <= MAX_AUTO_FIX_ATTEMPTS && remainingIssues.length > 0; attempt++) {
    reportStep?.(`AI 自动修复校验问题（第 ${attempt} 次，${remainingIssues.length} 条）`);
    logGenerationStep('postprocess.auto_fix.started', logContext, {
      attempt,
      issueCount: remainingIssues.length,
    });

    await requestPolish(chapterId, buildValidationFixInstruction(remainingIssues));

    // 修复稿会成为新的 current draft，必须立即重建事实层，否则复检仍会基于旧事实数据。
    reportStep?.(`自动修复后重建事实层（第 ${attempt} 次）`);
    logGenerationStep('postprocess.auto_fix.memory_rebuild.started', logContext, { attempt });
    await apiFetch(`/projects/${projectId}/memory/rebuild?chapterId=${encodeURIComponent(chapterId)}&dryRun=false`, {
      method: 'POST',
    });

    reportStep?.(`自动修复后复检（第 ${attempt} 次）`);
    logGenerationStep('postprocess.auto_fix.validation.started', logContext, { attempt });
    const validationResult = await apiFetch<ValidationRunResult>(`/projects/${projectId}/validation/run?chapterId=${encodeURIComponent(chapterId)}`, {
      method: 'POST',
    });

    remainingIssues = await fetchOpenValidationIssues(chapterId);
    logGenerationStep('postprocess.auto_fix.validation.completed', logContext, {
      attempt,
      createdIssueCount: validationResult.createdCount,
      openIssueCount: remainingIssues.length,
    });
  }

  return remainingIssues;
}

/** Run the mandatory post-generation chain so the next chapter sees final-text facts. */
async function runChapterPostProcess(
  projectId: string,
  chapterId: string,
  logContext: GenerationLogContext,
  reportStep?: GenerationStepReporter,
): Promise<ValidationIssue[]> {
  // 润色必须先于重建记忆执行；否则事实层会基于初稿而不是最终稿。
  reportStep?.('润色正文');
  logGenerationStep('postprocess.polish.started', logContext);
  await requestPolish(
    chapterId,
    '请在不改变剧情事实、人物关系和章节主线结果的前提下，润色当前章节正文：提升句子流畅度、画面感、节奏和衔接，修正明显语病与重复表达。直接输出润色后的完整章节正文，不要添加说明。',
  );

  reportStep?.('重建事实层/记忆');
  logGenerationStep('postprocess.memory_rebuild.started', logContext);
  await apiFetch(`/projects/${projectId}/memory/rebuild?chapterId=${encodeURIComponent(chapterId)}&dryRun=false`, {
    method: 'POST',
  });

  reportStep?.('运行校验');
  logGenerationStep('postprocess.validation.started', logContext);
  const validationResult = await apiFetch<ValidationRunResult>(`/projects/${projectId}/validation/run?chapterId=${encodeURIComponent(chapterId)}`, {
    method: 'POST',
  });

  let openIssues = await fetchOpenValidationIssues(chapterId);
  logGenerationStep('postprocess.validation.completed', logContext, {
    createdIssueCount: validationResult.createdCount,
    openIssueCount: openIssues.length,
  });

  if (openIssues.length > 0) {
    // 先自动调用“一键修复”同款链路：修复稿 → 重建事实层 → 复检；仍失败才中断下一章。
    openIssues = await autoFixValidationIssues(projectId, chapterId, openIssues, logContext, reportStep);
    if (openIssues.length > 0) {
      return openIssues;
    }
  }

  reportStep?.('AI 审核 pending_review 记忆');
  logGenerationStep('postprocess.memory_review.started', logContext);
  await apiFetch(`/projects/${projectId}/memory/reviews/ai-resolve`, {
    method: 'POST',
    body: JSON.stringify({ chapterId }),
  });

  logGenerationStep('postprocess.completed', logContext);
  return [];
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
      const openIssues = await runChapterPostProcess(projectId, chapterId, {
        jobId: job.id,
        projectId,
        chapterId,
      });

      if (openIssues.length > 0) {
        setError(`当前章节仍有 ${openIssues.length} 个校验问题，请先修复后再继续。`);
        setState('failed');
        return null;
      }

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
        batchProgress.currentStep = '等待 Worker 生成正文';
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

        // Step 3: Complete the chapter lifecycle before starting the next chapter.
        // This guarantees subsequent chapters retrieve polished text and refreshed facts/memory.
        const openIssues = await runChapterPostProcess(projectId, chapter.id, logContext, (stepLabel) => {
          batchProgress.currentStep = stepLabel;
          setProgress({ ...batchProgress });
        });
        if (openIssues.length > 0) {
          batchProgress.failedIds.push(chapter.id);
          setProgress({ ...batchProgress });
          throw new Error(`第 ${chapter.chapterNo} 章仍有 ${openIssues.length} 个校验问题，请先修复后再继续生成下一章。`);
        }

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
