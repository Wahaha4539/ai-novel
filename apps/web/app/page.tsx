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
    <main className="flex h-screen w-full overflow-hidden bg-[#030712] font-sans text-slate-200">
      
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
      <section className="flex-1 overflow-hidden relative">
        <EditorPanel 
          selectedProject={selectedProject}
          selectedChapterId={data.selectedChapterId}
          chapters={chapters}
        />

        {/* 对于全局警告的 Toast 提示位置，如果有报错漂浮在编辑区上方 */}
        {(data.error || data.actionMessage) && (
          <div className="absolute top-4 right-8 z-50 animate-in fade-in slide-in-from-top-4">
            <div className={`rounded-2xl border px-4 py-3 text-sm shadow-xl ${data.error ? 'border-rose-500/40 bg-rose-500/90 text-white backdrop-blur-md' : 'border-slate-700 bg-slate-800/90 text-emerald-100 backdrop-blur-md'}`}>
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
