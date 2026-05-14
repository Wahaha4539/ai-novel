import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StructuredLogger } from '../../common/logging/structured-logger';
import { AgentContextBuilderService, AgentContextV2 } from './agent-context-builder.service';
import { AgentCancelledError, AgentExecutorService, AgentRunStateChangedError, AgentWaitingReviewError } from './agent-executor.service';
import { AgentExecutionObservationError, AgentObservation, ReplanAttemptStats, ReplanPatch } from './agent-observation.types';
import { AgentPlannerFailedError, AgentPlannerService, AgentPlanSpec } from './agent-planner.service';
import { AgentReplannerService } from './agent-replanner.service';
import { AgentTraceService } from './agent-trace.service';

type AgentArtifactDraft = {
  artifactType: string;
  title: string;
  content: unknown;
};

type ProjectImportPreviewArtifact = {
  requestedAssetTypes?: unknown;
  projectProfile?: unknown;
  characters?: unknown;
  lorebookEntries?: unknown;
  writingRules?: unknown;
  volumes?: unknown;
  chapters?: unknown;
  risks?: unknown;
};

type ProjectImportAssetType = 'projectProfile' | 'outline' | 'characters' | 'worldbuilding' | 'writingRules';

const PROJECT_IMPORT_ASSET_TYPES: ProjectImportAssetType[] = ['projectProfile', 'outline', 'characters', 'worldbuilding', 'writingRules'];
const CROSS_TARGET_CONSISTENCY_CHECK_TOOL = 'cross_target_consistency_check';

const PROJECT_IMPORT_TARGET_TOOL_BY_ASSET_TYPE: Record<ProjectImportAssetType, string> = {
  projectProfile: 'generate_import_project_profile_preview',
  outline: 'generate_import_outline_preview',
  characters: 'generate_import_characters_preview',
  worldbuilding: 'generate_import_worldbuilding_preview',
  writingRules: 'generate_import_writing_rules_preview',
};

const PROJECT_IMPORT_TARGET_TOOL_ASSET_TYPE: Record<string, ProjectImportAssetType> = {
  generate_import_project_profile_preview: 'projectProfile',
  generate_import_outline_preview: 'outline',
  generate_import_characters_preview: 'characters',
  generate_import_worldbuilding_preview: 'worldbuilding',
  generate_import_writing_rules_preview: 'writingRules',
};

const MERGE_PREVIEW_ARG_BY_ASSET_TYPE: Record<ProjectImportAssetType, string> = {
  projectProfile: 'projectProfilePreview',
  outline: 'outlinePreview',
  characters: 'charactersPreview',
  worldbuilding: 'worldbuildingPreview',
  writingRules: 'writingRulesPreview',
};

const PROJECT_IMPORT_ASSET_LABELS: Record<ProjectImportAssetType, string> = {
  projectProfile: 'project profile',
  outline: 'outline',
  characters: 'characters',
  worldbuilding: 'worldbuilding',
  writingRules: 'writing rules',
};

/** 编排 AgentRun 状态机：Plan 阶段生成预览，Act 阶段执行已审批工具。 */
@Injectable()
export class AgentRuntimeService {
  private readonly logger = new StructuredLogger(AgentRuntimeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly planner: AgentPlannerService,
    private readonly contextBuilder: AgentContextBuilderService,
    private readonly executor: AgentExecutorService,
    private readonly replanner: AgentReplannerService,
    private readonly trace: AgentTraceService,
  ) {}

