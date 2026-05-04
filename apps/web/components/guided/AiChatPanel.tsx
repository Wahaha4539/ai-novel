import React, { useState, useRef, useEffect } from 'react';
import { ChatMessage, GuidedAgentPanelStatus } from '../../hooks/useGuidedSession';

interface Props {
  messages: ChatMessage[];
  onSend: (content: string) => void;
  loading?: boolean;
  isOpen: boolean;
  onClose: () => void;
  currentStepLabel?: string;
  agentStatus?: GuidedAgentPanelStatus;
}

export function AiChatPanel({ messages, onSend, loading, isOpen, onClose, currentStepLabel, agentStatus }: Props) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const visibleAgentStatus = agentStatus && agentStatus.state !== 'idle' ? agentStatus : undefined;

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSubmit = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className={`ai-drawer ${isOpen ? '' : 'ai-drawer--collapsed'}`}>
      {/* Drawer Header */}
      <div className="ai-drawer__header">
        <div className="ai-drawer__title">
          <span>🤖</span>
          <span>AI 助手</span>
          {currentStepLabel && (
            <span
              style={{
                fontSize: '0.65rem',
                color: 'var(--text-dim)',
                fontWeight: 400,
              }}
            >
              · {currentStepLabel}
            </span>
          )}
        </div>
        <button className="ai-drawer__close" onClick={onClose} title="收起面板">
          ✕
        </button>
      </div>

      {/* Messages area */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '0.75rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
        }}
      >
        {messages.length === 0 && (
          <div
            style={{
              textAlign: 'center',
              padding: '2rem 0.5rem',
              color: 'var(--text-dim)',
              fontSize: '0.75rem',
              lineHeight: 1.7,
            }}
          >
            <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>💬</div>
            向 AI 提问或讨论当前步骤
            <br />
            也可直接在文档中手动编辑
          </div>
        )}

        {visibleAgentStatus && (
          <div
            className="animate-fade-in"
            style={{
              padding: '0.6rem 0.75rem',
              borderRadius: '0.6rem',
              border: visibleAgentStatus.state === 'failed' ? '1px solid rgba(244,63,94,0.35)' : '1px solid rgba(14,165,233,0.28)',
              background: visibleAgentStatus.state === 'failed' ? 'var(--status-err-bg)' : 'rgba(14,165,233,0.08)',
              color: visibleAgentStatus.state === 'failed' ? '#fecdd3' : 'var(--text-main)',
              fontSize: '0.72rem',
              lineHeight: 1.6,
            }}
          >
            <div style={{ fontWeight: 700, color: visibleAgentStatus.state === 'failed' ? '#fb7185' : 'var(--accent-cyan)', marginBottom: '0.2rem' }}>
              {visibleAgentStatus.title}
            </div>
            {visibleAgentStatus.summary && (
              <div style={{ color: 'var(--text-muted)' }}>
                {visibleAgentStatus.summary}
              </div>
            )}
          </div>
        )}

        {messages.map((msg, idx) => (
          <div
            key={idx}
            className="animate-fade-in"
            style={{
              display: 'flex',
              justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            <div
              style={{
                maxWidth: '90%',
                padding: '0.6rem 0.75rem',
                borderRadius: msg.role === 'user'
                  ? '0.75rem 0.75rem 0.2rem 0.75rem'
                  : '0.75rem 0.75rem 0.75rem 0.2rem',
                background: msg.role === 'user'
                  ? 'linear-gradient(135deg, var(--accent-cyan), #0d9488)'
                  : 'var(--bg-card)',
                border: msg.role === 'user' ? 'none' : '1px solid var(--border-light)',
                color: msg.role === 'user' ? '#ffffff' : 'var(--text-main)',
                fontSize: '0.78rem',
                lineHeight: 1.65,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {msg.role === 'ai' && (
                <div
                  style={{
                    fontSize: '0.6rem',
                    fontWeight: 700,
                    color: 'var(--accent-cyan)',
                    marginBottom: '0.25rem',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  AI
                </div>
              )}
              {msg.content}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex animate-fade-in" style={{ justifyContent: 'flex-start' }}>
            <div
              style={{
                padding: '0.6rem 0.75rem',
                borderRadius: '0.75rem',
                background: 'var(--bg-card)',
                border: '1px solid var(--border-light)',
                color: 'var(--text-dim)',
                fontSize: '0.78rem',
              }}
            >
              <span className="animate-pulse-glow">
                {agentStatus?.state === 'planning' ? 'Agent 正在生成计划/预览…' : 'AI 正在思考…'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Input area */}
      <div
        style={{
          padding: '0.5rem 0.75rem',
          borderTop: '1px solid var(--border-dim)',
          background: 'var(--bg-card)',
          flexShrink: 0,
        }}
      >
        <div className="flex gap-2">
          <textarea
            className="input-field"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="向 AI 提问… (Enter 发送)"
            rows={2}
            style={{
              flex: 1,
              resize: 'none',
              borderRadius: '0.5rem',
              background: 'var(--bg-deep)',
              fontSize: '0.78rem',
            }}
          />
          <button
            onClick={handleSubmit}
            disabled={!input.trim()}
            style={{
              alignSelf: 'flex-end',
              padding: '0.45rem 0.8rem',
              borderRadius: '0.5rem',
              border: 'none',
              background: input.trim() ? 'var(--accent-cyan)' : 'var(--bg-hover-subtle)',
              color: input.trim() ? '#ffffff' : 'var(--text-dim)',
              fontSize: '0.72rem',
              fontWeight: 600,
              cursor: input.trim() ? 'pointer' : 'default',
              transition: 'all 0.2s ease',
            }}
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
