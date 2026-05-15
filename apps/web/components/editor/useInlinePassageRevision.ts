'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAgentRun, type AgentRunStatus } from '../../hooks/useAgentRun';
import type { PassageAgentContext } from './passageSelection';
import { buildInlinePassageRevisionContextPatch, extractLatestPassageRevisionPreview } from './inlinePassageRevisionSession';

const PREVIEW_PENDING_STATUSES = new Set<AgentRunStatus>(['planning', 'running', 'acting']);
const PREVIEW_READY_STATUSES = new Set<AgentRunStatus>(['waiting_approval', 'waiting_review']);

interface UseInlinePassageRevisionOptions {
  projectId?: string;
  onApplied?: () => void | Promise<void>;
}

export function useInlinePassageRevision({ projectId, onApplied }: UseInlinePassageRevisionOptions) {
  const { currentRun, loading, error, actionMessage, createPlan, replan, act, startNewSession } = useAgentRun();
  const preview = useMemo(() => extractLatestPassageRevisionPreview(currentRun), [currentRun]);
  const appliedRunIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!currentRun || currentRun.status !== 'succeeded' || !preview) return;
    if (appliedRunIdRef.current === currentRun.id) return;
    appliedRunIdRef.current = currentRun.id;
    void onApplied?.();
  }, [currentRun, onApplied, preview]);

  const submit = useCallback(async (
    message: string,
    context: PassageAgentContext,
    options?: { forceNewSession?: boolean },
  ) => {
    if (!projectId) throw new Error('请先选择项目后再发起局部修订。');

    if (!options?.forceNewSession && currentRun && preview && PREVIEW_READY_STATUSES.has(currentRun.status)) {
      const contextPatch = buildInlinePassageRevisionContextPatch(currentRun);
      await replan(currentRun.id, message, contextPatch ? { contextPatch } : undefined);
      return;
    }

    appliedRunIdRef.current = null;
    startNewSession();
    await createPlan(projectId, message, context);
  }, [createPlan, currentRun, preview, projectId, replan, startNewSession]);

  const apply = useCallback(async () => {
    if (!currentRun || !preview) return;
    appliedRunIdRef.current = null;
    await act(currentRun.id);
  }, [act, currentRun, preview]);

  const reset = useCallback(() => {
    appliedRunIdRef.current = null;
    startNewSession();
  }, [startNewSession]);

  const isGeneratingPreview = Boolean(!preview && currentRun && PREVIEW_PENDING_STATUSES.has(currentRun.status));
  const isPreviewReady = Boolean(preview && currentRun && PREVIEW_READY_STATUSES.has(currentRun.status));
  const isApplying = Boolean(preview && currentRun && currentRun.status === 'acting');

  return {
    currentRun,
    preview,
    error,
    actionMessage,
    loading,
    isGeneratingPreview,
    isPreviewReady,
    isApplying,
    canApply: Boolean(preview && isPreviewReady && preview.validation.valid),
    submit,
    apply,
    reset,
  };
}
