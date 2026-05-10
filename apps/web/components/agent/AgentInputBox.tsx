'use client';

import { ChangeEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentImportAssetType, AgentImportPreviewMode, AgentPlanPayload, AgentRunStepRecord } from '../../hooks/useAgentRun';
import { CREATIVE_DOCUMENT_ACCEPT } from '../../lib/uploadCreativeDocument';
import type { AgentCreativeDocumentAttachment, AgentCreativeDocumentExtension } from '../../types/agent-attachment';
import {
  chapterNosFromPlanStep,
  chapterRangeLabel,
  formatChapterProgress,
  outlineChapterProgress,
} from './agentBatchPlanView';

/** 输入字符数达到此阈值时显示计数器 */
const CHAR_COUNT_THRESHOLD = 20;
/** 建议的最大输入长度 */
const MAX_CHAR_LIMIT = 2000;

export type AgentTargetProductId = AgentImportAssetType;

export interface AgentInputSubmitOptions {
  requestedAssetTypes?: AgentTargetProductId[];
  importPreviewMode?: AgentImportPreviewMode;
}

const TARGET_PRODUCTS: Array<{ id: AgentTargetProductId; label: string; promptLabel: string; detail: string }> = [
  { id: 'outline', label: '剧情大纲', promptLabel: '剧情大纲', detail: '卷纲、章节规划、主线推进' },
  { id: 'characters', label: '角色与人设', promptLabel: '角色与人设（角色档案、动机、关系，不包含世界设定）', detail: '主配角、动机、关系基线' },
  { id: 'worldbuilding', label: '世界设定', promptLabel: '世界设定', detail: '地点、势力、规则、背景' },
  { id: 'writingRules', label: '写作规则', promptLabel: '写作规则', detail: '文风、视角、禁写规则' },
  { id: 'projectProfile', label: '项目资料', promptLabel: '项目资料', detail: '题材、主题、简介、基调' },
];

const IMPORT_PREVIEW_MODES: Array<{ id: AgentImportPreviewMode; label: string; detail: string }> = [
  { id: 'auto', label: '自动', detail: '单目标或双目标使用深度拆分，多目标使用快速预览' },
  { id: 'quick', label: '快速', detail: '优先使用 build_import_preview 生成统一预览' },
  { id: 'deep', label: '深度', detail: '优先使用分目标工具并合并预览' },
];

/** 聊天消息类型：user=用户发送，agent=Agent 回复，system=系统提示 */
export type ChatMessageRole = 'user' | 'agent' | 'system';

/** 单条聊天消息数据结构 */
export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  timestamp: number;
}

export type CreativeDocumentAttachmentStatus = 'uploading' | 'uploaded' | 'failed';

export interface CreativeDocumentAttachmentItem {
  id: string;
  fileName: string;
  extension?: AgentCreativeDocumentExtension;
  size?: number;
  status: CreativeDocumentAttachmentStatus;
  error?: string;
  attachment?: AgentCreativeDocumentAttachment;
}

interface AgentInputBoxProps {
  goal: string;
  loading: boolean;
  canReplan: boolean;
  hasCurrentRun: boolean;
  canAct?: boolean;
  plan?: AgentPlanPayload;
  runSteps?: AgentRunStepRecord[];
  activePlanVersion?: number;
  runStatus?: string;
  actionMessage?: string;
  currentRunGoal?: string;
  riskSummary?: string[];
  /** 聊天历史记录，按时间正序排列 */
  chatHistory?: ChatMessage[];
  creativeDocumentAttachments?: CreativeDocumentAttachmentItem[];
  onGoalChange: (value: string) => void;
  onSubmit: (options?: AgentInputSubmitOptions) => void | Promise<void>;
  onReplan: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onCreativeDocumentSelect?: (file: File) => void | Promise<void>;
  onCreativeDocumentRemove?: (id: string) => void;
}

