import { useState } from 'react';
import { SectionHeader } from './SectionHeader';
import { StatusBadge } from './StatusBadge';
import { ReviewItem } from '../types/dashboard';

interface Props {
  reviewQueue: ReviewItem[];
  onRunReviewAction: (memoryId: string, action: 'confirm' | 'reject') => void;
  onRunAiReviewQueue?: () => void | Promise<void>;
}

/**
 * 待审核记忆队列：保留人工确认按钮，同时提供 LLM 一键审核入口给全自动流程复用。
 */
export function ReviewQueueList({ reviewQueue, onRunReviewAction, onRunAiReviewQueue }: Props) {
  const [isAiReviewing, setIsAiReviewing] = useState(false);

  /**
   * 点击后一律进入本地 loading，避免全局 Toast 自动隐藏后用户误以为按钮没有响应。
   * finally 中恢复按钮，网络失败时由上层 actionMessage 展示错误原因。
   */
  const handleRunAiReviewQueue = async () => {
    if (!onRunAiReviewQueue || isAiReviewing) return;

    setIsAiReviewing(true);
    try {
      await onRunAiReviewQueue();
    } finally {
      setIsAiReviewing(false);
    }
  };

  return (
    <article className="panel p-5 animate-fade-in" style={{ animationDelay: '0.3s', animationFillMode: 'both' }}>
      <SectionHeader title="待审核记忆队列" desc="pending_review → LLM 判断采纳 / rejected 工作流。" />
      {reviewQueue.length > 0 && onRunAiReviewQueue ? (
        <button className="btn mt-5 w-full justify-center" type="button" disabled={isAiReviewing} onClick={handleRunAiReviewQueue}>
          {isAiReviewing ? '🤖 AI 正在审核待确认记忆…' : '🤖 AI 审核全部待确认记忆'}
        </button>
      ) : null}
      <div className="mt-5 space-y-3">
        {reviewQueue.length ? (
          reviewQueue.map((item) => (
            <div key={item.id} className="list-card text-sm" style={{ borderLeft: '3px solid rgba(245, 158, 11, 0.5)' }}>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <StatusBadge value={item.status} />
                <span className="badge" style={{ background: 'var(--bg-overlay)', borderColor: 'var(--border-dim)', color: 'var(--text-dim)' }}>{item.memoryType}</span>
                {item.sourceTrace?.chapterNo != null ? (
                  <span className="text-xs font-semibold" style={{ color: 'var(--accent-cyan)' }}>第{item.sourceTrace.chapterNo}章</span>
                ) : null}
              </div>
              <div className="mt-2 text-heading font-medium text-base mb-1">{item.summary || '未命名记忆'}</div>
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
