import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentCreativeDocumentAttachment } from '../types/agent-attachment';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3001/api';

export type AgentRunStatus = 'planning' | 'waiting_approval' | 'acting' | 'running' | 'waiting_review' | 'succeeded' | 'failed' | 'cancelled';

export interface AgentPlanStep {
  stepNo: number;
  name?: string;
  tool?: string;
  mode?: string;
  requiresApproval?: boolean;
  args?: unknown;
}

export interface AgentPlanPayload {
  schemaVersion?: number;
  understanding?: string;
  userGoal?: string;
  confidence?: number;
  summary?: string;
  assumptions?: string[];
  missingInfo?: Array<{ field?: string; reason?: string; canResolveByTool?: boolean; resolverTool?: string }>;
  requiredContext?: Array<{ name?: string; reason?: string; source?: string }>;
  risks?: string[];
  steps?: AgentPlanStep[];
  requiredApprovals?: Array<{ approvalType?: string; target?: { stepNos?: number[]; tools?: string[] } }>;
  riskReview?: { riskLevel?: 'low' | 'medium' | 'high'; reasons?: string[]; requiresApproval?: boolean; approvalMessage?: string };
  userVisiblePlan?: { summary?: string; bullets?: string[]; hiddenTechnicalSteps?: boolean };
}

export interface AgentRunStepRecord {
  id: string;
  planVersion?: number;
  stepNo: number;
  name?: string;
  tool?: string;
  toolName?: string;
  mode?: string;
  status?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  phase?: string | null;
  phaseMessage?: string | null;
  progressCurrent?: number | null;
  progressTotal?: number | null;
  startedAt?: string;
  heartbeatAt?: string;
  timeoutAt?: string | null;
  deadlineAt?: string | null;
  errorCode?: string | null;
  errorDetail?: unknown;
  finishedAt?: string;
  metadata?: {
    executionCost?: {
      model?: string;
      models?: string[];
      elapsedMs?: number;
      llmCallCount?: number;
      tokenUsage?: unknown;
      llmCalls?: Array<{ model?: string; appStep?: string; elapsedMs?: number }>;
    };
  };
}

export interface AgentRunArtifact {
  id: string;
  artifactType?: string;
  title?: string;
  content?: unknown;
  status?: string;
  sourceStepNo?: number;
  createdAt?: string;
}

export interface AgentObservationPayload {
  stepId?: string;
  stepNo: number;
  tool: string;
  mode: 'plan' | 'act';
  args?: unknown;
  error: {
    code?: string;
    message?: string;
    missing?: string[];
    candidates?: unknown[];
    retryable?: boolean;
  };
  previousOutputs?: Record<string, unknown>;
}

export interface ReplanClarificationChoice {
  id?: string;
  label?: string;
  payload?: unknown;
}

export interface AgentRunReplanOptions {
  worldbuildingSelection?: { selectedTitles: string[] };
  importTargetRegeneration?: { assetType: AgentImportAssetType };
}

export interface ReplanPatchPayload {
  action?: 'patch_plan' | 'ask_user' | 'fail_with_reason';
  reason?: string;
  questionForUser?: string;
  choices?: ReplanClarificationChoice[];
  insertStepsBeforeFailedStep?: Array<{ id?: string; name?: string; tool?: string; stepNo?: number }>;
  replaceFailedStepArgs?: Record<string, unknown>;
}

export interface AgentObservationArtifactContent {
  observation?: AgentObservationPayload;
  replanPatch?: ReplanPatchPayload;
}

export interface AgentClarificationHistoryEntry {
  roundNo?: number;
  question?: string;
  choices?: ReplanClarificationChoice[];
  selectedChoice?: ReplanClarificationChoice;
  message?: string;
  answeredAt?: string;
}

export interface AgentAuditEvent {
  id: string;
  eventType: string;
  title: string;
  severity?: 'info' | 'ok' | 'warn' | 'danger';
  timestamp?: string;
  status?: string;
  mode?: string;
  planVersion?: number;
  stepNo?: number;
  toolName?: string;
  detail?: unknown;
}

export interface AgentRun {
  id: string;
  projectId: string;
  chapterId?: string | null;
  agentType?: string;
  taskType?: string;
  status: AgentRunStatus;
  mode?: string;
  goal: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  currentStepNo?: number | null;
  currentTool?: string | null;
  currentPhase?: string | null;
  heartbeatAt?: string | null;
  leaseExpiresAt?: string | null;
  deadlineAt?: string | null;
  plans?: AgentPlanRecord[];
  steps?: AgentRunStepRecord[];
  artifacts?: AgentRunArtifact[];
  createdAt?: string;
  updatedAt?: string;
}

