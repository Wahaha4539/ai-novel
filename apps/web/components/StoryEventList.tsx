import { SectionHeader } from './SectionHeader';
import { StatusBadge } from './StatusBadge';
import { StoryEventItem } from '../types/dashboard';

interface Props {
  storyEvents: StoryEventItem[];
}

export function StoryEventList({ storyEvents }: Props) {
  return (
    <article className="panel p-5 animate-fade-in" style={{ animationDelay: '0.2s', animationFillMode: 'both' }}>
      <SectionHeader title="StoryEvent" desc="结构化事件读取接口结果。" />
      <div className="mt-5 space-y-3">
        {storyEvents.length ? (
          storyEvents.map((event) => (
            <div key={event.id} className="list-card text-sm">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="text-heading font-medium">{event.title}</span>
                <StatusBadge value={event.status} />
                <span className="badge" style={{ background: 'var(--bg-overlay)', borderColor: 'var(--border-dim)', color: 'var(--text-dim)' }}>{event.eventType}</span>
              </div>
              <p className="leading-6" style={{ color: 'var(--text-main)', fontSize: '0.9rem' }}>{event.description}</p>
              <div className="mt-3 text-xs" style={{ color: 'var(--text-dim)', borderTop: '1px solid var(--border-dim)', paddingTop: '0.5rem' }}>
                <span style={{ color: 'var(--accent-cyan)' }}>第{event.chapterNo ?? '?'}章</span> · timelineSeq {event.timelineSeq ?? '—'} · 参与者：
                <span style={{ color: 'var(--text-muted)' }}>{Array.isArray(event.participants) ? event.participants.join('、') : '—'}</span>
              </div>
            </div>
          ))
        ) : (
          <div className="list-card-empty">暂无 StoryEvent 数据。</div>
        )}
      </div>
    </article>
  );
}