  async plan(agentRunId: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: agentRunId } });
    if (!run) throw new Error(`AgentRun 不存在：${agentRunId}`);

    const startedAt = Date.now();
    this.logger.log('agent.runtime.plan.started', { agentRunId, projectId: run.projectId, chapterId: run.chapterId, goalLength: run.goal.length });
    try {
      const leaseStartedAt = new Date();
      const lease = await this.prisma.agentRun.updateMany({
        where: { id: agentRunId, status: 'planning' },
        data: {
          mode: 'plan',
          error: null,
          heartbeatAt: leaseStartedAt,
          leaseExpiresAt: new Date(leaseStartedAt.getTime() + 120_000),
          deadlineAt: null,
        },
      });
      if (lease.count !== 1) throw new AgentRunStateChangedError('AgentRun 当前状态已不再允许执行 Plan', run.status);
      const context = await this.contextBuilder.buildForPlan(run);
      const contextDigest = this.contextBuilder.createDigest(context);
      await this.persistContextSnapshot(agentRunId, run.input, context, contextDigest);
      this.logger.log('agent.runtime.plan.context_ready', { agentRunId, contextDigest, availableToolCount: context.availableTools.length, hasCurrentChapter: Boolean(context.currentChapter) });
      const plan = await this.planner.createPlan(run.goal, context);
      this.logger.log('agent.runtime.plan.created', { agentRunId, taskType: plan.taskType, stepCount: plan.steps.length, requiredApprovalCount: plan.requiredApprovals.length, risks: plan.risks });
      await this.trace.recordDecision(agentRunId, { name: '生成 Agent Plan', mode: 'plan', input: { goal: run.goal, contextDigest }, output: { taskType: plan.taskType, stepCount: plan.steps.length, understanding: plan.understanding, plannerDiagnostics: plan.plannerDiagnostics } });
      const savedPlan = await this.prisma.agentPlan.create({
        data: {
          agentRunId,
          status: 'waiting_approval',
          taskType: plan.taskType,
          summary: plan.summary,
          assumptions: plan.assumptions as Prisma.InputJsonValue,
          risks: plan.risks as Prisma.InputJsonValue,
          steps: plan.steps as unknown as Prisma.InputJsonValue,
          requiredApprovals: plan.requiredApprovals as unknown as Prisma.InputJsonValue,
        },
      });

      const artifact = await this.prisma.agentArtifact.create({
        data: { agentRunId, artifactType: 'agent_plan_preview', title: 'Agent 执行计划预览', content: plan as unknown as Prisma.InputJsonValue, status: 'preview' },
      });

      const previewOutputs = await this.executor.execute(agentRunId, plan.steps, { mode: 'plan', planVersion: savedPlan.version, approved: false, previewOnly: true, agentContext: context });
      const previewArtifacts = this.buildPreviewArtifacts(plan.taskType, previewOutputs, plan.steps);
      this.logger.log('agent.runtime.plan.preview_completed', { agentRunId, planVersion: savedPlan.version, previewStepNos: Object.keys(previewOutputs).map(Number), previewArtifactCount: previewArtifacts.length });
      if (previewArtifacts.length) {
        await this.prisma.agentArtifact.createMany({
          data: previewArtifacts.map((preview) => ({
            agentRunId,
            artifactType: preview.artifactType,
            title: preview.title,
            content: preview.content as Prisma.InputJsonValue,
            status: 'preview',
          })),
        });
      }

      const artifacts = await this.prisma.agentArtifact.findMany({ where: { agentRunId }, orderBy: { createdAt: 'asc' } });
      const completed = await this.prisma.agentRun.updateMany({
        where: { id: agentRunId, status: 'planning' },
        data: {
          status: 'waiting_approval',
          taskType: plan.taskType,
          output: { planId: savedPlan.id },
          currentStepNo: null,
          currentTool: null,
          currentPhase: null,
          leaseExpiresAt: null,
        },
      });
      if (completed.count !== 1) {
        const current = await this.prisma.agentRun.findUnique({ where: { id: agentRunId } });
        this.logger.warn('agent.runtime.plan.late_completion_ignored', { agentRunId, currentStatus: current?.status, planVersion: savedPlan.version });
        return { plan: savedPlan, artifacts: artifacts.length ? artifacts : [artifact], currentRun: current };
      }
      this.logger.log('agent.runtime.plan.completed', { agentRunId, planVersion: savedPlan.version, elapsedMs: Date.now() - startedAt, artifactCount: artifacts.length });
      return { plan: savedPlan, artifacts: artifacts.length ? artifacts : [artifact] };
    } catch (error) {
      if (error instanceof AgentCancelledError || error instanceof AgentRunStateChangedError) {
        const current = await this.prisma.agentRun.findUnique({ where: { id: agentRunId } });
        this.logger.warn('agent.runtime.plan.aborted_after_run_state_change', { agentRunId, elapsedMs: Date.now() - startedAt, message: error.message, currentStatus: current?.status });
        return { plan: null, artifacts: [], currentRun: current };
      }
      await this.recordPlannerFailure(agentRunId, error);
      this.logger.error('agent.runtime.plan.failed', error, { agentRunId, elapsedMs: Date.now() - startedAt });
      throw error;
    }
  }

  async act(agentRunId: string, approvedStepNos?: number[], confirmation?: { confirmHighRisk?: boolean; confirmedRiskIds?: string[] }) {
    const latestPlan = await this.prisma.agentPlan.findFirst({ where: { agentRunId }, orderBy: { version: 'desc' } });
    if (!latestPlan) throw new Error('缺少可执行计划');
    const run = await this.prisma.agentRun.findUnique({ where: { id: agentRunId } });
    if (!run) throw new Error(`AgentRun 不存在：${agentRunId}`);
    const spec = { steps: latestPlan.steps } as unknown as Pick<AgentPlanSpec, 'steps'>;
    let context: AgentContextV2 | undefined;

    const startedAt = Date.now();
    this.logger.log('agent.runtime.act.started', { agentRunId, projectId: run.projectId, planVersion: latestPlan.version, taskType: latestPlan.taskType, approvedStepNos, confirmHighRisk: confirmation?.confirmHighRisk, confirmedRiskIds: confirmation?.confirmedRiskIds });
    try {
      // 通过条件更新获取轻量执行租约，避免两个 /act 或 /retry 请求并发执行同一份计划。
      const leaseStartedAt = new Date();
      const lease = await this.prisma.agentRun.updateMany({
        where: { id: agentRunId, status: { in: ['waiting_approval', 'waiting_review', 'failed'] } },
        data: {
          status: 'acting',
          mode: 'act',
          error: null,
          heartbeatAt: leaseStartedAt,
          leaseExpiresAt: new Date(leaseStartedAt.getTime() + 120_000),
          deadlineAt: null,
        },
      });
      if (lease.count !== 1) throw new Error('AgentRun 当前状态不允许进入 Act，可能正在执行或已结束');
      this.logger.log('agent.runtime.act.lease_acquired', { agentRunId, planVersion: latestPlan.version });
      context = await this.loadContextForExecution(run);
      const outputs = await this.executor.execute(agentRunId, spec.steps, { mode: 'act', planVersion: latestPlan.version, approved: true, approvedStepNos, confirmation, reuseSucceeded: true, agentContext: context });
      const currentRun = await this.prisma.agentRun.findUnique({ where: { id: agentRunId } });
      if (currentRun?.status === 'cancelled') return currentRun;
      const artifactDrafts = this.buildExecutionArtifacts(String(latestPlan.taskType), outputs, spec.steps);
      this.logger.log('agent.runtime.act.executed', { agentRunId, planVersion: latestPlan.version, outputStepNos: Object.keys(outputs).map(Number), artifactDraftCount: artifactDrafts.length });
      if (artifactDrafts.length) {
        await this.prisma.agentArtifact.createMany({
          data: artifactDrafts.map((artifact) => ({
            agentRunId,
            artifactType: artifact.artifactType,
            title: artifact.title,
            content: artifact.content as Prisma.InputJsonValue,
            status: 'final',
          })),
        });
      }
      const completed = await this.prisma.agentRun.updateMany({
        where: { id: agentRunId, status: 'acting' },
        data: {
          status: 'succeeded',
          output: { outputs } as unknown as Prisma.InputJsonValue,
          currentStepNo: null,
          currentTool: null,
          currentPhase: null,
          leaseExpiresAt: null,
        },
      });
      const updated = await this.findRunOrThrow(agentRunId);
      if (completed.count !== 1) {
        this.logger.warn('agent.runtime.act.late_completion_ignored', { agentRunId, planVersion: latestPlan.version, currentStatus: updated?.status });
        return updated;
      }
      this.logger.log('agent.runtime.act.completed', { agentRunId, planVersion: latestPlan.version, elapsedMs: Date.now() - startedAt, status: updated?.status });
      return updated;
    } catch (error) {
      if (error instanceof AgentRunStateChangedError) {
        this.logger.warn('agent.runtime.act.aborted_after_run_state_change', { agentRunId, planVersion: latestPlan.version, elapsedMs: Date.now() - startedAt, message: error.message, status: error.status });
        return this.findRunOrThrow(agentRunId);
      }
      if (error instanceof AgentCancelledError) {
        this.logger.warn('agent.runtime.act.cancelled', { agentRunId, planVersion: latestPlan.version, elapsedMs: Date.now() - startedAt, message: error.message });
        await this.prisma.agentRun.updateMany({ where: { id: agentRunId, status: { notIn: ['failed', 'succeeded'] } }, data: { status: 'cancelled', error: error.message, currentPhase: null, leaseExpiresAt: null } });
        return this.findRunOrThrow(agentRunId);
      }
      if (error instanceof AgentWaitingReviewError) {
        this.logger.warn('agent.runtime.act.waiting_review', { agentRunId, planVersion: latestPlan.version, elapsedMs: Date.now() - startedAt, message: error.message });
        await this.prisma.agentRun.updateMany({ where: { id: agentRunId, status: 'acting' }, data: { status: 'waiting_review', error: error.message, currentPhase: null, leaseExpiresAt: null } });
        return this.findRunOrThrow(agentRunId);
      }
      if (error instanceof AgentExecutionObservationError) {
        this.logger.warn('agent.runtime.act.observation_created', { agentRunId, planVersion: latestPlan.version, elapsedMs: Date.now() - startedAt, observation: error.observation });
        return this.handleExecutionObservation(agentRunId, run, latestPlan, spec.steps, context ?? await this.loadContextForExecution(run), error);
      }
      await this.prisma.agentRun.updateMany({ where: { id: agentRunId, status: 'acting' }, data: { status: 'failed', error: error instanceof Error ? error.message : String(error), currentPhase: null, leaseExpiresAt: null } });
      this.logger.error('agent.runtime.act.failed', error, { agentRunId, planVersion: latestPlan.version, elapsedMs: Date.now() - startedAt });
      throw error;
    }
  }

  async resumeFromFailedStep(agentRunId: string, approvedStepNos?: number[], confirmation?: { confirmHighRisk?: boolean; confirmedRiskIds?: string[] }) {
    const latestPlan = await this.prisma.agentPlan.findFirst({ where: { agentRunId }, orderBy: { version: 'desc' } });
    if (!latestPlan) throw new Error('缺少可恢复执行的计划');
    const run = await this.prisma.agentRun.findUnique({ where: { id: agentRunId } });
    if (!run) throw new Error(`AgentRun 不存在：${agentRunId}`);
    const failedStep = await this.prisma.agentStep.findFirst({
      where: { agentRunId, planVersion: latestPlan.version, status: 'failed' },
      orderBy: [{ finishedAt: 'desc' }, { createdAt: 'desc' }, { stepNo: 'desc' }],
      select: { stepNo: true, mode: true, toolName: true },
    });
    if (!failedStep) throw new Error('当前 Run 没有可从步骤恢复的失败记录，请重新规划或重新发起任务');
    if (failedStep.mode === 'plan') return this.resumePlanPreviewFromFailedStep(agentRunId, run, latestPlan, failedStep);
    return this.act(agentRunId, approvedStepNos, confirmation);
  }

  private async resumePlanPreviewFromFailedStep(
    agentRunId: string,
    run: { id: string; projectId: string; chapterId?: string | null; goal: string; input: unknown },
    latestPlan: { id: string; version: number; taskType: string; steps: unknown },
    failedStep: { stepNo: number; mode: string; toolName: string | null },
  ) {
    const spec = { steps: latestPlan.steps } as unknown as Pick<AgentPlanSpec, 'steps'>;
    const startedAt = Date.now();
    this.logger.log('agent.runtime.resume_plan_preview.started', { agentRunId, planVersion: latestPlan.version, failedStepNo: failedStep.stepNo, failedTool: failedStep.toolName });
    try {
      const leaseStartedAt = new Date();
      const lease = await this.prisma.agentRun.updateMany({
        where: { id: agentRunId, status: 'failed' },
        data: {
          status: 'planning',
          mode: 'plan',
          error: null,
          currentStepNo: failedStep.stepNo,
          currentTool: failedStep.toolName,
          currentPhase: 'resume_failed_step',
          heartbeatAt: leaseStartedAt,
          leaseExpiresAt: new Date(leaseStartedAt.getTime() + 120_000),
          deadlineAt: null,
        },
      });
      if (lease.count !== 1) throw new AgentRunStateChangedError('AgentRun 当前状态已不允许恢复 Plan 预览', 'changed');

      const context = await this.loadContextForExecution(run);
      const previewOutputs = await this.executor.execute(agentRunId, spec.steps, { mode: 'plan', planVersion: latestPlan.version, approved: false, previewOnly: true, reuseSucceeded: true, agentContext: context });
      const previewArtifacts = this.buildPreviewArtifacts(String(latestPlan.taskType), previewOutputs, spec.steps);
      this.logger.log('agent.runtime.resume_plan_preview.completed_steps', { agentRunId, planVersion: latestPlan.version, failedStepNo: failedStep.stepNo, outputStepNos: Object.keys(previewOutputs).map(Number), previewArtifactCount: previewArtifacts.length });
      if (previewArtifacts.length) {
        await this.prisma.agentArtifact.createMany({
          data: previewArtifacts.map((preview) => ({
            agentRunId,
            artifactType: preview.artifactType,
            title: preview.title,
            content: preview.content as Prisma.InputJsonValue,
            status: 'preview',
          })),
        });
      }

      const completed = await this.prisma.agentRun.updateMany({
        where: { id: agentRunId, status: 'planning' },
        data: {
          status: 'waiting_approval',
          mode: 'plan',
          taskType: String(latestPlan.taskType),
          error: null,
          output: { planId: latestPlan.id, resumedFromFailedStep: { stepNo: failedStep.stepNo, mode: failedStep.mode, tool: failedStep.toolName } } as unknown as Prisma.InputJsonValue,
          currentStepNo: null,
          currentTool: null,
          currentPhase: null,
          leaseExpiresAt: null,
        },
      });
      const updated = await this.findRunOrThrow(agentRunId);
      if (completed.count !== 1) {
        this.logger.warn('agent.runtime.resume_plan_preview.late_completion_ignored', { agentRunId, planVersion: latestPlan.version, currentStatus: updated.status });
      }
      this.logger.log('agent.runtime.resume_plan_preview.completed', { agentRunId, planVersion: latestPlan.version, elapsedMs: Date.now() - startedAt, status: updated.status });
      return updated;
    } catch (error) {
      if (error instanceof AgentCancelledError || error instanceof AgentRunStateChangedError) {
        const current = await this.prisma.agentRun.findUnique({ where: { id: agentRunId } });
        this.logger.warn('agent.runtime.resume_plan_preview.aborted_after_run_state_change', { agentRunId, elapsedMs: Date.now() - startedAt, message: error.message, currentStatus: current?.status });
        return current;
      }
      await this.recordPlannerFailure(agentRunId, error);
      this.logger.error('agent.runtime.resume_plan_preview.failed', error, { agentRunId, planVersion: latestPlan.version, failedStepNo: failedStep.stepNo, elapsedMs: Date.now() - startedAt });
      throw error;
    }
  }

  async replan(agentRunId: string, goal?: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: agentRunId } });
    if (!run) throw new Error(`AgentRun 不存在：${agentRunId}`);

    // 重新规划保留原 Run 和历史 Plan/Step/Artifact，新增 plan version 方便用户回看变化。
    const nextGoal = goal?.trim() || run.goal;
    const latest = await this.prisma.agentPlan.findFirst({ where: { agentRunId }, orderBy: { version: 'desc' } });
    await this.prisma.agentRun.update({ where: { id: agentRunId }, data: { goal: nextGoal, status: 'planning', mode: 'plan', error: null } });

    try {
      const baseRun = { ...run, goal: nextGoal };
      const context = await this.contextBuilder.buildForPlan(baseRun);
      const contextDigest = this.contextBuilder.createDigest(context);
      await this.persistContextSnapshot(agentRunId, run.input, context, contextDigest);
      const plan = await this.planner.createPlan(nextGoal, context);
      const nextVersion = (latest?.version ?? 0) + 1;
      await this.trace.recordDecision(agentRunId, { name: '重新生成 Agent Plan', mode: 'plan', planVersion: nextVersion, input: { goal: nextGoal, replannedFromVersion: latest?.version ?? null, contextDigest }, output: { taskType: plan.taskType, stepCount: plan.steps.length, understanding: plan.understanding, plannerDiagnostics: plan.plannerDiagnostics } });
      const savedPlan = await this.prisma.agentPlan.create({
        data: {
          agentRunId,
          version: nextVersion,
          status: 'waiting_approval',
          taskType: plan.taskType,
          summary: plan.summary,
          assumptions: plan.assumptions as Prisma.InputJsonValue,
          risks: plan.risks as Prisma.InputJsonValue,
          steps: plan.steps as unknown as Prisma.InputJsonValue,
          requiredApprovals: plan.requiredApprovals as unknown as Prisma.InputJsonValue,
        },
      });

      await this.prisma.agentArtifact.create({
        data: { agentRunId, artifactType: 'agent_plan_preview', title: `Agent 执行计划预览 v${savedPlan.version}`, content: plan as unknown as Prisma.InputJsonValue, status: 'preview' },
      });

      const previewOutputs = await this.executor.execute(agentRunId, plan.steps, { mode: 'plan', planVersion: savedPlan.version, approved: false, previewOnly: true, agentContext: context });
      const previewArtifacts = this.buildPreviewArtifacts(plan.taskType, previewOutputs, plan.steps);
      if (previewArtifacts.length) {
        await this.prisma.agentArtifact.createMany({
          data: previewArtifacts.map((preview) => ({
            agentRunId,
            artifactType: preview.artifactType,
            title: `${preview.title} v${savedPlan.version}`,
            content: preview.content as Prisma.InputJsonValue,
            status: 'preview',
          })),
        });
      }

      return this.prisma.agentRun.update({ where: { id: agentRunId }, data: { status: 'waiting_approval', taskType: plan.taskType, output: { planId: savedPlan.id, replannedFromVersion: latest?.version ?? null } } });
    } catch (error) {
      await this.recordPlannerFailure(agentRunId, error);
      throw error;
    }
  }

  /**
   * 世界观预览勾选后的专用局部重规划：只 patch persist_worldbuilding.selectedTitles，
   * 不重新请求 LLM，避免用户明确选择在自然语言 replan 中丢失或被扩大写入范围。
   */
  async replanImportTargetRegeneration(agentRunId: string, assetType: ProjectImportAssetType, message?: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: agentRunId } });
    if (!run) throw new Error(`AgentRun 不存在：${agentRunId}`);
    const latest = await this.prisma.agentPlan.findFirst({ where: { agentRunId }, orderBy: { version: 'desc' } });
    if (!latest) throw new Error('Missing plan for import target regeneration');
    if (latest.taskType !== 'project_import_preview') throw new Error('Import target regeneration only supports project_import_preview plans');

    const previousSteps = Array.isArray(latest.steps) ? latest.steps as unknown as AgentPlanSpec['steps'] : [];
    const history = await this.loadImportRegenerationHistory(agentRunId, latest.version, previousSteps);
    const requestedAssetTypes = this.resolveImportRegenerationAssetScope(previousSteps, history.unifiedPreview, history.targetPreviewByAssetType);
    if (!requestedAssetTypes.includes(assetType)) {
      throw new Error(`Cannot regenerate ${assetType}; it is outside the current import target scope`);
    }

    const steps = this.buildImportTargetRegenerationSteps({
      assetType,
      requestedAssetTypes,
      previousSteps,
      targetPreviewByAssetType: history.targetPreviewByAssetType,
      unifiedPreview: history.unifiedPreview,
      analysis: history.analysis,
      importBrief: history.importBrief,
      instruction: message?.trim() || run.goal,
      projectContext: this.projectContextFromRunInput(run.input),
    });
    const nextVersion = latest.version + 1;
    const summary = `Regenerate ${PROJECT_IMPORT_ASSET_LABELS[assetType]} import preview only; existing selected targets are preserved.`;
    const plan: AgentPlanSpec = {
      schemaVersion: 2,
      understanding: summary,
      userGoal: message?.trim() || run.goal,
      taskType: 'project_import_preview',
      confidence: 1,
      summary,
      assumptions: [
        'Reuses the latest successful source analysis and import brief as literal inputs.',
        'Only the requested import target preview tool is rerun.',
      ],
      risks: [
        'persist_project_assets remains approval-gated and reads the merged preview.',
      ],
      steps,
      requiredApprovals: this.requiredApprovalsForSteps(steps),
      riskReview: {
        riskLevel: 'medium',
        reasons: ['The final persist_project_assets step can write project assets after approval.'],
        requiresApproval: true,
        approvalMessage: 'Confirm before writing regenerated import assets.',
      },
      userVisiblePlan: {
        summary,
        bullets: [
          `Regenerate ${PROJECT_IMPORT_ASSET_LABELS[assetType]} preview.`,
          'Merge it with the unchanged previews for the other selected targets.',
          'Validate and wait for approval before persisting.',
        ],
        hiddenTechnicalSteps: true,
      },
      plannerDiagnostics: {
        source: 'runtime_patch',
        patchType: 'import_target_regeneration',
        assetType,
        requestedAssetTypes,
        replannedFromVersion: latest.version,
      },
    };

    await this.prisma.agentRun.update({ where: { id: agentRunId }, data: { status: 'planning', mode: 'plan', error: null } });
    const savedPlan = await this.prisma.agentPlan.create({
      data: {
        agentRunId,
        version: nextVersion,
        status: 'waiting_approval',
        taskType: plan.taskType,
        summary: plan.summary,
        assumptions: plan.assumptions as Prisma.InputJsonValue,
        risks: plan.risks as Prisma.InputJsonValue,
        steps: plan.steps as unknown as Prisma.InputJsonValue,
        requiredApprovals: plan.requiredApprovals as unknown as Prisma.InputJsonValue,
      },
    });

    await this.prisma.agentArtifact.create({
      data: { agentRunId, artifactType: 'agent_plan_preview', title: `Agent 执行计划预览 v${savedPlan.version}（重新生成 ${PROJECT_IMPORT_ASSET_LABELS[assetType]}）`, content: plan as unknown as Prisma.InputJsonValue, status: 'preview' },
    });
    await this.trace.recordDecision(agentRunId, { name: 'Import target regeneration plan', mode: 'plan', planVersion: nextVersion, input: { assetType, message, requestedAssetTypes }, output: { stepCount: steps.length, requiredApprovals: plan.requiredApprovals } });

    const previewOutputs = await this.executor.execute(agentRunId, steps, { mode: 'plan', planVersion: nextVersion, approved: false, previewOnly: true });
    const previewArtifacts = this.buildPreviewArtifacts(plan.taskType, previewOutputs, steps);
    if (previewArtifacts.length) {
      await this.prisma.agentArtifact.createMany({
        data: previewArtifacts.map((preview) => ({
          agentRunId,
          artifactType: preview.artifactType,
          title: `${preview.title} v${savedPlan.version}`,
          content: preview.content as Prisma.InputJsonValue,
          status: 'preview',
        })),
      });
    }

    return this.prisma.agentRun.update({
      where: { id: agentRunId },
      data: {
        status: 'waiting_approval',
        taskType: plan.taskType,
        error: null,
        output: { planId: savedPlan.id, replannedFromVersion: latest.version, importTargetRegeneration: { assetType } } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async replanWorldbuildingSelection(agentRunId: string, selectedTitles: string[], message?: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: agentRunId } });
    if (!run) throw new Error(`AgentRun 不存在：${agentRunId}`);
    const latest = await this.prisma.agentPlan.findFirst({ where: { agentRunId }, orderBy: { version: 'desc' } });
    if (!latest) throw new Error('缺少可局部重规划的计划');
    if (latest.taskType !== 'worldbuilding_expand') throw new Error('只有世界观扩展计划支持 selectedTitles 局部重规划');

    const steps = Array.isArray(latest.steps) ? latest.steps as unknown as AgentPlanSpec['steps'] : [];
    const persistStep = steps.find((step) => step.tool === 'persist_worldbuilding');
    if (!persistStep) throw new Error('当前计划缺少 persist_worldbuilding 步骤，无法应用 selectedTitles');

    const nextVersion = latest.version + 1;
    const patchedSteps = steps.map((step) => step.stepNo === persistStep.stepNo ? { ...step, args: { ...step.args, selectedTitles } } : step);
    const summary = `${latest.summary}（已限定世界观写入条目：${selectedTitles.join('、')}）`;
    const savedPlan = await this.prisma.agentPlan.create({
      data: {
        agentRunId,
        version: nextVersion,
        status: 'waiting_approval',
        taskType: String(latest.taskType),
        summary,
        assumptions: latest.assumptions as Prisma.InputJsonValue,
        risks: latest.risks as Prisma.InputJsonValue,
        steps: patchedSteps as unknown as Prisma.InputJsonValue,
        requiredApprovals: this.requiredApprovalsForSteps(patchedSteps) as Prisma.InputJsonValue,
      },
    });

    const previewContent = {
      schemaVersion: 2,
      taskType: latest.taskType,
      summary,
      assumptions: latest.assumptions,
      risks: latest.risks,
      steps: patchedSteps,
      requiredApprovals: this.requiredApprovalsForSteps(patchedSteps),
      userVisiblePlan: {
        summary: `将仅写入已选择的 ${selectedTitles.length} 个世界观设定条目，仍需审批后执行。`,
        bullets: selectedTitles.map((title) => `写入：${title}`),
        hiddenTechnicalSteps: true,
      },
      plannerDiagnostics: { source: 'runtime_patch', patchType: 'worldbuilding_selected_titles', selectedTitles, message },
    };

    await this.prisma.agentArtifact.create({
      data: { agentRunId, artifactType: 'agent_plan_preview', title: `Agent 执行计划预览 v${savedPlan.version}（已选择世界观条目）`, content: previewContent as unknown as Prisma.InputJsonValue, status: 'preview' },
    });
    await this.trace.recordDecision(agentRunId, { name: '世界观条目选择局部重规划', mode: 'plan', planVersion: nextVersion, input: { selectedTitles, message }, output: { stepCount: patchedSteps.length, patchedStepNo: persistStep.stepNo } });

    return this.prisma.agentRun.update({ where: { id: agentRunId }, data: { status: 'waiting_approval', taskType: String(latest.taskType), error: null, output: { planId: savedPlan.id, replannedFromVersion: latest.version, worldbuildingSelection: { selectedTitles } } as unknown as Prisma.InputJsonValue } });
  }

  /**
   * 澄清卡片候选选择专用重规划：把用户显式选择写入 Run.input.context，
   * 再生成新的可审批计划；不执行任何 Tool，避免候选选择绕过审批边界。
   */
  async answerClarificationChoice(agentRunId: string, choice: { id?: string; label?: string; payload?: unknown }, message?: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: agentRunId } });
    if (!run) throw new Error(`AgentRun 不存在：${agentRunId}`);

    const normalizedChoice = {
      id: this.stringValue(choice.id),
      label: this.stringValue(choice.label),
      payload: this.toJsonCompatible(choice.payload),
    };
    const input = this.asRecord(run.input);
    const context = this.asRecord(input.context);
    const clarificationHistory = Array.isArray(input.clarificationChoices) ? input.clarificationChoices : [];
    const clarificationState = this.asRecord(input.clarificationState);
    const stateHistory = Array.isArray(clarificationState.history) ? clarificationState.history : [];
    const prompt = await this.loadLatestClarificationPrompt(agentRunId);
    const answeredAt = new Date().toISOString();
    const latestChoice = { ...normalizedChoice, message: this.stringValue(message), answeredAt };
    const historyEntry = {
      roundNo: stateHistory.length + 1,
      question: prompt.question,
      choices: prompt.choices,
      selectedChoice: normalizedChoice,
      message: this.stringValue(message),
      answeredAt,
      sourceObservation: prompt.sourceObservation,
    };

    // 结构化选择和完整澄清轮次同时进入 input，Planner 能读取最新选择，前端也能回放多轮澄清历史。
    await this.prisma.agentRun.update({
      where: { id: agentRunId },
      data: {
        input: {
          ...input,
          context: { ...context, clarificationChoice: normalizedChoice },
          clarificationState: { latestChoice, history: [...stateHistory, historyEntry] },
          clarificationChoices: [...clarificationHistory, latestChoice],
        } as Prisma.InputJsonValue,
      },
    });

    const nextGoal = [
      run.goal,
      `用户已通过澄清选择专用 API 选择：${normalizedChoice.label ?? normalizedChoice.id ?? '未命名候选'}。`,
      normalizedChoice.payload !== null ? `结构化候选 payload：${JSON.stringify(normalizedChoice.payload)}` : '',
      message?.trim() ? `用户补充说明：${message.trim()}` : '',
      '请把该选择作为用户显式澄清结果重新生成可审批计划；不得直接执行写入或绕过审批。',
    ].filter(Boolean).join('\n');

    await this.trace.recordDecision(agentRunId, { name: '澄清候选选择重新规划', mode: 'plan', input: { choice: normalizedChoice, message, question: prompt.question }, output: { requiresApproval: true, roundNo: historyEntry.roundNo } });
    return this.replan(agentRunId, nextGoal);
  }

  /**
   * 读取最近一次 ask_user Observation，作为澄清历史的“问题与候选”来源。
   * 该信息只用于审计/上下文回放，不触发任何 Tool，也不替用户自动选择候选。
   */
  private async loadLatestClarificationPrompt(agentRunId: string) {
    const artifact = await this.prisma.agentArtifact.findFirst({
      where: { agentRunId, artifactType: 'agent_observation' },
      orderBy: { createdAt: 'desc' },
      select: { content: true, sourceStepNo: true },
    });
    const content = this.asRecord(artifact?.content);
    const patch = this.asRecord(content.replanPatch);
    const observation = this.asRecord(content.observation);
    return {
      question: this.stringValue(patch.questionForUser),
      choices: Array.isArray(patch.choices) ? this.toJsonCompatible(patch.choices) : [],
      sourceObservation: {
        stepNo: typeof artifact?.sourceStepNo === 'number' ? artifact.sourceStepNo : this.numberValue(observation.stepNo),
        tool: this.stringValue(observation.tool),
        errorCode: this.stringValue(this.asRecord(observation.error).code),
      },
    };
  }

  /** Planner 失败时同时写入结构化诊断 Artifact，方便前端直接回显失败阶段和修复建议。 */
  private async recordPlannerFailure(agentRunId: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostics = error instanceof AgentPlannerFailedError ? error.diagnostics : { failures: [{ stage: 'unknown', message }] };
    await this.prisma.agentArtifact.create({
      data: {
        agentRunId,
        artifactType: 'planner_diagnostics',
        title: 'Planner 失败诊断',
        content: { message, diagnostics } as unknown as Prisma.InputJsonValue,
        status: 'final',
      },
    });
    await this.prisma.agentRun.updateMany({
      where: { id: agentRunId, status: { in: ['planning', 'acting'] } },
      data: { status: 'failed', error: message, output: { plannerDiagnostics: diagnostics } as unknown as Prisma.InputJsonValue, currentPhase: null, leaseExpiresAt: null },
    });
  }

  /**
   * 执行失败后生成 Observation/Replan 诊断。可安全修复时创建新 Plan version 并回到审批态，
   * 不在失败栈内继续执行新计划，避免自动绕过用户对写入步骤的审批。
   */
  private async handleExecutionObservation(agentRunId: string, run: { goal: string }, latestPlan: { version: number; taskType: string; summary: string; assumptions: unknown; risks: unknown; requiredApprovals: unknown }, steps: AgentPlanSpec['steps'], context: AgentContextV2, error: AgentExecutionObservationError) {
    const observation = error.observation;
    const replanStats = await this.loadReplanAttemptStats(agentRunId, observation);
    const patch = await this.replanner.createPatchWithExperimentalFallback({ userGoal: run.goal, currentPlanSteps: steps, failedObservation: observation, agentContext: context, replanStats });
    await this.prisma.agentArtifact.create({
      data: { agentRunId, artifactType: 'agent_observation', title: `执行失败观察：步骤 ${observation.stepNo}`, content: { observation, replanPatch: patch, replanStats } as unknown as Prisma.InputJsonValue, status: 'final', sourceStepNo: observation.stepNo },
    });

    if (patch.action === 'patch_plan') {
      const patchedSteps = this.applyReplanPatch(steps, observation.stepNo, patch);
      const nextVersion = latestPlan.version + 1;
      const savedPlan = await this.prisma.agentPlan.create({
        data: {
          agentRunId,
          version: nextVersion,
          status: 'waiting_approval',
          taskType: String(latestPlan.taskType),
          summary: `${latestPlan.summary}（已根据失败观察自动修复计划）`,
          assumptions: latestPlan.assumptions as Prisma.InputJsonValue,
          risks: latestPlan.risks as Prisma.InputJsonValue,
          steps: patchedSteps as unknown as Prisma.InputJsonValue,
          requiredApprovals: this.requiredApprovalsForSteps(patchedSteps) as Prisma.InputJsonValue,
        },
      });
      await this.trace.recordDecision(agentRunId, { name: 'Observation/Replan 自动修复计划', mode: 'act', planVersion: nextVersion, input: { observation }, output: { patch, stepCount: patchedSteps.length } });
      await this.prisma.agentRun.updateMany({
        where: { id: agentRunId, status: 'acting' },
        data: { status: 'waiting_approval', error: null, output: { planId: savedPlan.id, latestObservation: observation, replanPatch: patch, replanStats } as unknown as Prisma.InputJsonValue, currentPhase: null, leaseExpiresAt: null },
      });
      return this.findRunOrThrow(agentRunId);
    }

    const status = patch.action === 'ask_user' ? 'waiting_review' : 'failed';
    await this.trace.recordDecision(agentRunId, { name: 'Observation/Replan 诊断', mode: 'act', planVersion: latestPlan.version, status: patch.action === 'ask_user' ? 'succeeded' : 'failed', input: { observation }, output: { patch }, error: patch.action === 'fail_with_reason' ? patch.reason : undefined });
    await this.prisma.agentRun.updateMany({
      where: { id: agentRunId, status: 'acting' },
      data: { status, error: patch.questionForUser ?? patch.reason, output: { latestObservation: observation, replanPatch: patch, replanStats } as unknown as Prisma.InputJsonValue, currentPhase: null, leaseExpiresAt: null },
    });
    return this.findRunOrThrow(agentRunId);
  }

  private async findRunOrThrow(agentRunId: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: agentRunId } });
    if (!run) throw new Error(`AgentRun 不存在：${agentRunId}`);
    return run;
  }

  /** 读取历史 Observation Artifact，计算自动 Replan 的总轮数和同类错误轮数。 */
  private async loadReplanAttemptStats(agentRunId: string, observation: AgentObservation): Promise<ReplanAttemptStats> {
    const artifacts = await this.prisma.agentArtifact.findMany({
      where: { agentRunId, artifactType: 'agent_observation' },
      orderBy: { createdAt: 'asc' },
      select: { content: true },
    });
    const patchArtifacts = artifacts
      .map((artifact) => this.asRecord(artifact.content))
      .filter((content) => this.asRecord(content.replanPatch).action === 'patch_plan');
    const sameStepErrorPatchCount = patchArtifacts.filter((content) => {
      const previous = this.asRecord(content.observation) as unknown as Partial<AgentObservation>;
      return previous.stepNo === observation.stepNo && previous.tool === observation.tool && this.asRecord(previous.error).code === observation.error.code;
    }).length;
    return { previousAutoPatchCount: patchArtifacts.length, sameStepErrorPatchCount };
  }

  private applyReplanPatch(steps: AgentPlanSpec['steps'], failedStepNo: number, patch: ReplanPatch): AgentPlanSpec['steps'] {
    const insertions = patch.insertStepsBeforeFailedStep ?? [];
    if (!insertions.length) {
      return steps.map((step) => step.stepNo === failedStepNo ? { ...step, args: { ...step.args, ...(patch.replaceFailedStepArgs ?? {}) } } : step);
    }
    const shifted = steps.map((step) => {
      const nextStepNo = step.stepNo >= failedStepNo ? step.stepNo + insertions.length : step.stepNo;
      const args = this.rewriteNumericStepReferences(step.args, failedStepNo, insertions.length) as Record<string, unknown>;
      const runIf = step.runIf ? { ...step.runIf, ref: this.rewriteNumericStepReferences(step.runIf.ref, failedStepNo, insertions.length) as string } : undefined;
      return { ...step, stepNo: nextStepNo, args, ...(runIf ? { runIf } : {}) };
    });
    const repairedFailedStepNo = failedStepNo + insertions.length;
    const patched = shifted.map((step) => step.stepNo === repairedFailedStepNo ? { ...step, args: { ...step.args, ...(patch.replaceFailedStepArgs ?? {}) } } : step);
    const cleanedInsertions = insertions.map((step, index) => ({ ...step, stepNo: failedStepNo + index, args: this.removeUndefinedArgs(step.args) }));
    return [...patched.filter((step) => step.stepNo < failedStepNo), ...cleanedInsertions, ...patched.filter((step) => step.stepNo >= failedStepNo)].sort((a, b) => a.stepNo - b.stepNo);
  }

  private rewriteNumericStepReferences(value: unknown, fromStepNo: number, offset: number): unknown {
    if (typeof value === 'string') return value.replace(/{{steps\.(\d+)\.output/g, (_match, rawStepNo) => `{{steps.${Number(rawStepNo) >= fromStepNo ? Number(rawStepNo) + offset : Number(rawStepNo)}.output`);
    if (Array.isArray(value)) return value.map((item) => this.rewriteNumericStepReferences(item, fromStepNo, offset));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.rewriteNumericStepReferences(item, fromStepNo, offset)]));
    return value;
  }

  private removeUndefinedArgs(args: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
  }

  private async loadImportRegenerationHistory(agentRunId: string, planVersion: number, previousSteps: AgentPlanSpec['steps']) {
    const records = await this.prisma.agentStep.findMany({
      where: { agentRunId, planVersion, mode: 'plan', status: 'succeeded' },
      orderBy: { stepNo: 'asc' },
      select: { stepNo: true, toolName: true, input: true, output: true },
    });
    const outputs: Record<number, unknown> = {};
    const targetPreviewByAssetType = new Map<ProjectImportAssetType, unknown>();
    let analysis: unknown;
    let importBrief: unknown;
    let unifiedPreview: ProjectImportPreviewArtifact | undefined;

    for (const record of records) {
      if (record.output !== null && record.output !== undefined) outputs[record.stepNo] = record.output;
      const input = this.asRecord(record.input);
      if (analysis === undefined && input.analysis !== undefined) analysis = input.analysis;
      if (importBrief === undefined && input.importBrief !== undefined) importBrief = input.importBrief;
      if (record.toolName === 'analyze_source_text') analysis = record.output;
      if (record.toolName === 'build_import_brief') importBrief = record.output;
      const assetType = record.toolName ? PROJECT_IMPORT_TARGET_TOOL_ASSET_TYPE[record.toolName] : undefined;
      if (assetType && record.output !== null && record.output !== undefined) targetPreviewByAssetType.set(assetType, record.output);
      if (record.toolName === 'merge_import_previews' && record.output) unifiedPreview = record.output as ProjectImportPreviewArtifact;
      if (!unifiedPreview && record.toolName === 'build_import_preview' && record.output) unifiedPreview = record.output as ProjectImportPreviewArtifact;
    }

    unifiedPreview ??= this.buildProjectImportPreviewFromTargetOutputs(outputs, previousSteps);
    if (analysis === undefined) throw new Error('Missing historical analyze_source_text output for import target regeneration');
    return { analysis, importBrief, unifiedPreview, targetPreviewByAssetType };
  }

  private resolveImportRegenerationAssetScope(steps: AgentPlanSpec['steps'], unifiedPreview: ProjectImportPreviewArtifact | undefined, targetPreviewByAssetType: Map<ProjectImportAssetType, unknown>): ProjectImportAssetType[] {
    const planScope = this.requestedImportAssetTypesFromPlan(steps);
    if (planScope.length) return planScope;
    const previewScope = this.normalizeProjectImportAssetTypes(this.asRecord(unifiedPreview).requestedAssetTypes);
    if (previewScope.length) return previewScope;
    const targetScope = this.uniqueProjectImportAssetTypes([...targetPreviewByAssetType.keys()]);
    if (targetScope.length) return targetScope;
    return this.inferImportAssetTypesFromPreview(unifiedPreview);
  }

  private buildImportTargetRegenerationSteps(input: {
    assetType: ProjectImportAssetType;
    requestedAssetTypes: ProjectImportAssetType[];
    previousSteps: AgentPlanSpec['steps'];
    targetPreviewByAssetType: Map<ProjectImportAssetType, unknown>;
    unifiedPreview?: ProjectImportPreviewArtifact;
    analysis: unknown;
    importBrief?: unknown;
    instruction: string;
    projectContext?: unknown;
  }): AgentPlanSpec['steps'] {
    const targetTool = PROJECT_IMPORT_TARGET_TOOL_BY_ASSET_TYPE[input.assetType];
    const targetStep: AgentPlanSpec['steps'][number] = {
      id: targetTool,
      stepNo: 1,
      name: `Regenerate ${PROJECT_IMPORT_ASSET_LABELS[input.assetType]} import preview`,
      purpose: `Only rerun ${targetTool} for the selected import target.`,
      tool: targetTool,
      mode: 'act',
      requiresApproval: false,
      args: this.removeUndefinedArgs({
        analysis: input.analysis,
        importBrief: input.importBrief,
        instruction: input.instruction,
        projectContext: input.projectContext,
      }),
    };

    const mergeArgs: Record<string, unknown> = { requestedAssetTypes: input.requestedAssetTypes };
    for (const assetType of input.requestedAssetTypes) {
      const mergeArg = MERGE_PREVIEW_ARG_BY_ASSET_TYPE[assetType];
      mergeArgs[mergeArg] = assetType === input.assetType
        ? '{{steps.1.output}}'
        : this.previousPreviewForAsset(assetType, input.targetPreviewByAssetType, input.unifiedPreview);
    }

    const steps: AgentPlanSpec['steps'] = [
      targetStep,
      {
        id: 'merge_import_previews',
        stepNo: 2,
        name: 'Merge regenerated import preview',
        purpose: 'Replace only the regenerated target preview and preserve literal old previews for the other selected targets.',
        tool: 'merge_import_previews',
        mode: 'act',
        requiresApproval: false,
        args: mergeArgs,
      },
    ];

    if (input.previousSteps.some((step) => step.tool === CROSS_TARGET_CONSISTENCY_CHECK_TOOL)) {
      steps.push({
        id: CROSS_TARGET_CONSISTENCY_CHECK_TOOL,
        stepNo: steps.length + 1,
        name: 'Check cross-target consistency',
        purpose: 'Validate consistency after replacing one target preview.',
        tool: CROSS_TARGET_CONSISTENCY_CHECK_TOOL,
        mode: 'act',
        requiresApproval: false,
        args: { preview: '{{steps.2.output}}', instruction: input.instruction },
      });
    }

    steps.push(
      {
        id: 'validate_imported_assets',
        stepNo: steps.length + 1,
        name: 'Validate regenerated import preview',
        purpose: 'Validate the merged import preview before any write step.',
        tool: 'validate_imported_assets',
        mode: 'act',
        requiresApproval: false,
        args: { preview: '{{steps.2.output}}' },
      },
      {
        id: 'persist_project_assets',
        stepNo: steps.length + 2,
        name: 'Persist regenerated import assets after approval',
        purpose: 'Write the merged preview only after explicit user approval.',
        tool: 'persist_project_assets',
        mode: 'act',
        requiresApproval: true,
        args: { preview: '{{steps.2.output}}' },
      },
    );
    return steps;
  }

  private previousPreviewForAsset(assetType: ProjectImportAssetType, targetPreviewByAssetType: Map<ProjectImportAssetType, unknown>, unifiedPreview: ProjectImportPreviewArtifact | undefined) {
    const targetPreview = targetPreviewByAssetType.get(assetType);
    if (targetPreview !== undefined) return targetPreview;
    const sliced = this.sliceUnifiedPreviewForAsset(assetType, unifiedPreview);
    if (sliced !== undefined) return sliced;
    throw new Error(`Missing historical ${assetType} preview for import target regeneration`);
  }

  private sliceUnifiedPreviewForAsset(assetType: ProjectImportAssetType, unifiedPreview: ProjectImportPreviewArtifact | undefined): unknown {
    const preview = this.asRecord(unifiedPreview);
    if (!Object.keys(preview).length) return undefined;
    const risks = Array.isArray(preview.risks) ? preview.risks : [];
    if (assetType === 'projectProfile') return { projectProfile: this.projectProfileWithoutOutline(preview.projectProfile), risks };
    if (assetType === 'outline') {
      const profile = this.asRecord(preview.projectProfile);
      return { projectProfile: this.removeUndefinedArgs({ outline: profile.outline }), volumes: preview.volumes ?? [], chapters: preview.chapters ?? [], risks };
    }
    if (assetType === 'characters') return { characters: preview.characters ?? [], risks };
    if (assetType === 'worldbuilding') return { lorebookEntries: preview.lorebookEntries ?? [], risks };
    if (assetType === 'writingRules') return { writingRules: preview.writingRules ?? [], risks };
    return undefined;
  }

  private requestedImportAssetTypesFromPlan(steps: AgentPlanSpec['steps']) {
    for (const step of steps) {
      if (step.tool === 'merge_import_previews' || step.tool === 'build_import_preview') {
        const explicit = this.normalizeProjectImportAssetTypes(this.asRecord(step.args).requestedAssetTypes);
        if (explicit.length) return explicit;
      }
    }
    return this.uniqueProjectImportAssetTypes(steps.map((step) => PROJECT_IMPORT_TARGET_TOOL_ASSET_TYPE[step.tool]).filter((item): item is ProjectImportAssetType => Boolean(item)));
  }

  private inferImportAssetTypesFromPreview(preview: ProjectImportPreviewArtifact | undefined) {
    const record = this.asRecord(preview);
    const profile = this.asRecord(record.projectProfile);
    const inferred: ProjectImportAssetType[] = [];
    if (['title', 'genre', 'theme', 'tone', 'logline', 'synopsis'].some((key) => profile[key] !== undefined)) inferred.push('projectProfile');
    if (profile.outline !== undefined || (Array.isArray(record.volumes) && record.volumes.length) || (Array.isArray(record.chapters) && record.chapters.length)) inferred.push('outline');
    if (Array.isArray(record.characters) && record.characters.length) inferred.push('characters');
    if (Array.isArray(record.lorebookEntries) && record.lorebookEntries.length) inferred.push('worldbuilding');
    if (Array.isArray(record.writingRules) && record.writingRules.length) inferred.push('writingRules');
    return this.uniqueProjectImportAssetTypes(inferred);
  }

  private normalizeProjectImportAssetTypes(value: unknown) {
    if (!Array.isArray(value)) return [];
    return this.uniqueProjectImportAssetTypes(value.filter((item): item is ProjectImportAssetType => typeof item === 'string' && PROJECT_IMPORT_ASSET_TYPES.includes(item as ProjectImportAssetType)));
  }

  private uniqueProjectImportAssetTypes(value: ProjectImportAssetType[]) {
    const selected = new Set(value);
    return PROJECT_IMPORT_ASSET_TYPES.filter((assetType) => selected.has(assetType));
  }

  private projectContextFromRunInput(input: unknown) {
    const contextSnapshot = this.asRecord(this.asRecord(input).contextSnapshot);
    const project = this.asRecord(contextSnapshot.project);
    return Object.keys(project).length ? project : undefined;
  }

  private requiredApprovalsForSteps(steps: AgentPlanSpec['steps']) {
    const approvalSteps = steps.filter((step) => step.requiresApproval);
    return approvalSteps.length ? [{ approvalType: 'plan', target: { stepNos: approvalSteps.map((step) => step.stepNo), tools: approvalSteps.map((step) => step.tool) } }] : [];
  }

  /** 将 AgentContext V2 的摘要和裁剪快照写回 Run.input，方便审计回放和 Act 阶段变量解析。 */
  private async persistContextSnapshot(agentRunId: string, input: unknown, context: AgentContextV2, digest: string) {
    const base = this.asRecord(input);
    const contextSnapshot = this.compactContextSnapshot(context);
    await this.prisma.agentRun.update({ where: { id: agentRunId }, data: { input: { ...base, contextSnapshotDigest: digest, contextSnapshot } as unknown as Prisma.InputJsonValue } });
  }

  private async loadContextForExecution(run: { id: string; projectId: string; chapterId?: string | null; goal: string; input: unknown }) {
    const input = this.asRecord(run.input);
    const snapshot = input.contextSnapshot;
    if (snapshot && typeof snapshot === 'object') return snapshot as unknown as AgentContextV2;
    return this.contextBuilder.buildForPlan(run as { id: string; projectId: string; chapterId?: string | null; goal: string; input: Prisma.JsonValue | null });
  }

  private compactContextSnapshot(context: AgentContextV2) {
    return {
      schemaVersion: context.schemaVersion,
      userMessage: context.userMessage,
      runtime: context.runtime,
      session: context.session,
      project: context.project,
      currentChapter: context.currentChapter,
      attachments: context.attachments,
      constraints: context.constraints,
      // Tool Manifest 已在 Plan Artifact 中保存；快照只保留名称，避免 Run.input 过大。
      availableTools: context.availableTools.map((tool) => ({ name: tool.name, riskLevel: tool.riskLevel, requiresApproval: tool.requiresApproval })),
    };
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  /** 读取非空字符串字段；无副作用，用于把外部 DTO/JSON 安全投影为可选值。 */
  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  /** 读取有限数字字段；无副作用，用于 Observation/Artifact 元数据归一化。 */
  private numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  /** 把未知值转换成 Prisma Json 可接受的结构；无法序列化时退化为字符串，不抛错。 */
  private toJsonCompatible(value: unknown): unknown {
    if (value === undefined) return null;
    try {
      return JSON.parse(JSON.stringify(value)) as unknown;
    } catch {
      return String(value);
    }
  }

  /** Plan 阶段执行只读预览步骤后，把可展示内容提前提升为 Artifact。 */
  private buildPreviewArtifacts(taskType: string, outputs: Record<number, unknown>, steps: Pick<AgentPlanSpec, 'steps'>['steps'] = []): AgentArtifactDraft[] {
    if (taskType === 'outline_design') {
      const preview = this.latestOutputByTools(outputs, steps, ['merge_chapter_outline_batch_previews', 'merge_chapter_outline_previews', 'generate_outline_preview', 'generate_volume_outline_preview']);
      const storyUnitsPreview = this.latestOutputByTools(outputs, steps, ['generate_story_units_preview']);
      const validation = this.latestOutputByTools(outputs, steps, ['validate_outline']);
      const inspectContext = this.latestOutputByTools(outputs, steps, ['inspect_project_context']);
      const volumeCharacterCandidatesPreview = this.buildVolumeCharacterCandidatesPreview(preview, inspectContext);
      return [
        ...(preview ? [this.buildOutlinePreviewArtifact(preview, outputs, steps)] : []),
        ...(storyUnitsPreview ? [{ artifactType: 'story_units_preview', title: '单元故事计划预览', content: storyUnitsPreview }] : []),
        ...(volumeCharacterCandidatesPreview ? [volumeCharacterCandidatesPreview] : []),
        ...(validation ? [{ artifactType: 'outline_validation_report', title: '大纲校验报告', content: validation }] : []),
        ...this.buildTimelineArtifacts(outputs, steps),
      ];
    }

    if (taskType === 'timeline_plan') {
      return this.buildTimelineArtifacts(outputs, steps);
    }

    if (taskType === 'project_import_preview') {
      const preview = (this.latestOutputByTools(outputs, steps, ['merge_import_previews', 'build_import_preview']) as ProjectImportPreviewArtifact | undefined)
        ?? this.buildProjectImportPreviewFromTargetOutputs(outputs, steps);
      const validation = this.latestOutputByTools(outputs, steps, ['validate_imported_assets']);
      return this.buildProjectImportArtifacts(preview, validation);
    }

    if (taskType === 'chapter_write' || taskType === 'chapter_polish') {
      return outputs[2] ? [{ artifactType: 'chapter_context_preview', title: '章节上下文与写入预览', content: outputs[2] }] : [];
    }

    if (taskType === 'chapter_passage_revision' || taskType === 'passage_revision') {
      const preview = this.latestOutputByTools(outputs, steps, ['revise_chapter_passage_preview']);
      return preview ? [{ artifactType: 'chapter_passage_revision_preview', title: '章节选区局部修订预览', content: preview }] : [];
    }

    if (taskType === 'story_bible_expand') {
      const preview = this.latestOutputByTools(outputs, steps, ['generate_story_bible_preview']);
      const validation = this.latestOutputByTools(outputs, steps, ['validate_story_bible']);
      return [
        ...(preview ? [{ artifactType: 'story_bible_preview', title: 'Story Bible 扩展预览', content: preview }] : []),
        ...(validation ? [{ artifactType: 'story_bible_validation_report', title: 'Story Bible 校验与写入前 Diff', content: validation }] : []),
      ];
    }

    if (taskType === 'scene_card_planning') {
      const list = this.latestOutputByTools(outputs, steps, ['list_scene_cards']);
      const preview = this.latestOutputByTools(outputs, steps, ['generate_scene_cards_preview']);
      const validation = this.latestOutputByTools(outputs, steps, ['validate_scene_cards']);
      return [
        ...(list ? [{ artifactType: 'scene_cards_list', title: 'SceneCard List', content: list }] : []),
        ...(preview ? [{ artifactType: 'scene_cards_preview', title: 'SceneCard Preview', content: preview }] : []),
        ...(validation ? [{ artifactType: 'scene_cards_validation_report', title: 'SceneCard Validation Report', content: validation }] : []),
      ];
    }

    if (taskType === 'chapter_craft_brief' || taskType === 'chapter_progress_card') {
      const preview = this.latestOutputByTools(outputs, steps, ['generate_chapter_craft_brief_preview']);
      const validation = this.latestOutputByTools(outputs, steps, ['validate_chapter_craft_brief']);
      return [
        ...(preview ? [{ artifactType: 'chapter_craft_brief_preview', title: '章节推进卡预览', content: preview }] : []),
        ...(validation ? [{ artifactType: 'chapter_craft_brief_validation_report', title: '章节推进卡校验报告', content: validation }] : []),
        ...this.buildTimelineArtifacts(outputs, steps),
      ];
    }

    if (taskType === 'continuity_check') {
      const preview = this.latestOutputByTools(outputs, steps, ['generate_continuity_preview']);
      const validation = this.latestOutputByTools(outputs, steps, ['validate_continuity_changes']);
      return [
        ...(preview ? [{ artifactType: 'continuity_preview', title: '关系/时间线变更预览', content: preview }] : []),
        ...(validation ? [{ artifactType: 'continuity_validation_report', title: '关系/时间线校验与写入前 Diff', content: validation }] : []),
      ];
    }

    if (taskType === 'chapter_passage_revision' || taskType === 'passage_revision') {
      const preview = this.latestOutputByTools(outputs, steps, ['revise_chapter_passage_preview']);
      return preview ? [{ artifactType: 'chapter_passage_revision_preview', title: '章节选区局部修订预览', content: preview }] : [];
    }

    return [];
  }

  private buildTimelineArtifacts(outputs: Record<number, unknown>, steps: Pick<AgentPlanSpec, 'steps'>['steps'] = [], includePersist = false): AgentArtifactDraft[] {
    const preview = this.latestOutputByTools(outputs, steps, ['generate_timeline_preview']);
    const validation = this.latestOutputByTools(outputs, steps, ['validate_timeline_preview']);
    const persist = includePersist ? this.latestOutputByTools(outputs, steps, ['persist_timeline_events']) : undefined;
    return [
      ...(preview ? [{ artifactType: 'timeline_preview', title: '计划时间线候选预览', content: preview }] : []),
      ...(validation ? [{ artifactType: 'timeline_validation_report', title: '计划时间线校验与写入前 Diff', content: validation }] : []),
      ...(persist ? [{ artifactType: 'timeline_persist_result', title: '计划时间线写入结果', content: persist }] : []),
    ];
  }

  private buildOutlinePreviewArtifact(preview: unknown, outputs: Record<number, unknown>, steps: Pick<AgentPlanSpec, 'steps'>['steps']): AgentArtifactDraft {
    return {
      artifactType: 'outline_preview',
      title: '大纲预览',
      content: this.decorateOutlinePreviewContent(preview, outputs, steps),
    };
  }

  private decorateOutlinePreviewContent(preview: unknown, outputs: Record<number, unknown>, steps: Pick<AgentPlanSpec, 'steps'>['steps']): unknown {
    const previewRecord = this.asRecord(preview);
    if (!Object.keys(previewRecord).length) return preview;
    return {
      ...previewRecord,
      chapterOutlineContext: this.buildChapterOutlineContext(previewRecord, outputs, steps),
    };
  }

  private buildChapterOutlineContext(preview: Record<string, unknown>, outputs: Record<number, unknown>, steps: Pick<AgentPlanSpec, 'steps'>['steps']) {
    const volume = this.asRecord(preview.volume);
    const narrativePlan = this.asRecord(volume.narrativePlan);
    const chapters = this.recordArray(preview.chapters);
    const chapterCount = this.numberValue(volume.chapterCount) ?? chapters.length;
    const volumeNo = this.numberValue(volume.volumeNo);
    const previewTool = this.latestOutputStepByTools(outputs, steps, ['merge_chapter_outline_batch_previews', 'merge_chapter_outline_previews', 'generate_outline_preview', 'generate_volume_outline_preview'])?.tool;
    const rebuiltVolumeStep = this.latestOutputStepByTools(outputs, steps, ['generate_volume_outline_preview']);
    const rebuiltVolumeArgs = this.asRecord(rebuiltVolumeStep?.args);
    const contextChapterCount = this.contextVolumeChapterCountFromOutputs(outputs, steps, volumeNo);
    const rebuiltChapterCount = this.numberValue(rebuiltVolumeArgs.chapterCount) ?? chapterCount;
    const storyUnitsStep = this.latestOutputStepByTools(outputs, steps, ['generate_story_units_preview']);
    const hasStoryUnitPlan = Object.keys(this.asRecord(narrativePlan.storyUnitPlan)).length > 0;
    const batchRanges = this.batchRangesFromOutputs(outputs, steps);
    const chapterCountSource = previewTool === 'generate_volume_outline_preview'
      ? 'generated_volume_outline'
      : rebuiltVolumeStep
        ? (contextChapterCount !== undefined && rebuiltChapterCount !== undefined && contextChapterCount !== rebuiltChapterCount ? 'user_explicit_rebuild' : 'rebuilt_volume_outline')
        : 'context_volume';
    const storyUnitPlanSource = storyUnitsStep
      ? 'generated_story_units_preview'
      : hasStoryUnitPlan
        ? (rebuiltVolumeStep ? 'rebuilt_volume_outline' : 'context_volume')
        : 'missing';
    return {
      volumeNo,
      chapterCount,
      chapterCountSource,
      chapterCountSourceLabel: this.chapterCountSourceLabel(chapterCountSource),
      storyUnitPlanSource,
      storyUnitPlanSourceLabel: this.storyUnitPlanSourceLabel(storyUnitPlanSource),
      batchCount: batchRanges.length,
      batchRanges,
      approvalMessage: this.outlineApprovalMessage(chapterCount, chapterCountSource, batchRanges.length),
    };
  }

  private batchRangesFromOutputs(outputs: Record<number, unknown>, steps: Pick<AgentPlanSpec, 'steps'>['steps']) {
    return steps
      .filter((step) => step.tool === 'generate_chapter_outline_batch_preview' && outputs[step.stepNo] !== undefined)
      .sort((left, right) => left.stepNo - right.stepNo)
      .map((step) => {
        const output = this.asRecord(outputs[step.stepNo]);
        const batch = this.asRecord(output.batch);
        const range = this.asRecord(batch.chapterRange);
        return {
          stepNo: step.stepNo,
          start: this.numberValue(range.start),
          end: this.numberValue(range.end),
          storyUnitIds: this.stringArray(batch.storyUnitIds),
        };
      })
      .filter((range) => range.start !== undefined && range.end !== undefined);
  }

  private contextVolumeChapterCountFromOutputs(outputs: Record<number, unknown>, steps: Pick<AgentPlanSpec, 'steps'>['steps'], volumeNo: number | undefined) {
    const inspectContext = this.asRecord(this.latestOutputByTools(outputs, steps, ['inspect_project_context']));
    if (volumeNo === undefined) return undefined;
    const volume = this.recordArray(inspectContext.volumes).find((item) => this.numberValue(item.volumeNo) === volumeNo);
    return this.numberValue(volume?.chapterCount);
  }

  private chapterCountSourceLabel(source: string) {
    if (source === 'user_explicit_rebuild') return '来自用户明确改章数后的本次重建卷纲';
    if (source === 'rebuilt_volume_outline') return '来自本次重建卷纲';
    if (source === 'generated_volume_outline') return '来自本次生成卷纲';
    return '来自已审批卷纲 Volume.chapterCount';
  }

  private storyUnitPlanSourceLabel(source: string) {
    if (source === 'generated_story_units_preview') return '来自本次生成的 storyUnitPlan';
    if (source === 'rebuilt_volume_outline') return '来自本次重建卷纲';
    if (source === 'context_volume') return '来自已审批卷纲 Volume.narrativePlan.storyUnitPlan';
    return '未检测到 storyUnitPlan';
  }

  private outlineApprovalMessage(chapterCount: number | undefined, source: string, batchCount: number) {
    const countText = chapterCount ? `${chapterCount} 章` : '目标章节';
    const sourceText = this.chapterCountSourceLabel(source);
    const batchText = batchCount ? `，已拆成 ${batchCount} 个 batch 覆盖目标范围` : '';
    return `本次将按${sourceText}的 ${countText} 生成章节细纲${batchText}；审批前不写库，审批后仅写入 planned 章节并跳过已起草章节。`;
  }

  private buildVolumeCharacterCandidatesPreview(preview: unknown, inspectContext: unknown): AgentArtifactDraft | undefined {
    const previewRecord = this.asRecord(preview);
    const volume = this.asRecord(previewRecord.volume);
    const narrativePlan = this.asRecord(volume.narrativePlan);
    const characterPlan = this.asRecord(narrativePlan.characterPlan);
    const candidates = this.recordArray(characterPlan.newCharacterCandidates);
    if (!candidates.length) return undefined;

    const existingCatalog = this.buildExistingCharacterCatalog(inspectContext);
    const persistableCandidates: Array<Record<string, unknown>> = [];
    const existingCandidates: Array<Record<string, unknown>> = [];

    for (const candidate of candidates) {
      const name = this.stringValue(candidate.name);
      if (!name) continue;
      const normalizedName = this.normalizeComparableName(name);
      const existing = existingCatalog.get(normalizedName);
      const row = {
        candidateId: this.stringValue(candidate.candidateId),
        name,
        roleType: this.stringValue(candidate.roleType),
        firstAppearChapter: this.numberValue(candidate.firstAppearChapter),
        narrativeFunction: this.stringValue(candidate.narrativeFunction),
        expectedArc: this.stringValue(candidate.expectedArc),
      };
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
    }

    return {
      artifactType: 'volume_character_candidates_preview',
      title: '卷级角色候选写入预览',
      content: {
        volumeNo: this.numberValue(volume.volumeNo),
        volumeTitle: this.stringValue(volume.title),
        totalCandidateCount: candidates.length,
        persistableCount: persistableCandidates.length,
        existingCount: existingCandidates.length,
        persistableCandidates,
        existingCandidates,
        relationshipArcCount: this.recordArray(characterPlan.relationshipArcs).length,
        approvalMessage: 'persist_volume_character_candidates 只应写入可持久化候选；正式 Character 表中已存在的姓名或别名会在写入前跳过。',
      },
    };
  }

  private buildExistingCharacterCatalog(inspectContext: unknown): Map<string, { name: string; source?: string; matchedBy: 'name' | 'alias' }> {
    const inspect = this.asRecord(inspectContext);
    const catalog = new Map<string, { name: string; source?: string; matchedBy: 'name' | 'alias' }>();
    for (const character of this.recordArray(inspect.characters)) {
      const name = this.stringValue(character.name);
      if (!name) continue;
      const source = this.stringValue(character.source);
      catalog.set(this.normalizeComparableName(name), { name, source, matchedBy: 'name' });
      for (const alias of this.stringArray(character.aliases)) {
        catalog.set(this.normalizeComparableName(alias), { name, source, matchedBy: 'alias' });
      }
    }
    return catalog;
  }

  private recordArray(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value)
      ? value.map((item) => this.asRecord(item)).filter((item) => Object.keys(item).length > 0)
      : [];
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
      : [];
  }

  private normalizeComparableName(value: string): string {
    return value.trim().toLocaleLowerCase();
  }

  /**
   * 将关键 Tool 输出提升为 AgentArtifact，便于前端按业务类型预览，而不是只看原始 step JSON。
   * 这里不重新解释 LLM 内容，只按已审批执行结果做只读拆分，避免引入额外副作用。
   */
  private buildExecutionArtifacts(taskType: string, outputs: Record<number, unknown>, steps: Pick<AgentPlanSpec, 'steps'>['steps'] = []): AgentArtifactDraft[] {
    if (taskType === 'outline_design') {
      const preview = this.latestOutputByTools(outputs, steps, ['merge_chapter_outline_batch_previews', 'merge_chapter_outline_previews', 'generate_outline_preview', 'generate_volume_outline_preview']);
      const validation = this.latestOutputByTools(outputs, steps, ['validate_outline']);
      const persist = this.latestOutputByTools(outputs, steps, ['persist_outline']);
      const volumePersist = this.latestOutputByTools(outputs, steps, ['persist_volume_outline']);
      const storyUnitsPreview = this.latestOutputByTools(outputs, steps, ['generate_story_units_preview']);
      const storyUnitsPersist = this.latestOutputByTools(outputs, steps, ['persist_story_units']);
      const characterPersist = this.latestOutputByTools(outputs, steps, ['persist_volume_character_candidates']);
      return [
        ...(preview ? [this.buildOutlinePreviewArtifact(preview, outputs, steps)] : []),
        ...(storyUnitsPreview ? [{ artifactType: 'story_units_preview', title: '单元故事计划预览', content: storyUnitsPreview }] : []),
        ...(validation ? [{ artifactType: 'outline_validation_report', title: '大纲校验报告', content: validation }] : []),
        ...this.buildTimelineArtifacts(outputs, steps, true),
        ...(persist ? [{ artifactType: 'outline_persist_result', title: '大纲写入结果', content: persist }] : []),
        ...(volumePersist ? [{ artifactType: 'outline_persist_result', title: '卷大纲写入结果', content: volumePersist }] : []),
        ...(storyUnitsPersist ? [{ artifactType: 'story_units_persist_result', title: '单元故事计划写入结果', content: storyUnitsPersist }] : []),
        ...(characterPersist ? [{ artifactType: 'volume_character_candidates_persist_result', title: '卷级角色候选写入结果', content: characterPersist }] : []),
      ];
    }

    if (taskType === 'timeline_plan') {
      return this.buildTimelineArtifacts(outputs, steps, true);
    }

    if (taskType === 'project_import_preview') {
      const preview = (this.latestOutputByTools(outputs, steps, ['merge_import_previews', 'build_import_preview']) as ProjectImportPreviewArtifact | undefined)
        ?? this.buildProjectImportPreviewFromTargetOutputs(outputs, steps);
      const validation = this.latestOutputByTools(outputs, steps, ['validate_imported_assets']);
      const persist = this.latestOutputByTools(outputs, steps, ['persist_project_assets']);
      return this.buildProjectImportArtifacts(preview, validation, persist);
    }

    if (taskType === 'worldbuilding_expand') {
      return [
        ...(this.latestOutputByTools(outputs, steps, ['generate_worldbuilding_preview']) ? [{ artifactType: 'worldbuilding_preview', title: '世界观扩展预览', content: this.latestOutputByTools(outputs, steps, ['generate_worldbuilding_preview']) }] : []),
        ...(this.latestOutputByTools(outputs, steps, ['validate_worldbuilding']) ? [{ artifactType: 'worldbuilding_validation_report', title: '世界观扩展校验与写入前 Diff', content: this.latestOutputByTools(outputs, steps, ['validate_worldbuilding']) }] : []),
        ...(this.latestOutputByTools(outputs, steps, ['persist_worldbuilding']) ? [{ artifactType: 'worldbuilding_persist_result', title: '世界观设定写入结果', content: this.latestOutputByTools(outputs, steps, ['persist_worldbuilding']) }] : []),
      ];
    }

    if (taskType === 'story_bible_expand') {
      return [
        ...(this.latestOutputByTools(outputs, steps, ['generate_story_bible_preview']) ? [{ artifactType: 'story_bible_preview', title: 'Story Bible 扩展预览', content: this.latestOutputByTools(outputs, steps, ['generate_story_bible_preview']) }] : []),
        ...(this.latestOutputByTools(outputs, steps, ['validate_story_bible']) ? [{ artifactType: 'story_bible_validation_report', title: 'Story Bible 校验与写入前 Diff', content: this.latestOutputByTools(outputs, steps, ['validate_story_bible']) }] : []),
        ...(this.latestOutputByTools(outputs, steps, ['persist_story_bible']) ? [{ artifactType: 'story_bible_persist_result', title: 'Story Bible 写入结果', content: this.latestOutputByTools(outputs, steps, ['persist_story_bible']) }] : []),
      ];
    }

    if (taskType === 'scene_card_planning') {
      const list = this.latestOutputByTools(outputs, steps, ['list_scene_cards']);
      const preview = this.latestOutputByTools(outputs, steps, ['generate_scene_cards_preview']);
      const validation = this.latestOutputByTools(outputs, steps, ['validate_scene_cards']);
      const persist = this.latestOutputByTools(outputs, steps, ['persist_scene_cards']);
      const update = this.latestOutputByTools(outputs, steps, ['update_scene_card']);
      return [
        ...(list ? [{ artifactType: 'scene_cards_list', title: 'SceneCard List', content: list }] : []),
        ...(preview ? [{ artifactType: 'scene_cards_preview', title: 'SceneCard Preview', content: preview }] : []),
        ...(validation ? [{ artifactType: 'scene_cards_validation_report', title: 'SceneCard Validation Report', content: validation }] : []),
        ...(persist ? [{ artifactType: 'scene_cards_persist_result', title: 'SceneCard Persist Result', content: persist }] : []),
        ...(update ? [{ artifactType: 'scene_card_update_result', title: 'SceneCard Update Result', content: update }] : []),
      ];
    }

    if (taskType === 'chapter_craft_brief' || taskType === 'chapter_progress_card') {
      const preview = this.latestOutputByTools(outputs, steps, ['generate_chapter_craft_brief_preview']);
      const validation = this.latestOutputByTools(outputs, steps, ['validate_chapter_craft_brief']);
      const persist = this.latestOutputByTools(outputs, steps, ['persist_chapter_craft_brief']);
      return [
        ...(preview ? [{ artifactType: 'chapter_craft_brief_preview', title: '章节推进卡预览', content: preview }] : []),
        ...(validation ? [{ artifactType: 'chapter_craft_brief_validation_report', title: '章节推进卡校验报告', content: validation }] : []),
        ...this.buildTimelineArtifacts(outputs, steps, true),
        ...(persist ? [{ artifactType: 'chapter_craft_brief_persist_result', title: '章节推进卡写入结果', content: persist }] : []),
      ];
    }

    if (taskType === 'continuity_check') {
      const preview = this.latestOutputByTools(outputs, steps, ['generate_continuity_preview']);
      const validation = this.latestOutputByTools(outputs, steps, ['validate_continuity_changes']);
      const persist = this.latestOutputByTools(outputs, steps, ['persist_continuity_changes']);
      return [
        ...(preview ? [{ artifactType: 'continuity_preview', title: '关系/时间线变更预览', content: preview }] : []),
        ...(validation ? [{ artifactType: 'continuity_validation_report', title: '关系/时间线校验与写入前 Diff', content: validation }] : []),
        ...(persist ? [{ artifactType: 'continuity_persist_result', title: '关系/时间线写入结果', content: persist }] : []),
      ];
    }

    if (taskType === 'character_consistency_check') {
      const context = this.latestOutputByTools(outputs, steps, ['collect_task_context']);
      const report = this.latestOutputByTools(outputs, steps, ['character_consistency_check']);
      return [
        ...(context ? [{ artifactType: 'task_context_preview', title: '角色检查上下文预览', content: context }] : []),
        ...(report ? [{ artifactType: 'character_consistency_report', title: '角色一致性检查报告', content: report }] : []),
      ];
    }

    if (taskType === 'plot_consistency_check') {
      const context = this.latestOutputByTools(outputs, steps, ['collect_task_context']);
      const report = this.latestOutputByTools(outputs, steps, ['plot_consistency_check']);
      return [
        ...(context ? [{ artifactType: 'task_context_preview', title: '剧情一致性上下文预览', content: context }] : []),
        ...(report ? [{ artifactType: 'plot_consistency_report', title: '剧情一致性检查报告', content: report }] : []),
      ];
    }

    if (taskType === 'ai_quality_review') {
      const report = this.latestOutputByTools(outputs, steps, ['ai_quality_review']);
      return report ? [{ artifactType: 'ai_quality_report', title: 'AI 审稿质量报告', content: report }] : [];
    }

    if (taskType === 'chapter_passage_revision' || taskType === 'passage_revision') {
      const preview = this.latestOutputByTools(outputs, steps, ['revise_chapter_passage_preview']);
      return preview ? [{ artifactType: 'chapter_passage_revision_preview', title: '章节选区局部修订预览', content: preview }] : [];
    }

    if (taskType === 'chapter_write' || taskType === 'multi_chapter_write') {
      const series = this.latestOutputByTools(outputs, steps, ['write_chapter_series']);
      const draft = this.latestOutputByTools(outputs, steps, ['auto_repair_chapter', 'polish_chapter', 'postprocess_chapter', 'rewrite_chapter', 'write_chapter']);
      const validation = this.latestOutputByTools(outputs, steps, ['fact_validation']);
      const autoRepair = this.latestOutputByTools(outputs, steps, ['auto_repair_chapter']);
      const facts = this.latestOutputByTools(outputs, steps, ['extract_chapter_facts']);
      const memory = this.latestOutputByTools(outputs, steps, ['rebuild_memory']);
      const memoryReview = this.latestOutputByTools(outputs, steps, ['review_memory']);
      return [
        ...(series ? [{ artifactType: 'chapter_series_result', title: '多章连续生成结果', content: series }] : []),
        ...(draft ? [{ artifactType: 'chapter_generation_quality_report', title: '生成前、生成后与召回质量报告', content: { preflight: this.readPath(draft, ['preflight']), qualityGate: this.readPath(draft, ['qualityGate']), retrievalDiagnostics: this.readPath(draft, ['retrievalPayload', 'diagnostics']) } }] : []),
        ...(draft ? [{ artifactType: 'chapter_draft_result', title: '章节草稿结果', content: draft }] : []),
        ...(validation ? [{ artifactType: 'fact_validation_report', title: '事实校验报告', content: validation }] : []),
        ...(autoRepair ? [{ artifactType: 'auto_repair_report', title: '有界自动修复报告', content: autoRepair }] : []),
        ...(facts ? [{ artifactType: 'fact_extraction_report', title: '事实抽取报告', content: facts }] : []),
        ...(memory ? [{ artifactType: 'memory_rebuild_report', title: '记忆重建报告', content: memory }] : []),
        ...(memoryReview ? [{ artifactType: 'memory_review_report', title: '记忆复核报告', content: memoryReview }] : []),
      ];
    }

    if (taskType === 'chapter_polish') {
      const polish = outputs[3];
      const validation = outputs[4];
      const autoRepair = outputs[5];
      const facts = outputs[6];
      const memory = outputs[7];
      const memoryReview = outputs[8];
      return [
        ...(polish ? [{ artifactType: 'chapter_polish_result', title: '章节润色结果', content: polish }] : []),
        ...(validation ? [{ artifactType: 'fact_validation_report', title: '事实校验报告', content: validation }] : []),
        ...(autoRepair ? [{ artifactType: 'auto_repair_report', title: '有界自动修复报告', content: autoRepair }] : []),
        ...(facts ? [{ artifactType: 'fact_extraction_report', title: '事实抽取报告', content: facts }] : []),
        ...(memory ? [{ artifactType: 'memory_rebuild_report', title: '记忆重建报告', content: memory }] : []),
        ...(memoryReview ? [{ artifactType: 'memory_review_report', title: '记忆复核报告', content: memoryReview }] : []),
      ];
    }

    return [];
  }

  private buildProjectImportArtifacts(preview?: ProjectImportPreviewArtifact, validation?: unknown, persist?: unknown): AgentArtifactDraft[] {
    return [
      ...(this.shouldShowImportArtifact(preview, 'projectProfile') ? [{ artifactType: 'project_profile_preview', title: '项目资料预览', content: this.projectProfileWithoutOutline(preview?.projectProfile) }] : []),
      ...(this.shouldShowImportArtifact(preview, 'characters') ? [{ artifactType: 'characters_preview', title: '角色预览', content: preview?.characters ?? [] }] : []),
      ...(this.shouldShowImportArtifact(preview, 'worldbuilding') ? [{ artifactType: 'lorebook_preview', title: '设定预览', content: preview?.lorebookEntries ?? [] }] : []),
      ...(this.shouldShowImportArtifact(preview, 'writingRules') ? [{ artifactType: 'writing_rules_preview', title: '写作规则预览', content: preview?.writingRules ?? [] }] : []),
      ...(this.shouldShowImportArtifact(preview, 'outline') ? [{ artifactType: 'outline_preview', title: '卷与章节预览', content: this.removeUndefinedArgs({ outline: this.asRecord(preview?.projectProfile).outline, volumes: preview?.volumes ?? [], chapters: preview?.chapters ?? [], risks: preview?.risks ?? [] }) }] : []),
      ...(validation ? [{ artifactType: 'import_validation_report', title: '导入校验报告', content: validation }] : []),
      ...(persist ? [{ artifactType: 'import_persist_result', title: '导入写入结果', content: persist }] : []),
    ];
  }

  private projectProfileWithoutOutline(projectProfile: unknown) {
    const profile = { ...this.asRecord(projectProfile) };
    delete profile.outline;
    return profile;
  }

  private buildProjectImportPreviewFromTargetOutputs(outputs: Record<number, unknown>, steps: Pick<AgentPlanSpec, 'steps'>['steps']): ProjectImportPreviewArtifact | undefined {
    const previewSteps = steps.filter((step) => PROJECT_IMPORT_TARGET_TOOL_ASSET_TYPE[step.tool] && outputs[step.stepNo] !== undefined).sort((a, b) => a.stepNo - b.stepNo);
    if (!previewSteps.length) return undefined;
    const preview: ProjectImportPreviewArtifact = { requestedAssetTypes: [], risks: [] };
    const requestedAssetTypes: ProjectImportAssetType[] = [];
    const risks: unknown[] = [];
    for (const step of previewSteps) {
      const assetType = PROJECT_IMPORT_TARGET_TOOL_ASSET_TYPE[step.tool];
      if (!requestedAssetTypes.includes(assetType)) requestedAssetTypes.push(assetType);
      const output = this.asRecord(outputs[step.stepNo]);
      if (Array.isArray(output.risks)) risks.push(...output.risks);
      if (assetType === 'projectProfile') preview.projectProfile = output.projectProfile;
      if (assetType === 'outline') {
        preview.projectProfile = { ...this.asRecord(preview.projectProfile), ...this.asRecord(output.projectProfile) };
        preview.volumes = output.volumes;
        preview.chapters = output.chapters;
      }
      if (assetType === 'characters') preview.characters = output.characters;
      if (assetType === 'worldbuilding') preview.lorebookEntries = output.lorebookEntries;
      if (assetType === 'writingRules') preview.writingRules = output.writingRules;
    }
    preview.requestedAssetTypes = requestedAssetTypes;
    preview.risks = risks;
    return preview;
  }

  private shouldShowImportArtifact(preview: ProjectImportPreviewArtifact | undefined, assetType: ProjectImportAssetType) {
    if (!preview) return false;
    const requestedAssetTypes = Array.isArray(preview.requestedAssetTypes) ? preview.requestedAssetTypes.map((item) => String(item)) : [];
    return !requestedAssetTypes.length || requestedAssetTypes.includes(assetType);
  }

  private readPath(value: unknown, path: string[]) {
    return path.reduce<unknown>((current, key) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined), value);
  }

  /** 按计划中的 tool 名称动态定位最新输出，避免章节写作质量门禁插入条件步骤后 Artifact 错位。 */
  private latestOutputByTools(outputs: Record<number, unknown>, steps: Pick<AgentPlanSpec, 'steps'>['steps'], tools: string[]): unknown {
    const candidates = steps.filter((step) => tools.includes(step.tool) && outputs[step.stepNo] !== undefined).sort((a, b) => b.stepNo - a.stepNo);
    return candidates.length ? outputs[candidates[0].stepNo] : undefined;
  }

  private latestOutputStepByTools(outputs: Record<number, unknown>, steps: Pick<AgentPlanSpec, 'steps'>['steps'], tools: string[]) {
    const candidates = steps.filter((step) => tools.includes(step.tool) && outputs[step.stepNo] !== undefined).sort((a, b) => b.stepNo - a.stepNo);
    return candidates[0];
  }
}