/**
 * AgentInputBox 以聊天输入框形式承载自然语言任务、计划预览和审批确认。
 * 输入：受控 goal 文本、当前 Run/Plan 摘要与外部运行状态；输出：通过回调触发计划生成、聊天确认执行、重新规划或刷新；
 * 副作用：提交表单会调用上层 API 流程，具体执行分支由父组件根据消息意图决定。
 */
export function AgentInputBox({ goal, loading, canReplan, hasCurrentRun, canAct = false, plan, runSteps = [], activePlanVersion = 1, runStatus, actionMessage, currentRunGoal, riskSummary = [], chatHistory = [], creativeDocumentAttachments = [], onGoalChange, onSubmit, onReplan, onRefresh, onCreativeDocumentSelect, onCreativeDocumentRemove }: AgentInputBoxProps) {
  /** 当前输入长度，超过阈值时展示字符计数 */
  const charCount = useMemo(() => goal.length, [goal]);
  const showCounter = charCount >= CHAR_COUNT_THRESHOLD;
  const planSteps = useMemo(() => plan?.steps ?? [], [plan]);
  const [selectedTargetIds, setSelectedTargetIds] = useState<AgentTargetProductId[]>([]);
  const [importPreviewMode, setImportPreviewMode] = useState<AgentImportPreviewMode>('auto');
  const lastTargetPromptRef = useRef('');
  const inputPlaceholder = canAct ? '可以用自然语言回复是否执行当前计划；我会先让 LLM 判断你的意图…' : '例如：帮我写第 2 卷第一章内容，目标 5000 字…';
  const isExecutingSteps = loading && Boolean(planSteps.length) && (
    runStatus === 'acting'
    || runStatus === 'running'
    || /执行|调用工具|重试/.test(actionMessage ?? '')
  );

  /** 自动滚动到最新消息 */
  const threadRef = useRef<HTMLDivElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [chatHistory.length, loading]);

  useEffect(() => {
    if (!goal.trim()) {
      setSelectedTargetIds([]);
      setImportPreviewMode('auto');
      lastTargetPromptRef.current = '';
    }
  }, [goal]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!goal.trim() || loading) return;
    await onSubmit(createSubmitOptions(selectedTargetIds, importPreviewMode));
  };

  const handleInputKeyDown = async (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 聊天框习惯：Enter 直接发送；中文输入法组词或 Shift+Enter 时保留换行行为。
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!goal.trim() || loading) return;
      await onSubmit(createSubmitOptions(selectedTargetIds, importPreviewMode));
    }
  };

  const handleCreativeDocumentClick = () => {
    if (loading) return;
    documentInputRef.current?.click();
  };

  const handleCreativeDocumentChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || loading) return;
    await onCreativeDocumentSelect?.(file);
  };

  const hasUploadedCreativeDocument = creativeDocumentAttachments.some((item) => item.status === 'uploaded');

  const applyTargetProducts = (nextIds: AgentTargetProductId[]) => {
    const baseInstruction = stripPreviousTargetPrompt(goal, lastTargetPromptRef.current);
    const nextPrompt = nextIds.length ? composeTargetPrompt(nextIds, hasUploadedCreativeDocument) : '';
    lastTargetPromptRef.current = nextPrompt;
    onGoalChange(nextPrompt && baseInstruction ? `${nextPrompt}\n补充要求：${baseInstruction}` : nextPrompt || baseInstruction);
  };

  const handleTargetProductToggle = (id: AgentTargetProductId) => {
    if (loading) return;
    const nextIds = selectedTargetIds.includes(id)
      ? selectedTargetIds.filter((item) => item !== id)
      : [...selectedTargetIds, id];
    setSelectedTargetIds(nextIds);
    applyTargetProducts(nextIds);
  };

  const handleTargetProductAll = () => {
    if (loading) return;
    const allIds = TARGET_PRODUCTS.map((item) => item.id);
    setSelectedTargetIds(allIds);
    applyTargetProducts(allIds);
  };

  const handleImportPreviewModeChange = (mode: AgentImportPreviewMode) => {
    if (loading) return;
    setImportPreviewMode(mode);
  };

  return (
    <form onSubmit={handleSubmit} className="panel agent-chat-form h-fit">
      <div ref={threadRef} className="agent-chat-thread" aria-label="Agent 创作聊天框">
        {/* Agent 欢迎消息 — 带装饰性渐变条 */}
        <div className="agent-chat-row agent-chat-row--assistant">
          <div className="agent-chat-avatar agent-chat-avatar--animated" aria-hidden="true">
            <span className="agent-chat-avatar__icon">🧠</span>
          </div>
          <div className="agent-chat-bubble agent-chat-bubble--assistant agent-chat-bubble--welcome">
            <div className="agent-chat-name">Agent</div>
            <p>把写作目标像聊天一样发给我。我会先整理可审阅计划，再按你的确认执行。</p>
            {/* 底部装饰渐变条 */}
            <div className="agent-chat-bubble__accent" aria-hidden="true" />
          </div>
        </div>

        {/* ── 聊天历史消息渲染 ── */}
        {chatHistory.map((msg) => (
          <ChatMessageRow key={msg.id} message={msg} />
        ))}

        {/* 已有运行记录提示 — 淡入动画 */}
        {hasCurrentRun && (
          <div className="agent-chat-row agent-chat-row--assistant agent-chat-row--compact animate-fade-in">
            <div className="agent-chat-avatar agent-chat-avatar--muted" aria-hidden="true">✓</div>
            <div className="agent-chat-bubble agent-chat-bubble--system">
              <span className="agent-chat-bubble__dot" aria-hidden="true" />
              已有运行记录，可继续发送新任务，或使用下方控制重新规划 / 刷新当前结果。
            </div>
          </div>
        )}

        {plan && (
          <div className="agent-chat-row agent-chat-row--assistant animate-fade-in">
            <div className="agent-chat-avatar agent-chat-avatar--muted" aria-hidden="true">📋</div>
            <div className="agent-chat-bubble agent-chat-bubble--assistant agent-chat-bubble--plan">
              <div className="agent-chat-name">Agent · 审批计划</div>
              {currentRunGoal && <div className="agent-chat-plan__goal">任务：{currentRunGoal}</div>}
              <p className="agent-chat-plan__summary">{plan.summary || '计划已生成，请检查步骤与风险后确认是否执行。'}</p>
              {planSteps.length > 0 && (
                <AgentChatStepList
                  planSteps={planSteps}
                  runSteps={runSteps}
                  activePlanVersion={activePlanVersion}
                  executing={isExecutingSteps}
                />
              )}
              {riskSummary.length > 0 && (
                <ul className="agent-chat-plan__risks">
                  {riskSummary.slice(0, 3).map((item) => <li key={item}>⚠ {item}</li>)}
                </ul>
              )}
              {canAct && (
                <div className="agent-chat-confirm-hint">
                  可直接用自然语言回复你的决定。发送后会先请求 LLM 判定是否为审批确认；只有判定为确认时才开始调用工具。
                </div>
              )}
            </div>
          </div>
        )}

        {/* 加载中 — 三点跳动指示器 */}
        {loading && (
          <div className="agent-chat-row agent-chat-row--assistant agent-chat-row--compact animate-fade-in">
            <div className="agent-chat-avatar agent-chat-avatar--muted" aria-hidden="true">⏳</div>
            <div className="agent-chat-bubble agent-chat-bubble--assistant">
              <div className="agent-typing-indicator" aria-label="Agent 正在思考">
                <span /><span /><span />
              </div>
            </div>
          </div>
        )}

        {/* 用户输入区 */}
        <div className="agent-chat-row agent-chat-row--user">
          <div className="agent-chat-composer">
            <label className="agent-chat-composer__label" htmlFor="agent-chat-goal">
              <span>创作指令</span>
              {/* 字符计数器 — 输入较长时才显示 */}
              {showCounter && (
                <span
                  className="agent-chat-composer__counter"
                  style={{ color: charCount > MAX_CHAR_LIMIT ? 'var(--status-err)' : undefined }}
                >
                  {charCount} / {MAX_CHAR_LIMIT}
                </span>
              )}
            </label>
            {creativeDocumentAttachments.length > 0 && (
              <div className="agent-chat-attachments" aria-label="已选择的创意文档">
                {creativeDocumentAttachments.map((attachment) => (
                  <div key={attachment.id} className={`agent-chat-attachment-card agent-chat-attachment-card--${attachment.status}`}>
                    <span className="agent-chat-attachment-card__icon" aria-hidden="true">📄</span>
                    <div className="agent-chat-attachment-card__body">
                      <div className="agent-chat-attachment-card__name" title={attachment.fileName}>
                        {attachment.fileName}
                      </div>
                      <div className="agent-chat-attachment-card__meta">
                        <span>{attachment.extension?.toUpperCase() ?? 'DOC'}</span>
                        <span>{formatFileSize(attachment.size)}</span>
                        <span>{attachmentStatusLabel(attachment.status)}</span>
                      </div>
                      {attachment.status === 'failed' && attachment.error && (
                        <div className="agent-chat-attachment-card__error">{attachment.error}</div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="agent-chat-attachment-card__remove"
                      onClick={() => onCreativeDocumentRemove?.(attachment.id)}
                      disabled={!onCreativeDocumentRemove}
                      aria-label={`删除创意文档：${attachment.fileName}`}
                      title="删除"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="agent-target-products" aria-label="目标产物">
              <div className="agent-target-products__head">
                <span>目标产物</span>
                <button type="button" className="agent-target-products__all" disabled={loading} onClick={handleTargetProductAll}>
                  全套
                </button>
              </div>
              <div className="agent-import-preview-mode" aria-label="导入预览模式">
                {IMPORT_PREVIEW_MODES.map((item) => {
                  const active = importPreviewMode === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`agent-import-preview-mode__btn ${active ? 'agent-import-preview-mode__btn--active' : ''}`}
                      aria-pressed={active}
                      title={item.detail}
                      disabled={loading}
                      onClick={() => handleImportPreviewModeChange(item.id)}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
              <div className="agent-target-products__grid">
                {TARGET_PRODUCTS.map((item) => {
                  const active = selectedTargetIds.includes(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`agent-target-product ${active ? 'agent-target-product--active' : ''}`}
                      aria-pressed={active}
                      title={item.detail}
                      disabled={loading}
                      onClick={() => handleTargetProductToggle(item.id)}
                    >
                      <span className="agent-target-product__mark" aria-hidden="true" />
                      <span className="agent-target-product__label">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <textarea
              id="agent-chat-goal"
              value={goal}
              onChange={(event) => onGoalChange(event.target.value)}
              onKeyDown={(event) => { void handleInputKeyDown(event); }}
              rows={4}
              maxLength={MAX_CHAR_LIMIT}
              className="agent-chat-input"
              placeholder={inputPlaceholder}
            />
            <div className="agent-chat-composer__footer">
              <span className="agent-chat-shortcut">
                {canAct ? '发送后先由 LLM 判定确认意图' : <><kbd>Enter</kbd> 发送 · <kbd>Shift+Enter</kbd> 换行</>}
              </span>
              <input
                ref={documentInputRef}
                type="file"
                accept={CREATIVE_DOCUMENT_ACCEPT}
                hidden
                disabled={loading}
                onChange={(event) => { void handleCreativeDocumentChange(event); }}
              />
              <div className="agent-chat-actions">
                <button
                  type="button"
                  onClick={handleCreativeDocumentClick}
                  disabled={loading}
                  className="agent-chat-ghost-btn"
                  title="导入 .md、.txt、.docx、.pdf 创意文档"
                >
                  <span aria-hidden="true">📄</span> 导入创意文档
                </button>
                {hasCurrentRun && (
                  <button type="button" onClick={() => void onReplan()} disabled={!canReplan || loading} className="agent-chat-ghost-btn">
                    <span aria-hidden="true">🔄</span> 重新规划
                  </button>
                )}
                {hasCurrentRun && (
                  <button type="button" onClick={() => void onRefresh()} disabled={loading} className="agent-chat-ghost-btn">
                    <span aria-hidden="true">🔃</span> 刷新
                  </button>
                )}
                <button
                  type="submit"
                  disabled={loading || !goal.trim()}
                  className="agent-chat-send-btn"
                  aria-label={canAct ? '发送消息并请求 LLM 判定是否确认执行' : '发送创作指令并生成计划'}
                >
                  {loading ? (
                    <>
                      <span className="agent-chat-send-btn__spinner" aria-hidden="true" />
                      生成中…
                    </>
                  ) : canAct ? '发送判定' : '发送'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

    </form>
  );
}

type AgentChatPlanStep = NonNullable<AgentPlanPayload['steps']>[number];
type AgentChatStepState = 'pending' | 'active' | 'done' | 'failed' | 'review';

function findChatStepRecord(records: AgentRunStepRecord[], stepNo: number, planVersion: number) {
  const matching = records.filter((item) => item.stepNo === stepNo && (item.planVersion ?? 1) === planVersion);
  return matching.find((item) => item.mode === 'act') ?? matching.find((item) => item.mode === 'plan') ?? matching[0];
}

function isChatStepDone(status?: string) {
  return status === 'succeeded' || status === 'skipped';
}

function isChatStepActive(status?: string) {
  return status === 'running' || status === 'acting' || status === 'planning';
}

function isChatStepFailed(status?: string) {
  return status === 'failed';
}

function chatStepState(record: AgentRunStepRecord | undefined, step: AgentChatPlanStep, active: boolean): AgentChatStepState {
  if (isChatStepDone(record?.status)) return 'done';
  if (isChatStepFailed(record?.status)) return 'failed';
  if (isChatStepActive(record?.status) || active) return 'active';
  if (step.requiresApproval) return 'review';
  return 'pending';
}

function chatStepStatusText(state: AgentChatStepState, step: AgentChatPlanStep) {
  if (state === 'done') return '已完成';
  if (state === 'failed') return '失败';
  if (state === 'active') return '进行中';
  if (state === 'review') return step.requiresApproval ? '待审批' : '待复核';
  return '待执行';
}

function AgentChatStepList({
  planSteps,
  runSteps,
  activePlanVersion,
  executing,
}: {
  planSteps: AgentChatPlanStep[];
  runSteps: AgentRunStepRecord[];
  activePlanVersion: number;
  executing: boolean;
}) {
  const optimisticActiveStepNo = useMemo(() => {
    if (!executing) return undefined;
    return planSteps.find((step) => {
      const record = findChatStepRecord(runSteps, step.stepNo, activePlanVersion);
      return !isChatStepDone(record?.status) && !isChatStepFailed(record?.status);
    })?.stepNo;
  }, [activePlanVersion, executing, planSteps, runSteps]);
  const chapterProgress = useMemo(
    () => outlineChapterProgress(planSteps, runSteps, activePlanVersion),
    [activePlanVersion, planSteps, runSteps],
  );

  return (
    <>
      {chapterProgress && (
        <div className="agent-chat-plan__chapter-progress">
          <span>章节 {formatChapterProgress(chapterProgress)}</span>
          <em>{chapterProgress.batchCount ? `${chapterProgress.batchCount} 个批次` : `${chapterProgress.singleChapterCount} 个章节步骤`}</em>
        </div>
      )}
      <ol className="agent-chat-plan__steps agent-chat-plan__steps--status">
        {planSteps.map((step) => {
          const record = findChatStepRecord(runSteps, step.stepNo, activePlanVersion);
          const state = chatStepState(record, step, step.stepNo === optimisticActiveStepNo);
          const toolName = step.tool ?? record?.tool ?? record?.toolName;
          const chapterNos = chapterNosFromPlanStep(step);
          const rangeLabel = chapterRangeLabel(step);
          return (
            <li key={step.stepNo} className={`agent-chat-plan-step agent-chat-plan-step--${state}`}>
              <span className={`agent-chat-step-status agent-chat-step-status--${state}`} aria-hidden="true">
                {state === 'active' ? <span className="agent-chat-step-status__spinner" /> : state === 'done' ? '✓' : state === 'failed' ? '!' : step.stepNo}
              </span>
              <span className="agent-chat-plan-step__main">
                <span className="agent-chat-plan-step__title">{step.name || step.tool || '未命名步骤'}</span>
                {toolName && <span className="agent-chat-plan-step__tool">{toolName}</span>}
                {chapterNos.length > 0 && (
                  <span className="agent-chat-chapter-row" aria-label={`${rangeLabel}目标章节`}>
                    {chapterNos.map((chapterNo) => <span key={chapterNo}>第 {chapterNo} 章</span>)}
                  </span>
                )}
              </span>
              <span className="agent-chat-plan-step__state">{chatStepStatusText(state, step)}</span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

// ────────────────────────────────────────────
// 聊天消息行子组件 — 按角色渲染不同样式
// ────────────────────────────────────────────

/** 格式化消息时间戳为 HH:mm */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

function formatFileSize(size?: number) {
  if (!Number.isFinite(size)) return '大小未知';
  const value = size ?? 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function attachmentStatusLabel(status: CreativeDocumentAttachmentStatus) {
  if (status === 'uploading') return '上传中';
  if (status === 'uploaded') return '上传成功';
  return '上传失败';
}

function composeTargetPrompt(ids: AgentTargetProductId[], hasCreativeDocument: boolean) {
  const selected = TARGET_PRODUCTS.filter((item) => ids.includes(item.id));
  const sourceText = hasCreativeDocument ? '我提供的文档和当前项目上下文' : '当前项目上下文';
  return `请根据${sourceText}生成目标产物：${selected.map((item) => item.promptLabel).join('、')}。只生成这些目标产物，不要生成未选择的其他资产。`;
}

function createSubmitOptions(ids: AgentTargetProductId[], importPreviewMode: AgentImportPreviewMode): AgentInputSubmitOptions | undefined {
  return ids.length ? { requestedAssetTypes: [...ids], importPreviewMode } : undefined;
}

function stripPreviousTargetPrompt(goal: string, previousPrompt: string) {
  if (!previousPrompt || !goal.startsWith(previousPrompt)) return goal.trim();
  return goal
    .slice(previousPrompt.length)
    .replace(/^\s*补充要求：?/, '')
    .trim();
}

/**
 * 单条聊天消息渲染组件。
 * user 角色靠右显示、使用品牌渐变背景；agent/system 角色靠左显示。
 */
function ChatMessageRow({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="agent-chat-row agent-chat-row--user animate-fade-in">
        <div className="agent-chat-bubble agent-chat-bubble--user">
          <p className="agent-chat-bubble__text">{message.content}</p>
          <span className="agent-chat-bubble__time">{formatTime(message.timestamp)}</span>
        </div>
      </div>
    );
  }

  // Agent / System 消息
  const isSystem = message.role === 'system';
  return (
    <div className={`agent-chat-row agent-chat-row--assistant animate-fade-in ${isSystem ? 'agent-chat-row--compact' : ''}`}>
      <div className={`agent-chat-avatar ${isSystem ? 'agent-chat-avatar--muted' : ''}`} aria-hidden="true">
        {isSystem ? '📎' : '🧠'}
      </div>
      <div className={`agent-chat-bubble ${isSystem ? 'agent-chat-bubble--system' : 'agent-chat-bubble--assistant'}`}>
        {!isSystem && <div className="agent-chat-name">Agent</div>}
        <p className="agent-chat-bubble__text">{message.content}</p>
        <span className="agent-chat-bubble__time">{formatTime(message.timestamp)}</span>
      </div>
    </div>
  );
}
