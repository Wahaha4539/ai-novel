import React from 'react';
import { ProjectSummary, ChapterSummary, VolumeSummary } from '../types/dashboard';
import { ThemeSwitcher } from './ThemeSwitcher';
import { VolumeChapterTree } from './VolumeChapterTree';

type ActiveView =
  | 'editor'
  | 'outline'
  | 'lore'
  | 'story-bible'
  | 'writing-rules'
  | 'scene-bank'
  | 'pacing'
  | 'chapter-patterns'
  | 'quality-reports'
  | 'scoring-center'
  | 'relationships'
  | 'timeline'
  | 'character-state'
  | 'generation-config'
  | 'projects'
  | 'volumes'
  | 'prompts'
  | 'foreshadow'
  | 'generate'
  | 'agent'
  | 'llm-config';

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
  onNavigateToEditor: () => void;
  onNavigateToOutline: () => void;
  onNavigateToLore: () => void;
  onNavigateToStoryBible: () => void;
  onNavigateToWritingRules: () => void;
  onNavigateToSceneBank: () => void;
  onNavigateToPacing: () => void;
  onNavigateToChapterPatterns: () => void;
  onNavigateToQualityReports: () => void;
  onNavigateToScoringCenter: () => void;
  onNavigateToRelationships: () => void;
  onNavigateToTimeline: () => void;
  onNavigateToCharacterState: () => void;
  onNavigateToGenerationConfig: () => void;
  onNavigateToVolumes: () => void;
  onNavigateToPrompts: () => void;
  onNavigateToForeshadow: () => void;
  onNavigateToGenerate: () => void;
  onNavigateToAgent: () => void;
  onNavigateToLlmConfig: () => void;
  onSelectVolume: (id: string) => void;
  onDeleteChapters: (chapterIds: string[]) => Promise<boolean>;
}

type NavItem = {
  view: ActiveView;
  label: string;
  detail: string;
  accent: string;
  onClick: () => void;
  step?: string;
};

