import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmGatewayService } from '../llm/llm-gateway.service';

type AgentChatIntent = 'approve_current_plan' | 'new_task' | 'revise_plan' | 'cancel_or_wait' | 'unclear';

interface LlmIntentPayload {
  intent?: AgentChatIntent;
  shouldExecute?: boolean;
  confidence?: number;
  reason?: string;
}

/**
 * Agent 聊天意图判定服务。
 * 输入：当前 AgentRun 与用户最新聊天消息；输出：LLM 判定出的意图；副作用：调用 LLM，但不执行任何 Tool 或写业务表。
 */
@Injectable()
export class AgentMessageIntentService {
  constructor(private readonly prisma: PrismaService, private readonly llm: LlmGatewayService) {}

  async interpret(agentRunId: string, message: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: agentRunId }, include: { plans: { orderBy: { version: 'desc' }, take: 1 } } });
    if (!run) throw new NotFoundException(`AgentRun 不存在：${agentRunId}`);
    if (!['waiting_approval', 'waiting_review'].includes(run.status)) throw new BadRequestException(`当前状态 ${run.status} 不需要审批意图判定`);

    const latestPlan = run.plans[0];
    const { data, result } = await this.llm.chatJson<LlmIntentPayload>([
      {
        role: 'system',
        content: [
          '你是 Agent 聊天审批意图分类器，只输出 JSON。',
          '判断用户最新消息是否是在确认执行“当前已生成的计划”。',
          '可选 intent：approve_current_plan、new_task、revise_plan、cancel_or_wait、unclear。',
          '只有用户明确表达批准、同意、继续、按当前计划执行时，才输出 approve_current_plan。',
          '如果用户提出新创作需求、修改计划、等待/取消/否定，不能输出 approve_current_plan。',
          'shouldExecute 由你根据语义判断，只有确认执行当前计划时才为 true。',
          '输出格式：{"intent":"...","shouldExecute":true或false,"confidence":0到1,"reason":"简短中文原因"}',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          run: this.describeRun(run),
          currentPlan: latestPlan ? { summary: latestPlan.summary, risks: latestPlan.risks, requiredApprovals: latestPlan.requiredApprovals, steps: latestPlan.steps } : null,
          latestUserMessage: message,
        }),
      },
    ], { appStep: 'agent_planner', temperature: 0, maxTokens: 300, timeoutMs: 30_000, retries: 0 });

    const intent = this.normalizeIntent(data.intent);
    const confidence = typeof data.confidence === 'number' && Number.isFinite(data.confidence) ? Math.max(0, Math.min(1, data.confidence)) : 0;
    // 是否执行由 LLM 输出的 shouldExecute 决定；intent 一致性检查只防止格式漂移导致误执行。
    return { intent, shouldExecute: Boolean(data.shouldExecute) && intent === 'approve_current_plan', confidence, reason: typeof data.reason === 'string' ? data.reason.slice(0, 240) : '', model: result.model, usage: result.usage };
  }

  private normalizeIntent(value: unknown): AgentChatIntent {
    const allowed: AgentChatIntent[] = ['approve_current_plan', 'new_task', 'revise_plan', 'cancel_or_wait', 'unclear'];
    return allowed.includes(value as AgentChatIntent) ? (value as AgentChatIntent) : 'unclear';
  }

  /** 只给 LLM 必要上下文，避免把完整 Run/Artifact 发送到判定请求里造成额外成本。 */
  private describeRun(run: { id: string; goal: string; status: string; taskType: string | null; chapterId: string | null }) {
    return { id: run.id, goal: run.goal, status: run.status, taskType: run.taskType, chapterId: run.chapterId };
  }
}