import { Injectable } from '@nestjs/common';
import { BaseTool, ToolContext } from '../base-tool';

interface EchoReportInput {
  message?: string;
}

/**
 * MVP 闭环验证工具：不写正式业务表，仅把 Agent 目标和输入整理成报告。
 * 后续接入 chapter_write / import_preview 时可作为 report_result 的雏形替换。
 */
@Injectable()
export class EchoReportTool implements BaseTool<EchoReportInput, Record<string, unknown>> {
  name = 'echo_report';
  description = '生成一个无副作用的 Agent 执行报告，用于验证 Plan/Act 同步闭环。';
  inputSchema = { type: 'object' as const, properties: { message: { type: 'string' as const } } };
  outputSchema = { type: 'object' as const, required: ['message', 'agentRunId', 'projectId', 'mode'], properties: { message: { type: 'string' as const }, agentRunId: { type: 'string' as const }, projectId: { type: 'string' as const }, mode: { type: 'string' as const }, previousOutputs: { type: 'object' as const } } };
  allowedModes: Array<'plan' | 'act'> = ['act'];
  riskLevel: 'low' = 'low';
  requiresApproval = true;
  sideEffects: string[] = [];

  async run(args: EchoReportInput, context: ToolContext) {
    return {
      message: args.message ?? 'Agent MVP 执行完成。',
      agentRunId: context.agentRunId,
      projectId: context.projectId,
      mode: context.mode,
      previousOutputs: context.outputs,
    };
  }
}