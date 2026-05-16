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

export type GuidedAiBackend = 'guided' | 'agent';

export type GuidedAgentPanelStatus = {
  state: 'idle' | 'planning' | 'waiting_approval' | 'failed';
  title?: string;
  summary?: string;
  taskType?: string;
};

export interface UseGuidedSessionOptions {
  aiBackend?: GuidedAiBackend;
}

type GuidedChatPayload = {
  currentStep: StepKey;
  userMessage: string;
  chatHistory: ChatMessage[];
  projectContext?: string;
  volumeNo?: number;
  chapterNo?: number;
};

type AgentPlanResponse = {
  agentRunId?: string;
  status?: string;
  plan?: {
    taskType?: string;
    summary?: string;
  } | null;
  artifacts?: AgentArtifactResponse[];
  steps?: AgentStepResponse[];
};

type AgentArtifactResponse = {
  artifactType?: string;
  title?: string | null;
  content?: unknown;
};

type AgentStepResponse = {
  tool?: string | null;
  toolName?: string | null;
  mode?: string | null;
  status?: string | null;
  output?: unknown;
};

type AgentRunDetailResponse = AgentPlanResponse & {
  id?: string;
  status?: string;
  output?: unknown;
  artifacts?: AgentArtifactResponse[];
  steps?: AgentStepResponse[];
  plans?: Array<{ taskType?: string; summary?: string; plan?: { taskType?: string; summary?: string } }>;
};

type GuidedStepPreviewResponse = {
  stepKey?: string;
  structuredData: Record<string, unknown>;
  summary?: string;
  warnings?: string[];
};

type PersistGuidedStepResultResponse = {
  stepKey?: string;
  written?: string[];
};

const AGENT_GUIDED_GENERATE_STEPS = new Set<StepKey>(['guided_setup', 'guided_style']);

const DEFAULT_GUIDED_AI_BACKEND: GuidedAiBackend =
  process.env.NEXT_PUBLIC_GUIDED_AI_BACKEND === 'agent' ? 'agent' : 'guided';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function extractGuidedStepPreview(value: unknown): GuidedStepPreviewResponse | null {
  const record = asRecord(value);
  const structuredData = record.structuredData;
  if (structuredData && typeof structuredData === 'object' && !Array.isArray(structuredData)) {
    return {
      stepKey: typeof record.stepKey === 'string' ? record.stepKey : undefined,
      structuredData: structuredData as Record<string, unknown>,
      summary: typeof record.summary === 'string' ? record.summary : undefined,
      warnings: Array.isArray(record.warnings) ? record.warnings.filter((item): item is string => typeof item === 'string') : undefined,
    };
  }

  const nestedOutput = record.output;
  if (nestedOutput) return extractGuidedStepPreview(nestedOutput);

  const nestedContent = record.content;
  if (nestedContent) return extractGuidedStepPreview(nestedContent);

  return null;
}

function findGuidedStepPreview(response?: AgentRunDetailResponse | AgentPlanResponse | null): GuidedStepPreviewResponse | null {
  if (!response) return null;

  const artifactPreview = response.artifacts
    ?.find((artifact) => artifact.artifactType === 'guided_step_preview')
    ?.content;
  const fromArtifact = extractGuidedStepPreview(artifactPreview);
  if (fromArtifact) return fromArtifact;

  const fromStep = response.steps
    ?.find((step) => step.status === 'succeeded' && step.mode === 'plan' && (step.toolName === 'generate_guided_step_preview' || step.tool === 'generate_guided_step_preview'))
    ?.output;
  return extractGuidedStepPreview(fromStep);
}

function extractPersistGuidedStepResult(value: unknown): PersistGuidedStepResultResponse | null {
  const record = asRecord(value);
  const written = record.written;
  if (Array.isArray(written)) {
    return {
      stepKey: typeof record.stepKey === 'string' ? record.stepKey : undefined,
      written: written.filter((item): item is string => typeof item === 'string'),
    };
  }

  const nestedOutput = record.output;
  if (nestedOutput) return extractPersistGuidedStepResult(nestedOutput);

  const nestedContent = record.content;
  if (nestedContent) return extractPersistGuidedStepResult(nestedContent);

  return null;
}

