'use client';

import { useMemo, useState } from 'react';
import { AgentRun } from '../../hooks/useAgentRun';
import { GUIDED_STEPS } from '../../hooks/useGuidedSession';
import {
  EmptyText,
  Metric,
  asArray,
  asRecord,
  latestPlan,
  numberValue,
  planWriteInfo,
  projectImportAssetTypeForArtifactType,
  projectImportTargetSources,
  safeJson,
  textValue,
  type ProjectImportAssetType,
  type ProjectImportTargetSource,
} from './AgentSharedWidgets';
import { PlannerDiagnosticsDetails } from './AgentPlanPanel';
import { buildPassageDiffSegments, parseChapterPassageRevisionPreview } from './chapterPassageRevisionPreview';
import { TimelineUpdatePreview } from './TimelineUpdatePreview';

// ────────────────────────────────────────────
// 产物去重与过滤
// ────────────────────────────────────────────

/** 按类型+标题保留最新产物，避免 Plan/Act 或多次 replan 后重复卡片淹没用户 */
function dedupeArtifacts(artifacts: NonNullable<AgentRun['artifacts']>) {
  const seen = new Set<string>();
  return [...artifacts].reverse().filter((artifact) => {
    const key = `${artifact.artifactType ?? ''}:${artifact.title ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).reverse();
}

function enrichArtifactsFromPlanSteps(run: AgentRun | null): NonNullable<AgentRun['artifacts']> {
  const artifacts = [...(run?.artifacts ?? [])];
  if (!run) return artifacts;

  if (!artifacts.some((artifact) => artifact.artifactType === 'guided_step_preview')) {
    const previewStep = latestSucceededPlanStep(run, 'generate_guided_step_preview');
    if (previewStep?.output) {
      artifacts.push({
        id: `${run.id}:guided_step_preview:${previewStep.stepNo}`,
        artifactType: 'guided_step_preview',
        title: '创作引导步骤预览',
        content: previewStep.output,
        createdAt: previewStep.finishedAt ?? previewStep.startedAt,
      });
    }
  }

  if (!artifacts.some((artifact) => artifact.artifactType === 'volume_character_candidates_preview')) {
    const characterPreview = buildVolumeCharacterCandidatesPreviewFromRun(run);
    if (characterPreview) artifacts.push(characterPreview);
  }

  return artifacts;
}

function latestSucceededPlanStep(run: AgentRun, toolName: string) {
  return [...(run.steps ?? [])].reverse().find((step) => {
    const stepToolName = step.tool ?? (step as { toolName?: string | null }).toolName;
    return step.mode === 'plan'
      && step.status === 'succeeded'
      && stepToolName === toolName
      && step.output;
  });
}

function buildVolumeCharacterCandidatesPreviewFromRun(run: AgentRun): NonNullable<AgentRun['artifacts']>[number] | undefined {
  const previewStep = latestSucceededPlanStep(run, 'generate_volume_outline_preview')
    ?? latestSucceededPlanStep(run, 'merge_chapter_outline_batch_previews')
    ?? latestSucceededPlanStep(run, 'merge_chapter_outline_previews')
    ?? latestSucceededPlanStep(run, 'generate_outline_preview');
  if (!previewStep?.output) return undefined;
  const inspectStep = latestSucceededPlanStep(run, 'inspect_project_context');
  const content = buildVolumeCharacterCandidatesPreviewContent(previewStep.output, inspectStep?.output);
  if (!content) return undefined;
  return {
    id: `${run.id}:volume_character_candidates_preview:${previewStep.stepNo}`,
    artifactType: 'volume_character_candidates_preview',
    title: '卷级角色候选写入预览',
    content,
    createdAt: previewStep.finishedAt ?? previewStep.startedAt,
  };
}

function buildVolumeCharacterCandidatesPreviewContent(preview: unknown, inspectContext: unknown) {
  const data = asRecord(preview);
  const volume = asRecord(data?.volume);
  const narrativePlan = asRecord(volume?.narrativePlan);
  const characterPlan = asRecord(narrativePlan?.characterPlan);
  const candidates = recordList(characterPlan?.newCharacterCandidates);
  if (!candidates.length) return undefined;
  const existingCatalog = buildExistingCharacterCatalog(inspectContext);
  const persistableCandidates: Array<Record<string, unknown>> = [];
  const existingCandidates: Array<Record<string, unknown>> = [];

  candidates.forEach((candidate) => {
    const name = textValue(candidate.name, '');
    if (!name) return;
    const row = {
      candidateId: textValue(candidate.candidateId, ''),
      name,
      roleType: textValue(candidate.roleType, ''),
      firstAppearChapter: numberValue(candidate.firstAppearChapter),
      narrativeFunction: textValue(candidate.narrativeFunction, ''),
      expectedArc: textValue(candidate.expectedArc, ''),
    };
    const existing = existingCatalog.get(normalizeComparableName(name));
    if (existing) {
      existingCandidates.push({
        ...row,
        existingName: existing.name,
        existingSource: existing.source,
        matchedBy: existing.matchedBy,
        reason: 'already_exists_in_character_table',
      });
    } else {
      persistableCandidates.push(row);
    }
  });

  return {
    volumeNo: numberValue(volume?.volumeNo),
    volumeTitle: textValue(volume?.title, ''),
    totalCandidateCount: candidates.length,
    persistableCount: persistableCandidates.length,
    existingCount: existingCandidates.length,
    persistableCandidates,
    existingCandidates,
    relationshipArcCount: recordList(characterPlan?.relationshipArcs).length,
    approvalMessage: 'persist_volume_character_candidates 只应写入可持久化候选；正式 Character 表中已存在的姓名或别名会在写入前跳过。',
  };
}

function buildExistingCharacterCatalog(inspectContext: unknown) {
  const inspect = asRecord(inspectContext);
  const catalog = new Map<string, { name: string; source?: string; matchedBy: 'name' | 'alias' }>();
  recordList(inspect?.characters).forEach((character) => {
    const name = textValue(character.name, '');
    if (!name) return;
    const source = textValue(character.source, '');
    catalog.set(normalizeComparableName(name), { name, source, matchedBy: 'name' });
    stringList(character.aliases).forEach((alias) => {
      catalog.set(normalizeComparableName(alias), { name, source, matchedBy: 'alias' });
    });
  });
  return catalog;
}

function normalizeComparableName(value: string) {
  return value.trim().toLocaleLowerCase();
}

function filterArtifacts(artifacts: NonNullable<AgentRun['artifacts']>, query: string) {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return artifacts;
  return artifacts.filter((artifact) => `${artifact.artifactType ?? ''}\n${artifact.title ?? ''}\n${safeJson(artifact.content)}`.toLowerCase().includes(keyword));
}

interface ArtifactSourceInfo {
  label: string;
  tool: string;
  verb: '生成' | '校验' | '写入';
  scope?: string;
  assetType?: ProjectImportAssetType;
}

interface RepairDiagnosticView {
  toolName?: string;
  attempts?: number;
  model?: string;
  failedError?: string;
  repairedFromErrors?: string[];
}

function artifactSourceInfo(artifactType: string | undefined, targetSources: ProjectImportTargetSource[], projectImportAssetLabels: string[]): ArtifactSourceInfo | undefined {
  const targetSource = targetSources.find((source) => source.artifactType === artifactType);
  if (targetSource) return { label: targetSource.label, tool: targetSource.tool, verb: '生成', assetType: targetSource.assetType };
  if (artifactType === 'import_validation_report') return { label: '导入预览', tool: 'validate_imported_assets', verb: '校验' };
  if (artifactType === 'import_persist_result') {
    return {
      label: '项目资产',
      tool: 'persist_project_assets',
      verb: '写入',
      scope: projectImportAssetLabels.length ? projectImportAssetLabels.join('、') : undefined,
    };
  }
  if (artifactType === 'timeline_preview') return { label: '计划时间线', tool: 'generate_timeline_preview', verb: '生成', scope: 'TimelineEvent 候选' };
  if (artifactType === 'timeline_validation_report') return { label: '时间线校验', tool: 'validate_timeline_preview', verb: '校验', scope: '写入前 diff' };
  if (artifactType === 'timeline_persist_result') return { label: '时间线写入', tool: 'persist_timeline_events', verb: '写入', scope: 'TimelineEvent' };
  if (artifactType === 'story_units_preview') return { label: '单元故事计划', tool: 'generate_story_units_preview', verb: '生成', scope: 'Volume.narrativePlan.storyUnitPlan' };
  if (artifactType === 'story_units_persist_result') return { label: '单元故事计划', tool: 'persist_story_units', verb: '写入', scope: 'Volume.narrativePlan.storyUnitPlan' };
  if (artifactType === 'volume_character_candidates_preview') return { label: '卷级角色候选', tool: 'generate_volume_outline_preview', verb: '生成', scope: 'persist_volume_character_candidates 写入前过滤' };
  if (artifactType === 'volume_character_candidates_persist_result') return { label: '卷级角色候选', tool: 'persist_volume_character_candidates', verb: '写入', scope: 'Character / RelationshipEdge' };
  return undefined;
}

function buildRepairDiagnosticsByTool(run: AgentRun | null): Map<string, RepairDiagnosticView[]> {
  const byTool = new Map<string, RepairDiagnosticView[]>();
  for (const step of run?.steps ?? []) {
    const stepTool = step.tool ?? step.toolName;
    for (const diagnostic of step.metadata?.repairDiagnostics ?? []) {
      const toolName = diagnostic.toolName ?? stepTool;
      if (!toolName) continue;
      const list = byTool.get(toolName) ?? [];
      list.push(diagnostic);
      byTool.set(toolName, list);
    }
  }
  return byTool;
}

function repairDiagnosticsForArtifact(
  artifactType: string | undefined,
  sourceInfo: ArtifactSourceInfo | undefined,
  byTool: Map<string, RepairDiagnosticView[]>,
): RepairDiagnosticView[] {
  const tools = new Set<string>();
  if (sourceInfo?.tool) tools.add(sourceInfo.tool);
  for (const tool of artifactToolCandidates(artifactType)) tools.add(tool);
  return [...tools].flatMap((tool) => byTool.get(tool) ?? []);
}

function artifactToolCandidates(artifactType: string | undefined): string[] {
  switch (artifactType) {
    case 'outline_preview':
      return ['merge_chapter_outline_batch_previews', 'merge_chapter_outline_previews', 'generate_outline_preview', 'generate_chapter_outline_batch_preview', 'generate_chapter_outline_preview', 'generate_volume_outline_preview'];
    case 'story_units_preview':
      return ['generate_story_units_preview'];
    case 'chapter_craft_brief_preview':
      return ['generate_chapter_craft_brief_preview'];
    case 'project_profile_preview':
      return ['generate_import_project_profile_preview'];
    case 'characters_preview':
      return ['generate_import_characters_preview'];
    case 'lorebook_preview':
      return ['generate_import_worldbuilding_preview'];
    case 'writing_rules_preview':
      return ['generate_import_writing_rules_preview'];
    default:
      return [];
  }
}

// ────────────────────────────────────────────
// ArtifactPanel 主体
// ────────────────────────────────────────────

interface AgentArtifactPanelProps {
  run: AgentRun | null;
  query: string;
  onQueryChange: (value: string) => void;
  onRequestWorldbuildingPersistSelection?: (titles: string[]) => void | Promise<void>;
  onRequestImportTargetRegeneration?: (assetType: ProjectImportAssetType) => void | Promise<void>;
  canApplyPassageRevision?: boolean;
  onApplyPassageRevision?: () => void | Promise<void>;
  actionDisabled?: boolean;
}

/** 产物预览面板：搜索、去重、按类型渲染业务化摘要 */
export function AgentArtifactPanel({
  run,
  query,
  onQueryChange,
  onRequestWorldbuildingPersistSelection,
  onRequestImportTargetRegeneration,
  canApplyPassageRevision,
  onApplyPassageRevision,
  actionDisabled,
}: AgentArtifactPanelProps) {
  const plan = latestPlan(run);
  const targetSources = useMemo(() => projectImportTargetSources(plan), [plan]);
  const writeInfo = useMemo(() => planWriteInfo(plan), [plan]);
  const repairDiagnosticsByTool = useMemo(() => buildRepairDiagnosticsByTool(run), [run]);
  const artifacts = dedupeArtifacts(enrichArtifactsFromPlanSteps(run));
  const selectedTargetArtifactTypes = new Set(targetSources.map((source) => source.artifactType));
  const visibleArtifacts = targetSources.length
    ? artifacts.filter((artifact) => {
        const targetAssetType = projectImportAssetTypeForArtifactType(artifact.artifactType);
        return !targetAssetType || selectedTargetArtifactTypes.has(artifact.artifactType ?? '');
      })
    : artifacts;
  const filteredArtifacts = filterArtifacts(visibleArtifacts, query);

  return (
    <section className="agent-panel-section">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>产物预览</h2>
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索产物/JSON…"
          className="agent-artifact-search"
        />
      </div>
      {filteredArtifacts.length ? (
        <div className="space-y-3">
          {filteredArtifacts.map((artifact) => {
            const sourceInfo = artifactSourceInfo(artifact.artifactType, targetSources, writeInfo.projectImportAssetLabels);
            return (
              <ArtifactCard
                key={artifact.id}
                artifactType={artifact.artifactType}
                title={artifact.title}
                content={artifact.content}
                sourceInfo={sourceInfo}
                repairDiagnostics={repairDiagnosticsForArtifact(artifact.artifactType, sourceInfo, repairDiagnosticsByTool)}
                onRequestWorldbuildingPersistSelection={onRequestWorldbuildingPersistSelection}
                onRequestImportTargetRegeneration={onRequestImportTargetRegeneration}
                canApplyPassageRevision={canApplyPassageRevision}
                onApplyPassageRevision={onApplyPassageRevision}
                actionDisabled={actionDisabled}
              />
            );
          })}
        </div>
      ) : (
        <EmptyText text={visibleArtifacts.length ? '没有匹配的产物。' : '计划产物和预览会在这里展开。'} />
      )}
    </section>
  );
}

// ────────────────────────────────────────────
// ArtifactCard + TypedArtifactPreview
// ────────────────────────────────────────────

/** 产物类型的 emoji 映射，提升视觉扫描效率 */
function typeEmoji(type?: string): string {
  if (!type) return '📦';
  if (type.includes('guided')) return '🧭';
  if (type.includes('outline')) return '📑';
  if (type.includes('story_units')) return '📚';
  if (type.includes('plot')) return '🧭';
  if (type.includes('chapter')) return '📝';
  if (type.includes('character')) return '👤';
  if (type.includes('validation') || type.includes('quality')) return '🔍';
  if (type.includes('fact')) return '🧩';
  if (type.includes('memory')) return '🧠';
  if (type.includes('worldbuilding')) return '🌐';
  if (type.includes('profile') || type.includes('project')) return '📋';
  if (type.includes('lorebook')) return '📚';
  if (type.includes('repair')) return '🔧';
  if (type.includes('polish')) return '✨';
  return '📦';
}

function ArtifactCard({
  artifactType,
  title,
  content,
  sourceInfo,
  repairDiagnostics,
  onRequestWorldbuildingPersistSelection,
  onRequestImportTargetRegeneration,
  canApplyPassageRevision,
  onApplyPassageRevision,
  actionDisabled,
}: {
  artifactType?: string;
  title?: string;
  content?: unknown;
  sourceInfo?: ArtifactSourceInfo;
  repairDiagnostics?: RepairDiagnosticView[];
  onRequestWorldbuildingPersistSelection?: (titles: string[]) => void | Promise<void>;
  onRequestImportTargetRegeneration?: (assetType: ProjectImportAssetType) => void | Promise<void>;
  canApplyPassageRevision?: boolean;
  onApplyPassageRevision?: () => void | Promise<void>;
  actionDisabled?: boolean;
}) {
  return (
    <details className="agent-artifact-card">
      <summary className="agent-artifact-card__summary">
        <span className="agent-artifact-card__icon" aria-hidden="true">{typeEmoji(artifactType)}</span>
        <span className="agent-artifact-card__title">{title ?? artifactType ?? 'Artifact'}</span>
        {artifactType && <span className="agent-artifact-card__type">{artifactType}</span>}
        <span className="agent-artifact-card__arrow" aria-hidden="true">▸</span>
      </summary>
      <div className="agent-artifact-card__body">
        {sourceInfo && <ArtifactSourceLine sourceInfo={sourceInfo} onRequestImportTargetRegeneration={onRequestImportTargetRegeneration} actionDisabled={actionDisabled} />}
        <RepairDiagnosticsLine diagnostics={repairDiagnostics} />
        <TypedArtifactPreview
          artifactType={artifactType}
          content={content}
          onRequestWorldbuildingPersistSelection={onRequestWorldbuildingPersistSelection}
          canApplyPassageRevision={canApplyPassageRevision}
          onApplyPassageRevision={onApplyPassageRevision}
          actionDisabled={actionDisabled}
        />
        <details className="agent-artifact-card__json-toggle">
          <summary className="cursor-pointer text-xs" style={{ color: 'var(--agent-text-label)' }}>📄 原始 JSON</summary>
          <pre className="agent-artifact-card__json">{safeJson(content)}</pre>
        </details>
      </div>
    </details>
  );
}

function RepairDiagnosticsLine({ diagnostics }: { diagnostics?: RepairDiagnosticView[] }) {
  if (!diagnostics?.length) return null;
  const attempts = diagnostics.reduce((sum, item) => sum + (numberValue(item.attempts) ?? 0), 0);
  const failed = diagnostics.find((item) => textValue(item.failedError));
  const model = diagnostics.map((item) => textValue(item.model, '')).find(Boolean);
  return (
    <div
      className="mb-3 rounded-md border px-3 py-2 text-xs"
      style={{
        borderColor: failed ? 'rgba(248,113,113,0.32)' : 'rgba(20,184,166,0.30)',
        background: failed ? 'rgba(127,29,29,0.12)' : 'rgba(20,184,166,0.08)',
        color: failed ? '#fecaca' : '#99f6e4',
      }}
    >
      结构修复：{failed ? `尝试 ${attempts || diagnostics.length} 次后仍失败` : `已由 LLM 修复 ${attempts || diagnostics.length} 次并重新校验`}
      {model ? <span style={{ color: 'var(--text-muted)' }}> · {model}</span> : null}
      {failed?.failedError ? <div className="mt-1" style={{ color: 'var(--text-muted)' }}>{failed.failedError}</div> : null}
    </div>
  );
}

function ArtifactSourceLine({
  sourceInfo,
  onRequestImportTargetRegeneration,
  actionDisabled,
}: {
  sourceInfo: ArtifactSourceInfo;
  onRequestImportTargetRegeneration?: (assetType: ProjectImportAssetType) => void | Promise<void>;
  actionDisabled?: boolean;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
      <span
        className="inline-flex items-center gap-1 rounded-full border px-2 py-1"
        style={{ borderColor: 'var(--border-dim)', background: 'rgba(15,23,42,0.18)' }}
      >
        <span style={{ color: 'var(--text-main)' }}>{sourceInfo.label}</span>由
        <code className="text-[11px]" style={{ color: '#67e8f9' }}>{sourceInfo.tool}</code>
        {sourceInfo.verb}
      </span>
      {sourceInfo.scope && (
        <span
          className="inline-flex items-center rounded-full border px-2 py-1"
          style={{ borderColor: 'rgba(20,184,166,0.28)', color: '#5eead4', background: 'rgba(20,184,166,0.08)' }}
        >
          写入范围：{sourceInfo.scope}
        </span>
      )}
      {sourceInfo.assetType && onRequestImportTargetRegeneration && (
        <button
          type="button"
          className="agent-new-session-btn"
          onClick={() => void onRequestImportTargetRegeneration(sourceInfo.assetType!)}
          disabled={actionDisabled}
          title={`只重新生成${sourceInfo.label}预览，写入仍需确认`}
          style={{ padding: '0.35rem 0.55rem', fontSize: 11 }}
        >
          重新生成{sourceInfo.label}
        </button>
      )}
    </div>
  );
}

/** 按 AgentArtifact 类型提供业务化摘要，避免用户只能阅读大段 JSON */
function TypedArtifactPreview({
  artifactType,
  content,
  onRequestWorldbuildingPersistSelection,
  canApplyPassageRevision,
  onApplyPassageRevision,
  actionDisabled,
}: {
  artifactType?: string;
  content?: unknown;
  onRequestWorldbuildingPersistSelection?: (titles: string[]) => void | Promise<void>;
  canApplyPassageRevision?: boolean;
  onApplyPassageRevision?: () => void | Promise<void>;
  actionDisabled?: boolean;
}) {
  if (artifactType === 'outline_preview') return <OutlinePreviewSummary content={content} />;
  if (artifactType === 'agent_plan_preview') return <AgentPlanPreviewSummary content={content} />;
  if (artifactType === 'guided_step_preview') return <GuidedStepPreviewSummary content={content} />;
  if (artifactType === 'outline_validation_report' || artifactType === 'import_validation_report' || artifactType === 'fact_validation_report' || artifactType === 'worldbuilding_validation_report') return <ValidationSummary content={content} />;
  if (artifactType === 'project_profile_preview') return <ProjectProfileSummary content={content} />;
  if (artifactType === 'characters_preview') return <ArraySummary content={content} label="角色" primaryKey="name" secondaryKey="roleType" />;
  if (artifactType === 'lorebook_preview') return <ArraySummary content={content} label="设定" primaryKey="title" secondaryKey="entryType" />;
  if (artifactType === 'writing_rules_preview') return <ArraySummary content={content} label="写作规则" primaryKey="title" secondaryKey="ruleType" />;
  if (artifactType === 'worldbuilding_preview') return <WorldbuildingPreviewSummary content={content} onRequestPersistSelection={onRequestWorldbuildingPersistSelection} actionDisabled={actionDisabled} />;
  if (artifactType === 'worldbuilding_persist_result') return <WorldbuildingPersistSummary content={content} />;
  if (artifactType === 'story_bible_preview') return <StoryBiblePreviewSummary content={content} />;
  if (artifactType === 'story_bible_validation_report') return <StoryBibleValidationSummary content={content} />;
  if (artifactType === 'story_bible_persist_result') return <StoryBiblePersistSummary content={content} />;
  if (artifactType === 'chapter_craft_brief_preview') return <ChapterCraftBriefPreviewSummary content={content} />;
  if (artifactType === 'chapter_craft_brief_validation_report') return <ChapterCraftBriefValidationSummary content={content} />;
  if (artifactType === 'chapter_craft_brief_persist_result') return <ChapterCraftBriefPersistSummary content={content} />;
  if (artifactType === 'timeline_preview') return <TimelinePreviewSummary content={content} />;
  if (artifactType === 'timeline_validation_report') return <TimelineValidationSummary content={content} />;
  if (artifactType === 'timeline_persist_result') return <TimelinePersistSummary content={content} />;
  if (artifactType === 'continuity_preview') return <ContinuityPreviewSummary content={content} />;
  if (artifactType === 'continuity_validation_report') return <ContinuityValidationSummary content={content} />;
  if (artifactType === 'continuity_persist_result') return <ContinuityPersistSummary content={content} />;
  if (artifactType === 'character_consistency_report') return <CharacterConsistencySummary content={content} />;
  if (artifactType === 'plot_consistency_report') return <PlotConsistencySummary content={content} />;
  if (artifactType === 'task_context_preview') return <TaskContextSummary content={content} />;
  if (artifactType === 'outline_persist_result') return <OutlinePersistSummary content={content} />;
  if (artifactType === 'story_units_preview') return <StoryUnitsPreviewSummary content={content} />;
  if (artifactType === 'story_units_persist_result') return <StoryUnitsPersistSummary content={content} />;
  if (artifactType === 'volume_character_candidates_preview') return <VolumeCharacterCandidatesPreviewSummary content={content} />;
  if (artifactType === 'volume_character_candidates_persist_result') return <VolumeCharacterCandidatesPersistSummary content={content} />;
  if (artifactType === 'chapter_passage_revision_preview') {
    return (
      <ChapterPassageRevisionPreviewSummary
        content={content}
        canApply={canApplyPassageRevision}
        onApply={onApplyPassageRevision}
        actionDisabled={actionDisabled}
      />
    );
  }
  if (artifactType === 'import_persist_result') return <PersistSummary content={content} />;
  if (artifactType === 'chapter_draft_result') return <ChapterDraftSummary content={content} />;
  if (artifactType === 'chapter_generation_quality_report') return <GenerationQualitySummary content={content} />;
  if (artifactType === 'chapter_polish_result') return <ChapterPolishSummary content={content} />;
  if (artifactType === 'chapter_context_preview') return <ChapterContextSummary content={content} />;
  if (artifactType === 'fact_extraction_report') return <FactExtractionSummary content={content} />;
  if (artifactType === 'auto_repair_report') return <AutoRepairSummary content={content} />;
  if (artifactType === 'memory_rebuild_report') return <PersistSummary content={content} />;
  if (artifactType === 'memory_review_report') return <MemoryReviewSummary content={content} />;
  return <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无专用视图，已保留原始 JSON。</div>;
}

// ── 以下为各类型产物摘要组件 ──

function ChapterPassageRevisionPreviewSummary({
  content,
  canApply,
  onApply,
  actionDisabled,
}: {
  content: unknown;
  canApply?: boolean;
  onApply?: () => void | Promise<void>;
  actionDisabled?: boolean;
}) {
  const preview = parseChapterPassageRevisionPreview(content);
  if (!preview) {
    return <div className="text-xs" style={{ color: 'var(--text-muted)' }}>章节选区预览结构不完整，请展开原始 JSON 查看。</div>;
  }

  const diffSegments = buildPassageDiffSegments(preview.originalText, preview.replacementText);
  const paragraphLabel = preview.selectedParagraphRange
    ? `${preview.selectedParagraphRange.start}-${preview.selectedParagraphRange.end} / ${preview.selectedParagraphRange.count} 段`
    : '未记录';
  const charDelta = preview.replacementText.length - preview.originalText.length;
  const canApplyNow = Boolean(canApply && onApply && preview.validation.valid);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid flex-1 gap-2 md:grid-cols-4">
          <Metric label="Draft 版本" value={`v${preview.draftVersion}`} />
          <Metric label="字符范围" value={`${preview.selectedRange.start}-${preview.selectedRange.end}`} />
          <Metric label="段落范围" value={paragraphLabel} />
          <Metric label="字数变化" value={formatSignedDelta(charDelta)} tone={charDelta < 0 ? 'ok' : charDelta > 0 ? 'warn' : undefined} />
        </div>
        {canApplyNow ? (
          <div className="flex min-w-[11rem] flex-col gap-2">
            <button
              type="button"
              className="agent-new-session-btn"
              onClick={() => void onApply?.()}
              disabled={actionDisabled}
              title="审批并应用这段局部修订，后端会创建新的 ChapterDraft 版本。"
            >
              应用到正文
            </button>
            <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
              审批后会新建 ChapterDraft，不会覆盖当前 draft。
            </span>
          </div>
        ) : null}
      </div>

      <div className="rounded-lg border p-3" style={{ borderColor: 'rgba(103,232,249,0.18)', background: 'rgba(15,23,42,0.18)' }}>
        <div className="mb-1 text-xs font-semibold" style={{ color: '#67e8f9' }}>修改摘要</div>
        <div className="text-sm leading-6" style={{ color: 'var(--text-main)' }}>{preview.editSummary}</div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <PassageTextCard title="原文" text={preview.originalText} tone="before" />
        <PassageTextCard title="替换预览" text={preview.replacementText} tone="after" />
      </div>

      <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-dim)', background: 'rgba(15,23,42,0.18)' }}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-xs font-semibold" style={{ color: 'var(--text-main)' }}>Diff</div>
          <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
            删除为红色删除线，新增为绿色高亮
          </div>
        </div>
        <div
          className="rounded-md border px-3 py-2 text-sm leading-6"
          style={{ borderColor: 'rgba(148,163,184,0.16)', background: 'rgba(2,6,23,0.26)', color: 'var(--text-main)', whiteSpace: 'pre-wrap' }}
        >
          {diffSegments.map((segment, index) => (
            <span
              key={`${segment.type}-${index}`}
              style={passageDiffSegmentStyle(segment.type)}
            >
              {segment.text}
            </span>
          ))}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <PassageNoteCard
          title="保留事实"
          tone="ok"
          emptyText="未单独标记保留事实。"
          items={preview.preservedFacts}
        />
        <PassageNoteCard
          title="风险提示"
          tone={preview.risks.length || preview.validation.issues.length ? 'warn' : 'ok'}
          emptyText="当前没有额外风险提示。"
          items={[...preview.risks, ...preview.validation.issues]}
        />
      </div>
    </div>
  );
}

function PassageTextCard({ title, text, tone }: { title: string; text: string; tone: 'before' | 'after' }) {
  const palette = tone === 'after'
    ? { borderColor: 'rgba(74,222,128,0.24)', background: 'rgba(20,83,45,0.18)', titleColor: '#bbf7d0' }
    : { borderColor: 'rgba(248,113,113,0.18)', background: 'rgba(69,10,10,0.18)', titleColor: '#fecaca' };
  return (
    <div className="rounded-lg border p-3" style={{ borderColor: palette.borderColor, background: palette.background }}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-xs font-semibold" style={{ color: palette.titleColor }}>{title}</div>
        <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>{text.length} 字</div>
      </div>
      <div className="text-sm leading-6" style={{ color: 'var(--text-main)', whiteSpace: 'pre-wrap' }}>{text}</div>
    </div>
  );
}

function PassageNoteCard({
  title,
  tone,
  items,
  emptyText,
}: {
  title: string;
  tone: 'ok' | 'warn';
  items: string[];
  emptyText: string;
}) {
  const palette = tone === 'warn'
    ? { borderColor: 'rgba(251,191,36,0.24)', background: 'rgba(120,53,15,0.16)', chipColor: '#fde68a' }
    : { borderColor: 'rgba(20,184,166,0.24)', background: 'rgba(15,118,110,0.14)', chipColor: '#99f6e4' };
  return (
    <div className="rounded-lg border p-3" style={{ borderColor: palette.borderColor, background: palette.background }}>
      <div className="mb-2 text-xs font-semibold" style={{ color: 'var(--text-main)' }}>{title}</div>
      {items.length ? (
        <div className="flex flex-wrap gap-2">
          {items.map((item, index) => (
            <span
              key={`${title}-${index}`}
              className="rounded-full border px-2 py-1 text-[11px]"
              style={{ borderColor: 'rgba(148,163,184,0.18)', color: palette.chipColor, background: 'rgba(15,23,42,0.22)' }}
            >
              {item}
            </span>
          ))}
        </div>
      ) : (
        <div className="text-xs" style={{ color: 'var(--text-dim)' }}>{emptyText}</div>
      )}
    </div>
  );
}

function passageDiffSegmentStyle(type: 'equal' | 'add' | 'remove') {
  if (type === 'add') {
    return {
      background: 'rgba(74,222,128,0.18)',
      color: '#dcfce7',
      borderRadius: 4,
    } as const;
  }
  if (type === 'remove') {
    return {
      background: 'rgba(248,113,113,0.14)',
      color: '#fecaca',
      textDecorationLine: 'line-through',
      borderRadius: 4,
    } as const;
  }
  return { color: 'var(--text-main)' } as const;
}

function formatSignedDelta(value: number) {
  if (value === 0) return '0';
  return value > 0 ? `+${value}` : String(value);
}

function AgentPlanPreviewSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const steps = asArray(data?.steps);
  const approvals = asArray(data?.requiredApprovals);
  const diagnostics = asRecord(data?.plannerDiagnostics);
  const toolNames = steps.map((step) => textValue(asRecord(step)?.tool, '')).filter(Boolean);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="任务类型" value={textValue(data?.taskType)} />
        <Metric label="步骤" value={steps.length} />
        <Metric label="审批" value={approvals.length} tone={approvals.length ? 'warn' : 'ok'} />
        <Metric label="Planner" value={textValue(diagnostics?.source, '—')} />
      </div>
      {toolNames.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {toolNames.slice(0, 12).map((tool) => (
            <code
              key={tool}
              className="rounded-full border px-2 py-1 text-[11px]"
              style={{ borderColor: 'rgba(103,232,249,0.28)', color: '#67e8f9', background: 'rgba(15,23,42,0.20)' }}
            >
              {tool}
            </code>
          ))}
          {toolNames.length > 12 && <span className="text-xs" style={{ color: 'var(--text-dim)' }}>+{toolNames.length - 12}</span>}
        </div>
      )}
      <PlannerDiagnosticsDetails diagnostics={diagnostics} className="mt-0" />
    </div>
  );
}

function OutlinePreviewSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const volume = asRecord(data?.volume);
  const volumes = asArray(data?.volumes);
  const volumeRecords = volume ? [volume] : recordList(volumes);
  const chapters = asArray(data?.chapters);
  const chapterRecords = chapters.map((item) => asRecord(item) ?? {});
  const totalExpectedWordCount = chapters.reduce<number>((sum, item) => sum + numberValue(asRecord(item)?.expectedWordCount), 0);
  const volumeTitle = volume?.title ? textValue(volume.title) : volumes.length ? `${volumes.length} 卷` : '未命名卷';
  const craftBriefCount = chapterRecords.filter((chapter) => hasCraftBrief(chapter.craftBrief)).length;
  const risks = asArray(data?.risks);
  const riskTexts = risks.map((item) => textValue(item)).filter(Boolean);
  const fallbackChapterCount = fallbackChapterCountFromRisks(riskTexts, chapters.length);
  const validation = asRecord(data?.validation);
  const stats = asRecord(data?.stats ?? validation?.stats);
  const outlineContext = asRecord(data?.chapterOutlineContext);
  const batchRanges = recordList(outlineContext?.batchRanges);
  const approvalMessage = textValue(outlineContext?.approvalMessage, '');
  const batchRangeSummary = batchRanges
    .map((range) => {
      const start = numberValue(range.start, 0);
      const end = numberValue(range.end, 0);
      return start && end ? `第${start}-${end}章` : '';
    })
    .filter(Boolean)
    .join('、');
  const volumeCandidateCount = numberValue(stats?.volumeCharacterCandidateCount, volumeCharacterCandidateCount(volumeRecords));
  const chapterCharacterExecutionCount = numberValue(stats?.chapterCharacterExecutionCount, chapterRecords.filter(hasChapterCharacterExecution).length);
  const temporaryCharacterCount = numberValue(stats?.temporaryCharacterCount, chapterRecords.reduce((sum, chapter) => sum + chapterTemporaryCharacterCount(chapter), 0));
  const characterRiskCount = outlineCharacterRiskCount(stats, riskTexts);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-5">
        <Metric label="卷" value={volumeTitle} />
        <Metric label="章节数" value={chapters.length} />
        <Metric label="执行卡覆盖" value={`${craftBriefCount}/${chapters.length}`} tone={craftBriefCount === chapters.length ? 'ok' : craftBriefCount > 0 ? 'warn' : 'danger'} />
        <Metric label="角色候选" value={volumeCandidateCount} tone={volumeCandidateCount ? 'warn' : 'ok'} />
        <Metric label="角色执行覆盖" value={`${chapterCharacterExecutionCount}/${chapters.length}`} tone={chapterCharacterExecutionCount === chapters.length ? 'ok' : chapterCharacterExecutionCount > 0 ? 'warn' : 'danger'} />
        <Metric label="临时角色" value={temporaryCharacterCount} tone={temporaryCharacterCount ? 'warn' : 'ok'} />
        <Metric label="角色引用风险" value={characterRiskCount} tone={characterRiskCount ? 'danger' : 'ok'} />
        <Metric label="异常风险章节" value={fallbackChapterCount} tone={fallbackChapterCount ? 'danger' : 'ok'} />
        <Metric label="风险" value={riskTexts.length} tone={riskTexts.length ? 'warn' : 'ok'} />
        <Metric label="总目标字数" value={totalExpectedWordCount} />
        {textValue(outlineContext?.chapterCountSourceLabel, '') && <Metric label="章数来源" value={textValue(outlineContext?.chapterCountSourceLabel)} />}
        {textValue(outlineContext?.storyUnitPlanSourceLabel, '') && <Metric label="单元故事来源" value={textValue(outlineContext?.storyUnitPlanSourceLabel)} />}
        {batchRanges.length > 0 && <Metric label="批次数" value={batchRanges.length} tone="ok" />}
      </div>
      {approvalMessage && (
        <div className="rounded-lg border px-3 py-2 text-xs leading-5" style={{ borderColor: 'rgba(103,232,249,0.24)', background: 'rgba(14,165,233,0.07)', color: 'var(--text-muted)' }}>
          {approvalMessage}
          {batchRangeSummary ? <div className="mt-1">批次覆盖：{batchRangeSummary}</div> : null}
        </div>
      )}
      <OutlineWriteNotice fallbackChapterCount={fallbackChapterCount} riskCount={riskTexts.length} />
      {riskTexts.length > 0 && (
        <div className="space-y-1">
          {riskTexts.slice(0, 4).map((risk, index) => (
            <div key={index} className="text-xs leading-5" style={{ color: '#fbbf24' }}>风险：{risk}</div>
          ))}
        </div>
      )}
      <div className="space-y-2">
        {volume && chapters.length === 0 && (
          <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>
            <b style={{ color: 'var(--text-main)' }}>第 {numberValue(volume.volumeNo, 1)} 卷：{textValue(volume.title, '未命名卷')}</b>
            <div>{textValue(volume.objective, '暂无目标')}</div>
            <div>{textValue(volume.synopsis, '暂无简介')}</div>
          </div>
        )}
        {volumes.slice(0, 3).map((item, index) => {
          const itemVolume = asRecord(item);
          return <div key={`volume-${index}`} className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}><b style={{ color: 'var(--text-main)' }}>第 {numberValue(itemVolume?.volumeNo, index + 1)} 卷：{textValue(itemVolume?.title, '未命名卷')}</b> — {textValue(itemVolume?.synopsis ?? itemVolume?.objective, '暂无简介')}</div>;
        })}
        {chapterRecords.slice(0, 5).map((chapter, index) => <OutlineChapterSummary key={index} chapter={chapter} index={index} />)}
        {chapters.length > 5 && <div className="text-xs" style={{ color: 'var(--text-dim)' }}>还有 {chapters.length - 5} 章，完整内容见原始 JSON 或写入后的卷管理。</div>}
      </div>
    </div>
  );
}

function OutlineChapterSummary({ chapter, index }: { chapter: Record<string, unknown>; index: number }) {
  const craftBrief = asCraftBriefRecord(chapter.craftBrief);
  const characterExecution = asRecord(craftBrief.characterExecution) ?? {};
  const actionBeats = stringList(craftBrief.actionBeats);
  const clues = asArray(craftBrief.concreteClues)
    .map((item) => textValue(asRecord(item)?.name, ''))
    .filter(Boolean);
  const hasBrief = Object.keys(craftBrief).length > 0;
  const mainlineTask = textValue(craftBrief.mainlineTask, '');
  const dialogueSubtext = textValue(craftBrief.dialogueSubtext, '');
  const characterShift = textValue(craftBrief.characterShift, '');
  const storyUnit = asRecord(craftBrief.storyUnit);
  const storyUnitRange = asRecord(storyUnit?.chapterRange);
  const storyUnitRangeText = typeof storyUnitRange?.start === 'number' && typeof storyUnitRange?.end === 'number'
    ? `第${storyUnitRange.start}-${storyUnitRange.end}章`
    : '';
  return (
    <div className="space-y-1 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-dim)', background: hasBrief ? 'rgba(20,184,166,0.06)' : 'rgba(251,191,36,0.06)' }}>
      <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>
        <b style={{ color: 'var(--text-main)' }}>{numberValue(chapter.chapterNo, index + 1)}. {textValue(chapter.title, '未命名章节')}</b>
        {' '}— {textValue(chapter.objective ?? chapter.outline, '暂无目标')}
      </div>
      {hasBrief ? (
        <div className="space-y-1 text-[11px] leading-5" style={{ color: 'var(--text-muted)' }}>
          <div><b style={{ color: 'var(--agent-text-label)' }}>执行卡</b>：{textValue(craftBrief.visibleGoal ?? craftBrief.mainlineTask, '暂无可见目标')}</div>
          {mainlineTask && <div>主线任务：{mainlineTask}</div>}
          {textValue(craftBrief.coreConflict, '') && <div>冲突：{textValue(craftBrief.coreConflict)}</div>}
          {textValue(storyUnit?.title, '') && <div>单元故事：{[textValue(storyUnit?.title, ''), storyUnitRangeText, textValue(storyUnit?.chapterRole, '')].filter(Boolean).join(' · ')}</div>}
          {textValue(storyUnit?.unitPayoff, '') && <div>单元结局：{textValue(storyUnit?.unitPayoff)}</div>}
          {actionBeats.length > 0 && <div>行动链：{actionBeats.slice(0, 3).join(' → ')}</div>}
          <ChapterCharacterExecutionSummary characterExecution={characterExecution} />
          {clues.length > 0 && <div>线索：{clues.slice(0, 3).join('、')}</div>}
          {dialogueSubtext && <div>潜台词：{dialogueSubtext}</div>}
          {characterShift && <div>人物变化：{characterShift}</div>}
          {textValue(craftBrief.irreversibleConsequence, '') && <div>后果：{textValue(craftBrief.irreversibleConsequence)}</div>}
        </div>
      ) : (
        <div className="text-[11px]" style={{ color: '#fbbf24' }}>缺少章节执行卡，写入前建议补齐或人工复核。</div>
      )}
    </div>
  );
}

function ChapterCharacterExecutionSummary({ characterExecution }: { characterExecution: Record<string, unknown> }) {
  if (!Object.keys(characterExecution).length) return null;
  const pov = textValue(characterExecution.povCharacter, '');
  const cast = recordList(characterExecution.cast);
  const relationshipBeats = recordList(characterExecution.relationshipBeats);
  const minorCharacters = recordList(characterExecution.newMinorCharacters);
  return (
    <div className="space-y-1">
      {pov && <div>POV：{pov}</div>}
      {cast.length > 0 && <div>出场角色：{cast.slice(0, 4).map(formatCastMember).join('；')}</div>}
      {relationshipBeats.length > 0 && <div>关系变化：{relationshipBeats.slice(0, 3).map(formatRelationshipBeat).join('；')}</div>}
      {minorCharacters.length > 0 && <div>临时角色：{minorCharacters.slice(0, 3).map(formatMinorCharacter).join('；')}</div>}
    </div>
  );
}

function formatCastMember(member: Record<string, unknown>) {
  const name = textValue(member.characterName, '未命名角色');
  const source = characterSourceLabel(member.source);
  const goal = textValue(member.visibleGoal ?? member.functionInChapter, '暂无目标');
  return `${name}（${source}：${goal}）`;
}

function formatRelationshipBeat(beat: Record<string, unknown>) {
  const participants = stringList(beat.participants).join('/');
  const shift = textValue(beat.shift ?? beat.publicStateAfter ?? beat.trigger, '暂无变化');
  return `${participants || '未标注关系'}：${shift}`;
}

function formatMinorCharacter(minor: Record<string, unknown>) {
  const name = textValue(minor.nameOrLabel, '临时角色');
  const functionText = textValue(minor.narrativeFunction ?? minor.interactionScope, '临时功能');
  return `${name}（${functionText}）`;
}

function characterSourceLabel(value: unknown) {
  const source = textValue(value, 'unknown');
  if (source === 'existing') return '既有';
  if (source === 'volume_candidate') return '卷候选';
  if (source === 'minor_temporary') return '临时';
  return source;
}

function OutlineWriteNotice({ fallbackChapterCount, riskCount }: { fallbackChapterCount: number; riskCount: number }) {
  return (
    <div className="rounded-lg border px-3 py-2 text-xs leading-5" style={{ borderColor: fallbackChapterCount ? 'rgba(248,113,113,0.35)' : 'rgba(20,184,166,0.30)', background: fallbackChapterCount ? 'rgba(248,113,113,0.08)' : 'rgba(20,184,166,0.07)', color: 'var(--text-muted)' }}>
      审批写入会创建或更新 planned 章节的细纲与执行卡；已起草或非 planned 章节会跳过。{fallbackChapterCount ? ` 检测到 ${fallbackChapterCount} 章带有历史 fallback 或确定性骨架风险，当前写入链路应重新生成并通过校验。` : ''}{riskCount ? ` 当前有 ${riskCount} 条风险提示。` : ''}
    </div>
  );
}

function ChapterCraftBriefPreviewSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const candidates = asArray(data?.candidates);
  const risks = asArray(data?.risks).map((item) => textValue(item)).filter(Boolean);
  const assumptions = asArray(data?.assumptions).map((item) => textValue(item)).filter(Boolean);
  const writePlan = asRecord(data?.writePlan);
  const existingCount = candidates.filter((item) => asRecord(item)?.hasExistingCraftBrief === true).length;
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="目标章节" value={candidates.length} />
        <Metric label="已有执行卡" value={existingCount} tone={existingCount ? 'warn' : undefined} />
        <Metric label="写入目标" value={textValue(writePlan?.target, 'Chapter.craftBrief')} />
        <Metric label="风险" value={risks.length} tone={risks.length ? 'warn' : 'ok'} />
      </div>
      <ChapterCraftBriefNotice />
      <div className="space-y-2">
        {candidates.slice(0, 6).map((item, index) => (
          <ChapterCraftBriefCandidateSummary key={textValue(asRecord(item)?.candidateId, `candidate-${index}`)} candidate={asRecord(item) ?? {}} index={index} />
        ))}
        {!candidates.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无章节推进卡候选。</div>}
      </div>
      <ChapterCraftBriefMessageList title="风险" items={risks} tone="warn" />
      <ChapterCraftBriefMessageList title="假设" items={assumptions} />
    </div>
  );
}

function ChapterCraftBriefValidationSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const accepted = asArray(data?.accepted);
  const rejected = asArray(data?.rejected);
  const warnings = asArray(data?.warnings).map((item) => textValue(item)).filter(Boolean);
  const writePreview = asRecord(data?.writePreview);
  const writeChapters = asArray(writePreview?.chapters);
  const skipCount = writeChapters.filter((item) => asRecord(item)?.action === 'skip_by_default').length;
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="状态" value={data?.valid === true ? '可写入' : '需复核'} tone={data?.valid === true ? 'ok' : 'danger'} />
        <Metric label="通过" value={accepted.length} tone="ok" />
        <Metric label="拒绝" value={rejected.length} tone={rejected.length ? 'danger' : 'ok'} />
        <Metric label="默认跳过" value={skipCount} tone={skipCount ? 'warn' : 'ok'} />
      </div>
      <div className="space-y-2">
        {writeChapters.slice(0, 8).map((item, index) => {
          const chapter = asRecord(item);
          const action = textValue(chapter?.action, 'unknown');
          const proposed = asRecord(chapter?.proposedFields);
          const color = action === 'skip_by_default' ? '#fbbf24' : 'var(--text-muted)';
          return (
            <div key={textValue(chapter?.candidateId, `write-${index}`)} className="space-y-1 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-dim)', background: 'rgba(15,23,42,0.18)' }}>
              <div className="text-xs leading-5" style={{ color }}>
                <b style={{ color: 'var(--text-main)' }}>第 {numberValue(chapter?.chapterNo, index + 1)} 章：{textValue(chapter?.title, '未命名章节')}</b> · {textValue(chapter?.status, 'unknown')} · {action}
                {chapter?.reason ? ` · ${textValue(chapter.reason)}` : ''}
              </div>
              <ChapterCraftBriefFields craftBrief={asCraftBriefRecord(proposed?.craftBrief)} />
            </div>
          );
        })}
        {!writeChapters.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无写入预览明细。</div>}
      </div>
      <ChapterCraftBriefRejectedList items={rejected} />
      <ChapterCraftBriefMessageList title="警告" items={warnings} tone="warn" />
    </div>
  );
}

function ChapterCraftBriefPersistSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const updated = asArray(data?.updatedChapters);
  const skipped = asArray(data?.skippedChapters);
  const audit = asArray(data?.perChapterAudit);
  const approval = asRecord(data?.approval);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="已更新" value={numberValue(data?.updatedCount, updated.length)} tone="ok" />
        <Metric label="已跳过" value={numberValue(data?.skippedCount, skipped.length)} tone={skipped.length ? 'warn' : 'ok'} />
        <Metric label="审批" value={approval?.approved === true ? '已审批' : '未审批'} tone={approval?.approved === true ? 'ok' : 'danger'} />
        <Metric label="允许已起草" value={approval?.allowDrafted === true ? '是' : '否'} tone={approval?.allowDrafted === true ? 'warn' : 'ok'} />
      </div>
      {textValue(data?.approvalMessage, '') && <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{textValue(data?.approvalMessage)}</div>}
      <div className="space-y-1">
        {updated.slice(0, 6).map((item, index) => {
          const chapter = asRecord(item);
          return <div key={textValue(chapter?.id, `updated-${index}`)} className="text-xs leading-5" style={{ color: '#86efac' }}>已更新：第 {numberValue(chapter?.chapterNo, index + 1)} 章 · {textValue(chapter?.title, '未命名章节')} · {textValue(chapter?.status, 'planned')}</div>;
        })}
        {skipped.slice(0, 6).map((item, index) => {
          const chapter = asRecord(item);
          return <div key={textValue(chapter?.candidateId, `skipped-${index}`)} className="text-xs leading-5" style={{ color: '#fbbf24' }}>已跳过：第 {numberValue(chapter?.chapterNo, index + 1)} 章 · {textValue(chapter?.title, '未命名章节')} · {textValue(chapter?.status, 'unknown')} · {textValue(chapter?.reason, '状态不允许默认写入')}</div>;
        })}
      </div>
      <div className="space-y-1" style={{ borderTop: '1px solid var(--border-dim)', paddingTop: '0.75rem' }}>
        {audit.slice(0, 10).map((item, index) => {
          const row = asRecord(item);
          const action = textValue(row?.action, 'unknown');
          const color = action === 'updated' ? '#86efac' : action === 'skipped_status' ? '#fbbf24' : 'var(--text-muted)';
          return <div key={textValue(row?.candidateId, `audit-${index}`)} className="text-xs leading-5" style={{ color }}>第 {numberValue(row?.chapterNo, index + 1)} 章 · {textValue(row?.title, '未命名章节')} · {action} · {textValue(row?.reason, '暂无说明')}</div>;
        })}
        {!audit.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无章节级写入审计。</div>}
      </div>
    </div>
  );
}

function ChapterCraftBriefCandidateSummary({ candidate, index }: { candidate: Record<string, unknown>; index: number }) {
  const proposed = asRecord(candidate.proposedFields);
  const craftBrief = asCraftBriefRecord(proposed?.craftBrief);
  const risks = asArray(candidate.risks).map((item) => textValue(item)).filter(Boolean);
  const objective = textValue(proposed?.objective, '');
  const conflict = textValue(proposed?.conflict, '');
  const outline = textValue(proposed?.outline, '');
  return (
    <div className="space-y-2 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-dim)', background: 'rgba(20,184,166,0.06)' }}>
      <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>
        <b style={{ color: 'var(--text-main)' }}>第 {numberValue(candidate.chapterNo, index + 1)} 章：{textValue(candidate.title, '未命名章节')}</b>
        {' '}· {textValue(candidate.status, 'unknown')}{candidate.hasExistingCraftBrief === true ? ' · 已有执行卡' : ''}
      </div>
      {(objective || conflict || outline) && (
        <div className="space-y-1 text-[11px] leading-5" style={{ color: 'var(--text-muted)' }}>
          {objective && <div>目标：{objective}</div>}
          {conflict && <div>冲突：{conflict}</div>}
          {outline && <div>细纲：{outline}</div>}
        </div>
      )}
      <ChapterCraftBriefFields craftBrief={craftBrief} />
      <ChapterCraftBriefMessageList title="风险" items={risks} tone="warn" />
    </div>
  );
}

function ChapterCraftBriefFields({ craftBrief }: { craftBrief: Record<string, unknown> }) {
  if (!Object.keys(craftBrief).length) return <div className="text-[11px]" style={{ color: '#fbbf24' }}>缺少 Chapter.craftBrief 字段。</div>;
  const characterExecution = asRecord(craftBrief.characterExecution) ?? {};
  const actionBeats = stringList(craftBrief.actionBeats);
  const subplotTasks = stringList(craftBrief.subplotTasks);
  const progressTypes = stringList(craftBrief.progressTypes);
  const storyUnit = asRecord(craftBrief.storyUnit);
  const storyUnitRange = asRecord(storyUnit?.chapterRange);
  const storyUnitRangeText = typeof storyUnitRange?.start === 'number' && typeof storyUnitRange?.end === 'number'
    ? `第${storyUnitRange.start}-${storyUnitRange.end}章`
    : '';
  const storyUnitFunctions = stringList(storyUnit?.serviceFunctions);
  const clues = asArray(craftBrief.concreteClues)
    .map((item) => {
      const clue = asRecord(item);
      const name = textValue(clue?.name, '');
      if (!name) return '';
      const details = [textValue(clue?.sensoryDetail, ''), textValue(clue?.laterUse, '')].filter(Boolean);
      return details.length ? `${name}（${details.join(' / ')}）` : name;
    })
    .filter(Boolean);
  return (
    <div className="space-y-1 text-[11px] leading-5" style={{ color: 'var(--text-muted)' }}>
      {textValue(craftBrief.visibleGoal, '') && <div><b style={{ color: 'var(--agent-text-label)' }}>可见目标</b>：{textValue(craftBrief.visibleGoal)}</div>}
      {textValue(craftBrief.coreConflict, '') && <div>核心冲突：{textValue(craftBrief.coreConflict)}</div>}
      {textValue(craftBrief.mainlineTask, '') && <div>主线任务：{textValue(craftBrief.mainlineTask)}</div>}
      {subplotTasks.length > 0 && <div>支线推进：{subplotTasks.slice(0, 3).join('；')}</div>}
      {textValue(storyUnit?.title, '') && <div>单元故事：{[textValue(storyUnit?.title, ''), storyUnitRangeText, textValue(storyUnit?.chapterRole, '')].filter(Boolean).join(' · ')}</div>}
      {textValue(storyUnit?.localGoal, '') && <div>单元目标：{textValue(storyUnit?.localGoal)}</div>}
      {storyUnitFunctions.length > 0 && <div>单元功能：{storyUnitFunctions.slice(0, 4).join(' / ')}</div>}
      {textValue(storyUnit?.unitPayoff, '') && <div>单元结局：{textValue(storyUnit?.unitPayoff)}</div>}
      {actionBeats.length > 0 && <div>行动链：{actionBeats.slice(0, 5).join(' -> ')}</div>}
      <ChapterCharacterExecutionSummary characterExecution={characterExecution} />
      {clues.length > 0 && <div>具体线索：{clues.slice(0, 4).join('；')}</div>}
      {textValue(craftBrief.dialogueSubtext, '') && <div>潜台词：{textValue(craftBrief.dialogueSubtext)}</div>}
      {textValue(craftBrief.characterShift, '') && <div>人物变化：{textValue(craftBrief.characterShift)}</div>}
      {textValue(craftBrief.irreversibleConsequence, '') && <div>不可逆后果：{textValue(craftBrief.irreversibleConsequence)}</div>}
      {textValue(craftBrief.hiddenEmotion, '') && <div>隐藏情绪：{textValue(craftBrief.hiddenEmotion)}</div>}
      {progressTypes.length > 0 && <div>推进类型：{progressTypes.slice(0, 4).join(' / ')}</div>}
    </div>
  );
}

function ChapterCraftBriefRejectedList({ items }: { items: unknown[] }) {
  if (!items.length) return null;
  return (
    <div className="space-y-1">
      {items.slice(0, 6).map((item, index) => {
        const row = asRecord(item);
        const reasons = asArray(row?.reasons).map((reason) => textValue(reason)).filter(Boolean);
        return <div key={textValue(row?.candidateId, `rejected-${index}`)} className="text-xs leading-5" style={{ color: '#fb7185' }}>拒绝：第 {numberValue(row?.chapterNo, index + 1)} 章 · {textValue(row?.title, '未命名章节')} · {reasons.join('；') || '未给出原因'}</div>;
      })}
    </div>
  );
}

function ChapterCraftBriefMessageList({ title, items, tone = 'muted' }: { title: string; items: string[]; tone?: 'muted' | 'warn' }) {
  if (!items.length) return null;
  const color = tone === 'warn' ? '#fbbf24' : 'var(--text-muted)';
  return (
    <div className="space-y-1">
      {items.slice(0, 5).map((item, index) => (
        <div key={`${title}-${index}`} className="text-xs leading-5" style={{ color }}>{title}：{item}</div>
      ))}
    </div>
  );
}

function ChapterCraftBriefNotice() {
  return (
    <div className="rounded-lg border px-3 py-2 text-xs leading-5" style={{ borderColor: 'rgba(20,184,166,0.30)', background: 'rgba(20,184,166,0.07)', color: 'var(--text-muted)' }}>
      这是章级推进卡预览，只写入 <code>Chapter.craftBrief</code> 和可选规划字段；已起草或非 planned 章节默认会跳过，不会改正文。
    </div>
  );
}

function fallbackChapterCountFromRisks(risks: string[], totalChapterCount: number) {
  const fallbackRisks = risks.filter((risk) => /fallback|LLM_TIMEOUT|LLM_PROVIDER_FALLBACK|确定性章节骨架/i.test(risk));
  if (!fallbackRisks.length) return 0;
  const chapterNos = new Set<number>();
  for (const risk of fallbackRisks) {
    const rangeMatches = risk.matchAll(/第\s*(\d+)\s*-\s*(\d+)\s*章/g);
    for (const match of rangeMatches) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      for (let chapterNo = Math.max(1, start); chapterNo <= Math.min(totalChapterCount, end); chapterNo += 1) {
        chapterNos.add(chapterNo);
      }
    }
  }
  return chapterNos.size || totalChapterCount;
}

function hasCraftBrief(value: unknown) {
  return Object.keys(asCraftBriefRecord(value)).length > 0;
}

function asCraftBriefRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function recordList(value: unknown): Array<Record<string, unknown>> {
  return asArray(value).map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => Boolean(item));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : [];
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function volumeCharacterCandidateCount(volumes: Array<Record<string, unknown>>) {
  return volumes.reduce((sum, volume) => {
    const narrativePlan = asRecord(volume.narrativePlan);
    const characterPlan = asRecord(narrativePlan?.characterPlan);
    return sum + asArray(characterPlan?.newCharacterCandidates).length;
  }, 0);
}

function chapterCharacterExecution(chapter: Record<string, unknown>) {
  return asRecord(asCraftBriefRecord(chapter.craftBrief).characterExecution) ?? {};
}

function hasChapterCharacterExecution(chapter: Record<string, unknown>) {
  return Object.keys(chapterCharacterExecution(chapter)).length > 0;
}

function chapterTemporaryCharacterCount(chapter: Record<string, unknown>) {
  return asArray(chapterCharacterExecution(chapter).newMinorCharacters).length;
}

function outlineCharacterRiskCount(stats: Record<string, unknown> | undefined, risks: string[]) {
  const characterRiskCount = optionalNumber(stats?.characterRiskCount);
  const unknownReferenceCount = optionalNumber(stats?.unknownCharacterReferenceCount);
  if (characterRiskCount !== undefined || unknownReferenceCount !== undefined) {
    return Math.max(characterRiskCount ?? 0, unknownReferenceCount ?? 0);
  }
  return risks.filter((risk) => /character|角色|pov|cast|minor_temporary|volume_candidate|characterExecution|unknown|未知|未进入|未出现在|未被|候选/i.test(risk)).length;
}

function GuidedStepPreviewSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const structuredData = asRecord(data?.structuredData ?? content) ?? {};
  const stepKey = textValue(data?.stepKey, '');
  const stepInfo = GUIDED_STEPS.find((step) => step.key === stepKey);
  const warnings = asArray(data?.warnings).map((item) => textValue(item)).filter(Boolean);
  const summary = textValue(data?.summary, '');
  const fieldLabels: Record<string, string> = {
    genre: '类型',
    theme: '主题',
    tone: '基调',
    logline: '一句话概述',
    synopsis: '故事简介',
    pov: '视角',
    tense: '时态',
    proseStyle: '文风',
    pacing: '节奏',
    outline: '故事总纲',
  };
  const primitiveEntries = Object.entries(structuredData)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    .slice(0, 8);
  const collectionEntries = Object.entries(structuredData)
    .filter(([, value]) => Array.isArray(value) || (value && typeof value === 'object'))
    .slice(0, 4);

  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="步骤" value={stepInfo?.label ?? (stepKey || '创作引导')} />
        <Metric label="字段数" value={Object.keys(structuredData).length} />
        <Metric label="警告" value={warnings.length} tone={warnings.length ? 'warn' : 'ok'} />
      </div>
      {summary && <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{summary}</div>}
      <div className="grid gap-2 md:grid-cols-2">
        {primitiveEntries.map(([key, value]) => (
          <div key={key} className="rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-dim)', background: 'rgba(15,23,42,0.18)' }}>
            <div className="text-[11px] font-semibold" style={{ color: 'var(--agent-text-label)' }}>{fieldLabels[key] ?? key}</div>
            <div className="mt-1 text-xs leading-5" style={{ color: 'var(--text-main)' }}>{String(value) || '未填写'}</div>
          </div>
        ))}
      </div>
      {collectionEntries.length > 0 && (
        <div className="space-y-1">
          {collectionEntries.map(([key, value]) => (
            <div key={key} className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>
              <b style={{ color: 'var(--text-main)' }}>{fieldLabels[key] ?? key}</b>：{Array.isArray(value) ? `${value.length} 项` : `${Object.keys(asRecord(value) ?? {}).length} 个字段`}
            </div>
          ))}
        </div>
      )}
      <div className="space-y-1">
        {warnings.slice(0, 5).map((warning, index) => (
          <div key={index} className="text-xs leading-5" style={{ color: '#fbbf24' }}>⚠ {warning}</div>
        ))}
        {!primitiveEntries.length && !collectionEntries.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>预览暂无结构化字段。</div>}
      </div>
    </div>
  );
}

function ValidationSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const issues = asArray(data?.issues);
  const hasError = issues.some((item) => asRecord(item)?.severity === 'error');
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="状态" value={data?.valid === false ? '需复核' : '可继续'} tone={hasError ? 'danger' : issues.length ? 'warn' : 'ok'} />
        <Metric label="问题数" value={numberValue(data?.issueCount, issues.length)} />
        <Metric label="来源风险" value={asArray(data?.sourceRisks).length} />
      </div>
      <WritePreviewSummary content={data?.writePreview} />
      <WorldbuildingValidationComparison content={data} />
      <div className="space-y-2">
        {issues.slice(0, 5).map((item, index) => {
          const issue = asRecord(item);
          return <div key={index} className="text-xs leading-5" style={{ color: issue?.severity === 'error' ? '#fb7185' : '#fbbf24' }}>[{textValue(issue?.severity)}] {textValue(issue?.message)}</div>;
        })}
        {!issues.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>未发现阻断性问题。</div>}
      </div>
    </div>
  );
}

/** 世界观校验视图补充条目级对比和 locked facts 说明，避免用户只看到 create/skip 的技术状态。 */
function WorldbuildingValidationComparison({ content }: { content: unknown }) {
  const data = asRecord(content);
  const writePreview = asRecord(data?.writePreview);
  const entries = asArray(writePreview?.entries);
  const relatedLockedFacts = asArray(data?.relatedLockedFacts);
  if (!entries.length && !relatedLockedFacts.length) return null;

  return (
    <div className="space-y-2" style={{ borderTop: '1px solid var(--border-dim)', paddingTop: '0.75rem' }}>
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="将新增" value={entries.filter((item) => asRecord(item)?.action === 'create').length} tone="ok" />
        <Metric label="将跳过" value={entries.filter((item) => asRecord(item)?.action === 'skip_duplicate').length} tone={entries.some((item) => asRecord(item)?.action === 'skip_duplicate') ? 'warn' : undefined} />
        <Metric label="相关 locked facts" value={relatedLockedFacts.length} tone={relatedLockedFacts.length ? 'warn' : 'ok'} />
      </div>
      <div className="space-y-1">
        {entries.slice(0, 8).map((item, index) => {
          const entry = asRecord(item);
          const action = textValue(entry?.action, 'unknown');
          const isSkip = action === 'skip_duplicate';
          return <div key={index} className="text-xs leading-5" style={{ color: isSkip ? '#fbbf24' : '#86efac' }}>{isSkip ? '跳过' : '新增'}：{textValue(entry?.title, '未命名设定')} · {textValue(entry?.entryType, 'setting')}{isSkip ? ` · 原状态 ${textValue(entry?.existingStatus, 'existing')}` : ''}</div>;
        })}
        {relatedLockedFacts.slice(0, 4).map((item, index) => {
          const fact = asRecord(item);
          return <div key={`locked-${index}`} className="text-xs leading-5" style={{ color: '#fbbf24' }}>locked fact：{textValue(fact?.title, '未命名')} — {textValue(fact?.excerpt, '暂无摘要')}</div>;
        })}
      </div>
    </div>
  );
}

/** 展示写入前 diff 摘要，帮助用户在审批前理解会新增、更新或跳过哪些资产 */
function WritePreviewSummary({ content }: { content: unknown }) {
  const preview = asRecord(content);
  const summary = asRecord(preview?.summary);
  if (!preview || !summary) return null;
  const chapterCreate = numberValue(summary.chapterCreateCount, numberValue(summary.createCount));
  const chapterUpdate = numberValue(summary.chapterUpdateCount, numberValue(summary.updateCount));
  const chapterSkip = numberValue(summary.chapterSkipCount, numberValue(summary.skipCount, numberValue(summary.skipDuplicateCount)));
  const chapters = asArray(preview.chapters);
  const entries = asArray(preview.entries);
  const volume = asRecord(preview.volume);
  return (
    <div className="space-y-2" style={{ borderTop: '1px solid var(--border-dim)', paddingTop: '0.75rem' }}>
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="将创建" value={chapterCreate + numberValue(summary.characterCreateCount) + numberValue(summary.lorebookCreateCount) + numberValue(summary.volumeCreateCount)} tone="ok" />
        <Metric label="将更新" value={chapterUpdate + numberValue(summary.volumeUpdateCount) + (volume?.action === 'update' ? 1 : 0)} tone={chapterUpdate ? 'warn' : undefined} />
        <Metric label="将跳过" value={chapterSkip + numberValue(summary.characterSkipCount) + numberValue(summary.lorebookSkipCount)} tone={chapterSkip ? 'warn' : undefined} />
      </div>
      <div className="space-y-1">
        {chapters.slice(0, 4).map((item, index) => {
          const chapter = asRecord(item);
          return <div key={index} className="text-xs leading-5" style={{ color: chapter?.action === 'skip_existing_content' ? '#fbbf24' : 'var(--text-muted)' }}>第 {numberValue(chapter?.chapterNo, index + 1)} 章：{textValue(chapter?.title, '未命名')} · {textValue(chapter?.action, 'unknown')}</div>;
        })}
        {entries.slice(0, 6).map((item, index) => {
          const entry = asRecord(item);
          return <div key={`entry-${index}`} className="text-xs leading-5" style={{ color: entry?.action === 'skip_duplicate' ? '#fbbf24' : 'var(--text-muted)' }}>设定：{textValue(entry?.title, '未命名')} · {textValue(entry?.action, 'unknown')}</div>;
        })}
      </div>
    </div>
  );
}

function WorldbuildingPreviewSummary({
  content,
  onRequestPersistSelection,
  actionDisabled,
}: {
  content: unknown;
  onRequestPersistSelection?: (titles: string[]) => void | Promise<void>;
  actionDisabled?: boolean;
}) {
  const data = asRecord(content);
  const entries = asArray(data?.entries);
  const risks = asArray(data?.risks);
  const writePlan = asRecord(data?.writePlan);
  const selectableEntries = useMemo(() => entries.map((item, index) => {
    const entry = asRecord(item);
    return {
      key: `${textValue(entry?.title, `设定${index + 1}`)}:${index}`,
      title: textValue(entry?.title, `设定${index + 1}`).trim(),
      entryType: textValue(entry?.entryType, 'setting'),
      summary: textValue(entry?.summary ?? entry?.impactAnalysis, '暂无摘要'),
    };
  }).filter((entry) => entry.title.length > 0), [entries]);
  const [selectedTitles, setSelectedTitles] = useState<string[]>(() => selectableEntries.map((entry) => entry.title));
  const [submitting, setSubmitting] = useState(false);
  const selectedTitleSet = new Set(selectedTitles);
  const allSelected = selectableEntries.length > 0 && selectableEntries.every((entry) => selectedTitleSet.has(entry.title));

  /** 勾选状态只传标题，不暴露内部 ID；后端 persist_worldbuilding 会再次校验标题必须来自预览。 */
  const toggleTitle = (title: string) => {
    setSelectedTitles((current) => (current.includes(title) ? current.filter((item) => item !== title) : [...current, title]));
  };

  const handleSubmitSelection = async () => {
    if (!onRequestPersistSelection || !selectedTitles.length) return;
    setSubmitting(true);
    try {
      await onRequestPersistSelection(selectedTitles);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="候选设定" value={entries.length} />
        <Metric label="写入模式" value={textValue(writePlan?.mode, 'preview_only')} />
        <Metric label="写入前审批" value={writePlan?.requiresApprovalBeforePersist === false ? '否' : '是'} tone={writePlan?.requiresApprovalBeforePersist === false ? 'danger' : 'warn'} />
      </div>
      <div className="space-y-2">
        {selectableEntries.slice(0, 8).map((entry) => (
          <label key={entry.key} className="flex cursor-pointer items-start gap-2 rounded-lg border px-2 py-2 text-xs leading-5" style={{ borderColor: 'var(--border-dim)', color: 'var(--text-muted)', background: selectedTitleSet.has(entry.title) ? 'rgba(20,184,166,0.10)' : 'rgba(15,23,42,0.24)' }}>
            <input
              type="checkbox"
              checked={selectedTitleSet.has(entry.title)}
              onChange={() => toggleTitle(entry.title)}
              className="mt-1"
              aria-label={`选择写入 ${entry.title}`}
            />
            <span>
              <b style={{ color: 'var(--text-main)' }}>{entry.title}</b> · {entry.entryType} — {entry.summary}
            </span>
          </label>
        ))}
        {!entries.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无世界观候选条目。</div>}
      </div>
      {selectableEntries.length > 0 && (
        <div className="space-y-2 rounded-xl border p-3" style={{ borderColor: 'rgba(20,184,166,0.28)', background: 'rgba(20,184,166,0.08)' }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>
              已选择 {selectedTitles.length}/{selectableEntries.length} 个条目。点击按钮会把标题作为 <code>selectedTitles</code> 写回重新规划，仍需再次审批后才会持久化。
            </div>
            <div className="flex gap-2">
              <button type="button" className="agent-new-session-btn" onClick={() => setSelectedTitles(allSelected ? [] : selectableEntries.map((entry) => entry.title))} disabled={actionDisabled || submitting}>
                {allSelected ? '清空选择' : '全选'}
              </button>
              <button type="button" className="agent-new-session-btn" onClick={handleSubmitSelection} disabled={!onRequestPersistSelection || actionDisabled || submitting || selectedTitles.length === 0} title={onRequestPersistSelection ? '基于当前选择重新规划写入步骤' : '当前入口尚未接入选择写入'}>
                {submitting ? '提交中…' : '按选择写入'}
              </button>
            </div>
          </div>
          {!selectedTitles.length && <div className="text-xs" style={{ color: '#fbbf24' }}>请至少选择 1 个条目；如果本次不写入，请不要执行持久化步骤。</div>}
        </div>
      )}
      <div className="space-y-1">{risks.slice(0, 4).map((item, index) => <div key={index} className="text-xs leading-5" style={{ color: '#fbbf24' }}>⚠ {textValue(item)}</div>)}</div>
    </div>
  );
}

function WorldbuildingPersistSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const createdEntries = asArray(data?.createdEntries);
  const skippedTitles = asArray(data?.skippedTitles);
  const skippedUnselectedTitles = asArray(data?.skippedUnselectedTitles);
  const perEntryAudit = asArray(data?.perEntryAudit);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="新增设定" value={numberValue(data?.createdCount, createdEntries.length)} tone="ok" />
        <Metric label="跳过同名" value={numberValue(data?.skippedDuplicateCount, skippedTitles.length)} tone={skippedTitles.length ? 'warn' : undefined} />
        <Metric label="未选择跳过" value={numberValue(data?.skippedUnselectedCount, skippedUnselectedTitles.length)} tone={skippedUnselectedTitles.length ? 'warn' : undefined} />
        <Metric label="写入策略" value="只新增不覆盖" tone="ok" />
      </div>
      <div className="space-y-1">
        {createdEntries.slice(0, 5).map((item, index) => {
          const entry = asRecord(item);
          return <div key={index} className="text-xs leading-5" style={{ color: '#86efac' }}>＋ {textValue(entry?.title, '未命名设定')} · {textValue(entry?.entryType, 'setting')}</div>;
        })}
        {skippedTitles.slice(0, 5).map((item, index) => <div key={`skip-${index}`} className="text-xs leading-5" style={{ color: '#fbbf24' }}>跳过同名：{textValue(item)}</div>)}
        {skippedUnselectedTitles.slice(0, 5).map((item, index) => <div key={`skip-unselected-${index}`} className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>未选择跳过：{textValue(item)}</div>)}
      </div>
      <div className="space-y-1" style={{ borderTop: '1px solid var(--border-dim)', paddingTop: '0.75rem' }}>
        {perEntryAudit.slice(0, 8).map((item, index) => {
          const audit = asRecord(item);
          const action = textValue(audit?.action, 'unknown');
          const color = action === 'created' ? '#86efac' : action === 'skipped_duplicate' ? '#fbbf24' : 'var(--text-muted)';
          return <div key={index} className="text-xs leading-5" style={{ color }}>{textValue(audit?.title, '未命名设定')} · {action} · {textValue(audit?.reason, '暂无原因')}</div>;
        })}
        {!perEntryAudit.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无条目级审计明细。</div>}
      </div>
    </div>
  );
}

function StoryBiblePreviewSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const candidates = asArray(data?.candidates);
  const risks = asArray(data?.risks);
  const writePlan = asRecord(data?.writePlan);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="候选设定" value={candidates.length} />
        <Metric label="写入目标" value={textValue(writePlan?.target, 'LorebookEntry')} />
        <Metric label="审批前置" value={writePlan?.requiresApprovalBeforePersist === false ? '否' : '是'} tone={writePlan?.requiresApprovalBeforePersist === false ? 'danger' : 'warn'} />
      </div>
      <div className="space-y-1">
        {candidates.slice(0, 8).map((item, index) => {
          const candidate = asRecord(item);
          return <div key={index} className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}><b style={{ color: 'var(--text-main)' }}>{textValue(candidate?.title, `设定${index + 1}`)}</b> · {textValue(candidate?.entryType, 'setting')} · {textValue(candidate?.summary ?? candidate?.impactAnalysis, '暂无摘要')}</div>;
        })}
        {!candidates.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无 Story Bible 候选。</div>}
      </div>
      <div className="space-y-1">{risks.slice(0, 4).map((item, index) => <div key={index} className="text-xs leading-5" style={{ color: '#fbbf24' }}>风险：{textValue(item)}</div>)}</div>
    </div>
  );
}

function StoryBibleValidationSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const accepted = asArray(data?.accepted);
  const rejected = asArray(data?.rejected);
  const issues = asArray(data?.issues);
  const writePreview = asRecord(data?.writePreview);
  const summary = asRecord(writePreview?.summary);
  const hasError = issues.some((item) => asRecord(item)?.severity === 'error');
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="状态" value={data?.valid === true ? '可写入' : '需复核'} tone={data?.valid === true ? 'ok' : 'danger'} />
        <Metric label="已接受" value={accepted.length} tone="ok" />
        <Metric label="已拒绝" value={rejected.length} tone={rejected.length ? 'danger' : 'ok'} />
        <Metric label="问题" value={numberValue(data?.issueCount, issues.length)} tone={hasError ? 'danger' : issues.length ? 'warn' : 'ok'} />
      </div>
      {summary && (
        <div className="grid gap-2 md:grid-cols-3">
          <Metric label="将创建" value={numberValue(summary.createCount)} tone={numberValue(summary.createCount) ? 'ok' : undefined} />
          <Metric label="将更新" value={numberValue(summary.updateCount)} tone={numberValue(summary.updateCount) ? 'warn' : undefined} />
          <Metric label="将拒绝" value={numberValue(summary.rejectCount)} tone={numberValue(summary.rejectCount) ? 'danger' : undefined} />
        </div>
      )}
      <div className="space-y-1">
        {issues.slice(0, 6).map((item, index) => {
          const issue = asRecord(item);
          return <div key={index} className="text-xs leading-5" style={{ color: issue?.severity === 'error' ? '#fb7185' : '#fbbf24' }}>[{textValue(issue?.severity)}] {textValue(issue?.message)}</div>;
        })}
        {!issues.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无阻断问题。</div>}
      </div>
    </div>
  );
}

function StoryBiblePersistSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const created = asArray(data?.createdEntries);
  const updated = asArray(data?.updatedEntries);
  const skipped = asArray(data?.skippedUnselectedCandidates);
  const audit = asArray(data?.perEntryAudit);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="新增" value={numberValue(data?.createdCount, created.length)} tone="ok" />
        <Metric label="更新" value={numberValue(data?.updatedCount, updated.length)} tone={updated.length ? 'warn' : undefined} />
        <Metric label="未选跳过" value={numberValue(data?.skippedUnselectedCount, skipped.length)} tone={skipped.length ? 'warn' : undefined} />
        <Metric label="审批" value={asRecord(data?.approval)?.approved === true ? '已审批' : '未审批'} tone={asRecord(data?.approval)?.approved === true ? 'ok' : 'danger'} />
      </div>
      <div className="space-y-1">
        {audit.slice(0, 8).map((item, index) => {
          const row = asRecord(item);
          const action = textValue(row?.action, 'unknown');
          const color = action === 'created' ? '#86efac' : action === 'updated' ? '#fbbf24' : 'var(--text-muted)';
          return <div key={index} className="text-xs leading-5" style={{ color }}><b style={{ color: 'var(--text-main)' }}>{textValue(row?.title, '未命名设定')}</b> · {action} · {textValue(row?.reason, '暂无说明')}</div>;
        })}
        {!audit.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无写入审计明细。</div>}
      </div>
    </div>
  );
}

function TimelinePreviewSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const candidates = asArray(data?.candidates);
  const risks = asArray(data?.risks).map((item) => textValue(item)).filter(Boolean);
  const assumptions = asArray(data?.assumptions).map((item) => textValue(item)).filter(Boolean);
  const writePlan = asRecord(data?.writePlan);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="计划候选" value={candidates.length} tone={candidates.length ? 'ok' : 'warn'} />
        <Metric label="写入目标" value={textValue(writePlan?.target, 'TimelineEvent')} />
        <Metric label="来源类型" value={textValue(writePlan?.sourceKind, 'planned_timeline_event')} />
        <Metric label="审批前置" value={writePlan?.requiresApprovalBeforePersist === false ? '否' : '是'} tone={writePlan?.requiresApprovalBeforePersist === false ? 'danger' : 'warn'} />
      </div>
      <TimelineCandidateList items={candidates} />
      {assumptions.length > 0 && (
        <div className="space-y-1">
          {assumptions.slice(0, 3).map((item, index) => <div key={index} className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>假设：{item}</div>)}
        </div>
      )}
      <div className="space-y-1">{risks.slice(0, 4).map((item, index) => <div key={index} className="text-xs leading-5" style={{ color: '#fbbf24' }}>风险：{item}</div>)}</div>
    </div>
  );
}

function TimelineCandidateList({ items }: { items: unknown[] }) {
  if (!items.length) return <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无计划时间线候选。</div>;
  return (
    <div className="space-y-2">
      {items.slice(0, 8).map((item, index) => {
        const candidate = asRecord(item);
        return (
          <div key={textValue(candidate?.candidateId, `timeline-${index}`)} className="rounded-lg border p-3" style={{ borderColor: 'var(--border-dim)', background: 'rgba(15,23,42,0.18)' }}>
            <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>
              <b style={{ color: 'var(--text-main)' }}>{candidate?.chapterNo ? `第${numberValue(candidate.chapterNo)}章 · ` : ''}{textValue(candidate?.title, '未命名事件')}</b>
              {' '}· {textValue(candidate?.action, 'create_planned')} · {textValue(candidate?.eventTime, '未标注时间')}
            </div>
            <div className="mt-1 text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{textValue(candidate?.impactAnalysis ?? candidate?.result, '暂无影响说明')}</div>
            <TimelineSourceTrace trace={asRecord(candidate?.sourceTrace)} />
          </div>
        );
      })}
      {items.length > 8 && <div className="text-xs" style={{ color: 'var(--text-dim)' }}>还有 {items.length - 8} 条候选，完整内容见原始 JSON。</div>}
    </div>
  );
}

function TimelineSourceTrace({ trace }: { trace: Record<string, unknown> | undefined }) {
  const sources = asArray(trace?.contextSources).map((item) => asRecord(item)).filter(Boolean);
  if (!trace && !sources.length) return null;
  const evidence = textValue(trace?.evidence, '');
  return (
    <div className="mt-2 space-y-1">
      <div className="flex flex-wrap gap-2">
        <span className="px-2 py-1 text-[11px]" style={{ borderRadius: 999, border: '1px solid rgba(20,184,166,0.28)', color: '#5eead4', background: 'rgba(20,184,166,0.08)' }}>
          {textValue(trace?.sourceKind, 'planned_timeline_event')} · {textValue(trace?.toolName ?? trace?.originTool, 'generate_timeline_preview')}
        </span>
        {sources.slice(0, 3).map((source, index) => (
          <span key={index} className="px-2 py-1 text-[11px]" style={{ borderRadius: 999, border: '1px solid var(--border-dim)', color: 'var(--text-muted)' }}>
            {textValue(source?.sourceType, 'source')}{source?.chapterNo ? `@第${numberValue(source.chapterNo)}章` : ''}{source?.title ? ` · ${textValue(source.title)}` : source?.sourceId ? ` · ${textValue(source.sourceId)}` : ''}
          </span>
        ))}
      </div>
      {evidence && <div className="text-xs leading-5" style={{ color: 'var(--text-dim)' }}>来源证据：{evidence}</div>}
    </div>
  );
}

function TimelineValidationSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const accepted = asArray(data?.accepted);
  const rejected = asArray(data?.rejected);
  const issues = asArray(data?.issues);
  const writePreview = asRecord(data?.writePreview);
  const summary = asRecord(writePreview?.summary);
  const hasError = issues.some((item) => asRecord(item)?.severity === 'error');
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="状态" value={data?.valid === true ? '可写入' : '需复核'} tone={data?.valid === true ? 'ok' : 'danger'} />
        <Metric label="通过" value={accepted.length} tone="ok" />
        <Metric label="拒绝" value={rejected.length} tone={rejected.length ? 'danger' : 'ok'} />
        <Metric label="问题" value={numberValue(data?.issueCount, issues.length)} tone={hasError ? 'danger' : issues.length ? 'warn' : 'ok'} />
      </div>
      {summary && (
        <div className="grid gap-2 md:grid-cols-5">
          <Metric label="计划新增" value={numberValue(summary.createPlannedCount)} tone={numberValue(summary.createPlannedCount) ? 'ok' : undefined} />
          <Metric label="确认计划" value={numberValue(summary.confirmPlannedCount)} tone={numberValue(summary.confirmPlannedCount) ? 'ok' : undefined} />
          <Metric label="更新" value={numberValue(summary.updateCount)} tone={numberValue(summary.updateCount) ? 'warn' : undefined} />
          <Metric label="归档" value={numberValue(summary.archiveCount)} tone={numberValue(summary.archiveCount) ? 'danger' : undefined} />
          <Metric label="发现新增" value={numberValue(summary.createDiscoveredCount)} tone={numberValue(summary.createDiscoveredCount) ? 'warn' : undefined} />
        </div>
      )}
      <TimelineUpdatePreview entries={asArray(writePreview?.entries)} />
      <div className="space-y-1">
        {issues.slice(0, 6).map((item, index) => {
          const issue = asRecord(item);
          return <div key={index} className="text-xs leading-5" style={{ color: issue?.severity === 'error' ? '#fb7185' : '#fbbf24' }}>[{textValue(issue?.severity)}] {textValue(issue?.message)}</div>;
        })}
        {!issues.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无阻断问题。</div>}
      </div>
    </div>
  );
}

function TimelinePersistSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const events = asArray(data?.events);
  const writtenCount = numberValue(data?.createdCount) + numberValue(data?.confirmedCount) + numberValue(data?.updatedCount) + numberValue(data?.archivedCount);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-5">
        <Metric label="新增 planned" value={numberValue(data?.createdCount)} tone={numberValue(data?.createdCount) ? 'ok' : undefined} />
        <Metric label="确认 active" value={numberValue(data?.confirmedCount)} tone={numberValue(data?.confirmedCount) ? 'ok' : undefined} />
        <Metric label="更新" value={numberValue(data?.updatedCount)} tone={numberValue(data?.updatedCount) ? 'warn' : undefined} />
        <Metric label="归档" value={numberValue(data?.archivedCount)} tone={numberValue(data?.archivedCount) ? 'danger' : undefined} />
        <Metric label="未选跳过" value={numberValue(data?.skippedUnselectedCount)} tone={numberValue(data?.skippedUnselectedCount) ? 'warn' : undefined} />
      </div>
      <div className="rounded-lg border px-3 py-2 text-xs leading-5" style={{ borderColor: 'rgba(20,184,166,0.30)', background: 'rgba(20,184,166,0.07)', color: 'var(--text-muted)' }}>
        已写入 {writtenCount} 条 TimelineEvent；所有写入仍以 approved Act 运行和后端 sourceTrace 校验为准。
      </div>
      <div className="space-y-1">
        {events.slice(0, 6).map((item, index) => {
          const event = asRecord(item);
          return <div key={index} className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{textValue(event?.candidateId, `candidate-${index + 1}`)} · {textValue(event?.action, 'create_planned')} · {textValue(event?.timelineEventId, '未返回 ID')} · {textValue(event?.eventStatus, 'planned')}</div>;
        })}
      </div>
    </div>
  );
}

function ContinuityPreviewSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const relationships = asArray(data?.relationshipCandidates);
  const timeline = asArray(data?.timelineCandidates);
  const risks = asArray(data?.risks);
  const writePlan = asRecord(data?.writePlan);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="关系候选" value={relationships.length} />
        <Metric label="时间线候选" value={timeline.length} />
        <Metric label="写入模式" value={textValue(writePlan?.mode, 'preview_only')} />
        <Metric label="审批前置" value={writePlan?.requiresApprovalBeforePersist === false ? '否' : '是'} tone={writePlan?.requiresApprovalBeforePersist === false ? 'danger' : 'warn'} />
      </div>
      <ContinuityCandidateList title="关系变更" items={relationships} kind="relationship" />
      <ContinuityCandidateList title="时间线变更" items={timeline} kind="timeline" />
      <div className="space-y-1">{risks.slice(0, 4).map((item, index) => <div key={index} className="text-xs leading-5" style={{ color: '#fbbf24' }}>风险：{textValue(item)}</div>)}</div>
    </div>
  );
}

function ContinuityCandidateList({ title, items, kind }: { title: string; items: unknown[]; kind: 'relationship' | 'timeline' }) {
  if (!items.length) return <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{title}暂无候选。</div>;
  return (
    <div className="space-y-1">
      <div className="text-xs font-semibold" style={{ color: 'var(--text-main)' }}>{title}</div>
      {items.slice(0, 8).map((item, index) => {
        const candidate = asRecord(item);
        const action = textValue(candidate?.action, 'create');
        const label = kind === 'relationship'
          ? `${textValue(candidate?.characterAName, '角色A')} -> ${textValue(candidate?.characterBName, '角色B')} · ${textValue(candidate?.relationType, '关系')}`
          : `${candidate?.chapterNo ? `第${numberValue(candidate.chapterNo)}章 · ` : ''}${textValue(candidate?.title, '未命名事件')}`;
        return <div key={index} className="text-xs leading-5" style={{ color: action === 'delete' ? '#fb7185' : action === 'update' ? '#fbbf24' : 'var(--text-muted)' }}><b style={{ color: 'var(--text-main)' }}>{label}</b> · {action} · {textValue(candidate?.impactAnalysis ?? candidate?.conflictRisk, '暂无影响说明')}</div>;
      })}
    </div>
  );
}

function ContinuityValidationSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const accepted = asRecord(data?.accepted);
  const rejected = asRecord(data?.rejected);
  const relationshipAccepted = asArray(accepted?.relationshipCandidates);
  const timelineAccepted = asArray(accepted?.timelineCandidates);
  const relationshipRejected = asArray(rejected?.relationshipCandidates);
  const timelineRejected = asArray(rejected?.timelineCandidates);
  const issues = asArray(data?.issues);
  const writePreview = asRecord(data?.writePreview);
  const relationshipWritePreview = asRecord(writePreview?.relationshipCandidates);
  const timelineWritePreview = asRecord(writePreview?.timelineCandidates);
  const relationshipSummary = asRecord(relationshipWritePreview?.summary);
  const timelineSummary = asRecord(timelineWritePreview?.summary);
  const hasError = issues.some((item) => asRecord(item)?.severity === 'error');
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="状态" value={data?.valid === true ? '可写入' : '需复核'} tone={data?.valid === true ? 'ok' : 'danger'} />
        <Metric label="关系通过" value={relationshipAccepted.length} tone="ok" />
        <Metric label="时间线通过" value={timelineAccepted.length} tone="ok" />
        <Metric label="问题" value={numberValue(data?.issueCount, issues.length)} tone={hasError ? 'danger' : issues.length ? 'warn' : 'ok'} />
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <ContinuityWriteSummary title="关系 Diff" summary={relationshipSummary} rejectedCount={relationshipRejected.length} />
        <ContinuityWriteSummary title="时间线 Diff" summary={timelineSummary} rejectedCount={timelineRejected.length} />
      </div>
      <div>
        <div className="mb-2 text-xs font-semibold" style={{ color: 'var(--text-main)' }}>时间线写入前 Diff</div>
        <TimelineUpdatePreview entries={asArray(timelineWritePreview?.entries)} maxItems={4} emptyText="暂无 continuity 时间线 diff。" />
      </div>
      <div className="space-y-1">
        {issues.slice(0, 6).map((item, index) => {
          const issue = asRecord(item);
          return <div key={index} className="text-xs leading-5" style={{ color: issue?.severity === 'error' ? '#fb7185' : '#fbbf24' }}>[{textValue(issue?.candidateType, 'continuity')}] {textValue(issue?.message)}</div>;
        })}
        {!issues.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无阻断问题。</div>}
      </div>
    </div>
  );
}

function ContinuityWriteSummary({ title, summary, rejectedCount }: { title: string; summary: Record<string, unknown> | undefined; rejectedCount: number }) {
  return (
    <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-dim)', background: 'rgba(15,23,42,0.18)' }}>
      <div className="mb-2 text-xs font-semibold" style={{ color: 'var(--text-main)' }}>{title}</div>
      <div className="grid gap-2 md:grid-cols-2">
        <Metric label="创建" value={numberValue(summary?.createCount)} tone={numberValue(summary?.createCount) ? 'ok' : undefined} />
        <Metric label="更新" value={numberValue(summary?.updateCount)} tone={numberValue(summary?.updateCount) ? 'warn' : undefined} />
        <Metric label="删除" value={numberValue(summary?.deleteCount)} tone={numberValue(summary?.deleteCount) ? 'danger' : undefined} />
        <Metric label="拒绝" value={numberValue(summary?.rejectCount, rejectedCount)} tone={numberValue(summary?.rejectCount, rejectedCount) ? 'danger' : undefined} />
      </div>
    </div>
  );
}

function ContinuityPersistSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const relationshipResults = asRecord(data?.relationshipResults);
  const timelineResults = asRecord(data?.timelineResults);
  const skipped = asRecord(data?.skippedUnselectedCandidates);
  const skippedRelationships = asArray(skipped?.relationshipCandidates);
  const skippedTimeline = asArray(skipped?.timelineCandidates);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="模式" value={data?.dryRun === true ? 'dry-run' : '写入'} tone={data?.dryRun === true ? 'warn' : 'ok'} />
        <Metric label="关系写入" value={numberValue(relationshipResults?.createdCount) + numberValue(relationshipResults?.updatedCount) + numberValue(relationshipResults?.deletedCount)} tone="ok" />
        <Metric label="时间线写入" value={numberValue(timelineResults?.createdCount) + numberValue(timelineResults?.updatedCount) + numberValue(timelineResults?.deletedCount)} tone="ok" />
        <Metric label="未选跳过" value={skippedRelationships.length + skippedTimeline.length} tone={skippedRelationships.length + skippedTimeline.length ? 'warn' : undefined} />
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <ContinuityPersistSection title="关系" result={relationshipResults} />
        <ContinuityPersistSection title="时间线" result={timelineResults} />
      </div>
    </div>
  );
}

function ContinuityPersistSection({ title, result }: { title: string; result: Record<string, unknown> | undefined }) {
  const created = asArray(result?.created);
  const updated = asArray(result?.updated);
  const deleted = asArray(result?.deleted);
  return (
    <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-dim)', background: 'rgba(15,23,42,0.18)' }}>
      <div className="mb-2 text-xs font-semibold" style={{ color: 'var(--text-main)' }}>{title}</div>
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="创建" value={numberValue(result?.createdCount, created.length)} tone={created.length ? 'ok' : undefined} />
        <Metric label="更新" value={numberValue(result?.updatedCount, updated.length)} tone={updated.length ? 'warn' : undefined} />
        <Metric label="删除" value={numberValue(result?.deletedCount, deleted.length)} tone={deleted.length ? 'danger' : undefined} />
      </div>
      <div className="mt-2 space-y-1">
        {[...created, ...updated, ...deleted].slice(0, 5).map((item, index) => {
          const row = asRecord(item);
          return <div key={index} className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{textValue(row?.label ?? row?.id, '未命名条目')}</div>;
        })}
      </div>
    </div>
  );
}

function CharacterConsistencySummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const character = asRecord(data?.character);
  const verdict = asRecord(data?.verdict);
  const deviations = asArray(data?.deviations);
  const status = textValue(verdict?.status, 'unknown');
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="角色" value={textValue(character?.name ?? character?.id, '未命名角色')} />
        <Metric label="结论" value={status} tone={status === 'likely_break' ? 'danger' : status === 'minor_drift' ? 'warn' : 'ok'} />
        <Metric label="偏差数" value={deviations.length} tone={deviations.length ? 'warn' : 'ok'} />
      </div>
      <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{textValue(verdict?.summary, '暂无结论摘要')}</div>
      <LlmEvidenceSummaryNotice content={data?.llmEvidenceSummary} />
      <div className="space-y-1">
        {deviations.slice(0, 5).map((item, index) => {
          const deviation = asRecord(item);
          return <div key={index} className="text-xs leading-5" style={{ color: deviation?.severity === 'error' ? '#fb7185' : deviation?.severity === 'warning' ? '#fbbf24' : 'var(--text-muted)' }}>[{textValue(deviation?.dimension, 'general')}] {textValue(deviation?.message, '暂无说明')}</div>;
        })}
      </div>
    </div>
  );
}

function PlotConsistencySummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const scope = asRecord(data?.scope);
  const verdict = asRecord(data?.verdict);
  const evidence = asRecord(data?.evidence);
  const deviations = asArray(data?.deviations);
  const status = textValue(verdict?.status, 'unknown');
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="结论" value={status} tone={status === 'likely_conflict' ? 'danger' : status === 'needs_review' ? 'warn' : 'ok'} />
        <Metric label="章节" value={numberValue(scope?.chapterCount)} />
        <Metric label="剧情事件" value={numberValue(scope?.plotEventCount)} />
        <Metric label="关系边" value={numberValue(scope?.relationshipEdgeCount)} />
      </div>
      <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{textValue(verdict?.summary, '暂无剧情一致性结论')}</div>
      <LlmEvidenceSummaryNotice content={data?.llmEvidenceSummary} />
      <div className="grid gap-2 md:grid-cols-2">
        <Metric label="大纲证据" value={asArray(evidence?.outlineEvidence).length} />
        <Metric label="事件线证据" value={asArray(evidence?.eventTimeline).length} />
        <Metric label="伏笔证据" value={asArray(evidence?.foreshadowEvidence).length} />
        <Metric label="动机证据" value={asArray(evidence?.motivationEvidence).length} />
      </div>
      {/* 剧情检查报告优先展示偏差维度和建议，帮助用户快速定位是时间线、伏笔还是动机问题。 */}
      <div className="space-y-1">
        {deviations.slice(0, 6).map((item, index) => {
          const deviation = asRecord(item);
          return <div key={index} className="text-xs leading-5" style={{ color: deviation?.severity === 'error' ? '#fb7185' : deviation?.severity === 'warning' ? '#fbbf24' : 'var(--text-muted)' }}>[{textValue(deviation?.dimension, 'context')}] {textValue(deviation?.message, '暂无说明')}</div>;
        })}
        {!deviations.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂未发现明显剧情矛盾。</div>}
      </div>
    </div>
  );
}

/**
 * LLM 证据摘要是默认关闭的只读实验元数据，只辅助阅读。
 * 前端必须明确展示 fallback 状态，且不把摘要作为审批、写入或确定性结论依据。
 */
function LlmEvidenceSummaryNotice({ content }: { content: unknown }) {
  const summary = asRecord(content);
  if (!summary || !Object.keys(summary).length) return null;
  const status = textValue(summary.status, 'unknown');
  const fallbackUsed = summary.fallbackUsed === true || status === 'fallback';
  const keyFindings = asArray(summary.keyFindings).map((item) => textValue(item)).filter(Boolean);
  return (
    <div className="space-y-2 rounded-xl border p-3" style={{ borderColor: fallbackUsed ? 'rgba(251,191,36,0.34)' : 'rgba(20,184,166,0.30)', background: fallbackUsed ? 'rgba(251,191,36,0.08)' : 'rgba(20,184,166,0.08)' }}>
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="实验摘要" value={fallbackUsed ? '已降级' : '可用'} tone={fallbackUsed ? 'warn' : 'ok'} />
        <Metric label="状态" value={status} tone={fallbackUsed ? 'warn' : 'ok'} />
        <Metric label="模型" value={textValue(summary.model, fallbackUsed ? '未调用' : '未记录')} />
      </div>
      <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>
        {fallbackUsed ? `LLM 摘要降级：${textValue(summary.error, '未启用或不可用')}` : textValue(summary.summary, '暂无实验摘要内容')}
      </div>
      {!fallbackUsed && keyFindings.length > 0 && (
        <div className="space-y-1">
          {keyFindings.slice(0, 4).map((item, index) => <div key={index} className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>实验发现：{item}</div>)}
        </div>
      )}
      <div className="text-xs" style={{ color: 'var(--text-dim)' }}>仅作辅助阅读；审批、写入和诊断结论仍以确定性报告为准。</div>
    </div>
  );
}

function TaskContextSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const diagnostics = asRecord(data?.diagnostics);
  const chapters = asArray(data?.chapters);
  const characters = asArray(data?.characters);
  const worldFacts = asArray(data?.worldFacts);
  const memoryChunks = asArray(data?.memoryChunks);
  const plotEvents = asArray(data?.plotEvents);
  const relationshipGraph = asArray(data?.relationshipGraph);
  const constraints = asArray(data?.constraints);
  const missingContext = asArray(diagnostics?.missingContext);
  const dimensions = asArray(diagnostics?.retrievalDimensions).map((item) => textValue(item)).filter(Boolean);
  const fullDraftIncluded = diagnostics?.fullDraftIncluded === true;
  const chapterRange = textValue(diagnostics?.chapterRange, '');
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="章节" value={chapters.length} />
        <Metric label="角色" value={characters.length} />
        <Metric label="世界事实" value={worldFacts.length} />
        <Metric label="记忆片段" value={memoryChunks.length} />
        <Metric label="剧情事件" value={plotEvents.length} tone={plotEvents.length ? 'ok' : undefined} />
        <Metric label="关系边" value={relationshipGraph.length} tone={relationshipGraph.length ? 'ok' : undefined} />
        <Metric label="完整草稿" value={fullDraftIncluded ? '已召回' : '未召回'} tone={fullDraftIncluded ? 'warn' : 'ok'} />
        <Metric label="缺失上下文" value={missingContext.length} tone={missingContext.length ? 'warn' : 'ok'} />
      </div>
      {/* 将 collect_task_context 的检索维度显式暴露给用户/调试者，便于判断是否真的使用了剧情事件、关系图或完整草稿等 Warm/Cold Context。 */}
      <div className="flex flex-wrap gap-2">
        {dimensions.map((dimension, index) => <span key={`${dimension}-${index}`} className="px-2 py-1 text-xs" style={{ borderRadius: '999px', border: '1px solid rgba(20,184,166,0.28)', color: '#5eead4', background: 'rgba(20,184,166,0.08)' }}>{dimension}</span>)}
        {!dimensions.length && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无检索维度诊断。</span>}
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {chapterRange && <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>章节范围：{chapterRange}</div>}
        {missingContext.slice(0, 4).map((item, index) => <div key={`missing-${index}`} className="text-xs leading-5" style={{ color: '#fbbf24' }}>缺失：{textValue(item)}</div>)}
        {constraints.slice(0, 4).map((item, index) => <div key={`constraint-${index}`} className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>约束：{textValue(item)}</div>)}
      </div>
      <RelationshipGraphSummary graph={relationshipGraph} />
    </div>
  );
}

/** 将关系图边转换成人类可读证据列表，突出关系类型、强度、来源和冲突边。 */
function RelationshipGraphSummary({ graph }: { graph: unknown[] }) {
  if (!graph.length) return <div className="rounded-xl border p-3 text-xs" style={{ borderColor: 'var(--border-dim)', color: 'var(--text-muted)' }}>暂无关系图证据；当前上下文没有召回可形成关系边的剧情事件或角色状态。</div>;

  return (
    <div className="space-y-2 rounded-xl border p-3" style={{ borderColor: 'var(--border-dim)', background: 'rgba(15,23,42,0.20)' }}>
      <div className="text-xs font-semibold" style={{ color: 'var(--text-main)' }}>关系图证据</div>
      {graph.slice(0, 8).map((item, index) => {
        const edge = asRecord(item);
        const target = textValue(edge?.target, '状态证据');
        const relationType = textValue(edge?.relationType, 'unknown');
        const weight = numberValue(edge?.weight);
        const sources = asArray(edge?.evidenceSources).map((source) => asRecord(source)).map((source) => `${textValue(source?.sourceType, 'source')}${source?.chapterNo ? `@第${numberValue(source.chapterNo)}章` : ''}`).join('、');
        const timeRange = asRecord(edge?.timeRange);
        const timeLabel = timeRange?.fromChapterNo ? `第 ${numberValue(timeRange.fromChapterNo)} 章` : '未知时间';
        const conflict = edge?.conflict === true;
        return (
          <div key={index} className="text-xs leading-5" style={{ color: conflict ? '#fbbf24' : 'var(--text-muted)' }}>
            <b style={{ color: 'var(--text-main)' }}>{textValue(edge?.source, '未知角色')} → {target}</b> · {relationType} · 强度 {weight.toFixed(2)} · {timeLabel} · 来源 {sources || textValue(edge?.sourceType, 'unknown')}
            <div style={{ color: 'var(--text-dim)' }}>{textValue(edge?.evidence, '暂无证据摘录')}</div>
          </div>
        );
      })}
    </div>
  );
}

function ProjectProfileSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  return <div className="space-y-2 text-xs leading-5" style={{ color: 'var(--text-muted)' }}><Metric label="标题" value={textValue(data?.title, '未命名项目')} /><div>{textValue(data?.logline ?? data?.synopsis ?? data?.outline, '暂无简介')}</div></div>;
}

function ArraySummary({ content, label, primaryKey, secondaryKey }: { content: unknown; label: string; primaryKey: string; secondaryKey: string }) {
  const items = asArray(content);
  return (
    <div className="space-y-3">
      <Metric label={`${label}数量`} value={items.length} />
      <div className="flex flex-wrap gap-2">
        {items.slice(0, 12).map((item, index) => {
          const record = asRecord(item);
          return <span key={index} className="px-2 py-1 text-xs" style={{ borderRadius: '999px', border: '1px solid var(--border-dim)', color: 'var(--text-muted)' }}>{textValue(record?.[primaryKey], `${label}${index + 1}`)}{record?.[secondaryKey] ? ` · ${textValue(record[secondaryKey])}` : ''}</span>;
        })}
      </div>
    </div>
  );
}

function OutlinePersistSummary({ content }: { content: unknown }) {
  const data = asRecord(content) ?? {};
  const risks = asArray(data?.risks).map((item) => textValue(item)).filter(Boolean);
  const skippedCount = numberValue(data?.skippedCount);
  const writtenCount = numberValue(data?.createdCount) + numberValue(data?.updatedCount);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="创建章节" value={numberValue(data?.createdCount)} tone={numberValue(data?.createdCount) ? 'ok' : undefined} />
        <Metric label="更新 planned" value={numberValue(data?.updatedCount)} tone={numberValue(data?.updatedCount) ? 'ok' : undefined} />
        <Metric label="跳过章节" value={skippedCount} tone={skippedCount ? 'warn' : 'ok'} />
        <Metric label="预览章节" value={numberValue(data?.chapterCount)} />
      </div>
      <div className="rounded-lg border px-3 py-2 text-xs leading-5" style={{ borderColor: skippedCount ? 'rgba(251,191,36,0.35)' : 'rgba(20,184,166,0.30)', background: skippedCount ? 'rgba(251,191,36,0.08)' : 'rgba(20,184,166,0.07)', color: 'var(--text-muted)' }}>
        已写入 {writtenCount} 章规划字段与执行卡；已起草或非 planned 章节保持不覆盖。{skippedCount ? ` 本次跳过 ${skippedCount} 章。` : ''}
      </div>
      {risks.length > 0 && (
        <div className="space-y-1">
          {risks.slice(0, 4).map((risk, index) => (
            <div key={index} className="text-xs leading-5" style={{ color: '#fbbf24' }}>写入风险：{risk}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function StoryUnitsPreviewSummary({ content }: { content: unknown }) {
  const data = asRecord(content) ?? {};
  const plan = asRecord(data?.storyUnitPlan) ?? {};
  const mainlineSegments = recordList(plan?.mainlineSegments);
  const units = recordList(plan?.units);
  const allocations = recordList(plan?.chapterAllocation);
  const purposeMix = asRecord(plan?.purposeMix) ?? {};
  const purposeMixText = Object.entries(purposeMix).slice(0, 6).map(([key, value]) => `${key}: ${String(value)}`).join(' / ');
  const chapterCount = numberValue(data?.chapterCount);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="目标卷" value={numberValue(data?.volumeNo) ? `第 ${numberValue(data?.volumeNo)} 卷` : '—'} />
        <Metric label="目标章数" value={chapterCount || '—'} />
        <Metric label="主线段" value={mainlineSegments.length} tone={mainlineSegments.length ? 'ok' : 'warn'} />
        <Metric label="单元故事" value={units.length} tone={units.length ? 'ok' : 'warn'} />
      </div>
      {textValue(plan?.planningPrinciple, '') && (
        <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{textValue(plan?.planningPrinciple)}</div>
      )}
      {purposeMixText && (
        <div className="rounded-lg border px-3 py-2 text-xs leading-5" style={{ borderColor: 'var(--border-dim)', background: 'rgba(15,23,42,0.18)', color: 'var(--text-muted)' }}>
          {purposeMixText}
        </div>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {units.slice(0, 8).map((unit, index) => {
          const unitId = textValue(unit.unitId, `unit-${index}`);
          const allocation = allocations.find((item) => textValue(item.unitId, '') === unitId);
          const range = asRecord(allocation?.chapterRange);
          const rangeText = numberValue(range?.start) && numberValue(range?.end)
            ? `第 ${numberValue(range?.start)}-${numberValue(range?.end)} 章`
            : `${numberValue(unit.suggestedChapterMin) || '?'}-${numberValue(unit.suggestedChapterMax) || '?'} 章`;
          const purposes = [textValue(unit.primaryPurpose, ''), ...stringList(unit.secondaryPurposes)].filter(Boolean);
          const segmentIds = stringList(unit.mainlineSegmentIds);
          return (
            <div key={unitId} className="rounded-lg border px-3 py-2 text-xs leading-5" style={{ borderColor: 'var(--border-dim)', background: 'rgba(15,23,42,0.18)', color: 'var(--text-muted)' }}>
              <div className="font-semibold" style={{ color: 'var(--text-main)' }}>{textValue(unit.title, unitId)} · {rangeText}</div>
              {purposes.length > 0 && <div style={{ color: '#5eead4' }}>{purposes.slice(0, 4).join(' / ')}</div>}
              {segmentIds.length > 0 && <div>主线段：{segmentIds.join(' / ')}</div>}
              {textValue(unit.narrativePurpose, '') && <div>{textValue(unit.narrativePurpose)}</div>}
              {textValue(unit.payoff, '') && <div>回收：{textValue(unit.payoff)}</div>}
            </div>
          );
        })}
      </div>
      {units.length > 8 && <div className="text-xs" style={{ color: 'var(--text-dim)' }}>还有 {units.length - 8} 个单元故事，完整内容见原始 JSON。</div>}
    </div>
  );
}

function StoryUnitsPersistSummary({ content }: { content: unknown }) {
  const data = asRecord(content) ?? {};
  return (
    <div className="grid gap-2 md:grid-cols-4">
      <Metric label="目标卷" value={numberValue(data?.volumeNo) ? `第 ${numberValue(data?.volumeNo)} 卷` : '—'} />
      <Metric label="单元故事" value={numberValue(data?.storyUnitCount, 0)} tone="ok" />
      <Metric label="仅更新单元计划" value={data?.updatedStoryUnitPlanOnly ? '是' : '否'} tone={data?.updatedStoryUnitPlanOnly ? 'ok' : 'warn'} />
      <Metric label="Volume ID" value={textValue(data?.volumeId, '—')} />
    </div>
  );
}

function VolumeCharacterCandidatesPreviewSummary({ content }: { content: unknown }) {
  const data = asRecord(content) ?? {};
  const persistableCandidates = recordList(data?.persistableCandidates);
  const existingCandidates = recordList(data?.existingCandidates);
  const totalCandidateCount = numberValue(data?.totalCandidateCount, persistableCandidates.length + existingCandidates.length);
  const persistableCount = numberValue(data?.persistableCount, persistableCandidates.length);
  const existingCount = numberValue(data?.existingCount, existingCandidates.length);
  const relationshipArcCount = numberValue(data?.relationshipArcCount);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="候选总数" value={totalCandidateCount} />
        <Metric label="可写入角色" value={persistableCount} tone={persistableCount ? 'ok' : 'warn'} />
        <Metric label="已存在跳过" value={existingCount} tone={existingCount ? 'warn' : 'ok'} />
        <Metric label="关系弧" value={relationshipArcCount} tone={relationshipArcCount ? undefined : 'ok'} />
      </div>
      {textValue(data?.approvalMessage, '') && (
        <div className="rounded-lg border px-3 py-2 text-xs leading-5" style={{ borderColor: 'rgba(20,184,166,0.30)', background: 'rgba(20,184,166,0.07)', color: 'var(--text-muted)' }}>
          {textValue(data?.approvalMessage)}
        </div>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <VolumeCharacterCandidateList title="可写入候选" items={persistableCandidates} tone="ok" emptyText="没有新的卷级角色候选可写入。" />
        <VolumeCharacterCandidateList title="正式角色已存在，写入前跳过" items={existingCandidates} tone="warn" emptyText="没有命中正式角色表的候选。" />
      </div>
    </div>
  );
}

function VolumeCharacterCandidateList({ title, items, tone, emptyText }: { title: string; items: Array<Record<string, unknown>>; tone: 'ok' | 'warn'; emptyText: string }) {
  const color = tone === 'ok' ? '#86efac' : '#fbbf24';
  return (
    <div className="space-y-2 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-dim)', background: 'rgba(15,23,42,0.18)' }}>
      <div className="text-xs font-semibold" style={{ color: 'var(--text-main)' }}>{title}</div>
      {items.length ? (
        <div className="space-y-2">
          {items.slice(0, 8).map((item, index) => {
            const name = textValue(item.name, '未命名角色');
            const details = [
              textValue(item.roleType, ''),
              numberValue(item.firstAppearChapter) ? `第 ${numberValue(item.firstAppearChapter)} 章` : '',
              textValue(item.candidateId, ''),
            ].filter(Boolean);
            const existing = textValue(item.existingName, '');
            const source = textValue(item.existingSource, '');
            return (
              <div key={textValue(item.candidateId, `${name}-${index}`)} className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>
                <b style={{ color }}>{name}</b>{details.length ? ` · ${details.join(' · ')}` : ''}
                {textValue(item.narrativeFunction, '') && <div>{textValue(item.narrativeFunction)}</div>}
                {existing && <div>已存在：{existing}{source ? ` · ${source}` : ''}</div>}
              </div>
            );
          })}
          {items.length > 8 && <div className="text-xs" style={{ color: 'var(--text-dim)' }}>还有 {items.length - 8} 个候选，完整内容见原始 JSON。</div>}
        </div>
      ) : (
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{emptyText}</div>
      )}
    </div>
  );
}

function VolumeCharacterCandidatesPersistSummary({ content }: { content: unknown }) {
  const data = asRecord(content) ?? {};
  const characterResults = recordList(data?.characterResults);
  const relationshipResults = recordList(data?.relationshipResults);
  const createdCount = numberValue(data?.createdCount, characterResults.filter((item) => item.action === 'created').length);
  const updatedCount = numberValue(data?.updatedCount, characterResults.filter((item) => item.action === 'updated').length);
  const skippedCount = numberValue(data?.skippedCount, characterResults.filter((item) => item.action === 'skipped').length);
  const relationshipCreatedCount = numberValue(data?.relationshipCreatedCount, relationshipResults.filter((item) => item.action === 'created').length);
  const relationshipSkippedCount = numberValue(data?.relationshipSkippedCount, relationshipResults.filter((item) => item.action === 'skipped').length);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-5">
        <Metric label="新增角色" value={createdCount} tone={createdCount ? 'ok' : undefined} />
        <Metric label="更新角色" value={updatedCount} tone={updatedCount ? 'warn' : undefined} />
        <Metric label="跳过角色" value={skippedCount} tone={skippedCount ? 'warn' : 'ok'} />
        <Metric label="新增关系" value={relationshipCreatedCount} tone={relationshipCreatedCount ? 'ok' : undefined} />
        <Metric label="跳过关系" value={relationshipSkippedCount} tone={relationshipSkippedCount ? 'warn' : 'ok'} />
      </div>
      {textValue(data?.approvalMessage, '') && (
        <div className="rounded-lg border px-3 py-2 text-xs leading-5" style={{ borderColor: 'rgba(20,184,166,0.30)', background: 'rgba(20,184,166,0.07)', color: 'var(--text-muted)' }}>
          {textValue(data?.approvalMessage)}
        </div>
      )}
      <VolumeCharacterResultList items={characterResults} />
      <VolumeRelationshipResultList items={relationshipResults} />
    </div>
  );
}

function VolumeCharacterResultList({ items }: { items: Array<Record<string, unknown>> }) {
  if (!items.length) return <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无角色写入明细。</div>;
  return (
    <div className="space-y-1">
      <div className="text-xs font-semibold" style={{ color: 'var(--text-main)' }}>角色写入</div>
      {items.slice(0, 8).map((item, index) => {
        const action = textValue(item.action, 'unknown');
        return (
          <div key={textValue(item.candidateId, `character-${index}`)} className="text-xs leading-5" style={{ color: persistActionColor(action) }}>
            {persistActionLabel(action)}：{textValue(item.name, '未命名角色')} · {textValue(item.candidateId, '无候选 ID')}{item.reason ? ` · ${textValue(item.reason)}` : ''}
          </div>
        );
      })}
      {items.length > 8 && <div className="text-xs" style={{ color: 'var(--text-dim)' }}>还有 {items.length - 8} 条角色明细，完整内容见原始 JSON。</div>}
    </div>
  );
}

function VolumeRelationshipResultList({ items }: { items: Array<Record<string, unknown>> }) {
  if (!items.length) return <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无关系写入明细。</div>;
  return (
    <div className="space-y-1" style={{ borderTop: '1px solid var(--border-dim)', paddingTop: '0.75rem' }}>
      <div className="text-xs font-semibold" style={{ color: 'var(--text-main)' }}>关系写入</div>
      {items.slice(0, 6).map((item, index) => {
        const action = textValue(item.action, 'unknown');
        const participants = stringList(item.participants).join(' / ') || '未标注双方';
        return (
          <div key={`${participants}-${index}`} className="text-xs leading-5" style={{ color: persistActionColor(action) }}>
            {persistActionLabel(action)}：{participants}{item.reason ? ` · ${textValue(item.reason)}` : ''}
          </div>
        );
      })}
      {items.length > 6 && <div className="text-xs" style={{ color: 'var(--text-dim)' }}>还有 {items.length - 6} 条关系明细，完整内容见原始 JSON。</div>}
    </div>
  );
}

function persistActionLabel(action: string) {
  if (action === 'created') return '新增';
  if (action === 'updated') return '更新';
  if (action === 'skipped') return '跳过';
  return action;
}

function persistActionColor(action: string) {
  if (action === 'created') return '#86efac';
  if (action === 'updated') return '#fbbf24';
  if (action === 'skipped') return 'var(--text-muted)';
  return 'var(--text-muted)';
}

function PersistSummary({ content }: { content: unknown }) {
  const data = asRecord(content) ?? {};
  const entries = Object.entries(data).filter(([, value]) => typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean').slice(0, 8);
  return <div className="grid gap-2 md:grid-cols-3">{entries.length ? entries.map(([key, value]) => <Metric key={key} label={key} value={String(value)} />) : <Metric label="结果" value="已完成" tone="ok" />}</div>;
}

function ChapterDraftSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  return <div className="grid gap-2 md:grid-cols-3"><Metric label="Draft ID" value={textValue(data?.draftId)} /><Metric label="章节" value={textValue(data?.chapterId)} /><Metric label="字数" value={numberValue(data?.actualWordCount)} /></div>;
}

function GenerationQualitySummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const preflight = asRecord(data?.preflight);
  const qualityGate = asRecord(data?.qualityGate);
  const retrieval = asRecord(data?.retrievalDiagnostics);
  const warnings = [...asArray(preflight?.warnings), ...asArray(qualityGate?.warnings), ...asArray(retrieval?.warnings)];
  const blockers = [...asArray(preflight?.blockers), ...asArray(qualityGate?.blockers)];
  const blocked = preflight?.valid === false || qualityGate?.blocked === true || retrieval?.qualityStatus === 'blocked';
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="Preflight" value={preflight?.valid === false ? '未通过' : '通过'} tone={preflight?.valid === false ? 'danger' : warnings.length ? 'warn' : 'ok'} />
        <Metric label="生成后门禁" value={qualityGate?.blocked === true ? '阻断' : qualityGate ? '通过' : '未记录'} tone={qualityGate?.blocked === true ? 'danger' : warnings.length ? 'warn' : 'ok'} />
        <Metric label="召回方式" value={textValue(retrieval?.searchMethod, '未知')} tone={retrieval?.searchMethod === 'keyword_fallback' ? 'warn' : 'ok'} />
        <Metric label="质量分" value={numberValue(qualityGate?.score, numberValue(retrieval?.qualityScore) * 100).toFixed(0)} tone={blocked ? 'danger' : warnings.length ? 'warn' : 'ok'} />
      </div>
      <div className="space-y-1">
        {blockers.slice(0, 4).map((item, index) => <div key={`blocker-${index}`} className="text-xs leading-5" style={{ color: '#fb7185' }}>✖ {textValue(item)}</div>)}
        {warnings.slice(0, 5).map((item, index) => <div key={`warning-${index}`} className="text-xs leading-5" style={{ color: '#fbbf24' }}>⚠ {textValue(item)}</div>)}
        {!warnings.length && !blockers.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>生成前检查、生成后门禁与召回质量均正常。</div>}
      </div>
    </div>
  );
}

function ChapterPolishSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  return <div className="grid gap-2 md:grid-cols-3"><Metric label="Draft ID" value={textValue(data?.draftId)} /><Metric label="原字数" value={numberValue(data?.originalWordCount)} /><Metric label="润色字数" value={numberValue(data?.polishedWordCount)} /></div>;
}

function ChapterContextSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const chapter = asRecord(data?.chapter);
  const writePreview = asRecord(data?.writePreview);
  const draft = asRecord(writePreview?.draft);
  const facts = asRecord(writePreview?.facts);
  const memory = asRecord(writePreview?.memory);
  const validation = asRecord(writePreview?.validation);
  const hints = asArray(writePreview?.approvalRiskHints);
  const currentVersionNo = numberValue(draft?.currentVersionNo);
  const currentExcerpt = textValue(draft?.currentExcerpt, '');
  const autoFactCount = numberValue(facts?.existingAutoEventCount) + numberValue(facts?.existingAutoCharacterStateCount) + numberValue(facts?.existingAutoForeshadowCount);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="章节" value={`${numberValue(chapter?.chapterNo)} · ${textValue(chapter?.title, '未命名')}`} />
        <Metric label="角色" value={asArray(data?.characters).length} />
        <Metric label="记忆片段" value={asArray(data?.memoryChunks).length} />
      </div>
      <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{textValue(chapter?.objective ?? chapter?.outline, '暂无章节目标')}</div>
      {writePreview && (
        <div className="space-y-2" style={{ borderTop: '1px solid var(--border-dim)', paddingTop: '0.75rem' }}>
          <div className="grid gap-2 md:grid-cols-4">
            <Metric label="草稿动作" value={textValue(draft?.action, 'unknown')} tone={draft?.action === 'create_new_version' ? 'warn' : 'ok'} />
            <Metric label="当前版本" value={currentVersionNo ? `v${currentVersionNo}` : '无'} />
            <Metric label="自动事实" value={autoFactCount} tone={autoFactCount ? 'warn' : undefined} />
            <Metric label="自动记忆" value={numberValue(memory?.existingAutoMemoryCount)} tone={numberValue(memory?.existingAutoMemoryCount) ? 'warn' : undefined} />
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <Metric label="Open 校验问题" value={numberValue(validation?.openIssueCount)} tone={numberValue(validation?.openErrorCount) ? 'danger' : numberValue(validation?.openIssueCount) ? 'warn' : 'ok'} />
            <Metric label="当前草稿字数" value={numberValue(draft?.currentWordCount)} />
          </div>
          <div className="space-y-1">{hints.slice(0, 5).map((item, index) => <div key={index} className="text-xs leading-5" style={{ color: '#fbbf24' }}>⚠ {textValue(item)}</div>)}</div>
          {currentExcerpt ? <div className="text-xs leading-5" style={{ color: 'var(--text-dim)' }}>当前草稿摘录：{currentExcerpt}</div> : null}
        </div>
      )}
    </div>
  );
}

function FactExtractionSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const events = asArray(data?.events);
  const states = asArray(data?.characterStates);
  const foreshadows = asArray(data?.foreshadows);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="剧情事件" value={numberValue(data?.createdEvents, events.length)} />
        <Metric label="角色状态" value={numberValue(data?.createdCharacterStates, states.length)} />
        <Metric label="伏笔" value={numberValue(data?.createdForeshadows, foreshadows.length)} />
      </div>
      <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{textValue(data?.summary, '暂无章节摘要')}</div>
      <div className="space-y-1">
        {events.slice(0, 3).map((item, index) => {
          const event = asRecord(item);
          return <div key={index} className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}><b style={{ color: 'var(--text-main)' }}>{textValue(event?.title, `事件${index + 1}`)}</b> — {textValue(event?.description, '暂无描述')}</div>;
        })}
      </div>
    </div>
  );
}

function AutoRepairSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const skipped = data?.skipped === true;
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-3">
        <Metric label="状态" value={skipped ? '已跳过' : '已修复'} tone={skipped ? 'warn' : 'ok'} />
        <Metric label="修复问题" value={numberValue(data?.repairedIssueCount)} />
        <Metric label="修复后字数" value={numberValue(data?.repairedWordCount)} />
      </div>
      <div className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>{skipped ? `原因：${textValue(data?.reason, '无可修复问题')}` : textValue(data?.summary, '已创建修复草稿')}</div>
    </div>
  );
}

function MemoryReviewSummary({ content }: { content: unknown }) {
  const data = asRecord(content);
  const decisions = asArray(data?.decisions);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 md:grid-cols-4">
        <Metric label="已复核" value={numberValue(data?.reviewedCount)} />
        <Metric label="确认" value={numberValue(data?.confirmedCount)} tone="ok" />
        <Metric label="拒绝" value={numberValue(data?.rejectedCount)} tone={numberValue(data?.rejectedCount) ? 'warn' : undefined} />
        <Metric label="跳过" value={numberValue(data?.skippedCount)} />
      </div>
      <div className="space-y-1">
        {decisions.slice(0, 4).map((item, index) => {
          const decision = asRecord(item);
          const action = textValue(decision?.action, 'unknown');
          return <div key={index} className="text-xs leading-5" style={{ color: action === 'confirm' ? '#86efac' : '#fbbf24' }}>[{action}] {textValue(decision?.reason, '暂无理由')}</div>;
        })}
        {!decisions.length && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无待复核记忆。</div>}
      </div>
    </div>
  );
}
