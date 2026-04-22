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
    <aside className="flex flex-col shrink-0 h-full" style={{ width: '16rem', borderRight: '1px solid var(--border-light)', background: 'rgba(5, 5, 10, 0.6)', backdropFilter: 'blur(24px)', overflow: 'hidden' }}>
      <div className="p-5" style={{ borderBottom: '1px solid var(--border-dim)' }}>
        <h2 className="text-sm font-bold mb-3 text-slate-500" style={{ textTransform: 'uppercase', letterSpacing: '0.1em' }}>切换项目</h2>
        <select
          className="select"
          style={{ background: 'rgba(0,0,0,0.3)' }}
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

      <nav className="flex-1 p-3 space-y-6" style={{ overflowY: 'auto' }}>
        {/* Core Navigation Section */}
        <div>
          <div className="px-3 mb-2 font-bold text-slate-500" style={{ fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.2em' }}>全局创作</div>
          <ul className="space-y-1">
            <li>
              <button
                disabled
                className="w-full flex items-center gap-3 text-sm font-medium text-slate-400 p-2"
                style={{ borderRadius: '0.5rem', opacity: 0.6, cursor: 'not-allowed' }}
                title="尚未开放大纲树"
              >
                <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#f59e0b', boxShadow: '0 0 8px rgba(245,158,11,0.5)' }} />
                剧情大纲 (Outline)
              </button>
            </li>
            <li>
              <button
                disabled
                className="w-full flex items-center gap-3 text-sm font-medium text-slate-400 p-2"
                style={{ borderRadius: '0.5rem', opacity: 0.6, cursor: 'not-allowed' }}
                title="尚未开放全局设定模块"
              >
                <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#8b5cf6', boxShadow: '0 0 8px rgba(139,92,246,0.5)' }} />
                角色与设定 (Lore)
              </button>
            </li>
          </ul>
        </div>

        {/* Chapters Directory */}
        <div>
          <div className="px-3 mb-2 font-bold text-slate-500 flex justify-between items-center" style={{ fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.2em' }}>
            <span>章节草稿</span>
            <span style={{ fontSize: '10px', background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px' }}>{chapters.length}</span>
          </div>
          <ul className="space-y-1">
            <li>
              <button
                onClick={() => setSelectedChapterId('all')}
                className="w-full flex items-center gap-3 text-sm p-2"
                style={{
                  borderRadius: '0.5rem',
                  transition: 'all 0.3s ease',
                  background: selectedChapterId === 'all' ? 'var(--accent-cyan-bg)' : 'transparent',
                  color: selectedChapterId === 'all' ? 'var(--accent-cyan)' : 'var(--text-muted)',
                  boxShadow: selectedChapterId === 'all' ? 'inset 2px 0 0 var(--accent-cyan)' : 'none',
                  fontWeight: selectedChapterId === 'all' ? 500 : 400
                }}
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
                    className="w-full flex items-center gap-3 text-sm p-2"
                    style={{
                      borderRadius: '0.5rem',
                      transition: 'all 0.3s ease',
                      background: isActive ? 'var(--accent-cyan-bg)' : 'transparent',
                      color: isActive ? 'var(--accent-cyan)' : 'var(--text-muted)',
                      boxShadow: isActive ? 'inset 2px 0 0 var(--accent-cyan)' : 'none',
                      fontWeight: isActive ? 500 : 400
                    }}
                    onMouseEnter={(e) => { if(!isActive) { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = '#fff' } }}
                    onMouseLeave={(e) => { if(!isActive) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' } }}
                  >
                    <span className="truncate">
                      <span style={{ opacity: 0.5, marginRight: '6px', fontSize: '0.75rem' }}>#{chapter.chapterNo}</span>
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
      <div className="p-4" style={{ borderTop: '1px solid var(--border-dim)', background: 'rgba(0,0,0,0.2)' }}>
        <div className="flex items-center gap-3 px-2">
          <div className="flex items-center justify-center" style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'linear-gradient(to top right, var(--accent-cyan), #34d399)', padding: '2px', boxShadow: '0 4px 10px rgba(6,182,212,0.3)' }}>
            <div className="w-full h-full flex items-center justify-center" style={{ borderRadius: '50%', background: 'var(--bg-deep)' }}>
              <span style={{ fontSize: '10px', color: 'var(--accent-cyan)', fontWeight: 'bold' }}>AI</span>
            </div>
          </div>
          <div className="text-xs font-medium text-slate-300">小说辅写台</div>
        </div>
      </div>
    </aside>
  );
}
