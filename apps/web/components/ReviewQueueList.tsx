import { SectionHeader } from './SectionHeader';
import { StatusBadge } from './StatusBadge';
import { ReviewItem } from '../types/dashboard';

interface Props {
  reviewQueue: ReviewItem[];
  onRunReviewAction: (memoryId: string, action: 'confirm' | 'reject') => void;
}

export function ReviewQueueList({ reviewQueue, onRunReviewAction }: Props) {
  return (
    <article className="panel p-5 animate-fade-in" style={{ animationDelay: '0.3s', animationFillMode: 'both' }}>
      <SectionHeader title="待审核记忆队列" desc="pending_review → user_confirmed / rejected 工作流。" />
      <div className="mt-5 space-y-3">
        {reviewQueue.length ? (
          reviewQueue.map((item) => (
            <div key={item.id} className="list-card text-sm" style={{ borderLeft: '3px solid rgba(245, 158, 11, 0.5)' }}>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <StatusBadge value={item.status} />
                <span className="badge" style={{ background: 'rgba(0,0,0,0.4)', borderColor: 'var(--border-dim)', color: 'var(--text-dim)' }}>{item.memoryType}</span>
                {item.sourceTrace?.chapterNo != null ? (
                  <span className="text-xs font-semibold" style={{ color: 'var(--accent-cyan)' }}>第{item.sourceTrace.chapterNo}章</span>
                ) : null}
              </div>
              <div className="mt-2 text-white font-medium text-base mb-1">{item.summary || '未命名记忆'}</div>
              <div className="leading-6" style={{ color: 'var(--text-main)', fontSize: '0.9rem' }}>{item.content}</div>
              <div className="mt-4 flex gap-3">
                <button className="btn text-xs px-4 py-2" onClick={() => onRunReviewAction(item.id, 'confirm')}>
                  确认采纳
                </button>
                <button className="btn-danger text-xs px-4 py-2" onClick={() => onRunReviewAction(item.id, 'reject')}>
                  拒绝并移除
                </button>
              </div>
            </div>
          ))
        ) : (
          <div className="list-card-empty">当前范围内没有 pending_review 记忆。</div>
        )}
      </div>
    </article>
  );
}
