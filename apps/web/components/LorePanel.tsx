import React from 'react';
import { ProjectSummary } from '../types/dashboard';

interface Props {
  selectedProject?: ProjectSummary;
}

export function LorePanel({ selectedProject }: Props) {
  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      <header
        className="flex items-center justify-between shrink-0"
        style={{
          height: '3.5rem',
          background: 'var(--bg-editor-header)',
          padding: '0 2rem',
          borderBottom: '1px solid var(--border-light)',
          backdropFilter: 'blur(12px)',
          zIndex: 10,
        }}
      >
        <div className="flex items-center gap-3">
          <div
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: '#8b5cf6',
              boxShadow: '0 0 10px rgba(139,92,246,0.5)',
            }}
          />
          <h1
            className="text-lg font-bold text-heading"
            style={{ textShadow: '0 2px 10px var(--accent-cyan-glow)' }}
          >
            角色与设定
          </h1>
          <span
            className="badge"
            style={{
              background: 'rgba(139,92,246,0.12)',
              color: '#8b5cf6',
              border: 'none',
            }}
          >
            Lore
          </span>
        </div>
        <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>
          {selectedProject?.title ?? '未选择项目'}
        </div>
      </header>

      <div className="flex-1 px-8 py-10" style={{ overflowY: 'auto' }}>
        <div
          className="flex flex-col items-center justify-center h-full animate-fade-in"
          style={{ opacity: 0.7 }}
        >
          <div
            className="flex items-center justify-center animate-pulse-glow"
            style={{
              width: '5rem',
              height: '5rem',
              borderRadius: '1.25rem',
              background: 'var(--bg-card)',
              border: '1px solid var(--border-light)',
              color: '#8b5cf6',
              marginBottom: '1.5rem',
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="36"
              height="36"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
              />
            </svg>
          </div>
          <p
            className="text-base font-medium mb-2"
            style={{ color: 'var(--text-muted)' }}
          >
            角色与世界设定
          </p>
          <p
            className="text-sm text-center"
            style={{ color: 'var(--text-dim)', maxWidth: '24rem', lineHeight: 1.6 }}
          >
            在这里管理你的角色档案、世界观设定、势力关系与背景知识库，为 AI 提供创作上下文。
          </p>
        </div>
      </div>
    </article>
  );
}
