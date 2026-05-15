import fs from 'node:fs';
import path from 'node:path';
import {
  PlatformProfileKey,
  SCORING_PROMPT_VERSION,
  SCORING_RUBRIC_VERSION,
  ScoringIssue,
  ScoringReportPayload,
  ScoringTargetType,
  validateScoringReportPayload,
} from '../../apps/api/src/modules/scoring/scoring-contracts';
import { getTargetDimensionKeys } from '../../apps/api/src/modules/scoring/scoring-dimensions';
import { assertPlatformProfileCoversTarget, getPlatformProfile } from '../../apps/api/src/modules/scoring/platform-scoring-profiles';

type StructuralFault = 'omit_dimensions' | 'omit_evidence' | undefined;

interface ScoringEvalCase {
  id: string;
  targetType: ScoringTargetType;
  profileKey: PlatformProfileKey;
  promptVersion: string;
  rubricVersion: string;
  profileVersion: string;
  expectedValid: boolean;
  expectedBlockingIssueDimensionKeys: string[];
  dimensionScoreOverrides?: Record<string, number>;
  blockingIssues: ScoringIssue[];
  revisionPriorities: string[];
  structuralFault?: StructuralFault;
}

interface EvalCheck {
  passed: number;
  total: number;
}

interface CaseResult {
  id: string;
  targetType: ScoringTargetType;
  profileKey: PlatformProfileKey;
  promptVersion: string;
  rubricVersion: string;
  profileVersion: string;
  expectedValid: boolean;
  valid: boolean;
  structureError?: string;
  dimensionCoverage: boolean;
  expectedBlockingIssueHit: boolean | null;
  falsePositiveBlockingIssue: boolean;
  failures: string[];
}

interface EvalReport {
  generatedAt: string;
  casesPath: string;
  totalCases: number;
  passedCases: number;
  metrics: {
    dimensionCoverage: EvalCheck & { rate: number };
    blockingIssueHit: EvalCheck & { rate: number };
    falsePositiveRate: { falsePositives: number; total: number; rate: number };
    structureFailureRate: { structureFailures: number; total: number; rate: number };
    versionCoverage: EvalCheck & { rate: number };
  };
  failures: Array<{ id: string; failures: string[] }>;
  cases: CaseResult[];
}

const repoRoot = findRepoRoot();
const casesPath = path.resolve(repoRoot, readArg('--cases') ?? 'apps/api/test/fixtures/scoring-eval-cases.json');
const reportPath = readArg('--report');
const historyPath = readArg('--history');

const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8')) as ScoringEvalCase[];
const results = cases.map(evaluateCase);
const report = buildReport(results);

if (reportPath) {
  writeJson(path.resolve(process.cwd(), reportPath), report);
}
if (historyPath) {
  appendHistory(path.resolve(process.cwd(), historyPath), report);
}

printSummary(report);

if (report.failures.length) {
  process.exitCode = 1;
}

function evaluateCase(item: ScoringEvalCase): CaseResult {
  const failures: string[] = [];
  const versionCoverage = item.promptVersion === SCORING_PROMPT_VERSION
    && item.rubricVersion === SCORING_RUBRIC_VERSION
    && item.profileVersion === getPlatformProfile(item.profileKey).version;
  if (!versionCoverage) failures.push('prompt/rubric/profile version mismatch');

  let valid = false;
  let structureError: string | undefined;
  let payload: ScoringReportPayload | null = null;
  try {
    payload = validateScoringReportPayload(buildReportPayload(item), {
      targetType: item.targetType,
      platformProfile: item.profileKey,
      expectedDimensionWeights: assertPlatformProfileCoversTarget(item.targetType, item.profileKey),
    });
    valid = true;
  } catch (error) {
    structureError = error instanceof Error ? error.message : String(error);
  }

  if (item.expectedValid && !valid) failures.push(`expected valid report, got structure error: ${structureError}`);
  if (!item.expectedValid && valid) failures.push('expected structural failure, but report passed validation');

  const expectedKeys = getTargetDimensionKeys(item.targetType);
  const actualKeys = payload?.dimensions.map((dimension) => dimension.key) ?? [];
  const dimensionCoverage = valid && expectedKeys.length === actualKeys.length && expectedKeys.every((key) => actualKeys.includes(key));
  if (item.expectedValid && !dimensionCoverage) failures.push('dimension coverage did not match target rubric');

  const blockingIssues = payload?.blockingIssues.filter((issue) => issue.severity === 'blocking') ?? [];
  const expectedBlockingIssueHit = item.expectedBlockingIssueDimensionKeys.length
    ? item.expectedBlockingIssueDimensionKeys.every((key) => blockingIssues.some((issue) => issue.dimensionKey === key))
    : null;
  if (item.expectedBlockingIssueDimensionKeys.length && !expectedBlockingIssueHit) {
    failures.push(`missing expected blocking issue dimensions: ${item.expectedBlockingIssueDimensionKeys.join(', ')}`);
  }
  const falsePositiveBlockingIssue = item.expectedValid && item.expectedBlockingIssueDimensionKeys.length === 0 && blockingIssues.length > 0;
  if (falsePositiveBlockingIssue) failures.push('blocking issue false positive on no-blocking fixture');

  return {
    id: item.id,
    targetType: item.targetType,
    profileKey: item.profileKey,
    promptVersion: item.promptVersion,
    rubricVersion: item.rubricVersion,
    profileVersion: item.profileVersion,
    expectedValid: item.expectedValid,
    valid,
    structureError,
    dimensionCoverage,
    expectedBlockingIssueHit,
    falsePositiveBlockingIssue,
    failures,
  };
}

