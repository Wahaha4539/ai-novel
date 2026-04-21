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
    <article className="flex h-full flex-col bg-slate-950">
      <header className="flex h-14 shrink-0 flex-col justify-center border-b border-white/5 bg-slate-950/80 px-8 backdrop-blur-md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold text-slate-100">{title}</h1>
            {!isGlobal && (
              <span className="badge border-cyan-500/20 bg-cyan-500/10 text-cyan-400 border-none">草稿状态</span>
            )}
          </div>
          <div className="flex items-center gap-4 text-xs text-slate-500 font-medium">
            <span>正文：0 字</span>
            <span>更新：刚刚</span>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-8 py-10 custom-scrollbar">
        {isGlobal ? (
          <div className="mx-auto max-w-4xl opacity-50 flex h-full flex-col items-center justify-center space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-slate-800 rotate-12 flex items-center justify-center text-slate-500 shadow-inner">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
              </svg>
            </div>
            <p className="text-sm">选定了一个全局范围，由于大纲视图还未接入，请在左侧选择具体的章节进入撰写。</p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl">
            <textarea
              className="w-full h-[600px] bg-transparent resize-none outline-none text-slate-200 text-lg leading-relaxed placeholder:text-slate-700/50 focus:ring-0 border-none"
              placeholder="在这里开始撰写属于你的章节故事......"
            />
          </div>
        )}
      </div>
    </article>
  );
}
