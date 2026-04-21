import React, { useState } from 'react';
import { StoryEventList } from './StoryEventList';
import { CharacterStateList } from './CharacterStateList';
import { ForeshadowList } from './ForeshadowList';
import { ValidationIssueList } from './ValidationIssueList';
import { ProjectOverviewPanel } from './ProjectOverviewPanel';
import { RebuildToolPanel } from './RebuildToolPanel';
import { ValidationConsolePanel } from './ValidationConsolePanel';
import { ReviewQueueList } from './ReviewQueueList';
import { DashboardPayload, StoryEventItem, CharacterStateItem, ForeshadowItem, ValidationIssue, RebuildResult, ValidationRunResult, ReviewItem, ProjectSummary, ChapterSummary } from '../types/dashboard';

interface Props {
  // states
  selectedProject?: ProjectSummary;
  chapters: ChapterSummary[];
  selectedProjectId: string;
  selectedChapterId: string;
  storyEvents: StoryEventItem[];
  characterStates: CharacterStateItem[];
  foreshadowTracks: ForeshadowItem[];
  reviewQueue: ReviewItem[];
  validationIssues: ValidationIssue[];
  loading: boolean;
  rebuildResult: RebuildResult | null;
  validationRunResult: ValidationRunResult | null;

  // actions
  onRefresh: (projectId: string, chapterId: string) => void;
  onRunRebuild: (dryRun: boolean) => void;
  onRunValidation: () => void;
  onRunReviewAction: (memoryId: string, action: 'confirm' | 'reject') => void;
}

export function InspectorPanel(props: Props) {
  const [activeTab, setActiveTab] = useState<'preview' | 'edit'>('preview');

  return (
    <aside className="flex w-96 flex-col border-l border-slate-800 bg-slate-900/60 backdrop-blur-3xl shrink-0 h-full overflow-hidden shadow-2xl relative z-10">
      
      {/* Inspector Tabs */}
      <div className="flex shrink-0 border-b border-white/5 bg-slate-950/40 px-2 pt-2 gap-1">
        <button
          onClick={() => setActiveTab('preview')}
          className={`flex-1 rounded-t-lg px-4 py-3 text-xs font-bold uppercase tracking-wider transition-colors ${
            activeTab === 'preview'
              ? 'bg-slate-900/80 text-cyan-400 border-t border-x border-white/5 shadow-[0_-4px_15px_-5px_rgba(6,182,212,0.15)]'
              : 'text-slate-500 hover:text-slate-300 hover:bg-slate-900/40'
          }`}
        >
          剧情 / 设定预览
        </button>
        <button
          onClick={() => setActiveTab('edit')}
          className={`flex-1 rounded-t-lg px-4 py-3 text-xs font-bold uppercase tracking-wider transition-colors ${
            activeTab === 'edit'
              ? 'bg-slate-900/80 text-cyan-400 border-t border-x border-white/5 shadow-[0_-4px_15px_-5px_rgba(6,182,212,0.15)]'
              : 'text-slate-500 hover:text-slate-300 hover:bg-slate-900/40'
          }`}
        >
          后台审计与操作
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-6 custom-scrollbar bg-slate-900/20">
        <div className="text-xs text-center text-slate-500 mb-2">
          {props.loading ? (
            <span className="flex items-center justify-center gap-2 animate-pulse text-cyan-400">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" /> 同步数据中...
            </span>
          ) : (
            <span className="opacity-50">数据已同事实层对齐</span>
          )}
        </div>

        {activeTab === 'preview' ? (
          <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
            <ProjectOverviewPanel
              selectedProject={props.selectedProject}
              chapters={props.chapters}
              reviewQueue={props.reviewQueue}
              storyEvents={props.storyEvents}
              validationIssues={props.validationIssues}
              selectedProjectId={props.selectedProjectId}
              selectedChapterId={props.selectedChapterId}
              onRefresh={props.onRefresh}
            />
            <StoryEventList storyEvents={props.storyEvents} />
            <CharacterStateList characterStates={props.characterStates} />
            <ForeshadowList foreshadowTracks={props.foreshadowTracks} />
          </div>
        ) : (
          <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
            <RebuildToolPanel
              selectedProjectId={props.selectedProjectId}
              loading={props.loading}
              rebuildResult={props.rebuildResult}
              onRunRebuild={props.onRunRebuild}
            />
            <ValidationConsolePanel
              selectedProjectId={props.selectedProjectId}
              loading={props.loading}
              validationRunResult={props.validationRunResult}
              onRunValidation={props.onRunValidation}
            />
            <ReviewQueueList reviewQueue={props.reviewQueue} onRunReviewAction={props.onRunReviewAction} />
            <ValidationIssueList validationIssues={props.validationIssues} />
          </div>
        )}
      </div>
    </aside>
  );
}