function findPersistGuidedStepResult(response?: AgentRunDetailResponse | null): PersistGuidedStepResultResponse | null {
  if (!response) return null;

  const fromStep = response.steps
    ?.find((step) => step.status === 'succeeded' && (step.toolName === 'persist_guided_step_result' || step.tool === 'persist_guided_step_result'))
    ?.output;
  const stepResult = extractPersistGuidedStepResult(fromStep);
  if (stepResult) return stepResult;

  const outputs = asRecord(asRecord(response.output).outputs);
  for (const value of Object.values(outputs)) {
    const outputResult = extractPersistGuidedStepResult(value);
    if (outputResult) return outputResult;
  }

  return null;
}

function createGuidedAgentRequestId(projectId: string, stepKey: string, message: string) {
  const normalizedMessage = message.trim().slice(0, 120);
  const hash = Array.from(normalizedMessage)
    .reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 0)
    .toString(36);
  return `guided_agent_${projectId}_${stepKey}_${Date.now().toString(36)}_${hash}`;
}

export function useGuidedSession(projectId: string, options?: UseGuidedSessionOptions) {
  const [session, setSession] = useState<GuidedSession | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [agentStatus, setAgentStatus] = useState<GuidedAgentPanelStatus>({ state: 'idle' });

  const aiBackend = options?.aiBackend ?? DEFAULT_GUIDED_AI_BACKEND;
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

  // Finalize current step: ask AI for structured JSON, then keep it as a guided draft.
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
{"volumes":[{"volumeNo":1,"title":"卷名","synopsis":"Markdown结构：含全书主线阶段/本卷主线/本卷戏剧问题/卷内支线/单元故事/卷末交接","objective":"本卷核心目标","narrativePlan":{"globalMainlineStage":"全书主线阶段","volumeMainline":"本卷主线","dramaticQuestion":"本卷戏剧问题","startState":"开局状态","endState":"结尾状态","mainlineMilestones":["关键节点"],"subStoryLines":[{"name":"支线名","type":"mystery","function":"叙事作用","startState":"起点","progress":"推进方式","endState":"阶段结果","relatedCharacters":["角色名"],"chapterNodes":[1]}],"storyUnits":[{"unitId":"v1_unit_01","title":"单元故事名","chapterRange":{"start":1,"end":4},"localGoal":"单元局部目标","localConflict":"单元核心阻力","serviceFunctions":["mainline","relationship_shift","foreshadow"],"payoff":"单元阶段结局","stateChangeAfterUnit":"单元结束后的状态变化"}],"foreshadowPlan":["伏笔分配"],"endingHook":"卷末钩子","handoffToNextVolume":"卷末交接"}}]}`,

      guided_chapter: `根据我们的对话，请输出「章节细纲」的结构化 JSON（只输出JSON）：
{"chapters":[{"chapterNo":1,"volumeNo":1,"title":"章节标题","objective":"本章目标","conflict":"核心冲突","outline":"含主线任务/支线任务/单元故事/具体场景行动/阶段结果的章节大纲","craftBrief":{"visibleGoal":"表层目标","hiddenEmotion":"隐藏情绪","coreConflict":"核心冲突","mainlineTask":"本章主线任务","subplotTasks":["支线任务"],"storyUnit":{"unitId":"v1_unit_01","title":"单元故事名","chapterRange":{"start":1,"end":4},"chapterRole":"开局/升级/反转/收束","localGoal":"单元局部目标","localConflict":"单元核心阻力","serviceFunctions":["mainline","relationship_shift","foreshadow"],"mainlineContribution":"本章如何推进主线","characterContribution":"本章如何塑造人物","relationshipContribution":"本章如何改变关系","worldOrThemeContribution":"本章如何展开世界或主题","unitPayoff":"单元阶段结局","stateChangeAfterUnit":"单元结束后的状态变化"},"actionBeats":["行动链节点"],"concreteClues":[{"name":"物证或线索","sensoryDetail":"感官细节","laterUse":"后续用途"}],"dialogueSubtext":"对话潜台词","characterShift":"人物变化","irreversibleConsequence":"不可逆后果","progressTypes":["info"]}}]}`,

      guided_foreshadow: `根据我们的对话，请输出「伏笔设计」的结构化 JSON（只输出JSON）：
{"foreshadowTracks":[{"title":"伏笔标题","detail":"伏笔内容详细描述(50字以上)","scope":"book/cross_volume/volume/cross_chapter/chapter","technique":"道具型/对话型/行为型/环境型/叙事型/象征型/结构型","plantChapter":"埋设时机(如:第1卷第3章)","revealChapter":"揭开时机(如:第3卷第8章)","involvedCharacters":"涉及角色","payoff":"揭开后的影响和情感冲击"}]}`,
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

      await saveStepProgress({
        [`${currentStepKey}_draft`]: structuredData,
      });

      // Show success in chat
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'ai',
          content: `**${stepLabel}** 结构化草稿已生成。正式写入必须点击确认保存，并通过 Agent 校验与审批。`,
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
  }, [projectId, currentStepIndex, currentStepKey, chatMessages, saveStepProgress]);

  // Navigate to next step — finalize current step first, then ask AI for new step opening
  const goToNextStep = useCallback(async () => {
    if (currentStepIndex >= GUIDED_STEPS.length - 1) return;

    // Finalize current step: extract structured data into a draft only.
    const finalized = await finalizeCurrentStep();
    if (!finalized) return; // Don't advance if finalization failed

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

  // Detect [STEP_COMPLETE] marker and keep the structured result as a draft.
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

      await saveStepProgress({
        [`${currentStepKey}_draft`]: structuredData,
      });

      // Append draft notice to display text. Formal writes must use Agent approval.
      const successMsg = `${displayText}\n\n**${stepLabel}** 结构化草稿已生成。正式写入必须点击确认保存，并通过 Agent 校验与审批。`;

      return successMsg;
    } catch {
      return displayText || aiReply;
    }
  }, [currentStepIndex, currentStepKey, saveStepProgress]);

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
  const buildProjectContext = useCallback((targetStepKey?: StepKey): string | undefined => {
    const stepData = (session?.stepData as Record<string, unknown>) ?? {};
    const effectiveStepIndex = targetStepKey
      ? GUIDED_STEPS.findIndex((step) => step.key === targetStepKey)
      : currentStepIndex;

    // Determine which step keys come before the current step
    const priorStepKeys = new Set(
      GUIDED_STEPS.slice(0, Math.max(0, effectiveStepIndex)).map((s) => s.key),
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

  const buildGuidedAgentContext = useCallback((targetStepKey?: StepKey) => {
    const stepData = (session?.stepData as Record<string, unknown>) ?? {};
    const effectiveStepKey = targetStepKey ?? currentStepKey;
    const completedSteps = GUIDED_STEPS
      .filter((step) => {
        const result = stepData[`${step.key}_result`];
        return Boolean(result && typeof result === 'object' && !Array.isArray(result) && Object.keys(result as Record<string, unknown>).length > 0);
      })
      .map((step) => step.key);
    const currentStepLabel = GUIDED_STEPS.find((step) => step.key === effectiveStepKey)?.label;
    const currentStepData = stepData[`${effectiveStepKey}_result`];

    return {
      currentProjectId: projectId,
      sourcePage: 'guided_wizard',
      guided: {
        currentStep: effectiveStepKey,
        currentStepLabel,
        currentStepData: currentStepData && typeof currentStepData === 'object' && !Array.isArray(currentStepData)
          ? currentStepData as Record<string, unknown>
          : {},
        completedSteps,
        documentDraft: stepData,
      },
    };
  }, [currentStepKey, projectId, session]);

  const sendGuidedChat = useCallback(async (payload: GuidedChatPayload): Promise<{ reply: string }> => {
    if (aiBackend === 'agent') {
      setAgentStatus({
        state: 'planning',
        title: '正在生成 Agent 计划/预览',
        summary: 'Agent 正在结合当前引导步骤和项目上下文生成只读咨询计划。',
      });
      const agentGoal = [
        payload.userMessage,
        '系统意图：这是创作引导页右侧 AI 助手的当前步骤问答，请按 guided_step_consultation 生成只读咨询计划，不要写入业务表。',
      ].join('\n\n');
      const response = await apiFetch<AgentPlanResponse>('/agent-runs/plan', {
        method: 'POST',
        body: JSON.stringify({
          projectId,
          message: agentGoal,
          context: buildGuidedAgentContext(),
          clientRequestId: createGuidedAgentRequestId(projectId, payload.currentStep, payload.userMessage),
        }),
      });
      const summary = response.plan?.summary?.trim();
      const taskType = response.plan?.taskType;
      setAgentStatus({
        state: 'waiting_approval',
        title: 'Agent 计划已生成',
        summary: summary || '可在右下角 Agent 工作台查看计划、预览和后续审批。',
        taskType,
      });
      return {
        reply: [
          `已创建 Agent 当前步骤咨询计划${taskType ? `（${taskType}）` : ''}。`,
          summary ? `\n\n${summary}` : '',
          response.agentRunId ? '\n\n可在右下角 Agent 工作台查看计划与后续审批。' : '',
        ].filter(Boolean).join(''),
      };
    }

    setAgentStatus({ state: 'idle' });
    return apiFetch<{ reply: string }>(
      `/projects/${projectId}/guided-session/chat`,
      {
        method: 'POST',
        body: JSON.stringify({
          currentStep: payload.currentStep,
          userMessage: payload.userMessage,
          chatHistory: payload.chatHistory,
          projectContext: payload.projectContext,
          ...(payload.volumeNo !== undefined && { volumeNo: payload.volumeNo }),
          ...(payload.chapterNo !== undefined && { chapterNo: payload.chapterNo }),
        }),
      },
    );
  }, [aiBackend, buildGuidedAgentContext, projectId]);

  // Add a user message and get real AI response
  const sendMessage = useCallback(async (content: string) => {
    const userMsg: ChatMessage = { role: 'user', content, timestamp: Date.now() };
    setChatMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    try {
      // Send full chat history — selected backend handles windowing, planning or summarization.
      const response = await sendGuidedChat({
        currentStep: currentStepKey,
        userMessage: content,
        chatHistory: chatMessages,
        projectContext: buildProjectContext(),
      });

      // Check if AI decided to complete this step
      const displayContent = await handleStepComplete(response.reply);

      const aiMsg: ChatMessage = {
        role: 'ai',
        content: displayContent,
        timestamp: Date.now(),
      };
      setChatMessages((prev) => [...prev, aiMsg]);
    } catch (sendError) {
      if (aiBackend === 'agent') {
        setAgentStatus({
          state: 'failed',
          title: 'Agent 计划生成失败',
          summary: sendError instanceof Error ? sendError.message : '未知错误，请稍后重试。',
        });
      }
      const aiMsg: ChatMessage = {
        role: 'ai',
        content: `⚠️ AI 响应失败：${sendError instanceof Error ? sendError.message : '未知错误'}。请重试。`,
        timestamp: Date.now(),
      };
      setChatMessages((prev) => [...prev, aiMsg]);
    } finally {
      setLoading(false);
    }
  }, [currentStepKey, chatMessages, handleStepComplete, buildProjectContext, sendGuidedChat]);

  // One-shot AI generation: generate all data for a step without Q&A
  // Accepts optional targetStepKey, volumeNo and chapterNo to support per-volume
  // generation and single-chapter refinement.
  const generateStepData = useCallback(async (
    userHint?: string,
    targetStepKey?: StepKey,
    volumeNo?: number,
    chapterNo?: number,
  ): Promise<Record<string, unknown> | null> => {
    if (!projectId) return null;
    setLoading(true);
    setError('');

    const stepKey = targetStepKey ?? currentStepKey;
    const stepIndex = GUIDED_STEPS.findIndex((s) => s.key === stepKey);
    const stepLabel = GUIDED_STEPS[stepIndex]?.label ?? '';
    const shouldUseAgentGenerate = aiBackend === 'agent' && AGENT_GUIDED_GENERATE_STEPS.has(stepKey);

    try {
      // Build a summary of the current step's conversation so the AI
      // respects decisions already made during Q&A (e.g., "10卷", "地图推进型")
      const chatSummary = chatMessages.length > 0
        ? chatMessages
            .map((m) => `[${m.role === 'user' ? '用户' : 'AI'}]: ${m.content}`)
            .join('\n')
        : undefined;

      if (shouldUseAgentGenerate) {
        const volumeLabel = volumeNo ? ` · 第${volumeNo}卷` : '';
        const chapterLabel = chapterNo ? ` · 第${chapterNo}章` : '';
        setAgentStatus({
          state: 'planning',
          title: '正在生成 Agent 步骤预览',
          summary: `Agent 正在为「${stepLabel}${volumeLabel}${chapterLabel}」创建只读结构化预览。`,
          taskType: 'guided_step_generate',
        });

        const agentGoal = [
          `请为创作引导「${stepLabel}」生成结构化预览。`,
          userHint ? `用户提示：${userHint}` : '',
          chatSummary ? `当前对话摘要：\n${chatSummary}` : '',
          volumeNo ? `卷号：${volumeNo}` : '',
          chapterNo ? `章节号：${chapterNo}` : '',
          '系统意图：这是创作引导页的 AI 生成按钮，请使用 guided_step_generate taskType，在 Plan 阶段调用 generate_guided_step_preview 生成 guided_step_preview 预览；不要写入业务表。',
        ].filter(Boolean).join('\n\n');

        const planResponse = await apiFetch<AgentPlanResponse>('/agent-runs/plan', {
          method: 'POST',
          body: JSON.stringify({
            projectId,
            message: agentGoal,
            context: buildGuidedAgentContext(stepKey),
            clientRequestId: createGuidedAgentRequestId(projectId, stepKey, agentGoal),
          }),
        });
        const agentRunId = planResponse.agentRunId;
        const runDetail = agentRunId
          ? await apiFetch<AgentRunDetailResponse>(`/agent-runs/${agentRunId}`)
          : null;
        const preview = findGuidedStepPreview(planResponse) ?? findGuidedStepPreview(runDetail);
        if (!preview) {
          throw new Error('Agent 已创建计划，但没有返回 guided_step_preview 结构化预览。请到 Agent 工作台查看计划详情后重试。');
        }

        const planSummary = planResponse.plan?.summary
          ?? runDetail?.plans?.[0]?.plan?.summary
          ?? runDetail?.plans?.[0]?.summary;
        const summary = preview.summary ?? planSummary ?? 'Agent 已生成结构化步骤预览。';
        setAgentStatus({
          state: 'waiting_approval',
          title: 'Agent 预览已生成',
          summary,
          taskType: planResponse.plan?.taskType ?? runDetail?.plans?.[0]?.taskType ?? 'guided_step_generate',
        });
        setChatMessages((prev) => [
          ...prev,
          {
            role: 'ai',
            content: `⚡ **${stepLabel}${volumeLabel}${chapterLabel} · Agent 预览已生成**\n\n${summary}\n\n可在文档中查看并编辑；当前只是 Plan 预览，尚未写入业务表。`,
            timestamp: Date.now(),
          },
        ]);

        return preview.structuredData;
      }

      const response = await apiFetch<{ structuredData: Record<string, unknown>; summary: string }>(
        `/projects/${projectId}/guided-session/generate-step`,
        {
          method: 'POST',
          body: JSON.stringify({
            currentStep: stepKey,
            userHint,
            projectContext: buildProjectContext(stepKey),
            chatSummary,
            ...(volumeNo !== undefined && { volumeNo }),
            ...(chapterNo !== undefined && { chapterNo }),
          }),
        },
      );

      // Show AI summary in chat
      const volumeLabel = volumeNo ? ` · 第${volumeNo}卷` : '';
      const chapterLabel = chapterNo ? ` · 第${chapterNo}章` : '';
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'ai',
          content: `⚡ **${stepLabel}${volumeLabel}${chapterLabel} · 一键生成完成**\n\n${response.summary}\n\n可在文档中查看并编辑，确认无误后点击「✅ 保存」按钮。`,
          timestamp: Date.now(),
        },
      ]);

      return response.structuredData;
    } catch (genError) {
      if (shouldUseAgentGenerate) {
        setAgentStatus({
          state: 'failed',
          title: 'Agent 预览生成失败',
          summary: genError instanceof Error ? genError.message : '未知错误，请稍后重试。',
          taskType: 'guided_step_generate',
        });
      }
      setError(genError instanceof Error ? genError.message : 'AI 生成失败');
      return null;
    } finally {
      setLoading(false);
    }
  }, [projectId, currentStepKey, chatMessages, aiBackend, buildProjectContext, buildGuidedAgentContext]);

  // Confirm and persist generated/edited data directly (skip AI extraction)
  // Accepts optional targetStepKey and volumeNo to support document-editing mode
  const confirmGeneratedData = useCallback(async (
    structuredData: Record<string, unknown>,
    targetStepKey?: StepKey,
    volumeNo?: number,
    options?: { silent?: boolean },
  ): Promise<boolean> => {
    if (!projectId) return false;
    if (!options?.silent) setLoading(true);

    const stepKey = targetStepKey ?? currentStepKey;
    const stepIndex = GUIDED_STEPS.findIndex((s) => s.key === stepKey);
    const stepLabel = GUIDED_STEPS[stepIndex]?.label ?? '';

    try {
      const volumeLabel = volumeNo ? ` · 第${volumeNo}卷` : '';
      if (!options?.silent) {
        setAgentStatus({
          state: 'planning',
          title: '正在创建 Agent 保存计划',
          summary: `Agent 正在为「${stepLabel}${volumeLabel}」准备校验和审批后写入。`,
          taskType: 'guided_step_finalize',
        });
      }

      const baseContext = buildGuidedAgentContext(stepKey);
      const documentDraft = asRecord(baseContext.guided.documentDraft);
      const agentGoal = [
        `请保存创作引导「${stepLabel}」的结构化结果。`,
        volumeNo ? `目标卷号：${volumeNo}` : '',
        '系统意图：这是创作引导页用户点击确认保存后的写入流程，必须使用 guided_step_finalize taskType。',
        '计划必须先调用 validate_guided_step_preview，再在 Act 阶段调用 persist_guided_step_result；persist_guided_step_result 需要用户审批且只能在 Act 阶段执行。',
        `工具参数要求：stepKey 必须是 "${stepKey}"；structuredData 必须引用 "{{context.session.guided.currentStepData}}"，不要改写或重新生成；validation 必须引用 validate 步骤输出。`,
        volumeNo !== undefined ? `两个工具都必须携带 volumeNo: ${volumeNo}。` : '如果没有目标卷号，不要臆造 volumeNo。',
        '不要调用旧 guided-session/finalize-step；不要重新生成预览；不要写入计划外数据。',
      ].filter(Boolean).join('\n\n');

      const planResponse = await apiFetch<AgentPlanResponse>('/agent-runs/plan', {
        method: 'POST',
        body: JSON.stringify({
          projectId,
          message: agentGoal,
          context: {
            ...baseContext,
            guided: {
              ...baseContext.guided,
              currentStep: stepKey,
              currentStepLabel: stepLabel,
              currentStepData: structuredData,
              documentDraft: { ...documentDraft, [`${stepKey}_result`]: structuredData },
            },
          },
          clientRequestId: createGuidedAgentRequestId(projectId, stepKey, agentGoal),
        }),
      });
      const agentRunId = planResponse.agentRunId;
      if (!agentRunId) throw new Error('Agent 保存计划已创建，但响应中缺少 AgentRun ID。');

      if (!options?.silent) {
        setAgentStatus({
          state: 'planning',
          title: 'Agent 正在执行保存',
          summary: '用户已确认保存，Agent 正在执行校验和审批后写入。',
          taskType: planResponse.plan?.taskType ?? 'guided_step_finalize',
        });
      }

      const actResponse = await apiFetch<AgentRunDetailResponse>(`/agent-runs/${agentRunId}/act`, {
        method: 'POST',
        body: JSON.stringify({
          approval: true,
          confirmation: { confirmHighRisk: true },
          comment: '用户在创作引导页确认保存结构化步骤数据',
        }),
      });
      const runDetail = await apiFetch<AgentRunDetailResponse>(`/agent-runs/${agentRunId}`);
      const finalRun = runDetail ?? actResponse;
      if (finalRun.status && finalRun.status !== 'succeeded') {
        throw new Error(`Agent 保存未完成，当前状态：${finalRun.status}`);
      }

      const persistResult = findPersistGuidedStepResult(finalRun) ?? findPersistGuidedStepResult(actResponse);
      const written = persistResult?.written ?? [];

      if (!options?.silent) {
        setChatMessages((prev) => [
          ...prev,
          {
            role: 'ai',
            content: `✅ **${stepLabel}${volumeLabel}** 已通过 Agent 保存！\n\n已写入：${written.length ? written.join('、') : 'Agent 已完成审批后写入'}`,
            timestamp: Date.now(),
          },
        ]);
        setAgentStatus({
          state: 'waiting_approval',
          title: 'Agent 保存已完成',
          summary: planResponse.plan?.summary ?? '校验和审批后写入已执行完成，可在 Agent 工作台查看完整记录。',
          taskType: planResponse.plan?.taskType ?? 'guided_step_finalize',
        });
      }

      // Reload session to update completedSteps
      if (!options?.silent) await loadSession();

      return true;
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : '保存失败');
      return false;
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, [projectId, currentStepKey, buildGuidedAgentContext, loadSession]);

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
    agentStatus,
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