export interface AgentPlanRecord extends AgentPlanPayload {
  id: string;
  version?: number;
  status?: string;
  taskType?: string;
  createdAt?: string;
  plan?: AgentPlanPayload;
}

export interface AgentRunListItem extends Omit<AgentRun, 'steps' | 'artifacts' | 'approvals'> {}

export interface AgentMessageIntentResult {
  intent: 'approve_current_plan' | 'new_task' | 'revise_plan' | 'cancel_or_wait' | 'unclear';
  shouldExecute: boolean;
  confidence?: number;
  reason?: string;
  model?: string;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `请求失败: ${response.status}`);
  }

  return (await response.json()) as T;
}

/**
 * 为创建计划生成前端幂等键。键中包含项目、章节和消息摘要。
 * 具体复用由 useAgentRun 内的 Map 控制，避免每次重试都因 Date.now 生成新键。
 */
export interface GuidedAgentPageContext {
  currentStep?: string;
  currentStepLabel?: string;
  currentStepData?: Record<string, unknown>;
  completedSteps?: string[];
  documentDraft?: Record<string, unknown>;
}

export type AgentImportAssetType = 'projectProfile' | 'outline' | 'characters' | 'worldbuilding' | 'writingRules';
export type AgentImportPreviewMode = 'auto' | 'quick' | 'deep';

const IMPORT_ASSET_TYPES = new Set<AgentImportAssetType>(['projectProfile', 'outline', 'characters', 'worldbuilding', 'writingRules']);
const IMPORT_PREVIEW_MODES = new Set<AgentImportPreviewMode>(['auto', 'quick', 'deep']);
const POLLING_INTERVAL_MS = 1500;
const POLLING_STOP_STATUSES = new Set<AgentRunStatus>(['succeeded', 'failed', 'cancelled', 'waiting_approval', 'waiting_review']);

export interface AgentPageContext {
  currentProjectId?: string;
  currentChapterId?: string;
  currentChapterTitle?: string;
  currentChapterIndex?: number;
  currentDraftId?: string;
  currentDraftVersion?: number;
  selectedText?: string;
  selectedRange?: { start: number; end: number };
  sourcePage?: string;
  requestedAssetTypes?: AgentImportAssetType[];
  importPreviewMode?: AgentImportPreviewMode;
  guided?: GuidedAgentPageContext;
  [key: string]: unknown;
}

function hashRequestPart(value: string) {
  return Array.from(value).reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 0).toString(36);
}

function createAttachmentRequestFingerprint(attachments?: AgentCreativeDocumentAttachment[]) {
  if (!attachments?.length) return 'no-attachments';
  return attachments
    .map((attachment) => attachment.id || attachment.url)
    .filter(Boolean)
    .join('|');
}

function createRequestedAssetTypesFingerprint(requestedAssetTypes?: AgentImportAssetType[]) {
  return requestedAssetTypes?.length ? requestedAssetTypes.join('|') : 'infer-targets';
}

function createImportPreviewModeFingerprint(importPreviewMode?: AgentImportPreviewMode) {
  return importPreviewMode ?? 'default-mode';
}

function normalizeRequestedAssetTypes(value?: AgentImportAssetType[]) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is AgentImportAssetType => IMPORT_ASSET_TYPES.has(item)))];
}

function normalizeImportPreviewMode(value: unknown): AgentImportPreviewMode | undefined {
  return typeof value === 'string' && IMPORT_PREVIEW_MODES.has(value as AgentImportPreviewMode) ? value as AgentImportPreviewMode : undefined;
}

function createClientRequestId(projectId: string, message: string, currentChapterId?: string, attachments?: AgentCreativeDocumentAttachment[], requestedAssetTypes?: AgentImportAssetType[], importPreviewMode?: AgentImportPreviewMode) {
  const normalizedMessage = message.trim().slice(0, 120);
  const hash = hashRequestPart(`${normalizedMessage}:${createAttachmentRequestFingerprint(attachments)}:${createRequestedAssetTypesFingerprint(requestedAssetTypes)}:${createImportPreviewModeFingerprint(importPreviewMode)}`);
  return `agent_${projectId}_${currentChapterId ?? 'project'}_${Date.now().toString(36)}_${hash}`;
}

