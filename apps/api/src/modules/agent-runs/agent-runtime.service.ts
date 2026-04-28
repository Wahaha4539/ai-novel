import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentContextBuilderService, AgentContextV2 } from './agent-context-builder.service';
import { AgentCancelledError, AgentExecutorService, AgentWaitingReviewError } from './agent-executor.service';
import { AgentExecutionObservationError, AgentObservation, ReplanAttemptStats, ReplanPatch } from './agent-observation.types';
import { AgentPlannerFailedError, AgentPlannerService, AgentPlanSpec } from './agent-planner.service';
import { AgentReplannerService } from './agent-replanner.service';
import { AgentTraceService } from './agent-trace.service';

type AgentArtifactDraft = {
  artifactType: string;
  title: string;
  content: unknown;
};

/** 编排 AgentRun 状态机：Plan 阶段生成预览，Act 阶段执行已审批工具。 */
@Injectable()
export class AgentRuntimeService {
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

    try {
      const context = await this.contextBuilder.buildForPlan(run);
      const contextDigest = this.contextBuilder.createDigest(context);
      await this.persistContextSnapshot(agentRunId, run.input, context, contextDigest);
      const plan = await this.planner.createPlan(run.goal, context);
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
      const previewArtifacts = this.buildPreviewArtifacts(plan.taskType, previewOutputs);
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

      await this.prisma.agentRun.update({ where: { id: agentRunId }, data: { status: 'waiting_approval', taskType: plan.taskType, output: { planId: savedPlan.id } } });
      const artifacts = await this.prisma.agentArtifact.findMany({ where: { agentRunId }, orderBy: { createdAt: 'asc' } });
      return { plan: savedPlan, artifacts: artifacts.length ? artifacts : [artifact] };
    } catch (error) {
      await this.recordPlannerFailure(agentRunId, error);
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

    try {
      // 通过条件更新获取轻量执行租约，避免两个 /act 或 /retry 请求并发执行同一份计划。
      const lease = await this.prisma.agentRun.updateMany({ where: { id: agentRunId, status: { in: ['waiting_approval', 'waiting_review', 'failed'] } }, data: { status: 'acting', mode: 'act', error: null } });
      if (lease.count !== 1) throw new Error('AgentRun 当前状态不允许进入 Act，可能正在执行或已结束');
      context = await this.loadContextForExecution(run);
      const outputs = await this.executor.execute(agentRunId, spec.steps, { mode: 'act', planVersion: latestPlan.version, approved: true, approvedStepNos, confirmation, reuseSucceeded: true, agentContext: context });
      const currentRun = await this.prisma.agentRun.findUnique({ where: { id: agentRunId } });
      if (currentRun?.status === 'cancelled') return currentRun;
      const artifactDrafts = this.buildExecutionArtifacts(String(latestPlan.taskType), outputs, spec.steps);
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
      const updated = await this.prisma.agentRun.update({ where: { id: agentRunId }, data: { status: 'succeeded', output: { outputs } as unknown as Prisma.InputJsonValue } });
      return updated;
    } catch (error) {
      if (error instanceof AgentCancelledError) {
        return this.prisma.agentRun.update({ where: { id: agentRunId }, data: { status: 'cancelled', error: error.message } });
      }
      if (error instanceof AgentWaitingReviewError) {
        return this.prisma.agentRun.update({ where: { id: agentRunId }, data: { status: 'waiting_review', error: error.message } });
      }
      if (error instanceof AgentExecutionObservationError) {
        return this.handleExecutionObservation(agentRunId, run, latestPlan, spec.steps, context ?? await this.loadContextForExecution(run), error);
      }
      await this.prisma.agentRun.updateMany({ where: { id: agentRunId, status: { not: 'cancelled' } }, data: { status: 'failed', error: error instanceof Error ? error.message : String(error) } });
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
      const previewArtifacts = this.buildPreviewArtifacts(plan.taskType, previewOutputs);
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
    await this.prisma.agentRun.update({ where: { id: agentRunId }, data: { status: 'failed', error: message, output: { plannerDiagnostics: diagnostics } as unknown as Prisma.InputJsonValue } });
  }

  /**
   * 执行失败后生成 Observation/Replan 诊断。可安全修复时创建新 Plan version 并回到审批态，
   * 不在失败栈内继续执行新计划，避免自动绕过用户对写入步骤的审批。
   */
  private async handleExecutionObservation(agentRunId: string, run: { goal: string }, latestPlan: { version: number; taskType: string; summary: string; assumptions: unknown; risks: unknown; requiredApprovals: unknown }, steps: AgentPlanSpec['steps'], context: AgentContextV2, error: AgentExecutionObservationError) {
    const observation = error.observation;
    const replanStats = await this.loadReplanAttemptStats(agentRunId, observation);
    const patch = this.replanner.createPatch({ userGoal: run.goal, currentPlanSteps: steps, failedObservation: observation, agentContext: context, replanStats });
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
      return this.prisma.agentRun.update({ where: { id: agentRunId }, data: { status: 'waiting_approval', error: null, output: { planId: savedPlan.id, latestObservation: observation, replanPatch: patch, replanStats } as unknown as Prisma.InputJsonValue } });
    }

    const status = patch.action === 'ask_user' ? 'waiting_review' : 'failed';
    await this.trace.recordDecision(agentRunId, { name: 'Observation/Replan 诊断', mode: 'act', planVersion: latestPlan.version, status: patch.action === 'ask_user' ? 'succeeded' : 'failed', input: { observation }, output: { patch }, error: patch.action === 'fail_with_reason' ? patch.reason : undefined });
    return this.prisma.agentRun.update({ where: { id: agentRunId }, data: { status, error: patch.questionForUser ?? patch.reason, output: { latestObservation: observation, replanPatch: patch, replanStats } as unknown as Prisma.InputJsonValue } });
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

  private requiredApprovalsForSteps(steps: AgentPlanSpec['steps']) {
    const approvalSteps = steps.filter((step) => step.requiresApproval);
    return approvalSteps.length ? [{ approvalType: 'plan', target: { stepNos: approvalSteps.map((step) => step.stepNo), tools: approvalSteps.map((step) => step.tool) } }] : [];
  }

  /** 将 AgentContext V2 的摘要和裁剪快照写回 Run.input，方便审计回放和 Act 阶段变量解析。 */
  private async persistContextSnapshot(agentRunId: string, input: unknown, context: AgentContextV2, digest: string) {
    const base = this.asRecord(input);
    const contextSnapshot = this.compactContextSnapshot(context);
    await this.prisma.agentRun.update({ where: { id: agentRunId }, data: { input: { ...base, contextSnapshotDigest: digest, contextSnapshot } as Prisma.InputJsonValue } });
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
      constraints: context.constraints,
      // Tool Manifest 已在 Plan Artifact 中保存；快照只保留名称，避免 Run.input 过大。
      availableTools: context.availableTools.map((tool) => ({ name: tool.name, riskLevel: tool.riskLevel, requiresApproval: tool.requiresApproval })),
    };
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private toJsonCompatible(value: unknown): unknown {
    if (value === undefined) return null;
    try {
      return JSON.parse(JSON.stringify(value)) as unknown;
    } catch {
      return String(value);
    }
  }

  /** Plan 阶段执行只读预览步骤后，把可展示内容提前提升为 Artifact。 */
  private buildPreviewArtifacts(taskType: string, outputs: Record<number, unknown>): AgentArtifactDraft[] {
    if (taskType === 'outline_design') {
      return [
        ...(outputs[2] ? [{ artifactType: 'outline_preview', title: '大纲预览', content: outputs[2] }] : []),
        ...(outputs[3] ? [{ artifactType: 'outline_validation_report', title: '大纲校验报告', content: outputs[3] }] : []),
      ];
    }

    if (taskType === 'project_import_preview') {
      const preview = outputs[2] as { projectProfile?: unknown; characters?: unknown; lorebookEntries?: unknown; volumes?: unknown; chapters?: unknown; risks?: unknown } | undefined;
      return [
        ...(preview ? [{ artifactType: 'project_profile_preview', title: '项目资料预览', content: preview.projectProfile ?? {} }] : []),
        ...(preview ? [{ artifactType: 'characters_preview', title: '角色预览', content: preview.characters ?? [] }] : []),
        ...(preview ? [{ artifactType: 'lorebook_preview', title: '设定预览', content: preview.lorebookEntries ?? [] }] : []),
        ...(preview ? [{ artifactType: 'outline_preview', title: '卷与章节预览', content: { volumes: preview.volumes ?? [], chapters: preview.chapters ?? [], risks: preview.risks ?? [] } }] : []),
        ...(outputs[3] ? [{ artifactType: 'import_validation_report', title: '导入校验报告', content: outputs[3] }] : []),
      ];
    }

    if (taskType === 'chapter_write' || taskType === 'chapter_polish') {
      return outputs[2] ? [{ artifactType: 'chapter_context_preview', title: '章节上下文与写入预览', content: outputs[2] }] : [];
    }

    return [];
  }

  /**
   * 将关键 Tool 输出提升为 AgentArtifact，便于前端按业务类型预览，而不是只看原始 step JSON。
   * 这里不重新解释 LLM 内容，只按已审批执行结果做只读拆分，避免引入额外副作用。
   */
  private buildExecutionArtifacts(taskType: string, outputs: Record<number, unknown>, steps: Pick<AgentPlanSpec, 'steps'>['steps'] = []): AgentArtifactDraft[] {
    if (taskType === 'outline_design') {
      const preview = outputs[2];
      const validation = outputs[3];
      const persist = outputs[4];
      return [
        ...(preview ? [{ artifactType: 'outline_preview', title: '大纲预览', content: preview }] : []),
        ...(validation ? [{ artifactType: 'outline_validation_report', title: '大纲校验报告', content: validation }] : []),
        ...(persist ? [{ artifactType: 'outline_persist_result', title: '大纲写入结果', content: persist }] : []),
      ];
    }

    if (taskType === 'project_import_preview') {
      const preview = outputs[2] as { projectProfile?: unknown; characters?: unknown; lorebookEntries?: unknown; volumes?: unknown; chapters?: unknown; risks?: unknown } | undefined;
      const validation = outputs[3];
      const persist = outputs[4];
      if (!preview) {
        return [
          ...(validation ? [{ artifactType: 'import_validation_report', title: '导入校验报告', content: validation }] : []),
          ...(persist ? [{ artifactType: 'import_persist_result', title: '导入写入结果', content: persist }] : []),
        ];
      }

      return [
        { artifactType: 'project_profile_preview', title: '项目资料预览', content: preview.projectProfile ?? {} },
        { artifactType: 'characters_preview', title: '角色预览', content: preview.characters ?? [] },
        { artifactType: 'lorebook_preview', title: '设定预览', content: preview.lorebookEntries ?? [] },
        { artifactType: 'outline_preview', title: '卷与章节预览', content: { volumes: preview.volumes ?? [], chapters: preview.chapters ?? [], risks: preview.risks ?? [] } },
        ...(validation ? [{ artifactType: 'import_validation_report', title: '导入校验报告', content: validation }] : []),
        ...(persist ? [{ artifactType: 'import_persist_result', title: '导入写入结果', content: persist }] : []),
      ];
    }

    if (taskType === 'worldbuilding_expand') {
      return [
        ...(this.latestOutputByTools(outputs, steps, ['generate_worldbuilding_preview']) ? [{ artifactType: 'worldbuilding_preview', title: '世界观扩展预览', content: this.latestOutputByTools(outputs, steps, ['generate_worldbuilding_preview']) }] : []),
        ...(this.latestOutputByTools(outputs, steps, ['validate_worldbuilding']) ? [{ artifactType: 'worldbuilding_validation_report', title: '世界观扩展校验与写入前 Diff', content: this.latestOutputByTools(outputs, steps, ['validate_worldbuilding']) }] : []),
        ...(this.latestOutputByTools(outputs, steps, ['persist_worldbuilding']) ? [{ artifactType: 'worldbuilding_persist_result', title: '世界观设定写入结果', content: this.latestOutputByTools(outputs, steps, ['persist_worldbuilding']) }] : []),
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

    if (taskType === 'chapter_write') {
      const draft = this.latestOutputByTools(outputs, steps, ['auto_repair_chapter', 'polish_chapter', 'postprocess_chapter', 'write_chapter']);
      const validation = this.latestOutputByTools(outputs, steps, ['fact_validation']);
      const autoRepair = this.latestOutputByTools(outputs, steps, ['auto_repair_chapter']);
      const facts = this.latestOutputByTools(outputs, steps, ['extract_chapter_facts']);
      const memory = this.latestOutputByTools(outputs, steps, ['rebuild_memory']);
      const memoryReview = this.latestOutputByTools(outputs, steps, ['review_memory']);
      return [
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

  private readPath(value: unknown, path: string[]) {
    return path.reduce<unknown>((current, key) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined), value);
  }

  /** 按计划中的 tool 名称动态定位最新输出，避免章节写作质量门禁插入条件步骤后 Artifact 错位。 */
  private latestOutputByTools(outputs: Record<number, unknown>, steps: Pick<AgentPlanSpec, 'steps'>['steps'], tools: string[]): unknown {
    const candidates = steps.filter((step) => tools.includes(step.tool) && outputs[step.stepNo] !== undefined).sort((a, b) => b.stepNo - a.stepNo);
    return candidates.length ? outputs[candidates[0].stepNo] : undefined;
  }
}
