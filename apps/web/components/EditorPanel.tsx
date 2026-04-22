import React from 'react';
import { ProjectSummary, ChapterSummary } from '../types/dashboard';

interface Props {
  selectedProject?: ProjectSummary;
  selectedChapterId: string;
  chapters: ChapterSummary[];
}

export function EditorPanel({ selectedProject, selectedChapterId, chapters }: Props) {
  const isGlobal = selectedChapterId === 'all';
  const chapter = chapters.find((c) => c.id === selectedChapterId);

  const title = isGlobal
    ? selectedProject?.title || '未选择项目'
    : `第${chapter?.chapterNo ?? '?'}章 · ${chapter?.title || '无标题'}`;

  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      <header className="flex flex-col justify-center shrink-0" style={{ height: '3.5rem', background: 'var(--bg-editor-header)', padding: '0 2rem', borderBottom: '1px solid var(--border-light)', backdropFilter: 'blur(12px)', zIndex: 10 }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold text-heading" style={{ textShadow: '0 2px 10px var(--accent-cyan-glow)' }}>{title}</h1>
            {!isGlobal && (
              <span className="badge" style={{ background: 'var(--accent-cyan-bg)', color: 'var(--accent-cyan)', border: 'none', boxShadow: 'inset 0 0 10px var(--accent-cyan-bg)' }}>草稿状态</span>
            )}
          </div>
          <div className="flex items-center gap-4 text-xs font-medium text-slate-500">
            <span>正文：0 字</span>
            <span>更新：刚刚</span>
          </div>
        </div>
      </header>

      <div className="flex-1 px-8 py-10" style={{ overflowY: 'auto' }}>
        {isGlobal ? (
          <div className="flex flex-col items-center justify-center h-full space-y-4" style={{ maxWidth: '56rem', margin: '0 auto', opacity: 0.6 }}>
            <div className="flex items-center justify-center animate-pulse-glow" style={{ width: '4rem', height: '4rem', borderRadius: '1rem', background: 'var(--bg-card)', color: 'var(--accent-cyan)', border: '1px solid var(--border-light)', transform: 'rotate(5deg)' }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
              </svg>
            </div>
            <p className="text-sm">选定了一个全局范围，由于大纲视图还未接入，请在左侧选择具体的章节进入撰写。</p>
          </div>
        ) : (
          <div className="animate-fade-in" style={{ maxWidth: '48rem', margin: '0 auto' }}>
            <textarea
              className="w-full h-full text-lg"
              style={{
                minHeight: '600px',
                background: 'transparent',
                resize: 'none',
                outline: 'none',
                border: 'none',
                color: 'var(--text-main)',
                lineHeight: 1.8,
                fontFamily: 'inherit'
              }}
              placeholder="在这里开始撰写属于你的章节故事......"
            />
          </div>
        )}
      </div>
    </article>
  );
}
