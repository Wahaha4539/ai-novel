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
    <article className="panel p-5 animate-fade-in" style={{ animationDelay: '0.1s', animationFillMode: 'both' }}>
      <SectionHeader
        title="项目概览"
        desc="查看项目统计、当前范围和基本工程状态。"
        action={
          <button className="btn-secondary text-xs" style={{ padding: '0.4rem 0.8rem' }} onClick={() => selectedProjectId && onRefresh(selectedProjectId, selectedChapterId)}>
            刷新
          </button>
        }
      />
      {selectedProject ? (
        <div className="mt-5 space-y-4">
          <div>
            <div className="text-xl font-bold text-heading mb-2" style={{ textShadow: '0 2px 10px var(--accent-cyan-glow)' }}>{selectedProject.title}</div>
            <div className="flex flex-wrap gap-2 items-center">
              <StatusBadge value={selectedProject.status} />
              {selectedProject.genre ? <span className="badge" style={{ background: 'var(--bg-overlay)', borderColor: 'var(--border-dim)', color: 'var(--text-dim)' }}>{selectedProject.genre}</span> : null}
              {selectedProject.theme ? <span className="badge" style={{ background: 'var(--bg-overlay)', borderColor: 'var(--border-dim)', color: 'var(--text-dim)' }}>{selectedProject.theme}</span> : null}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 mt-4">
            <div className="stat-card">
              <div className="stat-card__label">章节</div>
              <div className="stat-card__value" style={{ color: 'var(--accent-cyan)' }}>{selectedProject.stats?.chapterCount ?? chapters.length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card__label">待审核记忆</div>
              <div className="stat-card__value" style={{ color: reviewQueue.length > 0 ? '#f59e0b' : 'var(--text-main)' }}>{reviewQueue.length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card__label">结构化事件</div>
              <div className="stat-card__value">{storyEvents.length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card__label">校验问题</div>
              <div className="stat-card__value" style={{ color: validationIssues.length > 0 ? 'var(--status-err)' : 'var(--text-main)' }}>{validationIssues.length}</div>
            </div>
          </div>
          <div className="p-4 text-xs mt-4" style={{ background: 'var(--bg-info-banner)', borderRadius: '12px', border: '1px solid var(--accent-cyan-glow)', color: 'var(--text-muted)' }}>
            当前支持：StoryEvent / CharacterStateSnapshot / ForeshadowTrack 读取、pending_review 审核、单章/全项目 rebuild、基于事实层硬规则校验。
          </div>
        </div>
      ) : (
        <div className="list-card-empty mt-5 text-center px-4">
          暂无项目，请先通过 API 或验证脚本创建项目数据。
        </div>
      )}
    </article>
  );
}
