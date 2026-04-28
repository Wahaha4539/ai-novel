import { SectionHeader } from './SectionHeader';
import { StatusBadge } from './StatusBadge';
import { ReviewItem } from '../types/dashboard';

interface Props {
  acceptedMemories: ReviewItem[];
}

/**
 * 已采纳记忆面板：只读展示 MemoryChunk.status=user_confirmed 的审核结果。
 * 该组件刻意与剧情事件、角色状态、伏笔等事实层列表分离，帮助用户识别真正会进入记忆召回的片段。
 */
export function AcceptedMemoryList({ acceptedMemories }: Props) {
  return (
    <article className="panel p-5 animate-fade-in" style={{ animationDelay: '0.2s', animationFillMode: 'both' }}>
      <SectionHeader title="已采纳记忆" desc="user_confirmed MemoryChunk · 会作为稳定上下文参与后续召回。" />
      <div className="mt-5 space-y-3">
        {acceptedMemories.length ? (
          acceptedMemories.map((item) => (
            <div
              key={item.id}
              className="list-card text-sm"
              style={{
                borderLeft: '3px solid rgba(34, 197, 94, 0.65)',
                background: 'linear-gradient(135deg, rgba(34,197,94,0.09), rgba(15,23,42,0.18))',
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              {/* 右上角“采纳章”是视觉提示，不参与交互，避免和审核按钮混淆。 */}
              <div
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  top: '0.75rem',
                  right: '0.75rem',
                  border: '1px solid rgba(34,197,94,0.38)',
                  color: '#86efac',
                  background: 'rgba(34,197,94,0.10)',
                  borderRadius: '999px',
                  padding: '0.2rem 0.55rem',
                  fontSize: '0.68rem',
                  fontWeight: 800,
                  letterSpacing: '0.08em',
                }}
              >
                ADOPTED
              </div>
              <div className="flex flex-wrap items-center gap-2 mb-2 pr-20">
                <StatusBadge value={item.status} />
                <span className="badge" style={{ background: 'var(--bg-overlay)', borderColor: 'rgba(34,197,94,0.32)', color: '#bbf7d0' }}>{item.memoryType}</span>
                {item.sourceTrace?.chapterNo != null ? (
                  <span className="text-xs font-semibold" style={{ color: 'var(--accent-cyan)' }}>第{item.sourceTrace.chapterNo}章</span>
                ) : null}
              </div>
              <div className="mt-2 text-heading font-medium text-base mb-1 pr-6">{item.summary || '未命名已采纳记忆'}</div>
              <div className="leading-6" style={{ color: 'var(--text-main)', fontSize: '0.9rem' }}>{item.content}</div>
            </div>
          ))
        ) : (
          <div className="list-card-empty">当前范围内暂无已采纳记忆。完成记忆复核并确认采纳后会显示在这里。</div>
        )}
      </div>
    </article>
  );
}