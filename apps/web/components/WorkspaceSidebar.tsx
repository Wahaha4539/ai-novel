import React from 'react';
import { ProjectSummary, ChapterSummary, VolumeSummary } from '../types/dashboard';
import { ThemeSwitcher } from './ThemeSwitcher';
import { VolumeChapterTree } from './VolumeChapterTree';

type ActiveView = 'editor' | 'outline' | 'lore' | 'projects' | 'volumes' | 'guided' | 'prompts' | 'foreshadow' | 'generate' | 'llm-config';

interface Props {
  projects: ProjectSummary[];
  volumes: VolumeSummary[];
  chapters: ChapterSummary[];
  selectedProjectId: string;
  selectedChapterId: string;
  selectedVolumeId: string;
  setSelectedChapterId: (id: string) => void;
  showProjectManagement: boolean;
  activeView: ActiveView;
  onNavigateToProjects: () => void;
  onNavigateToOutline: () => void;
  onNavigateToLore: () => void;
  onNavigateToVolumes: () => void;
  onNavigateToGuided: () => void;
  onNavigateToPrompts: () => void;
  onNavigateToForeshadow: () => void;
  onNavigateToGenerate: () => void;
  onNavigateToLlmConfig: () => void;
  onSelectVolume: (id: string) => void;
}

export function WorkspaceSidebar({
  projects,
  volumes,
  chapters,
  selectedProjectId,
  selectedChapterId,
  selectedVolumeId,
  setSelectedChapterId,
  showProjectManagement,
  activeView,
  onNavigateToProjects,
  onNavigateToOutline,
  onNavigateToLore,
  onNavigateToVolumes,
  onNavigateToGuided,
  onNavigateToPrompts,
  onNavigateToForeshadow,
  onNavigateToGenerate,
  onNavigateToLlmConfig,
  onSelectVolume,
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
                <NavButton
                  label="剧情大纲 (Outline)"
                  isActive={activeView === 'outline'}
                  activeColor="#f59e0b"
                  onClick={onNavigateToOutline}
                />
              </li>
              <li>
                <NavButton
                  label="角色与设定 (Lore)"
                  isActive={activeView === 'lore'}
                  activeColor="#8b5cf6"
                  onClick={onNavigateToLore}
                />
              </li>
              <li>
                <NavButton
                  label="卷管理 (Volumes)"
                  isActive={activeView === 'volumes'}
                  activeColor="#14b8a6"
                  onClick={onNavigateToVolumes}
                />
              </li>
              <li>
                <NavButton
                  label="✨ 创作引导 (AI)"
                  isActive={activeView === 'guided'}
                  activeColor="#ec4899"
                  onClick={onNavigateToGuided}
                />
              </li>
              <li>
                <NavButton
                  label="🤖 AI 生成 (Generate)"
                  isActive={activeView === 'generate'}
                  activeColor="#06b6d4"
                  onClick={onNavigateToGenerate}
                />
              </li>
              <li>
                <NavButton
                  label="提示词管理 (Prompts)"
                  isActive={activeView === 'prompts'}
                  activeColor="#f59e0b"
                  onClick={onNavigateToPrompts}
                />
              </li>
              <li>
                <NavButton
                  label="伏笔看板 (Foreshadow)"
                  isActive={activeView === 'foreshadow'}
                  activeColor="#ef4444"
                  onClick={onNavigateToForeshadow}
                />
              </li>
            </ul>
          </div>

          {/* Volume → Chapter Tree */}
          <VolumeChapterTree
            volumes={volumes}
            chapters={chapters}
            selectedChapterId={selectedChapterId}
            selectedVolumeId={selectedVolumeId}
            onSelectChapter={setSelectedChapterId}
            onSelectVolume={onSelectVolume}
          />
        </nav>
      )}

      {/* Empty space filler when nav is hidden */}
      {(!selectedProjectId || showProjectManagement) && (
        <div className="flex-1" />
      )}

      {/* Footer Profile or Settings block */}
      {/* Footer — always visible: LLM config + branding */}
      <div className="p-4" style={{ borderTop: '1px solid var(--border-dim)', background: 'var(--bg-sidebar-footer)' }}>
        {/* LLM Config — global, always accessible */}
        <button
          onClick={onNavigateToLlmConfig}
          className="flex items-center gap-2 w-full px-3 py-2 mb-3"
          style={{
            borderRadius: '0.5rem',
            fontSize: '0.8rem',
            fontWeight: activeView === 'llm-config' ? 700 : 500,
            cursor: 'pointer',
            border: `1px solid ${activeView === 'llm-config' ? 'rgba(245,158,11,0.4)' : 'var(--border-dim)'}`,
            background: activeView === 'llm-config' ? 'rgba(245,158,11,0.08)' : 'transparent',
            color: activeView === 'llm-config' ? '#f59e0b' : 'var(--text-muted)',
            transition: 'all 0.2s ease',
          }}
        >
          🔧 LLM 配置
        </button>

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

/** Reusable nav button to reduce duplication */
function NavButton({
  label,
  isActive,
  activeColor,
  onClick,
}: {
  label: string;
  isActive: boolean;
  activeColor: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 text-sm font-medium p-2"
      style={{
        borderRadius: '0.5rem',
        transition: 'all 0.3s ease',
        background: isActive ? `${activeColor}18` : 'transparent',
        color: isActive ? activeColor : 'var(--text-muted)',
        boxShadow: isActive ? `inset 2px 0 0 ${activeColor}` : 'none',
        fontWeight: isActive ? 500 : 400,
        border: 'none',
        cursor: 'pointer',
        textAlign: 'left',
      }}
      onMouseEnter={(e) => {
        if (!isActive) {
          e.currentTarget.style.background = 'var(--bg-hover-subtle)';
          e.currentTarget.style.color = 'var(--text-main)';
        }
      }}
      onMouseLeave={(e) => {
        if (!isActive) {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'var(--text-muted)';
        }
      }}
    >
      <div
        style={{
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: activeColor,
          boxShadow: `0 0 8px ${activeColor}80`,
        }}
      />
      {label}
    </button>
  );
}
