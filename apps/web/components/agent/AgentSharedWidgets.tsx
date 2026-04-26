'use client';

import { AgentPlanPayload, AgentPlanRecord, AgentRun } from '../../hooks/useAgentRun';

// ────────────────────────────────────────────
// 通用值处理工具函数
// ────────────────────────────────────────────

/** 安全地将任意值转换为展示用 JSON 字符串 */
export function safeJson(value: unknown) {
  if (value === undefined || value === null) return '—';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** 将 unknown 值尝试投影为 Record，不合法则返回 undefined */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/** 将 unknown 值尝试投影为数组，不合法则返回空数组 */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 提取字符串值，空/非字符串返回 fallback */
export function textValue(value: unknown, fallback = '—') {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/** 提取数值，非有限数返回 fallback */
export function numberValue(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 格式化日期字符串为中文本地化展示 */
export function formatDate(value?: string) {
  if (!value) return '未知时间';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

// ────────────────────────────────────────────
// Plan 相关工具函数
// ────────────────────────────────────────────

/**
 * 后端可能返回 Prisma AgentPlan 字段，也可能返回旧版嵌套 plan 字段。
 * 这里统一投影为前端展示契约，保证生产接口演进期间工作台仍可读。
 */
export function normalizePlan(record: AgentPlanRecord): AgentPlanPayload {
  return record.plan ?? { summary: record.summary, assumptions: record.assumptions, risks: record.risks, steps: record.steps, requiredApprovals: record.requiredApprovals };
}

/** 获取 Run 中最新版本的 Plan */
export function latestPlan(run: AgentRun | null): AgentPlanPayload | undefined {
  const record = [...(run?.plans ?? [])].sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
  return record ? normalizePlan(record) : undefined;
}

/** 获取 Run 中最新 Plan 的版本号 */
export function latestPlanVersion(run: AgentRun | null) {
  return [...(run?.plans ?? [])].sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0]?.version ?? 1;
}

/** 生成 Plan 版本标签 */
export function planVersionLabel(plan: { version?: number; createdAt?: string }) {
  return `v${plan.version ?? 1}${plan.createdAt ? ` · ${formatDate(plan.createdAt)}` : ''}`;
}

/** 汇总审批风险信息，帮助用户快速了解 Plan 写入影响 */
export function approvalRiskSummary(plan: AgentPlanPayload | undefined, approvedStepNos: number[]) {
  const requiredStepNos = plan?.requiredApprovals?.flatMap((item) => item.target?.stepNos ?? []) ?? [];
  const requiredTools = plan?.requiredApprovals?.flatMap((item) => item.target?.tools ?? []) ?? [];
  const uncheckedCount = requiredStepNos.filter((stepNo) => !approvedStepNos.includes(stepNo)).length;
  const summaries: string[] = [];
  if (requiredStepNos.length) summaries.push(`计划要求审批 ${requiredStepNos.length} 个写入/高风险步骤，当前已勾选 ${requiredStepNos.length - uncheckedCount} 个。`);
  if (uncheckedCount > 0) summaries.push(`有 ${uncheckedCount} 个要求审批步骤未勾选，确认执行时后端不会把这些步骤视为已审批。`);
  if (requiredTools.some((tool) => ['write_chapter', 'polish_chapter', 'postprocess_chapter', 'auto_repair_chapter'].includes(tool))) summaries.push('草稿写入：可能创建或切换当前章节草稿版本。');
  if (requiredTools.some((tool) => ['extract_chapter_facts', 'fact_validation'].includes(tool))) summaries.push('事实层写入：可能更新剧情事件、角色状态、伏笔或校验问题。');
  if (requiredTools.some((tool) => ['rebuild_memory', 'review_memory'].includes(tool))) summaries.push('记忆写入：可能重建自动记忆并复核待确认记忆。');
  if (requiredTools.some((tool) => ['persist_outline', 'persist_project_assets'].includes(tool))) summaries.push('项目资产写入：可能新增或更新大纲、角色、设定、卷和章节。');
  return summaries;
}

// ────────────────────────────────────────────
// 可复用 UI 小组件
// ────────────────────────────────────────────

/** 运行状态指示徽章：紧凑型带圆点指示器 */
export function StatusBadge({ status }: { status: string }) {
  const color = status === 'succeeded' ? '#22c55e' : status === 'failed' ? '#ef4444' : status === 'waiting_approval' ? '#f59e0b' : 'var(--agent-text-accent)';
  return (
    <div
      className="inline-flex w-fit items-center gap-1.5 px-2 py-1 text-[10px] font-bold"
      style={{
        borderRadius: '999px',
        color,
        border: `1px solid ${color === 'var(--agent-text-accent)' ? 'var(--agent-border)' : `${color}44`}`,
        background: color === 'var(--agent-text-accent)' ? 'var(--agent-glass)' : `${color}12`,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 99, background: color, flexShrink: 0 }} />
      {status}
    </div>
  );
}

/** 单项指标卡片：带色调区分的 label + value 展示 */
export function Metric({ label, value, tone }: { label: string; value: string | number; tone?: 'ok' | 'warn' | 'danger' }) {
  const color = tone === 'danger' ? '#ef4444' : tone === 'warn' ? '#f59e0b' : tone === 'ok' ? '#22c55e' : 'var(--agent-text-accent)';
  return (
    <div className="p-2" style={{ borderRadius: '0.65rem', border: '1px solid var(--agent-border)', background: 'var(--agent-glass)' }}>
      <div className="text-[10px] font-bold" style={{ color: 'var(--agent-text-label)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</div>
      <div className="mt-1 text-xs font-bold break-all" style={{ color }}>{value}</div>
    </div>
  );
}

/** 列表块：用于展示假设/风险等文本数组 */
export function ListBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="p-3" style={{ borderRadius: '0.75rem', background: 'var(--agent-glass)', border: '1px solid var(--agent-border)' }}>
      <div className="text-xs font-bold mb-2" style={{ color: 'var(--agent-text-label)' }}>{title}</div>
      <ul className="space-y-2">
        {items.length ? items.map((item) => <li key={item} className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>• {item}</li>) : <li className="text-xs" style={{ color: 'var(--text-dim)' }}>—</li>}
      </ul>
    </div>
  );
}

/** 空状态占位文本 */
export function EmptyText({ text }: { text: string }) {
  return <div className="text-xs py-6 text-center" style={{ color: 'var(--agent-text-label)' }}>{text}</div>;
}
