import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { assertPlatformProfileCoversTarget } from './platform-scoring-profiles';
import { ScoringController } from './scoring.controller';
import { buildScoringRevisionPrompt } from './scoring-revision-prompt';
import { ScoringRevisionService } from './scoring-revision.service';

const targetType = 'chapter_craft_brief' as const;
const profileKey = 'generic_longform' as const;
const weights = assertPlatformProfileCoversTarget(targetType, profileKey);

function dimensions() {
  return Object.entries(weights).map(([key, weight], index) => ({
    key,
    label: `Dimension ${index + 1}`,
    score: 70 + index,
    weight,
    weightedScore: Number((((70 + index) * weight) / 100).toFixed(4)),
    confidence: 'high',
    evidence: `${key} evidence`,
    reason: `${key} reason`,
    suggestion: `${key} suggestion`,
  }));
}

function scoringRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'score-1',
    projectId: 'project-1',
    chapterId: 'chapter-1',
    draftId: null,
    agentRunId: null,
    targetType,
    targetId: 'chapter-1',
    targetRef: { chapterId: 'chapter-1' },
    platformProfile: profileKey,
    profileVersion: 'profile.generic_longform.v1',
    promptVersion: 'multidimensional_scoring.prompt.v1',
    rubricVersion: 'multidimensional_scoring.rubric.v1',
    overallScore: 78,
    verdict: 'warn',
    summary: 'The craft brief is usable but needs a tighter handoff.',
    dimensions: dimensions(),
    issues: [
      {
        dimensionKey: 'continuity_handoff',
        severity: 'warning',
        path: 'handoffToNextChapter',
        evidence: 'handoff clue is generic',
        reason: 'the next chapter pressure is unclear',
        suggestion: 'name the concrete clue that carries forward',
      },
      {
        dimensionKey: 'scene_executability',
        severity: 'blocking',
        path: 'sceneBeats[1].obstacle',
        evidence: 'obstacle is not visible',
        reason: 'the action chain lacks resistance',
        suggestion: 'make the obstacle a visible opposing action',
      },
    ],
    revisionPriorities: ['Clarify the handoff clue', 'Make the second obstacle visible'],
    extractedElements: { mainCharacters: ['protagonist'], coreEvents: ['market pursuit'] },
    targetSnapshot: {
      targetType,
      targetId: 'chapter-1',
      targetRef: { chapterId: 'chapter-1' },
      assetSummary: {
        targetType,
        title: 'Chapter 1 craft brief',
        chapterNo: 1,
        source: 'Chapter.craftBrief',
        updatedAt: '2026-05-16T00:00:00.000Z',
      },
      content: {
        chapter: { id: 'chapter-1', chapterNo: 1, title: 'Chapter 1' },
        craftBrief: { visibleGoal: 'Find the ledger', actionBeats: ['enter', 'search', 'escape'] },
      },
      sourceTrace: { projectId: 'project-1', chapterId: 'chapter-1' },
    },
    sourceTrace: { projectId: 'project-1', chapterId: 'chapter-1' },
    llmMetadata: {},
    createdAt: new Date('2026-05-16T00:00:00.000Z'),
    updatedAt: new Date('2026-05-16T00:00:00.000Z'),
    ...overrides,
  };
}

function createService(run = scoringRun()) {
  const calls = {
    agentRunCreate: [] as unknown[],
    agentArtifactCreate: [] as unknown[],
    assetWrites: [] as string[],
  };
  const forbiddenWrite = (name: string) => async () => {
    calls.assetWrites.push(name);
    throw new Error(`forbidden asset write: ${name}`);
  };
  const prisma = {
    scoringRun: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.projectId !== 'project-1') return null;
        return run;
      },
    },
    agentRun: {
      create: async (args: unknown) => {
        calls.agentRunCreate.push(args);
        return { id: 'agent-run-1', status: 'planning', taskType: 'score_driven_revision', ...(args as { data: Record<string, unknown> }).data };
      },
    },
    agentArtifact: {
      create: async (args: unknown) => {
        calls.agentArtifactCreate.push(args);
        return { id: 'artifact-1', ...(args as { data: Record<string, unknown> }).data };
      },
    },
    project: { update: forbiddenWrite('project.update') },
    volume: { update: forbiddenWrite('volume.update') },
    chapter: { update: forbiddenWrite('chapter.update') },
    chapterDraft: { create: forbiddenWrite('chapterDraft.create'), update: forbiddenWrite('chapterDraft.update') },
  };
  return { service: new ScoringRevisionService(prisma as never), calls };
}

