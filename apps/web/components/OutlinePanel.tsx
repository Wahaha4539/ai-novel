import React from 'react';
import { ProjectSummary } from '../types/dashboard';
import { OutlineEditor } from './OutlineEditor';

interface Props {
  selectedProject?: ProjectSummary;
}

export function OutlinePanel({ selectedProject }: Props) {
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
              background: '#f59e0b',
              boxShadow: '0 0 10px rgba(245,158,11,0.5)',
            }}
          />
          <h1
            className="text-lg font-bold text-heading"
            style={{ textShadow: '0 2px 10px var(--accent-cyan-glow)' }}
          >
            剧情大纲
          </h1>
          <span
            className="badge"
            style={{
              background: 'rgba(245,158,11,0.12)',
              color: '#f59e0b',
              border: 'none',
            }}
          >
            Outline
          </span>
        </div>
        <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>
          {selectedProject?.title ?? '未选择项目'}
        </div>
      </header>

      <div className="flex-1 px-8 py-6" style={{ overflowY: 'auto' }}>
        {selectedProject ? (
          <div
            className="panel animate-fade-in"
            style={{
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--bg-card)',
              border: '1px solid var(--border-light)',
              borderRadius: '0.75rem',
              overflow: 'hidden',
            }}
          >
            <OutlineEditor project={selectedProject} />
          </div>
        ) : (
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
                color: '#f59e0b',
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
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
                />
              </svg>
            </div>
            <p
              className="text-base font-medium mb-2"
              style={{ color: 'var(--text-muted)' }}
            >
              剧情大纲模块
            </p>
            <p
              className="text-sm text-center"
              style={{ color: 'var(--text-dim)', maxWidth: '24rem', lineHeight: 1.6 }}
            >
              请先在左侧选择一个项目，然后在这里编写你的故事大纲。
            </p>
          </div>
        )}
      </div>
    </article>
  );
}
