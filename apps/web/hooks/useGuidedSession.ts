import { useState, useCallback, useEffect } from 'react';
import { GuidedSession } from '../types/dashboard';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3001/api';

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
  const text = await response.text();
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

export const GUIDED_STEPS = [
  { key: 'guided_setup', label: '基础设定', icon: '📋', color: '#0ea5e9' },
  { key: 'guided_style', label: '风格定义', icon: '🎨', color: '#8b5cf6' },
  { key: 'guided_characters', label: '核心角色', icon: '👤', color: '#f59e0b' },
  { key: 'guided_outline', label: '总纲生成', icon: '📖', color: '#ef4444' },
  { key: 'guided_volume', label: '卷纲拆分', icon: '📁', color: '#14b8a6' },
  { key: 'guided_chapter', label: '章节细纲', icon: '📝', color: '#f97316' },
  { key: 'guided_foreshadow', label: '伏笔设计', icon: '🔮', color: '#ec4899' },
] as const;

export type StepKey = (typeof GUIDED_STEPS)[number]['key'];

export type ChatMessage = {
  role: 'ai' | 'user';
  content: string;
  timestamp: number;
};

export function useGuidedSession(projectId: string) {
  const [session, setSession] = useState<GuidedSession | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const currentStepKey = GUIDED_STEPS[currentStepIndex]?.key ?? 'guided_setup';

  // Load existing session
  const loadSession = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const data = await apiFetch<GuidedSession | null>(`/projects/${projectId}/guided-session`);
      if (data) {
        setSession(data);
        const stepIdx = GUIDED_STEPS.findIndex((s) => s.key === data.currentStep);
        if (stepIdx >= 0) setCurrentStepIndex(stepIdx);

        // Restore chat history from stepData
        const stepData = data.stepData as Record<string, unknown>;
        const savedChat = stepData[`${data.currentStep}_chat`];
        if (Array.isArray(savedChat)) {
          setChatMessages(savedChat as ChatMessage[]);
        }
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载引导会话失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Create/restart session — ask AI for personalized opening
  const startSession = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch<GuidedSession>(`/projects/${projectId}/guided-session`, {
        method: 'POST',
        body: JSON.stringify({ currentStep: 'guided_setup' }),
      });
      setSession(data);
      setCurrentStepIndex(0);
      setChatMessages([]);

      // Ask AI for a dynamic opening
      const response = await apiFetch<{ reply: string }>(
        `/projects/${projectId}/guided-session/chat`,
        {
          method: 'POST',
          body: JSON.stringify({
            currentStep: 'guided_setup',
            userMessage: '请开始引导我创建小说。以选择题的方式提问，给我选项让我选择，同时也允许我自由发挥。',
            chatHistory: [],
          }),
        },
      );

      setChatMessages([{
        role: 'ai',
        content: response.reply,
        timestamp: Date.now(),
      }]);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : '创建引导会话失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Save current step progress
  const saveStepProgress = useCallback(async (stepData: Record<string, unknown>) => {
    if (!projectId) return;
    try {
      const merged = {
        ...stepData,
        [`${currentStepKey}_chat`]: chatMessages,
      };
      const data = await apiFetch<GuidedSession>(`/projects/${projectId}/guided-session/step`, {
        method: 'PATCH',
        body: JSON.stringify({
          currentStep: currentStepKey,
          stepData: merged,
        }),
      });
      setSession(data);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存进度失败');
    }
  }, [projectId, currentStepKey, chatMessages]);

  // Finalize current step: ask AI for structured JSON, then persist to database
  const finalizeCurrentStep = useCallback(async (): Promise<boolean> => {
    if (!projectId || chatMessages.length < 2) return false;

    const stepLabel = GUIDED_STEPS[currentStepIndex]?.label ?? '';

    // Step-specific extraction prompts with JSON schemas
    const jsonPrompts: Record<string, string> = {
      guided_setup: `根据我们的对话，请输出「基础设定」的结构化 JSON，严格使用以下格式（只输出JSON，不要其他文字）：
{"genre":"类型","theme":"主题","tone":"基调","logline":"一句话概述","synopsis":"故事简介(100-200字)"}`,

      guided_style: `根据我们的对话，请输出「风格定义」的结构化 JSON（只输出JSON）：
{"pov":"人称视角","tense":"时态","proseStyle":"文风描述","pacing":"节奏描述"}`,

      guided_characters: `根据我们的对话，请输出「核心角色」的结构化 JSON（只输出JSON）：
{"characters":[{"name":"角色名","roleType":"protagonist/antagonist/supporting","personalityCore":"性格核心","motivation":"动机","backstory":"背景故事"}]}`,

      guided_outline: `根据我们的对话，请输出「故事总纲」的结构化 JSON（只输出JSON）：
{"outline":"完整的故事总纲大纲(300-500字)"}`,

      guided_volume: `根据我们的对话，请输出「卷纲」的结构化 JSON（只输出JSON）：
{"volumes":[{"volumeNo":1,"title":"卷名","synopsis":"本卷剧情概要","objective":"本卷核心目标"}]}`,

      guided_chapter: `根据我们的对话，请输出「章节细纲」的结构化 JSON（只输出JSON）：
{"chapters":[{"chapterNo":1,"title":"章节标题","objective":"本章目标","conflict":"核心冲突","outline":"章节大纲"}]}`,

      guided_foreshadow: `根据我们的对话，请输出「伏笔设计」的结构化 JSON（只输出JSON）：
{"foreshadowTracks":[{"title":"伏笔标题","detail":"伏笔内容详细描述(50字以上)","scope":"arc/volume/chapter","technique":"道具型/对话型/行为型/环境型/叙事型/象征型/结构型","plantChapter":"埋设时机(如:第1卷第3章)","revealChapter":"揭开时机(如:第3卷第8章)","involvedCharacters":"涉及角色","payoff":"揭开后的影响和情感冲击"}]}`,
    };

    const extractionPrompt = jsonPrompts[currentStepKey];
    if (!extractionPrompt) return false;

    setLoading(true);
    try {
      // Ask AI to extract structured data from conversation
      const response = await apiFetch<{ reply: string }>(
        `/projects/${projectId}/guided-session/chat`,
        {
          method: 'POST',
          body: JSON.stringify({
            currentStep: currentStepKey,
            userMessage: extractionPrompt,
            chatHistory: chatMessages.slice(-12),
          }),
        },
      );

      // Parse the JSON from AI response
      const jsonMatch = response.reply.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        setError('AI 未返回有效的结构化数据，请重试');
        return false;
      }

      const structuredData = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

      // Send to finalize-step endpoint to persist
      const result = await apiFetch<{ written: string[] }>(
        `/projects/${projectId}/guided-session/finalize-step`,
        {
          method: 'POST',
          body: JSON.stringify({
            currentStep: currentStepKey,
            structuredData,
          }),
        },
      );

      // Show success in chat
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'ai',
          content: `✅ **${stepLabel}** 已保存！\n\n已写入：${result.written.join('、')}`,
          timestamp: Date.now(),
        },
      ]);

      return true;
    } catch (finalizeError) {
      setError(
        finalizeError instanceof Error ? finalizeError.message : '结构化保存失败',
      );
      return false;
    } finally {
      setLoading(false);
    }
  }, [projectId, currentStepIndex, currentStepKey, chatMessages]);

  // Navigate to next step — finalize current step first, then ask AI for new step opening
  const goToNextStep = useCallback(async () => {
    if (currentStepIndex >= GUIDED_STEPS.length - 1) return;

    // Finalize current step: extract structured data and persist
    const finalized = await finalizeCurrentStep();
    if (!finalized) return; // Don't advance if finalization failed

    // Save chat history
    await saveStepProgress({});

    const nextIndex = currentStepIndex + 1;
    const nextStep = GUIDED_STEPS[nextIndex];
    setCurrentStepIndex(nextIndex);
    setChatMessages([]);
    setLoading(true);

    // Update session on server
    try {
      await apiFetch(`/projects/${projectId}/guided-session/step`, {
        method: 'PATCH',
        body: JSON.stringify({ currentStep: nextStep.key, stepData: {} }),
      });
    } catch {
      // Non-critical
    }

    // Fetch fresh session to get latest stepData (avoids stale closure)
    let freshStepData: Record<string, unknown> = {};
    try {
      const freshSession = await apiFetch<GuidedSession | null>(
        `/projects/${projectId}/guided-session`,
      );
      if (freshSession) {
        setSession(freshSession);
        freshStepData = (freshSession.stepData as Record<string, unknown>) ?? {};
      }
    } catch {
      // Fall through with empty context
    }

    // Ask AI to generate a dynamic, selective opening for the new step
    try {
      const priorKeys = new Set(GUIDED_STEPS.slice(0, nextIndex).map((s) => s.key));
      const contextSummary = Object.entries(freshStepData)
        .filter(([key]) => {
          if (!key.endsWith('_result')) return false;
          // stepData 的 key 来自后端 JSON，需在运行时转回已知 guided step key 再做集合判断。
          return priorKeys.has(key.replace(/_result$/, '') as (typeof GUIDED_STEPS)[number]['key']);
        })
        .map(([key, val]) => `${key}: ${JSON.stringify(val)}`)
        .join('\n');

      const response = await apiFetch<{ reply: string }>(
        `/projects/${projectId}/guided-session/chat`,
        {
          method: 'POST',
          body: JSON.stringify({
            currentStep: nextStep.key,
            userMessage: `我们进入「${nextStep.label}」步骤了。请根据我之前的设定，以选择题的方式引导我，给我具体选项让我选择或组合，也可以让我自由补充。`,
            chatHistory: [],
            projectContext: contextSummary || undefined,
          }),
        },
      );

      setChatMessages([{
        role: 'ai',
        content: response.reply,
        timestamp: Date.now(),
      }]);
    } catch {
      setChatMessages([{
        role: 'ai',
        content: `让我们进入 **${nextStep.label}** 步骤。请告诉我你的想法，或者我来给你一些选项。`,
        timestamp: Date.now(),
      }]);
    } finally {
      setLoading(false);
    }
  }, [currentStepIndex, projectId, finalizeCurrentStep, saveStepProgress]);

  // Retrieve persisted step result from session.stepData
  const getStepResultData = useCallback((stepKey: string): Record<string, unknown> | null => {
    const data = (session?.stepData as Record<string, unknown>) ?? {};
    const result = data[`${stepKey}_result`];
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
    return null;
  }, [session]);

  // Go to previous step — restore both chat and preview data
  const goToPrevStep = useCallback(() => {
    if (currentStepIndex <= 0) return;
    const prevIndex = currentStepIndex - 1;
    const prevKey = GUIDED_STEPS[prevIndex].key;
    setCurrentStepIndex(prevIndex);

    // Restore chat from session stepData if available
    const stepData = (session?.stepData as Record<string, unknown>) ?? {};
    const savedChat = stepData[`${prevKey}_chat`];
    if (Array.isArray(savedChat)) {
      setChatMessages(savedChat as ChatMessage[]);
    } else {
      setChatMessages([]);
    }
  }, [currentStepIndex, session]);

  // Detect [STEP_COMPLETE] marker and auto-finalize
  const handleStepComplete = useCallback(async (aiReply: string): Promise<string> => {
    const marker = '[STEP_COMPLETE]';
    const markerIndex = aiReply.indexOf(marker);
    if (markerIndex === -1) return aiReply; // No completion marker

    // Split: display text before marker, JSON after marker
    const displayText = aiReply.slice(0, markerIndex).trim();
    const jsonPart = aiReply.slice(markerIndex + marker.length).trim();

    // Try to parse the structured JSON
    const jsonMatch = jsonPart.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return displayText || aiReply;

    try {
      const structuredData = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const stepLabel = GUIDED_STEPS[currentStepIndex]?.label ?? '';

      // Persist to database
      const result = await apiFetch<{ written: string[] }>(
        `/projects/${projectId}/guided-session/finalize-step`,
        {
          method: 'POST',
          body: JSON.stringify({
            currentStep: currentStepKey,
            structuredData,
          }),
        },
      );

      // Append success message to display text
      const successMsg = `${displayText}\n\n✅ **${stepLabel}** 已自动保存！已写入：${result.written.join('、')}`;

      // Auto-advance to next step after a brief delay
      if (currentStepIndex < GUIDED_STEPS.length - 1) {
        setTimeout(() => {
          autoAdvanceToNextStep();
        }, 1500);
      }

      return successMsg;
    } catch {
      return displayText || aiReply;
    }
  }, [projectId, currentStepIndex, currentStepKey]);

  // Auto-advance without re-finalizing (used after [STEP_COMPLETE] detection or one-shot confirm)
  const autoAdvanceToNextStep = useCallback(async () => {
    if (currentStepIndex >= GUIDED_STEPS.length - 1) return;

    await saveStepProgress({});

    const nextIndex = currentStepIndex + 1;
    const nextStep = GUIDED_STEPS[nextIndex];
    setCurrentStepIndex(nextIndex);
    setChatMessages([]);
    setLoading(true);

    // Update server-side current step
    try {
      await apiFetch(`/projects/${projectId}/guided-session/step`, {
        method: 'PATCH',
        body: JSON.stringify({ currentStep: nextStep.key, stepData: {} }),
      });
    } catch {
      // Non-critical
    }

    // Fetch fresh session to get latest stepData (avoids stale closure)
    let freshStepData: Record<string, unknown> = {};
    try {
      const freshSession = await apiFetch<GuidedSession | null>(
        `/projects/${projectId}/guided-session`,
      );
      if (freshSession) {
        setSession(freshSession);
        freshStepData = (freshSession.stepData as Record<string, unknown>) ?? {};
      }
    } catch {
      // Fall through with empty context
    }

    try {
      const priorKeys = new Set(GUIDED_STEPS.slice(0, nextIndex).map((s) => s.key));
      const contextSummary = Object.entries(freshStepData)
        .filter(([key]) => {
          if (!key.endsWith('_result')) return false;
          // stepData 的 key 来自后端 JSON，需在运行时转回已知 guided step key 再做集合判断。
          return priorKeys.has(key.replace(/_result$/, '') as StepKey);
        })
        .map(([key, val]) => `${key}: ${JSON.stringify(val)}`)
        .join('\n');

      const response = await apiFetch<{ reply: string }>(
        `/projects/${projectId}/guided-session/chat`,
        {
          method: 'POST',
          body: JSON.stringify({
            currentStep: nextStep.key,
            userMessage: `我们进入「${nextStep.label}」步骤了。请根据我之前的设定，以选择题的方式引导我，给我具体选项让我选择或组合，也可以让我自由补充。`,
            chatHistory: [],
            projectContext: contextSummary || undefined,
          }),
        },
      );

      setChatMessages([{
        role: 'ai',
        content: response.reply,
        timestamp: Date.now(),
      }]);
    } catch {
      setChatMessages([{
        role: 'ai',
        content: `让我们进入 **${nextStep.label}** 步骤。请告诉我你的想法，或者我来给你一些选项。`,
        timestamp: Date.now(),
      }]);
    } finally {
      setLoading(false);
    }
  }, [currentStepIndex, projectId, saveStepProgress]);

  // Build project context summary from accumulated step data
  // Build project context from steps BEFORE the current one (not current or future)
  const buildProjectContext = useCallback((): string | undefined => {
    const stepData = (session?.stepData as Record<string, unknown>) ?? {};

    // Determine which step keys come before the current step
    const priorStepKeys = new Set(
      GUIDED_STEPS.slice(0, currentStepIndex).map((s) => s.key),
    );

    const contextParts = Object.entries(stepData)
      .filter(([key]) => {
        // Only include _result entries from prior steps
        // e.g. "guided_setup_result" → step key is "guided_setup"
        if (!key.endsWith('_result')) return false;
        // stepData 是弱类型 JSON，收窄为 StepKey 后才能与 priorStepKeys 安全比较。
        const stepKey = key.replace(/_result$/, '') as StepKey;
        return priorStepKeys.has(stepKey);
      })
      .map(([key, val]) => `${key}: ${JSON.stringify(val)}`)
      .join('\n');
    return contextParts || undefined;
  }, [session, currentStepIndex]);

  // Add a user message and get real AI response
  const sendMessage = useCallback(async (content: string) => {
    const userMsg: ChatMessage = { role: 'user', content, timestamp: Date.now() };
    setChatMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    try {
      // Send full chat history — server handles windowing + summarization
      const response = await apiFetch<{ reply: string }>(
        `/projects/${projectId}/guided-session/chat`,
        {
          method: 'POST',
          body: JSON.stringify({
            currentStep: currentStepKey,
            userMessage: content,
            chatHistory: chatMessages,
            projectContext: buildProjectContext(),
          }),
        },
      );

      // Check if AI decided to complete this step
      const displayContent = await handleStepComplete(response.reply);

      const aiMsg: ChatMessage = {
        role: 'ai',
        content: displayContent,
        timestamp: Date.now(),
      };
      setChatMessages((prev) => [...prev, aiMsg]);
    } catch (sendError) {
      const aiMsg: ChatMessage = {
        role: 'ai',
        content: `⚠️ AI 响应失败：${sendError instanceof Error ? sendError.message : '未知错误'}。请重试。`,
        timestamp: Date.now(),
      };
      setChatMessages((prev) => [...prev, aiMsg]);
    } finally {
      setLoading(false);
    }
  }, [projectId, currentStepKey, chatMessages, handleStepComplete, buildProjectContext]);

  // One-shot AI generation: generate all data for a step without Q&A
  // Accepts optional targetStepKey and volumeNo to support per-volume chapter generation
  const generateStepData = useCallback(async (userHint?: string, targetStepKey?: StepKey, volumeNo?: number): Promise<Record<string, unknown> | null> => {
    if (!projectId) return null;
    setLoading(true);
    setError('');

    const stepKey = targetStepKey ?? currentStepKey;
    const stepIndex = GUIDED_STEPS.findIndex((s) => s.key === stepKey);

    try {
      // Build a summary of the current step's conversation so the AI
      // respects decisions already made during Q&A (e.g., "10卷", "地图推进型")
      const chatSummary = chatMessages.length > 0
        ? chatMessages
            .map((m) => `[${m.role === 'user' ? '用户' : 'AI'}]: ${m.content}`)
            .join('\n')
        : undefined;

      const response = await apiFetch<{ structuredData: Record<string, unknown>; summary: string }>(
        `/projects/${projectId}/guided-session/generate-step`,
        {
          method: 'POST',
          body: JSON.stringify({
            currentStep: stepKey,
            userHint,
            projectContext: buildProjectContext(),
            chatSummary,
            ...(volumeNo !== undefined && { volumeNo }),
          }),
        },
      );

      // Show AI summary in chat
      const stepLabel = GUIDED_STEPS[stepIndex]?.label ?? '';
      const volumeLabel = volumeNo ? ` · 第${volumeNo}卷` : '';
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'ai',
          content: `⚡ **${stepLabel}${volumeLabel} · 一键生成完成**\n\n${response.summary}\n\n可在文档中查看并编辑，确认无误后点击「✅ 保存」按钮。`,
          timestamp: Date.now(),
        },
      ]);

      return response.structuredData;
    } catch (genError) {
      setError(genError instanceof Error ? genError.message : 'AI 生成失败');
      return null;
    } finally {
      setLoading(false);
    }
  }, [projectId, currentStepKey, chatMessages, buildProjectContext]);

  // Confirm and persist generated/edited data directly (skip AI extraction)
  // Accepts optional targetStepKey and volumeNo to support document-editing mode
  const confirmGeneratedData = useCallback(async (
    structuredData: Record<string, unknown>,
    targetStepKey?: StepKey,
    volumeNo?: number,
  ): Promise<boolean> => {
    if (!projectId) return false;
    setLoading(true);

    const stepKey = targetStepKey ?? currentStepKey;
    const stepIndex = GUIDED_STEPS.findIndex((s) => s.key === stepKey);
    const stepLabel = GUIDED_STEPS[stepIndex]?.label ?? '';

    try {
      const result = await apiFetch<{ written: string[] }>(
        `/projects/${projectId}/guided-session/finalize-step`,
        {
          method: 'POST',
          body: JSON.stringify({
            currentStep: stepKey,
            structuredData,
            ...(volumeNo !== undefined && { volumeNo }),
          }),
        },
      );

      const volumeLabel = volumeNo ? ` · 第${volumeNo}卷` : '';
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'ai',
          content: `✅ **${stepLabel}${volumeLabel}** 已保存！\n\n已写入：${result.written.join('、')}`,
          timestamp: Date.now(),
        },
      ]);

      // Reload session to update completedSteps
      await loadSession();

      return true;
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : '保存失败');
      return false;
    } finally {
      setLoading(false);
    }
  }, [projectId, currentStepKey, loadSession]);

  // Auto-load session on mount
  useEffect(() => {
    if (projectId) {
      loadSession();
    }
  }, [projectId, loadSession]);

  return {
    session,
    currentStepIndex,
    currentStepKey,
    chatMessages,
    loading,
    error,
    setError,
    startSession,
    saveStepProgress,
    finalizeCurrentStep,
    goToNextStep,
    goToPrevStep,
    sendMessage,
    generateStepData,
    confirmGeneratedData,
    autoAdvanceToNextStep,
    getStepResultData,
  };
}
