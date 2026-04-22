import React from 'react';
import { ProjectSummary, ChapterSummary } from '../types/dashboard';
import { ThemeSwitcher } from './ThemeSwitcher';

interface Props {
  projects: ProjectSummary[];
  chapters: ChapterSummary[];
  selectedProjectId: string;
  selectedChapterId: string;
  setSelectedChapterId: (id: string) => void;
  showProjectManagement: boolean;
  onNavigateToProjects: () => void;
}

export function WorkspaceSidebar({
  projects,
  chapters,
  selectedProjectId,
  selectedChapterId,
  setSelectedChapterId,
  showProjectManagement,
  onNavigateToProjects,
}: Props) {
  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  return (
    <aside className="flex flex-col shrink-0 h-full" style={{ width: '16rem', borderRight: '1px solid var(--border-light)', background: 'var(--bg-sidebar)', backdropFilter: 'blur(24px)', overflow: 'hidden' }}>
      {/* Project Header — clickable to open project management */}
      <div
        className="p-5"
        style={{
          borderBottom: '1px solid var(--border-dim)',
          cursor: 'pointer',
          transition: 'background 0.2s ease',
        }}
        onClick={onNavigateToProjects}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover-subtle)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <h2
          className="text-sm font-bold mb-1 flex items-center gap-2"
          style={{
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            color: showProjectManagement ? 'var(--accent-cyan)' : 'var(--text-dim)',
          }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ opacity: 0.8 }}>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          项目
        </h2>
        {selectedProject ? (
          <div className="text-sm font-medium truncate" style={{ color: 'var(--text-main)' }}>
            {selectedProject.title}
          </div>
        ) : (
          <div className="text-xs" style={{ color: 'var(--text-dim)' }}>
            点击选择或管理项目
          </div>
        )}
      </div>

      {/* Conditional nav — only show when a project is selected and not in project management mode */}
      {selectedProjectId && !showProjectManagement && (
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
              <span style={{ fontSize: '10px', background: 'var(--bg-hover-subtle)', padding: '2px 6px', borderRadius: '4px' }}>{chapters.length}</span>
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
                      onMouseEnter={(e) => { if(!isActive) { e.currentTarget.style.background = 'var(--bg-hover-subtle)'; e.currentTarget.style.color = 'var(--text-main)' } }}
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
      )}

      {/* Empty space filler when nav is hidden */}
      {(!selectedProjectId || showProjectManagement) && (
        <div className="flex-1" />
      )}

      {/* Footer Profile or Settings block */}
      <div className="p-4" style={{ borderTop: '1px solid var(--border-dim)', background: 'var(--bg-sidebar-footer)' }}>
        <div className="flex items-center justify-between px-2">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center shrink-0" style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'linear-gradient(to top right, var(--accent-cyan), #34d399)', padding: '2px', boxShadow: '0 4px 10px var(--accent-cyan-glow)' }}>
              <div className="w-full h-full flex items-center justify-center" style={{ borderRadius: '50%', background: 'var(--bg-deep)' }}>
                <span style={{ fontSize: '10px', color: 'var(--accent-cyan)', fontWeight: 'bold' }}>AI</span>
              </div>
            </div>
            <div className="text-xs font-medium text-slate-300">小说辅写台</div>
          </div>
          <ThemeSwitcher />
        </div>
      </div>
    </aside>
  );
}
