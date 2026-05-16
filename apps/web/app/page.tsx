'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useDashboardData } from '../hooks/useDashboardData';
import { WorkspaceSidebar } from '../components/WorkspaceSidebar';
import { EditorPanel } from '../components/EditorPanel';
import { InspectorPanel } from '../components/InspectorPanel';
import { ProjectManagementPanel } from '../components/ProjectManagementPanel';
import { OutlinePanel } from '../components/OutlinePanel';
import { LorePanel } from '../components/LorePanel';
import { StoryBiblePanel } from '../components/StoryBiblePanel';
import { GenerationConfigPanel } from '../components/GenerationConfigPanel';
import { VolumePanel } from '../components/VolumePanel';
import { PromptManagerPanel } from '../components/PromptManagerPanel';
import { ForeshadowBoard } from '../components/ForeshadowBoard';
import { BatchGeneratePanel } from '../components/BatchGeneratePanel';
import { LlmProviderPanel } from '../components/LlmProviderPanel';
import { WritingRulesPanel } from '../components/WritingRulesPanel';
import { RelationshipMapPanel } from '../components/RelationshipMapPanel';
import { TimelinePanel } from '../components/TimelinePanel';
import { CharacterStatePanel } from '../components/CharacterStatePanel';
import { SceneBankPanel } from '../components/SceneBankPanel';
import { PacingPanel } from '../components/PacingPanel';
import { ChapterPatternPanel } from '../components/ChapterPatternPanel';
import { QualityReportPanel } from '../components/QualityReportPanel';
import { ScoringCenterPanel } from '../components/ScoringCenterPanel';
import { AgentFloatingOrb } from '../components/agent/AgentFloatingOrb';
import { AgentWorkspace } from '../components/agent/AgentWorkspace';
import { AgentPageContext } from '../hooks/useAgentRun';
import type { PassageAgentContext } from '../components/editor/passageSelection';

type ActiveView = 'editor' | 'outline' | 'lore' | 'story-bible' | 'writing-rules' | 'scene-bank' | 'pacing' | 'chapter-patterns' | 'quality-reports' | 'scoring-center' | 'relationships' | 'timeline' | 'character-state' | 'generation-config' | 'projects' | 'volumes' | 'prompts' | 'foreshadow' | 'generate' | 'agent' | 'llm-config';

const WORKSPACE_STATE_STORAGE_KEY = 'ai-novel:workspace-state';
const ACTIVE_VIEWS: ActiveView[] = ['editor', 'outline', 'lore', 'story-bible', 'writing-rules', 'scene-bank', 'pacing', 'chapter-patterns', 'quality-reports', 'scoring-center', 'relationships', 'timeline', 'character-state', 'generation-config', 'projects', 'volumes', 'prompts', 'foreshadow', 'generate', 'agent', 'llm-config'];

type WorkspaceState = {
  activeView: ActiveView;
  selectedProjectId: string;
  selectedChapterId: string;
  selectedVolumeId: string;
};

function isActiveView(value: string | undefined): value is ActiveView {
  return ACTIVE_VIEWS.includes(value as ActiveView);
}

/** Read the last workspace route-like state from localStorage so refresh keeps the current editor context. */
function readWorkspaceState(): Partial<WorkspaceState> {
  if (typeof window === 'undefined') return {};

  try {
    const parsed = JSON.parse(window.localStorage.getItem(WORKSPACE_STATE_STORAGE_KEY) ?? '{}') as {
      activeView?: unknown;
      selectedProjectId?: unknown;
      selectedChapterId?: unknown;
      selectedVolumeId?: unknown;
    };
    const storedActiveView = typeof parsed.activeView === 'string' ? parsed.activeView : undefined;
    const activeView = storedActiveView === 'guided' ? 'agent' : storedActiveView;
    return {
      activeView: isActiveView(activeView) ? activeView : undefined,
      selectedProjectId: typeof parsed.selectedProjectId === 'string' ? parsed.selectedProjectId : undefined,
      selectedChapterId: typeof parsed.selectedChapterId === 'string' ? parsed.selectedChapterId : undefined,
      selectedVolumeId: typeof parsed.selectedVolumeId === 'string' ? parsed.selectedVolumeId : undefined,
    };
  } catch {
    return {};
  }
}

/** Persist the workspace selection; this app is a single page, so localStorage acts as lightweight routing state. */
function writeWorkspaceState(state: WorkspaceState) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(WORKSPACE_STATE_STORAGE_KEY, JSON.stringify(state));
}

