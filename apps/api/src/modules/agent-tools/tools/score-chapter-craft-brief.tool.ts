import { Injectable } from '@nestjs/common';
import { AgentMode, BaseTool, ToolContext } from '../base-tool';
import { PlatformProfileKey, PLATFORM_PROFILE_KEYS } from '../../scoring/scoring-contracts';
import { ScoringService } from '../../scoring/scoring.service';

interface ScoreChapterCraftBriefInput {
  chapterId?: string;
  profileKey?: PlatformProfileKey;
}

@Injectable()
export class ScoreChapterCraftBriefTool implements BaseTool<ScoreChapterCraftBriefInput, unknown> {
  name = 'score_chapter_craft_brief';
  description = 'Score an existing Chapter.craftBrief with the multidimensional scoring center and save a read-only scoring report.';
  allowedModes: AgentMode[] = ['act'];
  riskLevel = 'low' as const;
  requiresApproval = false;
  sideEffects = ['create_scoring_run'];

  inputSchema = {
    type: 'object' as const,
    required: ['chapterId'],
    properties: {
      chapterId: { type: 'string' as const, minLength: 1 },
      profileKey: { type: 'string' as const, enum: [...PLATFORM_PROFILE_KEYS] },
    },
    additionalProperties: false,
  };

  outputSchema = {
    type: 'object' as const,
    required: ['id', 'targetType', 'targetId', 'overallScore', 'verdict'],
    properties: {
      id: { type: 'string' as const },
      targetType: { type: 'string' as const },
      targetId: { type: 'string' as const },
      overallScore: { type: 'number' as const },
      verdict: { type: 'string' as const },
    },
  };

  constructor(private readonly scoringService: ScoringService) {}

  async run(args: ScoreChapterCraftBriefInput, context: ToolContext) {
    const chapterId = args.chapterId?.trim() || context.chapterId;
    if (!chapterId) throw new Error('score_chapter_craft_brief requires chapterId.');
    const profileKey = args.profileKey ?? 'generic_longform';
    if (!(PLATFORM_PROFILE_KEYS as readonly string[]).includes(profileKey)) {
      throw new Error(`Unsupported scoring profile: ${profileKey}`);
    }
    return this.scoringService.createRun(
      context.projectId,
      {
        targetType: 'chapter_craft_brief',
        targetId: chapterId,
        profileKey,
      },
      { agentRunId: context.agentRunId },
    );
  }
}
