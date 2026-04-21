import React from 'react';
import { ProjectSummary, ChapterSummary } from '../types/dashboard';

interface Props {
  projects: ProjectSummary[];
  chapters: ChapterSummary[];
  selectedProjectId: string;
  setSelectedProjectId: (id: string) => void;
  selectedChapterId: string;
  setSelectedChapterId: (id: string) => void;
}

export function WorkspaceSidebar({
  projects,
  chapters,
  selectedProjectId,
  setSelectedProjectId,
  selectedChapterId,
  setSelectedChapterId,
}: Props) {
  return (
    <aside className="flex w-64 flex-col border-r border-slate-800 bg-slate-950/80 backdrop-blur-xl shrink-0 h-full overflow-hidden">
      <div className="p-5 border-b border-white/5">
        <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500 mb-3">切换项目</h2>
        <select
          className="select w-full !bg-slate-900/50"
          value={selectedProjectId}
          onChange={(event) => {
            setSelectedProjectId(event.target.value);
            setSelectedChapterId('all');
          }}
        >
          <option value="">请选择项目</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title}
            </option>
          ))}
        </select>
      </div>

      <nav className="flex-1 overflow-y-auto p-3 space-y-6 custom-scrollbar">
        {/* Core Navigation Section */}
        <div>
          <div className="px-3 mb-2 text-[0.65rem] font-bold uppercase tracking-[0.2em] text-slate-500">全局创作</div>
          <ul className="space-y-1">
            <li>
              <button
                disabled
                className="w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-400 hover:bg-slate-900 hover:text-slate-200 transition-colors opacity-60 cursor-not-allowed"
                title="尚未开放大纲树"
              >
                <div className="w-1.5 h-1.5 rounded-full bg-amber-500/50 shadow-[0_0_8px_rgba(245,158,11,0.5)]" />
                剧情大纲 (Outline)
              </button>
            </li>
            <li>
              <button
                disabled
                className="w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-400 hover:bg-slate-900 hover:text-slate-200 transition-colors opacity-60 cursor-not-allowed"
                title="尚未开放全局设定模块"
              >
                <div className="w-1.5 h-1.5 rounded-full bg-violet-500/50 shadow-[0_0_8px_rgba(139,92,246,0.5)]" />
                角色与设定 (Lore)
              </button>
            </li>
          </ul>
        </div>

        {/* Chapters Directory */}
        <div>
          <div className="px-3 mb-2 text-[0.65rem] font-bold uppercase tracking-[0.2em] text-slate-500 flex justify-between items-center">
            <span>章节草稿</span>
            <span className="bg-slate-800 text-[10px] px-1.5 py-0.5 rounded text-slate-400">{chapters.length}</span>
          </div>
          <ul className="space-y-1">
            <li>
              <button
                onClick={() => setSelectedChapterId('all')}
                className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all ${
                  selectedChapterId === 'all'
                    ? 'bg-cyan-500/10 text-cyan-400 shadow-[inset_2px_0_0_rgba(6,182,212,1)]'
                    : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                }`}
              >
                全书范围
              </button>
            </li>
            {chapters.map((chapter) => {
              const isActive = selectedChapterId === chapter.id;
              return (
                <li key={chapter.id}>
                  <button
                    onClick={() => setSelectedChapterId(chapter.id)}
                    className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all ${
                      isActive
                        ? 'bg-cyan-500/10 text-cyan-400 font-medium shadow-[inset_2px_0_0_rgba(6,182,212,1)]'
                        : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                    }`}
                  >
                    <span className="truncate">
                      <span className="opacity-50 mr-1.5 text-xs">#{chapter.chapterNo}</span>
                      {chapter.title || '未命名章节'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </nav>

      {/* Footer Profile or Settings block */}
      <div className="p-4 border-t border-white/5 bg-slate-900/20">
        <div className="flex items-center gap-3 px-2">
          <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-cyan-600 to-emerald-400 p-[2px] shadow-lg shadow-cyan-500/20">
            <div className="w-full h-full rounded-full bg-slate-950 flex items-center justify-center">
              <span className="text-[10px] text-cyan-300 font-bold uppercase">AI</span>
            </div>
          </div>
          <div className="text-xs font-medium text-slate-300">小说辅写台</div>
        </div>
      </div>
    </aside>
  );
}
