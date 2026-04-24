import React, { useState } from 'react';
import { StoryEventList } from './StoryEventList';
import { CharacterStateList } from './CharacterStateList';
import { ForeshadowList } from './ForeshadowList';
import { ValidationIssueList } from './ValidationIssueList';
import { ProjectOverviewPanel } from './ProjectOverviewPanel';
import { RebuildToolPanel } from './RebuildToolPanel';
import { ValidationConsolePanel } from './ValidationConsolePanel';
import { ReviewQueueList } from './ReviewQueueList';
import { StoryEventItem, CharacterStateItem, ForeshadowItem, ValidationIssue, RebuildResult, ValidationRunResult, ReviewItem, ProjectSummary, ChapterSummary } from '../types/dashboard';

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

/**
 * 右侧检查器面板：在预览态展示写作上下文，在后台态提供重建、校验和审核操作。
 * 校验问题需要在预览态直接露出，否则用户只能看到概览数量，看不到具体问题。
 */
export function InspectorPanel(props: Props) {
  const [activeTab, setActiveTab] = useState<'preview' | 'edit'>('preview');

  return (
    <aside className="flex flex-col shrink-0 h-full" style={{ width: '26rem', borderLeft: '1px solid var(--border-light)', background: 'var(--bg-inspector)', backdropFilter: 'blur(32px)', overflow: 'hidden', position: 'relative', zIndex: 10, boxShadow: '-10px 0 30px rgba(0,0,0,0.3)' }}>
      
      {/* Inspector Tabs - Sleek Segmented Control */}
      <div className="shrink-0 flex px-4 pt-4 pb-0" style={{ background: 'var(--bg-overlay)', borderBottom: '1px solid var(--border-dim)' }}>
        <div className="flex w-full" style={{ background: 'var(--bg-overlay)', padding: '4px', borderRadius: '12px 12px 0 0', border: '1px solid var(--border-dim)', borderBottom: 'none' }}>
          <button
            onClick={() => setActiveTab('preview')}
            className="flex-1 text-xs font-bold"
            style={{
              padding: '0.6rem 0',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              transition: 'all 0.3s ease',
              borderRadius: '8px',
              background: activeTab === 'preview' ? 'var(--bg-card-hover)' : 'transparent',
              color: activeTab === 'preview' ? 'var(--accent-cyan)' : 'var(--text-muted)',
              border: activeTab === 'preview' ? '1px solid var(--border-light)' : '1px solid transparent',
              boxShadow: activeTab === 'preview' ? '0 4px 15px rgba(0,0,0,0.2)' : 'none'
            }}
          >
            剧情 / 设定预览
          </button>
          <button
            onClick={() => setActiveTab('edit')}
            className="flex-1 text-xs font-bold"
            style={{
              padding: '0.6rem 0',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              transition: 'all 0.3s ease',
              borderRadius: '8px',
              background: activeTab === 'edit' ? 'var(--bg-card-hover)' : 'transparent',
              color: activeTab === 'edit' ? 'var(--accent-cyan)' : 'var(--text-muted)',
              border: activeTab === 'edit' ? '1px solid var(--border-light)' : '1px solid transparent',
              boxShadow: activeTab === 'edit' ? '0 4px 15px rgba(0,0,0,0.2)' : 'none'
            }}
          >
            后台审计与操作
          </button>
        </div>
      </div>

      <div className="flex-1 px-4 py-6 space-y-6" style={{ overflowY: 'auto' }}>
        <div className="text-xs text-center mb-2" style={{ color: 'var(--text-dim)' }}>
          {props.loading ? (
            <span className="flex items-center justify-center gap-2 text-cyan-400">
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--accent-cyan)', animation: 'pulseGlow 1s infinite' }} /> 同步数据中...
            </span>
          ) : (
            <span style={{ opacity: 0.5 }}>数据已同步至事实层</span>
          )}
        </div>

        {activeTab === 'preview' ? (
          <div className="space-y-6 animate-slide-right">
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
            {/* 有问题时在预览页直接展示详情，避免“校验问题”统计数字和问题列表分离。 */}
            {props.validationIssues.length > 0 ? <ValidationIssueList validationIssues={props.validationIssues} /> : null}
            <StoryEventList storyEvents={props.storyEvents} />
            <CharacterStateList characterStates={props.characterStates} />
            <ForeshadowList foreshadowTracks={props.foreshadowTracks} />
          </div>
        ) : (
          <div className="space-y-6 animate-slide-right">
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
