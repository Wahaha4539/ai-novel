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
  {
    assetType: 'projectProfile',
    label: PROJECT_IMPORT_ASSET_LABELS.projectProfile,
    tool: 'generate_import_project_profile_preview',
    artifactType: 'project_profile_preview',
    purpose: '生成作品标题、类型、主题、简介和长梗概。',
    frontendSurface: '项目资料 / 项目概览',
  },
  {
    assetType: 'outline',
    label: PROJECT_IMPORT_ASSET_LABELS.outline,
    tool: 'generate_import_outline_preview',
    artifactType: 'outline_preview',
    purpose: '生成卷结构、章节规划、冲突、钩子和字数建议。',
    frontendSurface: '剧情大纲 / 卷与章节列表',
  },
  {
    assetType: 'characters',
    label: PROJECT_IMPORT_ASSET_LABELS.characters,
    tool: 'generate_import_characters_preview',
    artifactType: 'characters_preview',
    purpose: '生成角色档案、动机、背景、关系和人物定位。',
    frontendSurface: '角色与人设面板',
  },
  {
    assetType: 'worldbuilding',
    label: PROJECT_IMPORT_ASSET_LABELS.worldbuilding,
    tool: 'generate_import_worldbuilding_preview',
    artifactType: 'lorebook_preview',
    purpose: '生成地点、势力、规则、物件等世界设定条目。',
    frontendSurface: '故事圣经 / 世界设定',
  },
  {
    assetType: 'writingRules',
    label: PROJECT_IMPORT_ASSET_LABELS.writingRules,
    tool: 'generate_import_writing_rules_preview',
    artifactType: 'writing_rules_preview',
    purpose: '生成叙事视角、文风、节奏、禁忌和一致性规则。',
    frontendSurface: '写作规则面板',
  },
] as const;

export type ProjectImportAssetType = (typeof PROJECT_IMPORT_TARGET_SOURCES)[number]['assetType'];

export interface ProjectImportTargetSource {
  assetType: ProjectImportAssetType;
  label: string;
  tool: string;
  artifactType: string;
  purpose: string;
  frontendSurface: string;
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
  persist_timeline_events: '计划时间线',
  persist_guided_step_result: '创作引导结果',
  persist_volume_character_candidates: '卷级角色候选',
};

export interface AgentToolUiExplanation {
  label: string;
  purpose: string;
  output: string;
  frontendSurface: string;
  artifactTypes?: string[];
  usesLlm?: boolean;
}

const PROJECT_IMPORT_TARGET_TOOL_EXPLANATIONS: Record<string, AgentToolUiExplanation> = Object.fromEntries(
  PROJECT_IMPORT_TARGET_SOURCES.map((source) => [
    source.tool,
    {
      label: source.label,
      purpose: source.purpose,
      output: `${source.label}预览`,
      frontendSurface: source.frontendSurface,
      artifactTypes: [source.artifactType],
      usesLlm: true,
    },
  ]),
);

