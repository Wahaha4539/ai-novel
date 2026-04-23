'use client';

import { useState, useCallback } from 'react';
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

type ActiveView = 'editor' | 'outline' | 'lore' | 'projects' | 'volumes' | 'guided' | 'prompts' | 'foreshadow' | 'generate';

export default function HomePage() {
  const data = useDashboardData();
  const [activeView, setActiveView] = useState<ActiveView>('projects');
  const [selectedVolumeId, setSelectedVolumeId] = useState('');
  const [autoStartGuided, setAutoStartGuided] = useState(false);

  const selectedProject = data.projects.find((item) => item.id === data.selectedProjectId) ?? data.dashboard?.project;
  const chapters = data.dashboard?.chapters ?? [];

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
        onSelectVolume={handleSelectVolume}
      />

      {/* 2. 主躯干：根据 activeView 切换面板 */}
      <section className="flex-1" style={{ position: 'relative', overflow: 'hidden' }}>
        {activeView === 'projects' || !hasProject ? (
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
            volumes={data.volumes}
            chapters={chapters}
            onComplete={() => data.loadProjectData(data.selectedProjectId, data.selectedChapterId)}
          />
        ) : (
          <EditorPanel
            selectedProject={selectedProject}
            selectedChapterId={data.selectedChapterId}
            chapters={chapters}
          />
        )}

        {/* 全局 Toast 提示 */}
        {(data.error || data.actionMessage) && (
          <div className="animate-slide-top" style={{ position: 'absolute', top: '1rem', right: '2rem', zIndex: 50 }}>
            <div
              className="panel px-4 py-3 text-sm"
              style={{
                borderColor: data.error ? 'var(--status-err)' : 'var(--accent-cyan)',
                background: data.error ? 'var(--status-err-bg)' : 'var(--accent-cyan-bg)',
                color: data.error ? '#ffe4e6' : '#ccfbf1'
              }}>
              {data.error || data.actionMessage}
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
          validationIssues={data.validationIssues}
          loading={data.loading}
          rebuildResult={data.rebuildResult}
          validationRunResult={data.validationRunResult}
          onRefresh={data.loadProjectData}
          onRunRebuild={data.runRebuild}
          onRunValidation={data.runValidation}
          onRunReviewAction={data.runReviewAction}
        />
      )}

    </main>
  );
}
