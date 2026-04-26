'use client';

import { EmptyText, safeJson } from './AgentSharedWidgets';

interface AgentResultPanelProps {
  output?: unknown;
  error?: unknown;
}

/** 最终报告面板：展示 AgentRun 执行完成后的输出或错误 */
export function AgentResultPanel({ output, error }: AgentResultPanelProps) {
  return (
    <section className="agent-panel-section">
      <h2 className="text-sm font-bold mb-3" style={{ color: 'var(--text-main)' }}>最终报告</h2>
      {error ? (
        <pre className="text-xs whitespace-pre-wrap" style={{ color: 'var(--status-err)' }}>{safeJson(error)}</pre>
      ) : output ? (
        <pre className="text-xs whitespace-pre-wrap overflow-auto max-h-96" style={{ color: 'var(--text-muted)' }}>{safeJson(output)}</pre>
      ) : (
        <EmptyText text="执行完成后会展示 draftId、校验结果、记忆回写和下一步建议。" />
      )}
    </section>
  );
}
