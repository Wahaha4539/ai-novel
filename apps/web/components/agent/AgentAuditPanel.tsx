'use client';

import { AgentAuditEvent } from '../../hooks/useAgentRun';
import { EmptyText, formatDate } from './AgentSharedWidgets';

/** 根据审计事件的严重级别返回对应颜色 */
function auditColor(severity?: AgentAuditEvent['severity']) {
  if (severity === 'danger') return '#fb7185';
  if (severity === 'warn') return '#fbbf24';
  if (severity === 'ok') return '#86efac';
  return '#67e8f9';
}

interface AgentAuditPanelProps {
  events: AgentAuditEvent[];
}

/** 审计视图把审批、计划、步骤和产物串成统一时间线，便于生产排障和人工复核。 */
export function AgentAuditPanel({ events }: AgentAuditPanelProps) {
  const recentEvents = [...events].slice(-12).reverse();

  return (
    <section className="agent-panel-section">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>审计轨迹</h2>
        <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>{events.length} 条事件</span>
      </div>
      {recentEvents.length ? (
        <div className="space-y-2">
          {recentEvents.map((event) => (
            <div key={event.id} className="p-3" style={{ borderRadius: '0.85rem', border: `1px solid ${auditColor(event.severity)}33`, background: `${auditColor(event.severity)}0f` }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-bold" style={{ color: auditColor(event.severity) }}>{event.title}</div>
                <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>{formatDate(event.timestamp)}</div>
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-[10px]" style={{ color: 'var(--text-dim)' }}>
                <span>{event.eventType}</span>
                {event.planVersion !== undefined && <span>v{event.planVersion}</span>}
                {event.mode && <span>{event.mode}</span>}
                {event.stepNo !== undefined && <span>step {event.stepNo}</span>}
                {event.toolName && <span>{event.toolName}</span>}
                {event.status && <span>{event.status}</span>}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyText text="创建或执行 AgentRun 后会展示可追踪审计事件。" />
      )}
    </section>
  );
}
