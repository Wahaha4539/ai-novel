'use client';

import { ChangeEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef } from 'react';
import type { AgentPlanPayload } from '../../hooks/useAgentRun';
import { CREATIVE_DOCUMENT_ACCEPT } from '../../lib/uploadCreativeDocument';

/** 输入字符数达到此阈值时显示计数器 */
const CHAR_COUNT_THRESHOLD = 20;
/** 建议的最大输入长度 */
const MAX_CHAR_LIMIT = 2000;

/** 聊天消息类型：user=用户发送，agent=Agent 回复，system=系统提示 */
export type ChatMessageRole = 'user' | 'agent' | 'system';

/** 单条聊天消息数据结构 */
export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  timestamp: number;
}

interface AgentInputBoxProps {
  goal: string;
  loading: boolean;
  canReplan: boolean;
  hasCurrentRun: boolean;
  canAct?: boolean;
  plan?: AgentPlanPayload;
  currentRunGoal?: string;
  riskSummary?: string[];
  /** 聊天历史记录，按时间正序排列 */
  chatHistory?: ChatMessage[];
  onGoalChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  onReplan: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onCreativeDocumentSelect?: (file: File) => void | Promise<void>;
}

/**
 * AgentInputBox 以聊天输入框形式承载自然语言任务、计划预览和审批确认。
 * 输入：受控 goal 文本、当前 Run/Plan 摘要与外部运行状态；输出：通过回调触发计划生成、聊天确认执行、重新规划或刷新；
 * 副作用：提交表单会调用上层 API 流程，具体执行分支由父组件根据消息意图决定。
 */
export function AgentInputBox({ goal, loading, canReplan, hasCurrentRun, canAct = false, plan, currentRunGoal, riskSummary = [], chatHistory = [], onGoalChange, onSubmit, onReplan, onRefresh, onCreativeDocumentSelect }: AgentInputBoxProps) {
  /** 当前输入长度，超过阈值时展示字符计数 */
  const charCount = useMemo(() => goal.length, [goal]);
  const showCounter = charCount >= CHAR_COUNT_THRESHOLD;
  const planSteps = useMemo(() => plan?.steps?.slice(0, 6) ?? [], [plan]);
  const inputPlaceholder = canAct ? '可以用自然语言回复是否执行当前计划；我会先让 LLM 判断你的意图…' : '例如：帮我写第 2 卷第一章内容，目标 5000 字…';

  /** 自动滚动到最新消息 */
  const threadRef = useRef<HTMLDivElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [chatHistory.length, loading]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!goal.trim() || loading) return;
    await onSubmit();
  };

  const handleInputKeyDown = async (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 聊天框习惯：Enter 直接发送；中文输入法组词或 Shift+Enter 时保留换行行为。
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!goal.trim() || loading) return;
      await onSubmit();
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
                <ol className="agent-chat-plan__steps">
                  {planSteps.map((step) => (
                    <li key={step.stepNo}>
                      <span className="agent-chat-plan__step-no">{step.stepNo}</span>
                      <span>{step.name || step.tool || '未命名步骤'}</span>
                    </li>
                  ))}
                </ol>
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

// ────────────────────────────────────────────
// 聊天消息行子组件 — 按角色渲染不同样式
// ────────────────────────────────────────────

/** 格式化消息时间戳为 HH:mm */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
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
