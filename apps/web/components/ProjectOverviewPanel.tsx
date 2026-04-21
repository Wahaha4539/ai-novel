import { SectionHeader } from './SectionHeader';
import { StatusBadge } from './StatusBadge';
import { ProjectSummary, ChapterSummary, ReviewItem, StoryEventItem, ValidationIssue } from '../types/dashboard';

interface Props {
  selectedProject?: ProjectSummary;
  chapters: ChapterSummary[];
  reviewQueue: ReviewItem[];
  storyEvents: StoryEventItem[];
  validationIssues: ValidationIssue[];
  selectedProjectId: string;
  selectedChapterId: string;
  onRefresh: (projectId: string, chapterId: string) => void;
}

export function ProjectOverviewPanel({
  selectedProject,
  chapters,
  reviewQueue,
  storyEvents,
  validationIssues,
  selectedProjectId,
  selectedChapterId,
  onRefresh,
}: Props) {
  return (
    <article className="panel p-5">
      <SectionHeader
        title="项目概览"
        desc="查看项目统计、当前范围和基本工程状态。"
        action={
          <button className="btn-secondary" onClick={() => selectedProjectId && onRefresh(selectedProjectId, selectedChapterId)}>
            刷新
          </button>
        }
      />
      {selectedProject ? (
        <div className="mt-5 space-y-4 text-sm text-slate-300">
          <div>
            <div className="text-xl font-semibold text-white">{selectedProject.title}</div>
            <div className="mt-2 flex flex-wrap gap-2">
              <StatusBadge value={selectedProject.status} />
              {selectedProject.genre ? <span className="badge border-slate-700 bg-slate-800 text-slate-200">{selectedProject.genre}</span> : null}
              {selectedProject.theme ? <span className="badge border-slate-700 bg-slate-800 text-slate-200">{selectedProject.theme}</span> : null}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3 shadow-inner">
              <div className="text-xs text-slate-500">章节</div>
              <div className="mt-1 text-2xl font-semibold text-white">{selectedProject.stats?.chapterCount ?? chapters.length}</div>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3 shadow-inner">
              <div className="text-xs text-slate-500">待审核记忆</div>
              <div className="mt-1 text-2xl font-semibold text-white">{reviewQueue.length}</div>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3 shadow-inner">
              <div className="text-xs text-slate-500">结构化事件</div>
              <div className="mt-1 text-2xl font-semibold text-white">{storyEvents.length}</div>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3 shadow-inner">
              <div className="text-xs text-slate-500">校验问题</div>
              <div className="mt-1 text-2xl font-semibold text-white">{validationIssues.length}</div>
            </div>
          </div>
          <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-slate-400">
            当前支持：StoryEvent / CharacterStateSnapshot / ForeshadowTrack 读取、pending_review 审核、单章/全项目 rebuild、基于事实层硬规则校验。
          </div>
        </div>
      ) : (
        <div className="mt-5 text-sm text-slate-500 flex h-32 items-center justify-center rounded-2xl border border-dashed border-slate-800">
          暂无项目，请先通过 API 或验证脚本创建项目数据。
        </div>
      )}
    </article>
  );
}