export default function HomePage() {
  const data = useDashboardData();
  const [activeView, setActiveView] = useState<ActiveView>('projects');
  const [selectedVolumeId, setSelectedVolumeId] = useState('');
  const [pendingAgentRequest, setPendingAgentRequest] = useState<{ id: string; message: string; pageContext: AgentPageContext } | undefined>();
  const [isToastVisible, setIsToastVisible] = useState(false);
  const [volumeRefreshSignal, setVolumeRefreshSignal] = useState(0);
  const [workspaceStateRestored, setWorkspaceStateRestored] = useState(false);
  const loadProjectDataRef = useRef(data.loadProjectData);

  const projectListItem = data.projects.find((item) => item.id === data.selectedProjectId);
  const dashboardProject = data.dashboard?.project?.id === data.selectedProjectId ? data.dashboard.project : undefined;
  const selectedProject = dashboardProject && projectListItem
    ? {
        ...projectListItem,
        ...dashboardProject,
        synopsis: dashboardProject.synopsis ?? projectListItem.synopsis,
        outline: dashboardProject.outline ?? projectListItem.outline,
        stats: { ...(projectListItem.stats ?? {}), ...(dashboardProject.stats ?? {}) },
      }
    : dashboardProject ?? projectListItem;
  const chapters = data.dashboard?.chapters ?? [];
  const toastMessage = data.error || data.actionMessage;

  useEffect(() => {
    loadProjectDataRef.current = data.loadProjectData;
  }, [data.loadProjectData]);

  useEffect(() => {
    const state = readWorkspaceState();
    if (state.selectedProjectId) {
      data.setSelectedProjectId(state.selectedProjectId);
      data.setSelectedChapterId(state.selectedChapterId || 'all');
    }
    if (state.selectedVolumeId) {
      setSelectedVolumeId(state.selectedVolumeId);
    }
    if (state.activeView) {
      setActiveView(state.activeView);
    }
    setWorkspaceStateRestored(true);
    // 只在首次挂载时恢复；后续导航由下面的持久化 effect 接管，避免来回覆盖用户操作。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!workspaceStateRestored) return;

    writeWorkspaceState({
      activeView,
      selectedProjectId: data.selectedProjectId,
      selectedChapterId: data.selectedChapterId,
      selectedVolumeId,
    });
  }, [activeView, data.selectedChapterId, data.selectedProjectId, selectedVolumeId, workspaceStateRestored]);

  useEffect(() => {
    if (activeView !== 'foreshadow' || !data.selectedProjectId) return;

    // 伏笔看板依赖全局 dashboard 缓存；从 Agent 或其他写入页切换过来时，
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

  const handleNavigateToEditor = useCallback(() => {
    setActiveView('editor');
  }, []);

  const handleNavigateToOutline = useCallback(() => {
    setActiveView('outline');
  }, []);

  const handleNavigateToLore = useCallback(() => {
    setActiveView('lore');
  }, []);

  const handleNavigateToStoryBible = useCallback(() => {
    setActiveView('story-bible');
  }, []);

  const handleNavigateToWritingRules = useCallback(() => {
    setActiveView('writing-rules');
  }, []);

  const handleNavigateToSceneBank = useCallback(() => {
    setActiveView('scene-bank');
  }, []);

  const handleNavigateToPacing = useCallback(() => {
    setActiveView('pacing');
  }, []);

  const handleNavigateToChapterPatterns = useCallback(() => {
    setActiveView('chapter-patterns');
  }, []);

  const handleNavigateToQualityReports = useCallback(() => {
    setActiveView('quality-reports');
  }, []);

  const handleNavigateToScoringCenter = useCallback(() => {
    setActiveView('scoring-center');
  }, []);

  const handleNavigateToRelationships = useCallback(() => {
    setActiveView('relationships');
  }, []);

  const handleNavigateToTimeline = useCallback(() => {
    setActiveView('timeline');
  }, []);

  const handleNavigateToCharacterState = useCallback(() => {
    setActiveView('character-state');
  }, []);

  const handleNavigateToGenerationConfig = useCallback(() => {
    setActiveView('generation-config');
  }, []);

  const handleNavigateToVolumes = useCallback(() => {
    setActiveView('volumes');
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

  /** Navigate to Agent Workspace for natural-language Plan/Act tasks */
  const handleNavigateToAgent = useCallback(() => {
    setActiveView('agent');
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

  const refreshSelectedProjectData = useCallback(async () => {
    if (!data.selectedProjectId) return;
    await Promise.all([
      data.loadProjects(),
      data.loadProjectData(data.selectedProjectId, data.selectedChapterId),
    ]);
    setVolumeRefreshSignal((value) => value + 1);
  }, [data]);

  const handlePassageRevisionApplied = useCallback(async () => {
    await refreshSelectedProjectData();
    setActiveView('editor');
  }, [refreshSelectedProjectData]);

  const handleSubmitPassageAgent = useCallback(async ({ message, context }: { message: string; context: PassageAgentContext }) => {
    setPendingAgentRequest({
      id: `passage-${Date.now().toString(36)}-${context.currentDraftId}-${context.selectedRange.start}-${context.selectedRange.end}`,
      message,
      pageContext: context,
    });
    setActiveView('agent');
  }, []);

  const showProjectManagement = activeView === 'projects';
  const hasProject = !!selectedProject;
  const showInspector = hasProject && activeView === 'editor';

  if (!workspaceStateRestored) {
    return (
      <main className="flex h-full w-full items-center justify-center" style={{ background: 'var(--bg-deep)', color: 'var(--text-dim)' }}>
        {/* 刷新页面时先恢复本地工作区状态，避免短暂渲染项目首页造成“跳回首页”的错觉。 */}
        正在恢复上次编辑位置…
      </main>
    );
  }

  return (
    <main className="workspace-shell">

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
        onNavigateToEditor={handleNavigateToEditor}
        onNavigateToOutline={handleNavigateToOutline}
        onNavigateToLore={handleNavigateToLore}
        onNavigateToStoryBible={handleNavigateToStoryBible}
        onNavigateToWritingRules={handleNavigateToWritingRules}
        onNavigateToSceneBank={handleNavigateToSceneBank}
        onNavigateToPacing={handleNavigateToPacing}
        onNavigateToChapterPatterns={handleNavigateToChapterPatterns}
        onNavigateToQualityReports={handleNavigateToQualityReports}
        onNavigateToScoringCenter={handleNavigateToScoringCenter}
        onNavigateToRelationships={handleNavigateToRelationships}
        onNavigateToTimeline={handleNavigateToTimeline}
        onNavigateToCharacterState={handleNavigateToCharacterState}
        onNavigateToGenerationConfig={handleNavigateToGenerationConfig}
        onNavigateToVolumes={handleNavigateToVolumes}
        onNavigateToPrompts={handleNavigateToPrompts}
        onNavigateToForeshadow={handleNavigateToForeshadow}
        onNavigateToGenerate={handleNavigateToGenerate}
        onNavigateToAgent={handleNavigateToAgent}
        onNavigateToLlmConfig={handleNavigateToLlmConfig}
        onSelectVolume={handleSelectVolume}
        onDeleteChapters={data.deleteChapters}
      />

      {/* 2. 主躯干：根据 activeView 切换面板 */}
      <section className="workspace-main">
        {/* LLM config is global — renders without requiring a project */}
        {activeView === 'llm-config' ? (
          <LlmProviderPanel />
        ) : activeView === 'projects' || !hasProject ? (
          <ProjectManagementPanel
            projects={data.projects}
            selectedProjectId={data.selectedProjectId}
            onSelectProject={handleSelectProject}
            onProjectsChanged={handleProjectsChanged}
          />
        ) : activeView === 'outline' ? (
          <OutlinePanel selectedProject={selectedProject} />
        ) : activeView === 'lore' ? (
          <LorePanel selectedProject={selectedProject} selectedProjectId={data.selectedProjectId} />
        ) : activeView === 'story-bible' ? (
          <StoryBiblePanel selectedProject={selectedProject} selectedProjectId={data.selectedProjectId} />
        ) : activeView === 'writing-rules' ? (
          <WritingRulesPanel selectedProject={selectedProject} selectedProjectId={data.selectedProjectId} />
        ) : activeView === 'scene-bank' ? (
          <SceneBankPanel selectedProject={selectedProject} selectedProjectId={data.selectedProjectId} volumes={data.volumes} chapters={chapters} />
        ) : activeView === 'pacing' ? (
          <PacingPanel selectedProject={selectedProject} selectedProjectId={data.selectedProjectId} volumes={data.volumes} chapters={chapters} />
        ) : activeView === 'chapter-patterns' ? (
          <ChapterPatternPanel selectedProject={selectedProject} selectedProjectId={data.selectedProjectId} />
        ) : activeView === 'quality-reports' ? (
          <QualityReportPanel selectedProject={selectedProject} selectedProjectId={data.selectedProjectId} selectedChapterId={data.selectedChapterId} chapters={chapters} />
        ) : activeView === 'scoring-center' ? (
          <ScoringCenterPanel selectedProject={selectedProject} selectedProjectId={data.selectedProjectId} />
        ) : activeView === 'relationships' ? (
          <RelationshipMapPanel selectedProject={selectedProject} selectedProjectId={data.selectedProjectId} />
        ) : activeView === 'timeline' ? (
          <TimelinePanel selectedProject={selectedProject} selectedProjectId={data.selectedProjectId} />
        ) : activeView === 'character-state' ? (
          <CharacterStatePanel
            selectedProject={selectedProject}
            selectedProjectId={data.selectedProjectId}
            characterStates={data.characterStates}
            loading={data.loading}
            onRefresh={() => data.loadProjectData(data.selectedProjectId, data.selectedChapterId)}
          />
        ) : activeView === 'generation-config' ? (
          <GenerationConfigPanel
            selectedProject={selectedProject}
            selectedProjectId={data.selectedProjectId}
            onSaved={() => data.loadProjectData(data.selectedProjectId, data.selectedChapterId)}
          />
        ) : activeView === 'volumes' ? (
          <VolumePanel selectedProject={selectedProject} selectedProjectId={data.selectedProjectId} selectedVolumeId={selectedVolumeId} chapters={chapters} refreshSignal={volumeRefreshSignal} />
        ) : activeView === 'prompts' ? (
          <PromptManagerPanel selectedProject={selectedProject} selectedProjectId={data.selectedProjectId} />
        ) : activeView === 'foreshadow' ? (
          <ForeshadowBoard
            selectedProject={selectedProject}
            selectedProjectId={data.selectedProjectId}
            foreshadowTracks={data.foreshadowTracks}
            chapters={chapters}
            onRefresh={() => data.loadProjectData(data.selectedProjectId, data.selectedChapterId)}
          />
        ) : activeView === 'generate' ? (
          <BatchGeneratePanel
            projectId={data.selectedProjectId}
            volumes={data.volumes}
            chapters={chapters}
            onComplete={async (chapterIds?: string[]) => {
              const generatedChapterId = chapterIds?.[0];
              const nextChapterId = generatedChapterId ?? data.selectedChapterId;

              // 批量生成完成后立即进入最新生成章节，避免用户停在生成页看不到正文。
              if (generatedChapterId) {
                data.setSelectedChapterId(generatedChapterId);
                setSelectedVolumeId('');
                setActiveView('editor');
              }

              await data.loadProjectData(data.selectedProjectId, nextChapterId);
            }}
          />

        ) : activeView === 'agent' ? (
          <AgentWorkspace
            projectId={data.selectedProjectId}
            selectedChapterId={data.selectedChapterId !== 'all' ? data.selectedChapterId : undefined}
            onRefresh={refreshSelectedProjectData}
            onPassageRevisionApplied={handlePassageRevisionApplied}
            initialRequest={pendingAgentRequest}
            onInitialRequestConsumed={() => setPendingAgentRequest(undefined)}
          />
        ) : (
          <EditorPanel
            selectedProject={selectedProject}
            selectedChapterId={data.selectedChapterId}
            chapters={chapters}
            volumes={data.volumes}
            draftRefreshKey={data.draftRefreshKey}
            onChapterGenerated={(chapterId) => data.loadProjectData(data.selectedProjectId, chapterId)}
            onChapterSaved={(chapterId) => data.loadProjectData(data.selectedProjectId, chapterId)}
            onRunAutoMaintenance={data.runAutoMaintenance}
            onMarkChapterComplete={data.markChapterComplete}
            onSubmitPassageAgent={handleSubmitPassageAgent}
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

      {/* 4. Agent 悬浮圆球 — 除全屏 Agent 工作台外全局可见 */}
      {hasProject && activeView !== 'agent' && (
        <AgentFloatingOrb
          projectId={data.selectedProjectId}
          selectedChapterId={data.selectedChapterId !== 'all' ? data.selectedChapterId : undefined}
          onRefresh={refreshSelectedProjectData}
        />
      )}

    </main>
  );
}
