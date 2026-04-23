import React, { useState, useRef, useEffect } from 'react';
import { ChatMessage } from '../../hooks/useGuidedSession';

interface Props {
  messages: ChatMessage[];
  onSend: (content: string) => void;
  loading?: boolean;
}

export function AiChatPanel({ messages, onSend, loading }: Props) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

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
    <div className="flex flex-col h-full">
      {/* Messages area */}
      <div
        ref={scrollRef}
        className="flex-1 p-4 space-y-4"
        style={{ overflowY: 'auto' }}
      >
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
                maxWidth: '85%',
                padding: '0.75rem 1rem',
                borderRadius: msg.role === 'user' ? '1rem 1rem 0.25rem 1rem' : '1rem 1rem 1rem 0.25rem',
                background: msg.role === 'user'
                  ? 'linear-gradient(135deg, var(--accent-cyan), #0d9488)'
                  : 'var(--bg-card)',
                border: msg.role === 'user' ? 'none' : '1px solid var(--border-light)',
                color: msg.role === 'user' ? '#ffffff' : 'var(--text-main)',
                fontSize: '0.85rem',
                lineHeight: 1.7,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {msg.role === 'ai' && (
                <div
                  style={{
                    fontSize: '0.65rem',
                    fontWeight: 700,
                    color: 'var(--accent-cyan)',
                    marginBottom: '0.35rem',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  AI 引导
                </div>
              )}
              {msg.content}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start animate-fade-in">
            <div
              style={{
                padding: '0.75rem 1rem',
                borderRadius: '1rem',
                background: 'var(--bg-card)',
                border: '1px solid var(--border-light)',
                color: 'var(--text-dim)',
                fontSize: '0.85rem',
              }}
            >
              <span className="animate-pulse-glow">AI 正在思考…</span>
            </div>
          </div>
        )}
      </div>

      {/* Input area */}
      <div
        style={{
          padding: '0.75rem 1rem',
          borderTop: '1px solid var(--border-dim)',
          background: 'var(--bg-card)',
        }}
      >
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入你的想法…（Enter 发送，Shift+Enter 换行）"
            rows={2}
            style={{
              flex: 1,
              resize: 'none',
              padding: '0.6rem 0.8rem',
              borderRadius: '0.75rem',
              border: '1px solid var(--border-light)',
              background: 'var(--bg-deep)',
              color: 'var(--text-main)',
              fontSize: '0.85rem',
              lineHeight: 1.5,
              outline: 'none',
              transition: 'border-color 0.2s ease',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent-cyan)'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-light)'; }}
          />
          <button
            onClick={handleSubmit}
            disabled={!input.trim()}
            style={{
              alignSelf: 'flex-end',
              padding: '0.6rem 1.2rem',
              borderRadius: '0.75rem',
              border: 'none',
              background: input.trim() ? 'var(--accent-cyan)' : 'var(--bg-hover-subtle)',
              color: input.trim() ? '#ffffff' : 'var(--text-dim)',
              fontSize: '0.8rem',
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
