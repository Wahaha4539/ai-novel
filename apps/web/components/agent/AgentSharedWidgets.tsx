'use client';

import type { AgentPlanPayload, AgentPlanRecord, AgentRun } from '../../hooks/useAgentRun';

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

export const PROJECT_IMPORT_ASSET_LABELS: Record<string, string> = {
  projectProfile: '项目资料',
  outline: '剧情大纲',
  characters: '角色与人设',
  worldbuilding: '世界设定',
  writingRules: '写作规则',
};

export const PROJECT_IMPORT_TARGET_SOURCES = [
  { assetType: 'projectProfile', label: PROJECT_IMPORT_ASSET_LABELS.projectProfile, tool: 'generate_import_project_profile_preview', artifactType: 'project_profile_preview' },
  { assetType: 'outline', label: PROJECT_IMPORT_ASSET_LABELS.outline, tool: 'generate_import_outline_preview', artifactType: 'outline_preview' },
  { assetType: 'characters', label: PROJECT_IMPORT_ASSET_LABELS.characters, tool: 'generate_import_characters_preview', artifactType: 'characters_preview' },
  { assetType: 'worldbuilding', label: PROJECT_IMPORT_ASSET_LABELS.worldbuilding, tool: 'generate_import_worldbuilding_preview', artifactType: 'lorebook_preview' },
  { assetType: 'writingRules', label: PROJECT_IMPORT_ASSET_LABELS.writingRules, tool: 'generate_import_writing_rules_preview', artifactType: 'writing_rules_preview' },
] as const;

export type ProjectImportAssetType = (typeof PROJECT_IMPORT_TARGET_SOURCES)[number]['assetType'];

export interface ProjectImportTargetSource {
  assetType: ProjectImportAssetType;
  label: string;
  tool: string;
  artifactType: string;
}

const PROJECT_IMPORT_TARGET_SOURCE_BY_TOOL = new Map<string, (typeof PROJECT_IMPORT_TARGET_SOURCES)[number]>(
  PROJECT_IMPORT_TARGET_SOURCES.map((source) => [source.tool, source]),
);

const PROJECT_IMPORT_TARGET_SOURCE_BY_ARTIFACT_TYPE = new Map<string, (typeof PROJECT_IMPORT_TARGET_SOURCES)[number]>(
  PROJECT_IMPORT_TARGET_SOURCES.map((source) => [source.artifactType, source]),
);

const WRITE_TOOL_LABELS: Record<string, string> = {
  write_chapter: '章节草稿',
  polish_chapter: '章节润色',
  postprocess_chapter: '章节后处理',
  auto_repair_chapter: '章节修复',
  extract_chapter_facts: '事实层',
  fact_validation: '事实校验',
  rebuild_memory: '自动记忆',
  review_memory: '记忆复核',
  persist_outline: '剧情大纲',
  persist_project_assets: '项目资产',
  persist_worldbuilding: '世界设定',
  persist_story_bible: '故事圣经',
  persist_continuity_changes: '连续性资料',
  persist_guided_step_result: '创作引导结果',
};

export interface AgentPlanWriteInfo {
  requiredStepNos: number[];
  requiredTools: string[];
  writeTools: string[];
  writeToolLabels: string[];
  projectImportAssetLabels: string[];
  hasWriteSteps: boolean;
  hasProjectImportWrite: boolean;
}

function uniqueStrings(items: string[]) {
  return [...new Set(items.filter(Boolean))];
}

function stringArray(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,\s，、]+/).filter(Boolean);
  return [];
}

function stepArgs(step: { args?: unknown } | undefined) {
  return step?.args && typeof step.args === 'object' ? (step.args as Record<string, unknown>) : undefined;
}

function isWriteTool(tool?: string) {
  return Boolean(tool && WRITE_TOOL_LABELS[tool]);
}

export function projectImportAssetTypeForArtifactType(artifactType?: string): ProjectImportAssetType | undefined {
  return artifactType ? PROJECT_IMPORT_TARGET_SOURCE_BY_ARTIFACT_TYPE.get(artifactType)?.assetType : undefined;
}

function collectProjectImportRequestedAssetTypes(plan: AgentPlanPayload | undefined) {
  const steps = plan?.steps ?? [];
  const requestedFromArgs = steps
    .filter((step) => ['build_import_preview', 'merge_import_previews', 'validate_imported_assets', 'persist_project_assets'].includes(step.tool ?? ''))
    .flatMap((step) => stringArray(stepArgs(step)?.requestedAssetTypes));
  const requestedFromTargetTools = steps.flatMap((step) => {
    const source = step.tool ? PROJECT_IMPORT_TARGET_SOURCE_BY_TOOL.get(step.tool) : undefined;
    return source ? [source.assetType] : [];
  });
  const requestedSet = new Set(uniqueStrings([...requestedFromArgs, ...requestedFromTargetTools]));
  return PROJECT_IMPORT_TARGET_SOURCES
    .map((source) => source.assetType)
    .filter((assetType) => requestedSet.has(assetType));
}