const AGENT_TOOL_UI_EXPLANATIONS: Record<string, AgentToolUiExplanation> = {
  inspect_project_context: {
    label: '读取项目上下文',
    purpose: '读取当前项目、章节和已有资料，避免生成内容脱离现有设定。',
    output: '项目上下文快照',
    frontendSurface: '作为后续步骤的上下文，不直接写入页面模块',
    usesLlm: false,
  },
  read_source_document: {
    label: '读取上传文档',
    purpose: '拉取并解析用户上传的创意文档或资料文件。',
    output: '源文档文本',
    frontendSurface: '附件内容 / 后续生成输入',
    usesLlm: false,
  },
  analyze_source_text: {
    label: '分析源文档',
    purpose: '提取文档段落、关键词和基础结构，给后续生成步骤做输入。',
    output: '文档分析结果',
    frontendSurface: '内部分析结果，不直接作为业务模块展示',
    usesLlm: false,
  },
  build_import_brief: {
    label: '生成导入简报',
    purpose: '把源文档压缩成多个目标产物可共用的全局理解。',
    output: '导入全局简报',
    frontendSurface: 'Tool Calls 展开详情 / 后续生成输入',
    artifactTypes: ['import_brief'],
    usesLlm: true,
  },
  ...PROJECT_IMPORT_TARGET_TOOL_EXPLANATIONS,
  build_import_preview: {
    label: '生成导入预览',
    purpose: 'Quick 模式下用一次生成完成所选项目资产预览。',
    output: '所选目标产物的综合预览',
    frontendSurface: '项目资料、剧情大纲、角色、故事圣经、写作规则等预览卡',
    artifactTypes: ['project_profile_preview', 'outline_preview', 'characters_preview', 'lorebook_preview', 'writing_rules_preview'],
    usesLlm: true,
  },
  merge_import_previews: {
    label: '合并导入预览',
    purpose: '把分目标生成的预览合并成统一导入预览，供校验和写入使用。',
    output: '统一导入预览',
    frontendSurface: '产物预览集合 / 后续校验输入',
    usesLlm: false,
  },
  cross_target_consistency_check: {
    label: '跨目标一致性检查',
    purpose: '检查大纲、角色、设定和写作规则之间是否互相冲突。',
    output: '一致性检查结果',
    frontendSurface: '执行详情 / 校验提示',
    usesLlm: false,
  },
  validate_imported_assets: {
    label: '校验导入资产',
    purpose: '检查预览内容是否可写入，并估算会新增、跳过或更新哪些资产。',
    output: '导入校验报告',
    frontendSurface: '产物预览中的校验报告',
    artifactTypes: ['import_validation_report'],
    usesLlm: false,
  },
  persist_project_assets: {
    label: '写入项目资产',
    purpose: '在用户确认后，把已校验的导入预览写入正式业务表。',
    output: '写入结果',
    frontendSurface: '项目资料、剧情大纲、角色、故事圣经、写作规则正式页面',
    artifactTypes: ['import_persist_result'],
    usesLlm: false,
  },
  generate_volume_outline_preview: {
    label: '生成卷级大纲',
    purpose: '生成单卷结构、卷内主线、storyUnits 和卷级角色规划候选，作为后续逐章细纲的稳定上游。',
    output: '卷级大纲预览',
    frontendSurface: 'Agent 产物预览 / 大纲预览中的卷摘要与角色规划指标',
    artifactTypes: ['outline_preview'],
    usesLlm: true,
  },
  generate_outline_preview: {
    label: '生成大纲预览',
    purpose: '生成或改写项目大纲、卷、章节规划、Chapter.craftBrief 和角色执行信息。',
    output: '大纲预览',
    frontendSurface: '剧情大纲 / 卷与章节列表',
    artifactTypes: ['outline_preview'],
    usesLlm: true,
  },
  generate_chapter_outline_preview: {
    label: '生成章节细纲',
    purpose: '基于卷纲为单章生成章节目标、场景段、执行卡和 craftBrief.characterExecution。',
    output: '单章章节细纲预览',
    frontendSurface: 'Agent 产物预览 / 合并后的大纲预览章节摘要',
    artifactTypes: ['outline_preview'],
    usesLlm: true,
  },
  merge_chapter_outline_previews: {
    label: '合并章节细纲',
    purpose: '把多个单章章节细纲预览合并为完整 outline_preview，并保留每章 craftBrief 和角色执行信息。',
    output: '完整大纲预览',
    frontendSurface: 'Agent 产物预览 / 大纲校验与写入前输入',
    artifactTypes: ['outline_preview'],
    usesLlm: false,
  },
  validate_outline: {
    label: '校验大纲',
    purpose: '只读校验大纲预览的章节连续性、执行卡、角色规划、未知角色引用和写入前 diff。',
    output: '大纲校验报告',
    frontendSurface: 'Agent 产物预览中的校验报告和写入前 Diff',
    artifactTypes: ['outline_validation_report'],
    usesLlm: false,
  },
  persist_outline: {
    label: '写入大纲',
    purpose: '把已确认且校验通过的大纲预览写入项目卷章结构；只写规划 JSON，不自动创建正式角色。',
    output: '大纲写入结果',
    frontendSurface: '剧情大纲 / 卷与章节列表',
    artifactTypes: ['outline_persist_result'],
    usesLlm: false,
  },
  persist_volume_character_candidates: {
    label: '写入卷级角色候选',
    purpose: '在用户明确审批后，把卷级 characterPlan 中选定候选写入正式 Character，并可写入对应关系边；章节临时角色不会写入。',
    output: '卷级角色候选写入结果',
    frontendSurface: '角色与人设面板 / 关系图面板',
    artifactTypes: ['volume_character_candidates_persist_result'],
    usesLlm: false,
  },
  generate_timeline_preview: {
    label: '生成计划时间线',
    purpose: '从全书大纲、卷大纲、章节细纲或 Chapter.craftBrief 生成 planned 时间线候选，不写库。',
    output: '计划时间线候选',
    frontendSurface: 'Agent 产物预览 / 时间线面板待审批候选',
    artifactTypes: ['timeline_preview'],
    usesLlm: true,
  },
  validate_timeline_preview: {
    label: '校验计划时间线',
    purpose: '校验章节引用、重复事件、sourceTrace 和写入前 diff，保持只读。',
    output: '计划时间线校验报告',
    frontendSurface: 'Agent 产物预览 / 写入前 Diff',
    artifactTypes: ['timeline_validation_report'],
    usesLlm: false,
  },
  persist_timeline_events: {
    label: '写入计划时间线',
    purpose: '在 Act 且用户审批后，把已校验的 TimelineEvent 候选写入当前项目。',
    output: '计划时间线写入结果',
    frontendSurface: '时间线面板',
    artifactTypes: ['timeline_persist_result'],
    usesLlm: false,
  },
  write_chapter: {
    label: '写章节草稿',
    purpose: '根据章节目标、上下文和记忆资料生成正文草稿。',
    output: '章节草稿',
    frontendSurface: '章节编辑器 / 草稿版本',
    artifactTypes: ['chapter_draft_result'],
    usesLlm: true,
  },
  polish_chapter: {
    label: '润色章节',
    purpose: '在保留剧情事实的前提下改善表达、节奏和文风。',
    output: '润色结果',
    frontendSurface: '章节编辑器 / 草稿版本',
    artifactTypes: ['chapter_polish_result'],
    usesLlm: true,
  },
  collect_chapter_context: {
    label: '收集章节上下文',
    purpose: '收集章节写作所需的大纲、角色、设定、记忆和历史草稿。',
    output: '章节上下文包',
    frontendSurface: '作为写作输入，不直接写入页面模块',
    artifactTypes: ['chapter_context_preview'],
    usesLlm: false,
  },
  collect_task_context: {
    label: '收集任务上下文',
    purpose: '为检查、修复或生成任务收集相关项目资料。',
    output: '任务上下文包',
    frontendSurface: '执行详情 / 后续步骤输入',
    artifactTypes: ['task_context_preview'],
    usesLlm: false,
  },
};

export function agentToolUiExplanation(tool?: string): AgentToolUiExplanation | undefined {
  if (!tool) return undefined;
  return AGENT_TOOL_UI_EXPLANATIONS[tool];
}

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
  if (requiredTools.includes('persist_volume_character_candidates')) {
    summaries.push('角色候选写入：确认后会把已审批的卷级角色候选写入正式角色表，可同时创建关系边；章节临时角色不会写入。');
  }
  if (requiredTools.includes('persist_timeline_events')) summaries.push('时间线写入：确认后会把已校验的 planned/changed TimelineEvent 候选写入当前项目。');
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
