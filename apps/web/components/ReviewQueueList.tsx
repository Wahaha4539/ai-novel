import { SectionHeader } from './SectionHeader';
import { StatusBadge } from './StatusBadge';
import { ReviewItem } from '../types/dashboard';

interface Props {
  reviewQueue: ReviewItem[];
  onRunReviewAction: (memoryId: string, action: 'confirm' | 'reject') => void;
}

export function ReviewQueueList({ reviewQueue, onRunReviewAction }: Props) {
  return (
    <article className="panel p-5">
      <SectionHeader title="待审核记忆队列" desc="pending_review → user_confirmed / rejected 工作流。" />
      <div className="mt-5 space-y-3">
        {reviewQueue.length ? (
          reviewQueue.map((item) => (
            <div key={item.id} className="list-card text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge value={item.status} />
                <span className="badge border-slate-700 bg-slate-800 text-slate-200">{item.memoryType}</span>
                {item.sourceTrace?.chapterNo != null ? (
                  <span className="text-xs text-slate-500 font-medium">第{item.sourceTrace.chapterNo}章</span>
                ) : null}
              </div>
              <div className="mt-2 text-white font-medium">{item.summary || '未命名记忆'}</div>
              <div className="mt-2 leading-6 text-slate-300">{item.content}</div>
              <div className="mt-4 flex gap-3">
                <button className="btn" onClick={() => onRunReviewAction(item.id, 'confirm')}>
                  确认
                </button>
                <button className="btn-danger" onClick={() => onRunReviewAction(item.id, 'reject')}>
                  拒绝
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
