import { SectionHeader } from './SectionHeader';
import { StatusBadge } from './StatusBadge';
import { StoryEventItem } from '../types/dashboard';

interface Props {
  storyEvents: StoryEventItem[];
}

export function StoryEventList({ storyEvents }: Props) {
  return (
    <article className="panel p-5">
      <SectionHeader title="StoryEvent" desc="结构化事件读取接口结果。" />
      <div className="mt-5 space-y-3">
        {storyEvents.length ? (
          storyEvents.map((event) => (
            <div key={event.id} className="list-card text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-white font-medium">{event.title}</span>
                <StatusBadge value={event.status} />
                <span className="badge border-slate-700 bg-slate-800 text-slate-200">{event.eventType}</span>
              </div>
              <p className="mt-2 leading-6 text-slate-300">{event.description}</p>
              <div className="mt-2 text-xs text-slate-500">
                第{event.chapterNo ?? '?'}章 · timelineSeq {event.timelineSeq ?? '—'} · 参与者：
                {Array.isArray(event.participants) ? event.participants.join('、') : '—'}
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