function buildReportPayload(item: ScoringEvalCase): unknown {
  const weights = assertPlatformProfileCoversTarget(item.targetType, item.profileKey);
  const dimensions = Object.entries(weights).map(([key, weight], index) => {
    const score = item.dimensionScoreOverrides?.[key] ?? 78 + (index % 7);
    return {
      key,
      label: key,
      score,
      weight,
      weightedScore: Number(((score * weight) / 100).toFixed(4)),
      confidence: 'high',
      evidence: `${item.id}:${key}:evidence`,
      reason: `${item.id}:${key}:reason`,
      suggestion: `${item.id}:${key}:suggestion`,
    };
  });
  if (item.structuralFault === 'omit_evidence' && dimensions[0]) dimensions[0].evidence = '';

  const payload: Record<string, unknown> = {
    targetType: item.targetType,
    platformProfile: item.profileKey,
    overallScore: average(dimensions.map((dimension) => dimension.score)),
    verdict: item.blockingIssues.some((issue) => issue.severity === 'blocking') ? 'fail' : 'pass',
    summary: `Scoring eval fixture ${item.id}.`,
    extractedElements: { fixtureId: item.id, targetType: item.targetType },
    dimensions,
    blockingIssues: item.blockingIssues,
    revisionPriorities: item.revisionPriorities,
  };
  if (item.structuralFault === 'omit_dimensions') delete payload.dimensions;
  return payload;
}

function buildReport(items: CaseResult[]): EvalReport {
  const expectedValid = items.filter((item) => item.expectedValid);
  const blockingExpected = items.filter((item) => item.expectedBlockingIssueHit !== null);
  const noBlockingExpected = items.filter((item) => item.expectedValid && item.expectedBlockingIssueHit === null);
  const versionPassed = items.filter((item) =>
    item.promptVersion === SCORING_PROMPT_VERSION
    && item.rubricVersion === SCORING_RUBRIC_VERSION
    && item.profileVersion === getPlatformProfile(item.profileKey).version,
  ).length;
  const dimensionPassed = expectedValid.filter((item) => item.dimensionCoverage).length;
  const blockingPassed = blockingExpected.filter((item) => item.expectedBlockingIssueHit).length;
  const falsePositives = noBlockingExpected.filter((item) => item.falsePositiveBlockingIssue).length;
  const structureFailures = items.filter((item) => !item.valid).length;
  return {
    generatedAt: new Date().toISOString(),
    casesPath,
    totalCases: items.length,
    passedCases: items.filter((item) => !item.failures.length).length,
    metrics: {
      dimensionCoverage: withRate(dimensionPassed, expectedValid.length),
      blockingIssueHit: withRate(blockingPassed, blockingExpected.length),
      falsePositiveRate: {
        falsePositives,
        total: noBlockingExpected.length,
        rate: rate(falsePositives, noBlockingExpected.length),
      },
      structureFailureRate: {
        structureFailures,
        total: items.length,
        rate: rate(structureFailures, items.length),
      },
      versionCoverage: withRate(versionPassed, items.length),
    },
    failures: items.filter((item) => item.failures.length).map((item) => ({ id: item.id, failures: item.failures })),
    cases: items,
  };
}

function withRate(passed: number, total: number) {
  return { passed, total, rate: rate(passed, total) };
}

function rate(numerator: number, total: number) {
  return total ? Number((numerator / total).toFixed(4)) : 1;
}

function average(values: number[]) {
  if (!values.length) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function printSummary(item: EvalReport) {
  console.log(`scoring eval: ${item.passedCases}/${item.totalCases} cases passed`);
  console.log(`dimensionCoverage=${item.metrics.dimensionCoverage.rate}`);
  console.log(`blockingIssueHit=${item.metrics.blockingIssueHit.rate}`);
  console.log(`falsePositiveRate=${item.metrics.falsePositiveRate.rate}`);
  console.log(`structureFailureRate=${item.metrics.structureFailureRate.rate}`);
  if (item.failures.length) {
    for (const failure of item.failures) console.error(`${failure.id}: ${failure.failures.join('; ')}`);
  }
}

function appendHistory(filePath: string, item: EvalReport) {
  const existing = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : [];
  const history = Array.isArray(existing) ? existing : [];
  history.push(item);
  writeJson(filePath, history.slice(-50));
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readArg(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function findRepoRoot() {
  let current = process.cwd();
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))) return current;
    current = path.dirname(current);
  }
  return process.cwd();
}