async function run() {
  {
    const result = buildScoringRevisionPrompt({
      scoringRunId: 'score-1',
      targetType,
      targetSnapshot: scoringRun().targetSnapshot as never,
      platformProfileKey: profileKey,
      dimensions: scoringRun().dimensions as never,
      selectedDimensions: [dimensions()[0] as never],
      issues: scoringRun().issues as never,
      selectedIssues: [scoringRun().issues[0] as never],
      revisionPriorities: ['Clarify the handoff clue'],
      selectedRevisionPriorities: ['Clarify the handoff clue'],
      request: { scoringRunId: 'score-1', entryPoint: 'issue', selectedIssueIndexes: [0] },
      mapping: {
        targetType,
        agentTarget: 'chapter_craft_brief_preview',
        recommendedPreviewAction: 'Generate a preview only.',
        expectedOutput: 'preview',
      },
      overallScore: 78,
      verdict: 'warn',
      summary: 'summary',
    });
    assert.match(result.prompt, /scoringRunId/);
    assert.match(result.prompt, /targetSnapshot/);
    assert.match(result.prompt, /platformProfile/);
    assert.match(result.prompt, /selectedIssues/);
    assert.match(result.prompt, /selectedDimensions/);
    assert.match(result.prompt, /revisionPriorities/);
    assert.match(result.prompt, /userInstruction/);
    assert.match(result.prompt, /prohibitions/);
    assert.match(result.prompt, /outputRequirements/);
  }

  {
    const { service, calls } = createService();
    const result = await service.createRevision('project-1', 'score-1', {
      scoringRunId: 'score-1',
      entryPoint: 'issue',
      selectedIssueIndexes: [1],
      selectedDimensions: ['scene_executability'],
      selectedRevisionPriorities: ['Make the second obstacle visible'],
      userInstruction: 'Keep the chapter ending intact.',
    });
    assert.equal(result.agentRunId, 'agent-run-1');
    assert.equal(result.mapping.agentTarget, 'chapter_craft_brief_preview');
    assert.equal(result.selectedIssues.length, 1);
    assert.equal(result.selectedIssues[0].path, 'sceneBeats[1].obstacle');
    assert.equal(result.selectedDimensions.length, 1);
    assert.equal(result.selectedDimensions[0].key, 'scene_executability');
    assert.equal(result.revisionPriorities.length, 1);
    assert.equal(calls.agentRunCreate.length, 1);
    assert.equal(calls.agentArtifactCreate.length, 1);
    assert.equal(calls.assetWrites.length, 0);
    const agentInput = (calls.agentRunCreate[0] as { data: { input: Record<string, unknown> } }).data.input;
    assert.equal((agentInput.scoringRevision as Record<string, unknown>).agentTarget, 'chapter_craft_brief_preview');
  }

  {
    const { service } = createService(null as never);
    await assert.rejects(() => service.createRevision('project-2', 'score-1', { scoringRunId: 'score-1' }), NotFoundException);
  }

  {
    const { service, calls } = createService(scoringRun({ dimensions: dimensions().slice(1) }));
    await assert.rejects(() => service.createRevision('project-1', 'score-1', { scoringRunId: 'score-1' }), BadRequestException);
    assert.equal(calls.agentRunCreate.length, 0);
  }

  {
    const { service, calls } = createService(scoringRun({ targetSnapshot: { targetType, targetId: 'chapter-1' } }));
    await assert.rejects(() => service.createRevision('project-1', 'score-1', { scoringRunId: 'score-1' }), BadRequestException);
    assert.equal(calls.agentRunCreate.length, 0);
  }

  {
    const { service } = createService();
    await assert.rejects(
      () => service.createRevision('project-1', 'score-1', { scoringRunId: 'score-1', entryPoint: 'dimension', selectedDimensions: ['missing_dimension'] }),
      BadRequestException,
    );
    await assert.rejects(
      () => service.createRevision('project-1', 'score-1', { scoringRunId: 'other-run' }),
      BadRequestException,
    );
  }

  {
    const scoringRevisionService = { createRevision: async () => ({ agentRunId: 'agent-run-1' }) };
    const controller = new ScoringController({} as never, scoringRevisionService as never);
    const response = await controller.createRevision('project-1', 'score-1', { scoringRunId: 'score-1' });
    assert.equal(response.agentRunId, 'agent-run-1');
  }
}

run().then(() => {
  console.log('scoring revision: ok');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
