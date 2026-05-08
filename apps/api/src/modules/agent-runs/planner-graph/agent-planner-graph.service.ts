import { Injectable } from '@nestjs/common';
import { invokeAgentPlannerGraph } from './agent-planner.graph';
import type { AgentPlannerGraphInput, AgentPlannerGraphState } from './planner-graph.state';

@Injectable()
export class AgentPlannerGraphService {
  invoke(input: AgentPlannerGraphInput): Promise<AgentPlannerGraphState> {
    return invokeAgentPlannerGraph(input);
  }
}