type NavSection = {
  title: string;
  items: NavItem[];
};

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
  onNavigateToEditor,
  onNavigateToOutline,
  onNavigateToLore,
  onNavigateToStoryBible,
  onNavigateToWritingRules,
  onNavigateToSceneBank,
  onNavigateToPacing,
  onNavigateToChapterPatterns,
  onNavigateToQualityReports,
  onNavigateToScoringCenter,
  onNavigateToRelationships,
  onNavigateToTimeline,
  onNavigateToCharacterState,
  onNavigateToGenerationConfig,
  onNavigateToVolumes,
  onNavigateToPrompts,
  onNavigateToForeshadow,
  onNavigateToGenerate,
  onNavigateToAgent,
  onNavigateToLlmConfig,
  onSelectVolume,
  onDeleteChapters,
}: Props) {
  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  const workflowItems: NavItem[] = [
    {
      view: 'agent',
      label: 'Agent 工作台',
      detail: '任务 / 计划 / 审批',
      accent: '#22c55e',
      step: '01',
      onClick: onNavigateToAgent,
    },
    {
      view: 'volumes',
      label: '卷与章节',
      detail: '卷纲 / 章目 / 顺序',
      accent: '#14b8a6',
      step: '02',
      onClick: onNavigateToVolumes,
    },
    {
      view: 'editor',
      label: '正文编辑',
      detail: selectedChapterId === 'all' ? '选择章节后写作' : '当前章节正文',
      accent: '#f59e0b',
      step: '03',
      onClick: onNavigateToEditor,
    },
    {
      view: 'generate',
      label: '批量生成',
      detail: '章节正文生产',
      accent: '#06b6d4',
      step: '04',
      onClick: onNavigateToGenerate,
    },
  ];

  const navSections: NavSection[] = [
    {
      title: '故事规划',
      items: [
        { view: 'outline', label: '剧情大纲', detail: '主线 / 卷纲', accent: '#f97316', onClick: onNavigateToOutline },
        { view: 'story-bible', label: '世界设定', detail: '规则 / 地点 / 势力', accent: '#10b981', onClick: onNavigateToStoryBible },
        { view: 'lore', label: '角色与设定', detail: '人物 / 设定条目', accent: '#8b5cf6', onClick: onNavigateToLore },
        { view: 'relationships', label: '人物关系', detail: '关系网 / 变化', accent: '#14b8a6', onClick: onNavigateToRelationships },
        { view: 'timeline', label: '时间线', detail: '事件 / 因果', accent: '#6366f1', onClick: onNavigateToTimeline },
      ],
    },
    {
      title: '写作素材',
      items: [
        { view: 'scene-bank', label: '场景库', detail: '场景卡 / 冲突', accent: '#f97316', onClick: onNavigateToSceneBank },
        { view: 'pacing', label: '节奏控制', detail: '节拍 / 密度', accent: '#22c55e', onClick: onNavigateToPacing },
        { view: 'chapter-patterns', label: '章节模式', detail: '结构模板', accent: '#a855f7', onClick: onNavigateToChapterPatterns },
        { view: 'foreshadow', label: '伏笔看板', detail: '埋设 / 回收', accent: '#ef4444', onClick: onNavigateToForeshadow },
        { view: 'writing-rules', label: '写作规则', detail: '风格 / 禁写', accent: '#f43f5e', onClick: onNavigateToWritingRules },
      ],
    },
    {
      title: '质量与运营',
      items: [
        { view: 'scoring-center', label: '评分中心', detail: '多维评分', accent: '#22c55e', onClick: onNavigateToScoringCenter },
        { view: 'quality-reports', label: '质量报告', detail: '审稿 / 问题', accent: '#0ea5e9', onClick: onNavigateToQualityReports },
        { view: 'character-state', label: '角色状态', detail: '阶段状态', accent: '#38bdf8', onClick: onNavigateToCharacterState },
      ],
    },
    {
      title: '系统配置',
      items: [
        { view: 'generation-config', label: '生成配置', detail: '模型参数', accent: '#38bdf8', onClick: onNavigateToGenerationConfig },
        { view: 'prompts', label: '提示词管理', detail: '模板 / 版本', accent: '#f59e0b', onClick: onNavigateToPrompts },
      ],
    },
  ];

  return (
    <aside className="workspace-sidebar workspace-sidebar-redesign flex flex-col shrink-0 h-full">
      <button
        type="button"
        className={`workspace-project-switcher ${showProjectManagement ? 'workspace-project-switcher--active' : ''}`}
        onClick={onNavigateToProjects}
      >
        <span className="workspace-project-switcher__eyebrow">项目</span>
        <span className="workspace-project-switcher__title">
          {selectedProject ? selectedProject.title : '选择或创建项目'}
        </span>
        <span className="workspace-project-switcher__meta">
          {selectedProject ? `${volumes.length} 卷 / ${chapters.length} 章` : `${projects.length} 个项目`}
        </span>
      </button>

      {selectedProject && selectedProjectId && !showProjectManagement ? (
        <nav className="workspace-nav" aria-label="创作流程导航">
          <section className="workspace-nav-section workspace-nav-section--primary">
            <div className="workspace-nav-section__title">开始创作</div>
            <ul className="workspace-nav-list">
              {workflowItems.map((item) => (
                <li key={item.view}>
                  <NavButton item={item} isActive={activeView === item.view} />
                </li>
              ))}
            </ul>
          </section>

          {navSections.map((section) => (
            <section key={section.title} className="workspace-nav-section">
              <div className="workspace-nav-section__title">{section.title}</div>
              <ul className="workspace-nav-list">
                {section.items.map((item) => (
                  <li key={item.view}>
                    <NavButton item={item} isActive={activeView === item.view} />
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <section className="workspace-nav-section workspace-nav-section--tree">
            <div className="workspace-nav-section__title">卷章节树</div>
            <VolumeChapterTree
              volumes={volumes}
              chapters={chapters}
              selectedChapterId={selectedChapterId}
              selectedVolumeId={selectedVolumeId}
              onSelectChapter={setSelectedChapterId}
              onSelectVolume={onSelectVolume}
              onDeleteChapters={onDeleteChapters}
            />
          </section>
        </nav>
      ) : (
        <div className="flex-1" />
      )}

      <footer className="workspace-sidebar-footer">
        <button
          type="button"
          onClick={onNavigateToLlmConfig}
          className={`workspace-llm-button ${activeView === 'llm-config' ? 'workspace-llm-button--active' : ''}`}
        >
          <span>LLM 配置</span>
          <span className="workspace-llm-button__status">全局</span>
        </button>

        <div className="workspace-sidebar-brand">
          <div className="workspace-sidebar-brand__mark">AI</div>
          <div className="workspace-sidebar-brand__copy">小说辅写台</div>
          <ThemeSwitcher />
        </div>
      </footer>
    </aside>
  );
}

function NavButton({ item, isActive }: { item: NavItem; isActive: boolean }) {
  const style = { '--nav-accent': item.accent } as React.CSSProperties;

  return (
    <button
      type="button"
      onClick={item.onClick}
      className={`workspace-nav-button ${isActive ? 'workspace-nav-button--active' : ''} ${item.step ? 'workspace-nav-button--workflow' : ''}`}
      style={style}
    >
      <span className="workspace-nav-button__rail">{item.step ?? ''}</span>
      <span className="workspace-nav-button__copy">
        <span className="workspace-nav-button__label">{item.label}</span>
        <span className="workspace-nav-button__detail">{item.detail}</span>
      </span>
    </button>
  );
}
