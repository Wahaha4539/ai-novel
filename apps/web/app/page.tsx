'use client';

import { useState, useCallback } from 'react';
import { useDashboardData } from '../hooks/useDashboardData';
import { WorkspaceSidebar } from '../components/WorkspaceSidebar';
import { EditorPanel } from '../components/EditorPanel';
import { InspectorPanel } from '../components/InspectorPanel';
import { ProjectManagementPanel } from '../components/ProjectManagementPanel';

export default function HomePage() {
  const data = useDashboardData();
  const [showProjectManagement, setShowProjectManagement] = useState(true);

  const selectedProject = data.projects.find((item) => item.id === data.selectedProjectId) ?? data.dashboard?.project;
  const chapters = data.dashboard?.chapters ?? [];

  const handleSelectProject = useCallback((id: string) => {
    data.setSelectedProjectId(id);
    data.setSelectedChapterId('all');
    if (id) {
      setShowProjectManagement(false);
    }
  }, [data]);

  const handleNavigateToProjects = useCallback(() => {
    setShowProjectManagement(true);
  }, []);

  const handleProjectsChanged = useCallback(async () => {
    await data.loadProjects();
  }, [data]);

  const hasProject = !!data.selectedProjectId;
  const showEditor = hasProject && !showProjectManagement;

  return (
    <main className="flex h-full w-full">

      {/* 1. 左侧：工作台导航侧边栏 */}
      <WorkspaceSidebar
        projects={data.projects}
        chapters={chapters}
        selectedProjectId={data.selectedProjectId}
        selectedChapterId={data.selectedChapterId}
        setSelectedChapterId={data.setSelectedChapterId}
        showProjectManagement={showProjectManagement}
        onNavigateToProjects={handleNavigateToProjects}
      />

      {/* 2. 主躯干：项目管理 或 沉浸式编辑区 */}
      <section className="flex-1" style={{ position: 'relative', overflow: 'hidden' }}>
        {showProjectManagement || !hasProject ? (
          <ProjectManagementPanel
            projects={data.projects}
            selectedProjectId={data.selectedProjectId}
            onSelectProject={handleSelectProject}
            onProjectsChanged={handleProjectsChanged}
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

      {/* 3. 右侧：情报辅助台 — 仅在选中项目且非项目管理模式时显示 */}
      {showEditor && (
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
