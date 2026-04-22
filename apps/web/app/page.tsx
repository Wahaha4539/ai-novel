'use client';

import { useDashboardData } from '../hooks/useDashboardData';
import { WorkspaceSidebar } from '../components/WorkspaceSidebar';
import { EditorPanel } from '../components/EditorPanel';
import { InspectorPanel } from '../components/InspectorPanel';

export default function HomePage() {
  const data = useDashboardData();

  const selectedProject = data.projects.find((item) => item.id === data.selectedProjectId) ?? data.dashboard?.project;
  const chapters = data.dashboard?.chapters ?? [];

  return (
    <main className="flex h-full w-full">
      
      {/* 1. 左侧：工作台导航侧边栏 */}
      <WorkspaceSidebar
        projects={data.projects}
        chapters={chapters}
        selectedProjectId={data.selectedProjectId}
        setSelectedProjectId={data.setSelectedProjectId}
        selectedChapterId={data.selectedChapterId}
        setSelectedChapterId={data.setSelectedChapterId}
      />

      {/* 2. 主躯干：沉浸式编辑区 */}
      <section className="flex-1" style={{ position: 'relative', overflow: 'hidden' }}>
        <EditorPanel 
          selectedProject={selectedProject}
          selectedChapterId={data.selectedChapterId}
          chapters={chapters}
        />

        {/* 对于全局警告的 Toast 提示位置 */}
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

      {/* 3. 右侧：情报辅助台 (兼具预览与审计双重模态) */}
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
      
    </main>
  );
}
