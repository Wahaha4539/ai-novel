'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useDashboardData } from '../hooks/useDashboardData';
import { WorkspaceSidebar } from '../components/WorkspaceSidebar';
import { EditorPanel } from '../components/EditorPanel';
import { InspectorPanel } from '../components/InspectorPanel';
import { ProjectManagementPanel } from '../components/ProjectManagementPanel';
import { OutlinePanel } from '../components/OutlinePanel';
import { LorePanel } from '../components/LorePanel';
import { VolumePanel } from '../components/VolumePanel';
import { GuidedWizard } from '../components/guided/GuidedWizard';
import { PromptManagerPanel } from '../components/PromptManagerPanel';
import { ForeshadowBoard } from '../components/ForeshadowBoard';
import { BatchGeneratePanel } from '../components/BatchGeneratePanel';
import { LlmProviderPanel } from '../components/LlmProviderPanel';
import { AgentFloatingOrb } from '../components/agent/AgentFloatingOrb';

type ActiveView = 'editor' | 'outline' | 'lore' | 'projects' | 'volumes' | 'guided' | 'prompts' | 'foreshadow' | 'generate' | 'llm-config';

export default function HomePage() {
  const data = useDashboardData();
  const [activeView, setActiveView] = useState<ActiveView>('projects');
  const [selectedVolumeId, setSelectedVolumeId] = useState('');
  const [autoStartGuided, setAutoStartGuided] = useState(false);
  const [isToastVisible, setIsToastVisible] = useState(false);
  const loadProjectDataRef = useRef(data.loadProjectData);

  const selectedProject = data.projects.find((item) => item.id === data.selectedProjectId) ?? data.dashboard?.project;
  const chapters = data.dashboard?.chapters ?? [];
  const toastMessage = data.error || data.actionMessage;

  useEffect(() => {
    loadProjectDataRef.current = data.loadProjectData;
  }, [data.loadProjectData]);

  useEffect(() => {
    if (activeView !== 'foreshadow' || !data.selectedProjectId) return;

    // 伏笔看板依赖全局 dashboard 缓存；从 AI 引导页写入后切换过来时，
    // 主数据可能尚未重新拉取，因此进入看板时主动刷新一次事实层伏笔。
    void loadProjectDataRef.current(data.selectedProjectId, data.selectedChapterId);
  }, [activeView, data.selectedChapterId, data.selectedProjectId]);

  useEffect(() => {
    if (!toastMessage) {
      setIsToastVisible(false);
      return;
    }

    setIsToastVisible(true);

    // Toast 只是轻量反馈层，不能因为底层 actionMessage 未清空而永久遮挡编辑区。
    // 每次文案变化都重新计时，长任务的阶段更新仍会继续短暂展示。
    const timeoutId = window.setTimeout(() => {
      setIsToastVisible(false);
    }, 6000);

    return () => window.clearTimeout(timeoutId);
  }, [toastMessage]);

  const handleSelectProject = useCallback((id: string) => {
    data.setSelectedProjectId(id);
    data.setSelectedChapterId('all');
    setSelectedVolumeId('');
    if (id) {
      setActiveView('editor');
    }
  }, [data]);

  const handleNavigateToProjects = useCallback(() => {
    setActiveView('projects');
  }, []);

  const handleNavigateToOutline = useCallback(() => {
    setActiveView('outline');
  }, []);

  const handleNavigateToLore = useCallback(() => {
    setActiveView('lore');
  }, []);

  const handleNavigateToVolumes = useCallback(() => {
    setActiveView('volumes');
  }, []);

  const handleNavigateToGuided = useCallback(() => {
    setActiveView('guided');
  }, []);

  const handleNavigateToPrompts = useCallback(() => {
    setActiveView('prompts');
  }, []);

  const handleNavigateToForeshadow = useCallback(() => {
    setActiveView('foreshadow');
  }, []);

  /** Navigate to AI batch generation view */
  const handleNavigateToGenerate = useCallback(() => {
    setActiveView('generate');
  }, []);



  /** Navigate to LLM provider configuration */
  const handleNavigateToLlmConfig = useCallback(() => {
    setActiveView('llm-config');
  }, []);

  const handleSelectVolume = useCallback((volumeId: string) => {
    setSelectedVolumeId(volumeId);
    setActiveView('volumes');
  }, []);

  const handleSelectChapter = useCallback((chapterId: string) => {
    data.setSelectedChapterId(chapterId);
    setSelectedVolumeId('');
    setActiveView('editor');
  }, [data]);

  const handleProjectsChanged = useCallback(async () => {
    await data.loadProjects();
  }, [data]);

  const handleGuidedCreate = useCallback((projectId: string) => {
    data.setSelectedProjectId(projectId);
    data.setSelectedChapterId('all');
    setSelectedVolumeId('');
    setAutoStartGuided(true);
    setActiveView('guided');
  }, [data]);

  const showProjectManagement = activeView === 'projects';
  const hasProject = !!data.selectedProjectId;
  const showInspector = hasProject && activeView === 'editor';

  return (
    <main className="flex h-full w-full">

      {/* 1. 左侧：工作台导航侧边栏 */}
      <WorkspaceSidebar
        projects={data.projects}
        volumes={data.volumes}
        chapters={chapters}
        selectedProjectId={data.selectedProjectId}
        selectedChapterId={data.selectedChapterId}
        selectedVolumeId={selectedVolumeId}
        setSelectedChapterId={handleSelectChapter}
        showProjectManagement={showProjectManagement}
        activeView={activeView}
        onNavigateToProjects={handleNavigateToProjects}
        onNavigateToOutline={handleNavigateToOutline}
        onNavigateToLore={handleNavigateToLore}
        onNavigateToVolumes={handleNavigateToVolumes}
        onNavigateToGuided={handleNavigateToGuided}
        onNavigateToPrompts={handleNavigateToPrompts}
        onNavigateToForeshadow={handleNavigateToForeshadow}
        onNavigateToGenerate={handleNavigateToGenerate}

        onNavigateToLlmConfig={handleNavigateToLlmConfig}
        onSelectVolume={handleSelectVolume}
      />

      {/* 2. 主躯干：根据 activeView 切换面板 */}
      <section className="flex-1" style={{ position: 'relative', overflow: 'hidden' }}>
        {/* LLM config is global — renders without requiring a project */}
        {activeView === 'llm-config' ? (
          <LlmProviderPanel />
        ) : activeView === 'projects' || !hasProject ? (
          <ProjectManagementPanel
            projects={data.projects}
            selectedProjectId={data.selectedProjectId}
            onSelectProject={handleSelectProject}
            onProjectsChanged={handleProjectsChanged}
            onGuidedCreate={handleGuidedCreate}
          />
        ) : activeView === 'outline' ? (
          <OutlinePanel selectedProject={selectedProject} />
        ) : activeView === 'lore' ? (
          <LorePanel selectedProject={selectedProject} selectedProjectId={data.selectedProjectId} />
        ) : activeView === 'volumes' ? (
          <VolumePanel selectedProject={selectedProject} selectedProjectId={data.selectedProjectId} chapters={chapters} />
        ) : activeView === 'guided' ? (
          <GuidedWizard selectedProject={selectedProject} selectedProjectId={data.selectedProjectId} autoStart={autoStartGuided} onDataChanged={() => data.loadProjectData(data.selectedProjectId, data.selectedChapterId)} />
        ) : activeView === 'prompts' ? (
          <PromptManagerPanel selectedProject={selectedProject} selectedProjectId={data.selectedProjectId} />
        ) : activeView === 'foreshadow' ? (
          <ForeshadowBoard
            selectedProject={selectedProject}
            selectedProjectId={data.selectedProjectId}
            foreshadowTracks={data.foreshadowTracks}
            onRefresh={() => data.loadProjectData(data.selectedProjectId, data.selectedChapterId)}
          />
        ) : activeView === 'generate' ? (
          <BatchGeneratePanel
            projectId={data.selectedProjectId}
            volumes={data.volumes}
            chapters={chapters}
            onComplete={async (chapterIds?: string[]) => {
              await data.loadProjectData(data.selectedProjectId, data.selectedChapterId);
            }}
          />

        ) : (
          <EditorPanel
            selectedProject={selectedProject}
            selectedChapterId={data.selectedChapterId}
            chapters={chapters}
            draftRefreshKey={data.draftRefreshKey}
            onRunAutoMaintenance={data.runAutoMaintenance}
            onMarkChapterComplete={data.markChapterComplete}
          />
        )}

        {/* 全局 Toast 提示 */}
        {toastMessage && isToastVisible && (
          <div className="animate-slide-top" style={{ position: 'absolute', top: '1rem', right: '2rem', zIndex: 50 }}>
            <div
              className="panel px-4 py-3 text-sm"
              style={{
                borderColor: data.error ? 'var(--status-err)' : 'var(--accent-cyan)',
                background: data.error ? 'var(--status-err-bg)' : 'var(--accent-cyan-bg)',
                color: data.error ? '#ffe4e6' : '#ccfbf1'
              }}>
              {toastMessage}
            </div>
          </div>
        )}
      </section>

      {/* 3. 右侧：情报辅助台 — 仅在编辑器视图时显示 */}
      {showInspector && (
        <InspectorPanel
          selectedProject={selectedProject}
          chapters={chapters}
          selectedProjectId={data.selectedProjectId}
          selectedChapterId={data.selectedChapterId}
          storyEvents={data.storyEvents}
          characterStates={data.characterStates}
          foreshadowTracks={data.foreshadowTracks}
          reviewQueue={data.reviewQueue}
          acceptedMemories={data.acceptedMemories}
          validationIssues={data.validationIssues}
          loading={data.loading}
          rebuildResult={data.rebuildResult}
          validationRunResult={data.validationRunResult}
          onRefresh={data.loadProjectData}
          onRunRebuild={data.runRebuild}
          onRunValidation={data.runValidation}
          onRunReviewAction={data.runReviewAction}
          onFixValidationIssues={data.fixValidationIssues}
          onRunAiReviewQueue={data.runAiReviewQueue}
          fixingValidationIssueId={data.fixingValidationIssueId}
        />
      )}

      {/* 4. Agent 悬浮圆球 — 全局可见，不依赖 activeView */}
      {hasProject && (
        <AgentFloatingOrb
          projectId={data.selectedProjectId}
          selectedChapterId={data.selectedChapterId !== 'all' ? data.selectedChapterId : undefined}
          onRefresh={() => data.loadProjectData(data.selectedProjectId, data.selectedChapterId)}
        />
      )}

    </main>
  );
}
