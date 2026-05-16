import assert from 'node:assert/strict';
import {
  SCORING_PROMPT_VERSION,
  SCORING_RUBRIC_VERSION,
  validateScoringReportPayload,
  validateScoringRunContractPayload,
  validateScoringTargetSnapshot,
} from './scoring-contracts';
import { assertPlatformProfileCoversTarget } from './platform-scoring-profiles';
import { buildScoringJsonSchema, buildScoringPromptMessages } from './scoring-prompts';

const targetType = 'chapter_craft_brief' as const;
const platformProfile = 'generic_longform' as const;
const weights = assertPlatformProfileCoversTarget(targetType, platformProfile);

function validReport() {
  return {
    targetType,
    platformProfile,
    overallScore: 78,
    verdict: 'warn',
    summary: '执行卡可写，但递交点偏弱。',
    extractedElements: {
      mainCharacters: ['主角'],
      coreEvents: ['主角追查线索'],
      keyScenes: ['黑市入口'],
      keyInformation: ['new clue'],
      continuityAnchors: ['handoff state'],
      marketSignals: ['platform hook'],
    },
    dimensions: Object.entries(weights).map(([key, weight]) => ({
      key,
      label: key,
      score: 80,
      weight,
      weightedScore: Number(((80 * weight) / 100).toFixed(4)),
      confidence: 'medium',
      evidence: `${key} evidence`,
      reason: `${key} reason`,
      suggestion: `${key} suggestion`,
    })),
    blockingIssues: [
      {
        dimensionKey: 'continuity_handoff',
        severity: 'warning',
        path: 'continuityState.handoffToNextChapter',
        evidence: '只写继续调查。',
        reason: '缺少具体递交动作。',
        suggestion: '补出下一章冲突入口。',
      },
    ],
    revisionPriorities: ['补强章节递交点'],
  };
}

function validSnapshot() {
  return {
    targetType,
    targetId: 'chapter-1',
    assetSummary: {
      title: '第 1 章执行卡',
      targetType,
      chapterNo: 1,
      source: 'chapter.craftBrief',
      updatedAt: '2026-05-16T00:00:00.000Z',
    },
    content: {
      craftBrief: {
        actionBeats: ['进入黑市', '追查线索'],
      },
    },
    sourceTrace: {
      projectId: 'project-1',
      chapterId: 'chapter-1',
    },
  };
}

function validRun() {
  return {
    targetType,
    targetId: 'chapter-1',
    profileKey: platformProfile,
    targetSnapshot: validSnapshot(),
    sourceTrace: {
      projectId: 'project-1',
      chapterId: 'chapter-1',
    },
    report: validReport(),
    promptVersion: SCORING_PROMPT_VERSION,
    rubricVersion: SCORING_RUBRIC_VERSION,
    profileVersion: 'profile.generic_longform.v1',
  };
}

function expectContractError(
  label: string,
  buildValue: () => unknown,
  runner: (value: unknown) => unknown = (value: unknown) => validateScoringReportPayload(value, { targetType, platformProfile, expectedDimensionWeights: weights }),
) {
  assert.throws(() => runner(buildValue()), Error, label);
}

assert.equal(validateScoringReportPayload(validReport(), { targetType, platformProfile, expectedDimensionWeights: weights }).dimensions.length, Object.keys(weights).length);
assert.equal(validateScoringTargetSnapshot(validSnapshot(), targetType).assetSummary.chapterNo, 1);
assert.equal(validateScoringRunContractPayload(validRun(), { targetType, platformProfile, expectedDimensionWeights: weights }).report.verdict, 'warn');
assertStrictObjectsDisallowAdditionalProperties(buildScoringJsonSchema().schema);
assertExactRequestedSchemaEnums(buildScoringJsonSchema({ targetType, platformProfile }).schema, targetType, platformProfile);
assertPromptLocksRequestedValuesAndScoreScale(buildScoringPromptMessages({ targetType, platformProfile, targetSnapshot: validSnapshot() }).user);

expectContractError('missing required top-level field fails', () => {
  const report = validReport() as Record<string, unknown>;
  delete report.summary;
  return report;
});

expectContractError('missing dimension fails', () => {
  const report = validReport();
  report.dimensions = report.dimensions.slice(1);
  return report;
});

expectContractError('invalid score fails', () => {
  const report = validReport();
  report.dimensions[0].score = 101;
  return report;
});

expectContractError('invalid weight fails', () => {
  const report = validReport();
  report.dimensions[0].weight = 99;
  report.dimensions[0].weightedScore = 79.2;
  return report;
});

expectContractError('missing evidence fails', () => {
  const report = validReport();
  report.dimensions[0].evidence = '';
  return report;
});

expectContractError('missing reason fails', () => {
  const report = validReport();
  report.dimensions[0].reason = '';
  return report;
});

expectContractError('missing suggestion fails', () => {
  const report = validReport();
  report.dimensions[0].suggestion = '';
  return report;
});

expectContractError('missing issue evidence fails', () => {
  const report = validReport();
  report.blockingIssues[0].evidence = '';
  return report;
});

expectContractError('missing target snapshot fails', () => {
  const run = validRun() as Record<string, unknown>;
  delete run.targetSnapshot;
  return run;
}, (value) => validateScoringRunContractPayload(value, { targetType, platformProfile, expectedDimensionWeights: weights }));

expectContractError('empty target snapshot content fails', () => {
  const snapshot = validSnapshot() as Record<string, unknown>;
  snapshot.content = {};
  return snapshot;
}, (value) => validateScoringTargetSnapshot(value, targetType));

console.log('scoring contracts: ok');

function assertStrictObjectsDisallowAdditionalProperties(schema: unknown, path = 'schema') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  const record = schema as Record<string, unknown>;

  if (record.type === 'object') {
    assert.equal(record.additionalProperties, false, `${path} must set additionalProperties: false`);
  }

  if (record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)) {
    for (const [key, value] of Object.entries(record.properties)) {
      assertStrictObjectsDisallowAdditionalProperties(value, `${path}.properties.${key}`);
    }
  }

  if (record.items) {
    assertStrictObjectsDisallowAdditionalProperties(record.items, `${path}.items`);
  }
}

function assertExactRequestedSchemaEnums(schema: unknown, targetTypeValue: string, platformProfileValue: string) {
  const record = schema as { properties?: Record<string, { enum?: string[] }> };
  assert.deepEqual(record.properties?.targetType?.enum, [targetTypeValue]);
  assert.deepEqual(record.properties?.platformProfile?.enum, [platformProfileValue]);
}

function assertPromptLocksRequestedValuesAndScoreScale(userPrompt: string) {
  const payload = JSON.parse(userPrompt) as { outputContract?: Record<string, unknown> };
  const outputContract = payload.outputContract as {
    exactOutputValues?: Record<string, unknown>;
    scoreScale?: string;
    weightedScoreFormula?: string;
  };
  assert.equal(outputContract.exactOutputValues?.targetType, targetType);
  assert.equal(outputContract.exactOutputValues?.platformProfile, platformProfile);
  assert.match(outputContract.scoreScale ?? '', /0-100/);
  assert.match(outputContract.weightedScoreFormula ?? '', /score \* dimension\.weight \/ 100/);
}