export function projectImportTargetSources(plan: AgentPlanPayload | undefined): ProjectImportTargetSource[] {
  const tools = new Set((plan?.steps ?? []).flatMap((step) => (step.tool ? [step.tool] : [])));
  return collectProjectImportRequestedAssetTypes(plan).map((assetType) => {
    const source = PROJECT_IMPORT_TARGET_SOURCES.find((item) => item.assetType === assetType)!;
    const tool = tools.has(source.tool) ? source.tool : tools.has('build_import_preview') ? 'build_import_preview' : source.tool;
    return { ...source, tool };
  });
}

/** 从 Plan 里提取“确认后会不会写入、会写入什么”的用户可见信息。 */
export function planWriteInfo(plan: AgentPlanPayload | undefined): AgentPlanWriteInfo {
  const steps = plan?.steps ?? [];
  const requiredStepNos = plan?.requiredApprovals?.flatMap((item) => item.target?.stepNos ?? []) ?? [];
  const requiredTools = uniqueStrings([
    ...(plan?.requiredApprovals?.flatMap((item) => item.target?.tools ?? []) ?? []),
    ...steps.filter((step) => step.stepNo && requiredStepNos.includes(step.stepNo)).flatMap((step) => (step.tool ? [step.tool] : [])),
  ]);
  const planTools = uniqueStrings(steps.flatMap((step) => (step.tool ? [step.tool] : [])));
  const writeTools = uniqueStrings(planTools.filter(isWriteTool));
  const writeToolLabels = uniqueStrings(writeTools.map((tool) => WRITE_TOOL_LABELS[tool] ?? tool));
  const requestedAssetTypes = collectProjectImportRequestedAssetTypes(plan);
  const projectImportAssetLabels = uniqueStrings(requestedAssetTypes.map((type) => PROJECT_IMPORT_ASSET_LABELS[type] ?? type));

  return {
    requiredStepNos,
    requiredTools,
    writeTools,
    writeToolLabels,
    projectImportAssetLabels,
    hasWriteSteps: writeTools.length > 0,
    hasProjectImportWrite: writeTools.includes('persist_project_assets'),
  };
}

/** 汇总审批风险信息，帮助用户快速了解 Plan 写入影响 */
export function approvalRiskSummary(plan: AgentPlanPayload | undefined, approvedStepNos: number[]) {
  const writeInfo = planWriteInfo(plan);
  const requiredStepNos = writeInfo.requiredStepNos;
  const requiredTools = writeInfo.requiredTools;
  const uncheckedCount = requiredStepNos.filter((stepNo) => !approvedStepNos.includes(stepNo)).length;
  const summaries: string[] = [];
  if (requiredStepNos.length) summaries.push(`计划要求审批 ${requiredStepNos.length} 个写入/高风险步骤，当前已勾选 ${requiredStepNos.length - uncheckedCount} 个。`);
  if (uncheckedCount > 0) summaries.push(`有 ${uncheckedCount} 个要求审批步骤未勾选，确认执行时后端不会把这些步骤视为已审批。`);
  if (requiredTools.some((tool) => ['write_chapter', 'polish_chapter', 'postprocess_chapter', 'auto_repair_chapter'].includes(tool))) summaries.push('草稿写入：可能创建或切换当前章节草稿版本。');
  if (requiredTools.some((tool) => ['extract_chapter_facts', 'fact_validation'].includes(tool))) summaries.push('事实层写入：可能更新剧情事件、角色状态、伏笔或校验问题。');
  if (requiredTools.some((tool) => ['rebuild_memory', 'review_memory'].includes(tool))) summaries.push('记忆写入：可能重建自动记忆并复核待确认记忆。');
  if (requiredTools.includes('persist_project_assets')) {
    const scope = writeInfo.projectImportAssetLabels.length ? writeInfo.projectImportAssetLabels.join('、') : '当前导入预览中的项目资产';
    summaries.push(`项目资产写入：确认后会按当前计划范围写入 ${scope}。`);
  } else if (requiredTools.includes('persist_outline')) {
    summaries.push('项目资产写入：确认后会新增或更新剧情大纲、卷和章节规划。');
  }
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