function createPlanRequestFingerprint(projectId: string, message: string, currentChapterId?: string, attachments?: AgentCreativeDocumentAttachment[], requestedAssetTypes?: AgentImportAssetType[], importPreviewMode?: AgentImportPreviewMode) {
  return `${projectId}:${currentChapterId ?? 'project'}:${message.trim()}:${createAttachmentRequestFingerprint(attachments)}:${createRequestedAssetTypesFingerprint(requestedAssetTypes)}:${createImportPreviewModeFingerprint(importPreviewMode)}`;
}

/**
 * 管理 AgentRun 的 Plan → Approval → Act 请求状态。
 * Hook 只保存当前会话的 AgentRun，正式执行状态仍以后端 AgentStep/Artifact 为准。
 */
export function useAgentRun() {
  const [currentRun, setCurrentRun] = useState<AgentRun | null>(null);
  const [runHistory, setRunHistory] = useState<AgentRunListItem[]>([]);
  const [auditEvents, setAuditEvents] = useState<AgentAuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const createPlanRequestIdsRef = useRef(new Map<string, string>());
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (!pollingRef.current) return;
    clearInterval(pollingRef.current);
    pollingRef.current = null;
  }, []);

  const listByProject = useCallback(async (projectId: string) => {
    setLoading(true);
    setError('');
    try {
      const runs = await apiFetch<AgentRunListItem[]>(`/projects/${projectId}/agent-runs`);
      setRunHistory(runs);
      return runs;
    } catch (listError) {
      const messageText = listError instanceof Error ? listError.message : '加载 AgentRun 历史失败';
      setError(messageText);
      throw listError;
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAudit = useCallback(async (agentRunId: string) => {
    const events = await apiFetch<AgentAuditEvent[]>(`/agent-runs/${agentRunId}/audit`);
    setAuditEvents(events);
    return events;
  }, []);

  const startPolling = useCallback((agentRunId: string) => {
    stopPolling();
    const tick = async () => {
      try {
        const run = await apiFetch<AgentRun>(`/agent-runs/${agentRunId}`);
        setCurrentRun(run);
        if (POLLING_STOP_STATUSES.has(run.status)) {
          stopPolling();
          await loadAudit(agentRunId);
        }
      } catch (pollError) {
        setError(pollError instanceof Error ? pollError.message : '轮询 AgentRun 失败');
        stopPolling();
      }
    };
    void tick();
    pollingRef.current = setInterval(() => void tick(), POLLING_INTERVAL_MS);
  }, [loadAudit, stopPolling]);

  useEffect(() => stopPolling, [stopPolling]);

  const createPlan = useCallback(async (projectId: string, message: string, pageContextOrChapterId?: string | AgentPageContext, attachments?: AgentCreativeDocumentAttachment[]) => {
    setLoading(true);
    setError('');
    setActionMessage('正在生成 Agent 执行计划…');
    const pageContext: AgentPageContext = typeof pageContextOrChapterId === 'string' ? { currentChapterId: pageContextOrChapterId } : (pageContextOrChapterId ?? {});
    const currentChapterId = pageContext.currentChapterId;
    const planAttachments = attachments?.length ? attachments : undefined;
    const { requestedAssetTypes: rawRequestedAssetTypes, importPreviewMode: rawImportPreviewMode, ...restPageContext } = pageContext;
    const requestedAssetTypes = normalizeRequestedAssetTypes(rawRequestedAssetTypes);
    const importPreviewMode = normalizeImportPreviewMode(rawImportPreviewMode);
    const fingerprint = createPlanRequestFingerprint(projectId, message, currentChapterId, planAttachments, requestedAssetTypes, importPreviewMode);
    let clientRequestId = createPlanRequestIdsRef.current.get(fingerprint);
    if (!clientRequestId) {
      clientRequestId = createClientRequestId(projectId, message, currentChapterId, planAttachments, requestedAssetTypes, importPreviewMode);
      createPlanRequestIdsRef.current.set(fingerprint, clientRequestId);
    }
    try {
      const run = await apiFetch<AgentRun & { agentRunId?: string }>('/agent-runs/plan', {
        method: 'POST',
        body: JSON.stringify({
          projectId,
          message,
          context: {
            currentProjectId: projectId,
            sourcePage: 'agent_workspace',
            ...restPageContext,
            ...(requestedAssetTypes.length ? { requestedAssetTypes } : {}),
            ...(importPreviewMode ? { importPreviewMode } : {}),
          },
          attachments: planAttachments,
          clientRequestId,
        }),
      });
      // 后端已成功返回 Run 后释放指纹，用户再次提交相同文本应创建新的创作任务。
      createPlanRequestIdsRef.current.delete(fingerprint);
      const agentRunId = run.id ?? (run as AgentRun & { agentRunId?: string }).agentRunId;
      // /plan 为轻量响应；成功后再读取完整 Run，确保前端 Plan/Step/Artifact 视图使用同一数据结构。
      const fullRun = agentRunId ? await apiFetch<AgentRun>(`/agent-runs/${agentRunId}`) : run;
      setCurrentRun(fullRun);
      if (agentRunId) await loadAudit(agentRunId);
      if (agentRunId && !POLLING_STOP_STATUSES.has(fullRun.status)) startPolling(agentRunId);
      await listByProject(projectId);
      setActionMessage(POLLING_STOP_STATUSES.has(fullRun.status) ? '计划已生成，请检查风险和步骤后确认执行。' : '已开始规划，正在轮询执行进度。');
      return fullRun;
    } catch (planError) {
      const messageText = planError instanceof Error ? planError.message : '生成计划失败';
      setError(messageText);
      setActionMessage(messageText);
      throw planError;
    } finally {
      setLoading(false);
    }
  }, [listByProject, loadAudit, startPolling]);

  const refresh = useCallback(async (agentRunId: string, options?: { silent?: boolean; skipAudit?: boolean }) => {
    if (!options?.silent) setLoading(true);
    setError('');
    try {
      const run = await apiFetch<AgentRun>(`/agent-runs/${agentRunId}`);
      setCurrentRun(run);
      if (!options?.skipAudit) await loadAudit(agentRunId);
      if (!POLLING_STOP_STATUSES.has(run.status)) startPolling(agentRunId);
      return run;
    } catch (refreshError) {
      const messageText = refreshError instanceof Error ? refreshError.message : '刷新 AgentRun 失败';
      setError(messageText);
      throw refreshError;
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, [loadAudit, startPolling]);

  const act = useCallback(async (agentRunId: string, approvedStepNos?: number[]) => {
    setLoading(true);
    setError('');
    setActionMessage('已确认计划，Agent 正在同步执行…');
    try {
      await apiFetch<AgentRun>(`/agent-runs/${agentRunId}/act`, {
        method: 'POST',
        body: JSON.stringify({ approval: true, approvedStepNos, confirmation: { confirmHighRisk: true }, comment: '用户在 Agent Workspace 确认执行' }),
      });
      // /act 可能触发 Observation/Replan 并创建新 Plan/Artifact；随后读取完整 Run，确保前端能展示澄清卡片和新计划版本。
      const fullRun = await apiFetch<AgentRun>(`/agent-runs/${agentRunId}`);
      setCurrentRun(fullRun);
      await loadAudit(agentRunId);
      if (!POLLING_STOP_STATUSES.has(fullRun.status)) startPolling(agentRunId);
      setActionMessage(fullRun.status === 'succeeded' ? 'Agent 执行完成。' : `Agent 当前状态：${fullRun.status}`);
      return fullRun;
    } catch (actError) {
      const messageText = actError instanceof Error ? actError.message : '执行 Agent 失败';
      setError(messageText);
      setActionMessage(messageText);
      throw actError;
    } finally {
      setLoading(false);
    }
  }, [loadAudit, startPolling]);

  const interpretMessage = useCallback(async (agentRunId: string, message: string) => {
    setLoading(true);
    setError('');
    setActionMessage('正在请求 LLM 判断你的聊天回复是否为审批确认…');
    try {
      const result = await apiFetch<AgentMessageIntentResult>(`/agent-runs/${agentRunId}/interpret-message`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      });
      setActionMessage(result.shouldExecute ? 'LLM 判定为确认执行，准备开始调用工具。' : `LLM 判定为：${result.intent}${result.reason ? `（${result.reason}）` : ''}`);
      return result;
    } catch (intentError) {
      const messageText = intentError instanceof Error ? intentError.message : 'LLM 意图判定失败';
      setError(messageText);
      setActionMessage(messageText);
      throw intentError;
    } finally {
      setLoading(false);
    }
  }, []);

  const retry = useCallback(async (agentRunId: string, approvedStepNos?: number[]) => {
    setLoading(true);
    setError('');
    setActionMessage('正在从失败步骤重新开始，已成功步骤会复用。');
    try {
      await apiFetch<AgentRun>(`/agent-runs/${agentRunId}/retry`, {
        method: 'POST',
        body: JSON.stringify({ approval: true, approvedStepNos, confirmation: { confirmHighRisk: true }, comment: '用户在 Agent Workspace 触发从失败步骤重新开始' }),
      });
      // retry 同样可能产生新的 Observation/Replan Artifact，必须刷新完整聚合视图。
      const fullRun = await apiFetch<AgentRun>(`/agent-runs/${agentRunId}`);
      setCurrentRun(fullRun);
      await loadAudit(agentRunId);
      if (!POLLING_STOP_STATUSES.has(fullRun.status)) startPolling(agentRunId);
      setActionMessage(fullRun.status === 'succeeded' ? 'Agent 已从失败步骤恢复并执行完成。' : `Agent 当前状态：${fullRun.status}`);
      return fullRun;
    } catch (retryError) {
      const messageText = retryError instanceof Error ? retryError.message : '从失败步骤重新开始失败';
      setError(messageText);
      setActionMessage(messageText);
      throw retryError;
    } finally {
      setLoading(false);
    }
  }, [loadAudit, startPolling]);

  const replan = useCallback(async (agentRunId: string, message?: string, options?: AgentRunReplanOptions) => {
    setLoading(true);
    setError('');
    setActionMessage('正在基于当前任务重新规划…');
    try {
      const run = await apiFetch<AgentRun>(`/agent-runs/${agentRunId}/replan`, {
        method: 'POST',
        body: JSON.stringify({ message, ...options }),
      });
      setCurrentRun(run);
      await loadAudit(agentRunId);
      if (!POLLING_STOP_STATUSES.has(run.status)) startPolling(agentRunId);
      setActionMessage('重新规划已完成，请重新检查计划与预览。');
      return run;
    } catch (replanError) {
      const messageText = replanError instanceof Error ? replanError.message : '重新规划失败';
      setError(messageText);
      setActionMessage(messageText);
      throw replanError;
    } finally {
      setLoading(false);
    }
  }, [loadAudit, startPolling]);

  const answerClarification = useCallback(async (agentRunId: string, choice: ReplanClarificationChoice) => {
    const label = choice.label ?? choice.id ?? '未命名候选';
    setLoading(true);
    setError('');
    setActionMessage('已收到你的澄清选择，正在通过专用接口重新规划…');
    try {
      const run = await apiFetch<AgentRun>(`/agent-runs/${agentRunId}/clarification-choice`, {
        method: 'POST',
        body: JSON.stringify({ choice, message: `用户从澄清卡片选择：${label}` }),
      });
      setCurrentRun(run);
      await loadAudit(agentRunId);
      if (!POLLING_STOP_STATUSES.has(run.status)) startPolling(agentRunId);
      setActionMessage('澄清选择已写入上下文，新计划已生成，请重新审批后执行。');
      return run;
    } catch (clarificationError) {
      const messageText = clarificationError instanceof Error ? clarificationError.message : '提交澄清选择失败';
      setError(messageText);
      setActionMessage(messageText);
      throw clarificationError;
    } finally {
      setLoading(false);
    }
  }, [loadAudit, startPolling]);

  const cancel = useCallback(async (agentRunId: string) => {
    setLoading(true);
    setError('');
    setActionMessage('正在取消 AgentRun…');
    try {
      const run = await apiFetch<AgentRun>(`/agent-runs/${agentRunId}/cancel`, { method: 'POST' });
      stopPolling();
      setCurrentRun(run);
      await loadAudit(agentRunId);
      setActionMessage('AgentRun 已取消。');
      return run;
    } catch (cancelError) {
      const messageText = cancelError instanceof Error ? cancelError.message : '取消失败';
      setError(messageText);
      throw cancelError;
    } finally {
      setLoading(false);
    }
  }, [loadAudit, stopPolling]);

  /**
   * 开启一个新的前端会话。
   * 输入/输出：无参数，返回 void；副作用：仅清空当前选中的 Run、审计轨迹和提示信息，不删除后端历史记录。
   */
  const startNewSession = useCallback(() => {
    setCurrentRun(null);
    stopPolling();
    setAuditEvents([]);
    setError('');
    setActionMessage('已开启新会话，可以输入新的创作指令。');
    // 新会话应摆脱上一次提交的幂等指纹，避免相同文本被误认为同一轮请求。
    createPlanRequestIdsRef.current.clear();
  }, [stopPolling]);

  return { currentRun, runHistory, auditEvents, loading, error, actionMessage, createPlan, refresh, interpretMessage, act, retry, replan, answerClarification, cancel, listByProject, loadAudit, setCurrentRun, startNewSession };
}
