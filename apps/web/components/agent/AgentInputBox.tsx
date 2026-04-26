'use client';

import { FormEvent, KeyboardEvent, useMemo } from 'react';

/** 输入字符数达到此阈值时显示计数器 */
const CHAR_COUNT_THRESHOLD = 20;
/** 建议的最大输入长度 */
const MAX_CHAR_LIMIT = 2000;

interface AgentInputBoxProps {
  goal: string;
  loading: boolean;
  canReplan: boolean;
  hasCurrentRun: boolean;
  onGoalChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  onReplan: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
}

/**
 * AgentInputBox 以聊天输入框形式承载自然语言任务、示例填充和运行控制。
 * 输入：受控 goal 文本与外部运行状态；输出：通过回调触发计划生成、重新规划或刷新；
 * 副作用：提交表单会调用上层 API 流程。
 */
export function AgentInputBox({ goal, loading, canReplan, hasCurrentRun, onGoalChange, onSubmit, onReplan, onRefresh }: AgentInputBoxProps) {
  /** 当前输入长度，超过阈值时展示字符计数 */
  const charCount = useMemo(() => goal.length, [goal]);
  const showCounter = charCount >= CHAR_COUNT_THRESHOLD;

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

  return (
    <form onSubmit={handleSubmit} className="panel agent-chat-form h-fit">
      <div className="agent-chat-thread" aria-label="Agent 创作聊天框">
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
              placeholder="例如：帮我写第 2 卷第一章内容，目标 5000 字…"
            />
            <div className="agent-chat-composer__footer">
              <span className="agent-chat-shortcut">
                <kbd>Enter</kbd> 发送 · <kbd>Shift+Enter</kbd> 换行
              </span>
              <div className="agent-chat-actions">
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
                  aria-label="发送创作指令并生成计划"
                >
                  {loading ? (
                    <>
                      <span className="agent-chat-send-btn__spinner" aria-hidden="true" />
                      生成中…
                    </>
                  ) : '发送'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

    </form>
  );
}
