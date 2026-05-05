#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const ReactDOMServer = require('react-dom/server');

const repoRoot = path.resolve(__dirname, '../..');

require.extensions['.ts'] = require.extensions['.tsx'] = function compileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const continuityModulePath = path.join(repoRoot, 'apps/web/hooks/useContinuityActions.ts');
const actualContinuityActions = require(continuityModulePath);

const mockState = createMockState();
require.cache[continuityModulePath] = {
  id: continuityModulePath,
  filename: continuityModulePath,
  loaded: true,
  exports: createContinuityHookMocks(mockState),
};

const { AgentArtifactPanel } = require(path.join(repoRoot, 'apps/web/components/agent/AgentArtifactPanel.tsx'));
const { QualityReportPanel } = require(path.join(repoRoot, 'apps/web/components/QualityReportPanel.tsx'));
const { SceneBankPanel } = require(path.join(repoRoot, 'apps/web/components/SceneBankPanel.tsx'));
const { PacingPanel } = require(path.join(repoRoot, 'apps/web/components/PacingPanel.tsx'));
const { ChapterPatternPanel } = require(path.join(repoRoot, 'apps/web/components/ChapterPatternPanel.tsx'));

global.window = { confirm: () => true };

const tests = [];
test('project-scoped request paths are generated for longform resources', () => {
  assertEqual(actualContinuityActions.buildContinuityCollectionPath('project-alpha', 'scenes'), '/projects/project-alpha/scenes');
  assertEqual(actualContinuityActions.buildContinuityItemPath('project-alpha', 'pacing-beats', 'beat-1'), '/projects/project-alpha/pacing-beats/beat-1');
  assertEqual(
    actualContinuityActions.buildQualityReportPath('project-alpha', {
      chapterId: 'chapter-7',
      draftId: '',
      sourceType: 'ai_review',
      reportType: 'all',
      verdict: 'warn',
    }),
    '/projects/project-alpha/quality-reports?chapterId=chapter-7&sourceType=ai_review&verdict=warn',
  );
});

test('AgentArtifactPanel renders story bible, continuity, persist, empty, error, and JSON fallback states', () => {
  let persistSelectionRequests = 0;
  const html = renderComponent(AgentArtifactPanel, {
    run: {
      id: 'run-artifacts',
      artifacts: [
        artifact('story_bible_preview', {
          candidates: [
            { title: '灵脉禁制', entryType: 'world_rule', summary: '禁制只能由宗门长老开启。' },
          ],
          risks: ['需要复核旧设定'],
          writePlan: { target: 'LorebookEntry', requiresApprovalBeforePersist: true },
        }),
        artifact('story_bible_validation_report', {
          valid: false,
          accepted: [{ candidateId: 'candidate-accepted' }],
          rejected: [{ candidateId: 'candidate-rejected' }],
          issueCount: 1,
          issues: [{ severity: 'warning', message: '与旧货币体系存在差异' }],
          writePreview: { summary: { createCount: 1, updateCount: 1, rejectCount: 1 } },
        }),
        artifact('story_bible_persist_result', {
          createdCount: 1,
          updatedCount: 1,
          skippedUnselectedCount: 1,
          approval: { approved: true },
          perEntryAudit: [{ title: '灵石货币', action: 'created', reason: '通过校验' }],
        }),
        artifact('continuity_preview', {
          relationshipCandidates: [
            { characterAName: '林烬', characterBName: '沈怀舟', relationType: '师徒裂痕', action: 'update', impactAnalysis: '关系公开状态需要改写。' },
          ],
          timelineCandidates: [
            { title: '宗主灭门真相', chapterNo: 12, action: 'create', impactAnalysis: '补足知情范围。' },
          ],
          writePlan: { mode: 'preview_only', requiresApprovalBeforePersist: true },
        }),
        artifact('continuity_validation_report', {
          valid: false,
          accepted: {
            relationshipCandidates: [{ candidateId: 'rel-ok' }],
            timelineCandidates: [{ candidateId: 'time-ok' }],
          },
          rejected: {
            relationshipCandidates: [{ candidateId: 'rel-bad' }],
            timelineCandidates: [{ candidateId: 'time-bad' }],
          },
          issues: [{ candidateType: 'relationship', severity: 'error', message: '角色 ID 与名称不一致' }],
          writePreview: {
            relationshipCandidates: { summary: { createCount: 1, updateCount: 1, deleteCount: 0, rejectCount: 1 } },
            timelineCandidates: { summary: { createCount: 1, updateCount: 0, deleteCount: 1, rejectCount: 1 } },
          },
        }),
        artifact('continuity_persist_result', {
          dryRun: false,
          relationshipResults: { createdCount: 1, updatedCount: 1, deletedCount: 0, created: [{ label: '林烬 -> 沈怀舟' }] },
          timelineResults: { createdCount: 1, updatedCount: 0, deletedCount: 1, deleted: [{ label: '旧时间线误差' }] },
          skippedUnselectedCandidates: { relationshipCandidates: [{}], timelineCandidates: [{}] },
        }),
        artifact('unknown_error_artifact', { error: 'preview failed gracefully', marker: 'fallback-marker' }),
      ],
      steps: [],
    },
    query: '',
    onQueryChange: () => {},
    onRequestWorldbuildingPersistSelection: () => { persistSelectionRequests += 1; },
    actionDisabled: true,
  });

  assertIncludes(html, ['灵脉禁制', '候选设定', '已接受', '已拒绝', '将创建', '将更新', '将拒绝']);
  assertIncludes(html, ['灵石货币', '关系变更', '时间线变更', '林烬', '沈怀舟', '宗主灭门真相']);
  assertIncludes(html, ['关系 Diff', '时间线 Diff', '创建', '更新', '删除', '未选跳过']);
  assertIncludes(html, ['暂无专用视图', 'preview failed gracefully', 'fallback-marker']);
  assertEqual(persistSelectionRequests, 0);

  const emptyHtml = renderComponent(AgentArtifactPanel, { run: null, query: '', onQueryChange: () => {} });
  assertIncludes(emptyHtml, ['计划产物和预览会在这里展开']);
  const noMatchHtml = renderComponent(AgentArtifactPanel, {
    run: { id: 'run-artifacts', artifacts: [artifact('story_bible_preview', { candidates: [] })], steps: [] },
    query: 'no-match',
    onQueryChange: () => {},
  });
  assertIncludes(noMatchHtml, ['没有匹配的产物']);
});

test('QualityReportPanel renders list, details, metadata, empty, error, and JSON fallback states', () => {
  resetMockState();
  mockState.quality.qualityReports = [
    {
      id: 'report-1',
      projectId: 'project-alpha',
      chapterId: 'chapter-1',
      draftId: 'draft-1234567890',
      agentRunId: 'agent-run-1234567890',
      sourceType: 'ai_review',
      sourceId: 'source-review-1',
      reportType: 'ai_review',
      scores: { plot: 82, pacing: 0.72, nested: { trend: 'down', reason: 'slow middle' } },
      issues: [
        { severity: 'warning', message: '伏笔没有兑现', suggestion: '在结尾补一处回收动作。' },
        { raw_issue: 'json-fallback-issue' },
      ],
      verdict: 'warn',
      summary: '第十二章 AI 审稿摘要',
      metadata: {
        focus: '伏笔回收',
        instruction: '只检查第十二章伏笔是否兑现。',
        sourceMetadata: { draftVersion: 3, excerpt: '雨夜破庙伏击片段' },
        model: 'review-model',
      },
      createdAt: '2026-05-05T12:00:00.000Z',
      updatedAt: '2026-05-05T12:00:00.000Z',
    },
  ];

  const html = renderQualityReportPanel();
  assertIncludes(html, ['质量报告', '第十二章 AI 审稿摘要', 'warn', 'ai_review', 'Ch.12']);
  assertIncludes(html, ['评分', 'plot', '82', 'pacing', '0.72', 'trend', 'down']);
  assertIncludes(html, ['问题列表', '伏笔没有兑现', '在结尾补一处回收动作', 'json-fallback-issue']);
  assertIncludes(html, ['AI 审稿元数据', 'focus', '伏笔回收', 'instruction', '只检查第十二章伏笔是否兑现']);
  assertIncludes(html, ['source.draftVersion', '3', 'source.excerpt', '雨夜破庙伏击片段', 'model', 'review-model']);
  assertEqual(mockState.quality.calls.delete.length, 0);

  mockState.quality.qualityReports = [];
  assertIncludes(renderQualityReportPanel(), ['暂无质量报告']);
  mockState.quality.error = '加载质量报告失败';
  assertIncludes(renderQualityReportPanel(), ['加载质量报告失败']);
  assertIncludes(renderComponent(QualityReportPanel, { selectedProjectId: '', selectedChapterId: 'all', chapters: [], selectedProject: undefined }), ['请先选择项目']);
});

test('SceneBankPanel covers filters, refresh, create, edit, archive, delete, and JSON validation', async () => {
  resetMockState();
  mockState.scene.items = [
    scene({ id: 'scene-1', title: '雨夜破庙伏击', chapterId: 'chapter-1', sceneNo: 1, status: 'planned', locationName: '破庙', participants: ['林烬'], metadata: { weather: 'rain' } }),
    scene({ id: 'scene-2', title: '旧场景归档', chapterId: 'chapter-2', sceneNo: 2, status: 'archived', locationName: '旧城', participants: ['沈怀舟'] }),
  ];
  const harness = createHarness(SceneBankPanel, baseSceneProps());
  harness.render();
  assertAtLeast(mockState.scene.calls.load, 1);
  assertIncludes(harness.html(), ['雨夜破庙伏击', '旧场景归档']);

  change(findByPlaceholder(harness.tree, '搜索标题'), '破庙');
  harness.render();
  assertIncludes(harness.html(), ['雨夜破庙伏击']);
  assertNotIncludes(harness.html(), ['旧场景归档']);

  change(findSelectWithOption(harness.tree, '全部状态'), 'archived');
  harness.render();
  assertIncludes(harness.html(), ['暂无场景卡']);
  change(findByPlaceholder(harness.tree, '搜索标题'), '');
  harness.render();
  assertIncludes(harness.html(), ['旧场景归档']);

  await click(findExactButton(harness.tree, '刷新'));
  assertAtLeast(mockState.scene.calls.load, 2);

  await click(findExactButton(harness.tree, '新建'));
  harness.render();
  change(findFieldControl(harness.tree, '场景标题', 'input'), '新场景');
  change(findFieldControl(harness.tree, 'metadata JSON', 'textarea'), '[');
  harness.render();
  await click(findExactButton(harness.tree, '保存'));
  harness.render();
  assertEqual(mockState.scene.calls.create.length, 0);
  assertIncludes(harness.html(), ['Unexpected']);

  change(findFieldControl(harness.tree, 'metadata JSON', 'textarea'), '{"camera":"close"}');
  harness.render();
  await click(findExactButton(harness.tree, '保存'));
  harness.render();
  assertEqual(mockState.scene.calls.create.length, 1);
  assertEqual(mockState.scene.calls.create[0].metadata.camera, 'close');

  change(findSelectWithOption(harness.tree, '全部状态'), 'all');
  harness.render();
  await click(findButton(harness.tree, '雨夜破庙伏击'));
  harness.render();
  await click(findExactButton(harness.tree, '保存'));
  assertEqual(mockState.scene.calls.update.at(-1).id, 'scene-1');
  assertEqual(mockState.scene.calls.update.at(-1).data.title, '雨夜破庙伏击');

  await click(findButton(harness.tree, '雨夜破庙伏击'));
  harness.render();
  await click(findExactButton(harness.tree, '归档'));
  assertEqual(mockState.scene.calls.update.at(-1).data.status, 'archived');

  await click(findButton(harness.tree, '雨夜破庙伏击'));
  harness.render();
  await click(findExactButton(harness.tree, '删除'));
  assertEqual(mockState.scene.calls.delete.at(-1), 'scene-1');
});

test('PacingPanel covers filters, refresh, create, edit, delete, and JSON validation', async () => {
  resetMockState();
  mockState.pacing.items = [
    pacing({ id: 'beat-1', beatType: 'turn', emotionalTone: '反转', chapterId: 'chapter-1', chapterNo: 12, tensionLevel: 88, metadata: { arc: 'betrayal' } }),
    pacing({ id: 'beat-2', beatType: 'payoff', emotionalTone: '释然', chapterId: 'chapter-2', chapterNo: 13, tensionLevel: 30 }),
  ];
  const harness = createHarness(PacingPanel, baseSceneProps());
  harness.render();
  assertAtLeast(mockState.pacing.calls.load, 1);
  assertIncludes(harness.html(), ['turn', 'payoff']);

  change(findByPlaceholder(harness.tree, '搜索类型'), '反转');
  harness.render();
  assertIncludes(harness.html(), ['turn']);
  assertNotIncludes(harness.html(), ['释然']);

  change(findSelectWithOption(harness.tree, '全部类型'), 'payoff');
  harness.render();
  assertIncludes(harness.html(), ['暂无节奏节点']);
  change(findByPlaceholder(harness.tree, '搜索类型'), '');
  harness.render();
  assertIncludes(harness.html(), ['payoff']);

  await click(findExactButton(harness.tree, '刷新'));
  assertAtLeast(mockState.pacing.calls.load, 2);

  await click(findExactButton(harness.tree, '新建'));
  harness.render();
  change(findFieldControl(harness.tree, '节奏类型', 'input'), 'reveal');
  change(findFieldControl(harness.tree, 'metadata JSON', 'textarea'), '[');
  harness.render();
  await click(findExactButton(harness.tree, '保存'));
  harness.render();
  assertEqual(mockState.pacing.calls.create.length, 0);
  assertIncludes(harness.html(), ['Unexpected']);

  change(findFieldControl(harness.tree, 'metadata JSON', 'textarea'), '{"beat":"midpoint"}');
  harness.render();
  await click(findExactButton(harness.tree, '保存'));
  harness.render();
  assertEqual(mockState.pacing.calls.create.length, 1);
  assertEqual(mockState.pacing.calls.create[0].metadata.beat, 'midpoint');

  change(findSelectWithOption(harness.tree, '全部类型'), 'all');
  harness.render();
  await click(findButton(harness.tree, 'turn'));
  harness.render();
  await click(findExactButton(harness.tree, '保存'));
  assertEqual(mockState.pacing.calls.update.at(-1).id, 'beat-1');
  assertEqual(mockState.pacing.calls.update.at(-1).data.beatType, 'turn');

  await click(findButton(harness.tree, 'turn'));
  harness.render();
  await click(findExactButton(harness.tree, '删除'));
  assertEqual(mockState.pacing.calls.delete.at(-1), 'beat-1');
});

test('ChapterPatternPanel covers filters, refresh, create, edit, archive, delete, and JSON validation', async () => {
  resetMockState();
  mockState.pattern.items = [
    pattern({ id: 'pattern-1', name: '追逐模板', patternType: 'chase', applicableScenes: ['追逐', '伏击'], status: 'active', structure: { beats: 3 } }),
    pattern({ id: 'pattern-2', name: '归档模板', patternType: 'payoff', applicableScenes: ['收束'], status: 'archived' }),
  ];
  const harness = createHarness(ChapterPatternPanel, { selectedProjectId: 'project-alpha', selectedProject: project() });
  harness.render();
  assertAtLeast(mockState.pattern.calls.load, 1);
  assertIncludes(harness.html(), ['追逐模板', '归档模板']);

  change(findByPlaceholder(harness.tree, '搜索名称'), '追逐');
  harness.render();
  assertIncludes(harness.html(), ['追逐模板']);
  assertNotIncludes(harness.html(), ['归档模板']);

  change(findSelectWithOption(harness.tree, '全部状态'), 'archived');
  harness.render();
  assertIncludes(harness.html(), ['暂无章节模式']);
  change(findByPlaceholder(harness.tree, '搜索名称'), '');
  harness.render();
  assertIncludes(harness.html(), ['归档模板']);

  await click(findExactButton(harness.tree, '刷新'));
  assertAtLeast(mockState.pattern.calls.load, 2);

  await click(findExactButton(harness.tree, '新建'));
  harness.render();
  change(findFieldControl(harness.tree, '模式名称', 'input'), '新模板');
  change(findFieldControl(harness.tree, 'structure JSON', 'textarea'), '[');
  harness.render();
  await click(findExactButton(harness.tree, '保存'));
  harness.render();
  assertEqual(mockState.pattern.calls.create.length, 0);
  assertIncludes(harness.html(), ['Unexpected']);

  change(findFieldControl(harness.tree, 'structure JSON', 'textarea'), '{"beats":4}');
  harness.render();
  await click(findExactButton(harness.tree, '保存'));
  harness.render();
  assertEqual(mockState.pattern.calls.create.length, 1);
  assertEqual(mockState.pattern.calls.create[0].structure.beats, 4);

  change(findSelectWithOption(harness.tree, '全部状态'), 'all');
  harness.render();
  await click(findButton(harness.tree, '追逐模板'));
  harness.render();
  await click(findExactButton(harness.tree, '保存'));
  assertEqual(mockState.pattern.calls.update.at(-1).id, 'pattern-1');
  assertEqual(mockState.pattern.calls.update.at(-1).data.name, '追逐模板');

  await click(findButton(harness.tree, '追逐模板'));
  harness.render();
  await click(findExactButton(harness.tree, '归档'));
  assertEqual(mockState.pattern.calls.update.at(-1).data.status, 'archived');

  await click(findButton(harness.tree, '追逐模板'));
  harness.render();
  await click(findExactButton(harness.tree, '删除'));
  assertEqual(mockState.pattern.calls.delete.at(-1), 'pattern-1');
});

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  let passed = 0;
  for (const item of tests) {
    try {
      await item.fn();
      passed += 1;
      console.log(`ok ${passed} - ${item.name}`);
    } catch (error) {
      console.error(`not ok - ${item.name}`);
      throw error;
    }
  }
  console.log(`\n${passed}/${tests.length} longform web interaction tests passed.`);
}

function artifact(artifactType, content) {
  return {
    id: `${artifactType}-${Math.random().toString(16).slice(2)}`,
    artifactType,
    title: artifactType,
    content,
    createdAt: '2026-05-05T12:00:00.000Z',
  };
}

function renderComponent(Component, props) {
  return ReactDOMServer.renderToStaticMarkup(React.createElement(Component, props));
}

function renderQualityReportPanel(extraProps = {}) {
  return renderComponent(QualityReportPanel, {
    selectedProjectId: 'project-alpha',
    selectedChapterId: 'all',
    chapters: chapters(),
    selectedProject: project(),
    ...extraProps,
  });
}

function createMockState() {
  return {
    quality: qualityMock(),
    scene: resourceMock(),
    pacing: resourceMock(),
    pattern: resourceMock(),
  };
}

function resetMockState() {
  Object.assign(mockState.quality, qualityMock());
  Object.assign(mockState.scene, resourceMock());
  Object.assign(mockState.pacing, resourceMock());
  Object.assign(mockState.pattern, resourceMock());
}

function resourceMock() {
  const state = {
    items: [],
    loading: false,
    formLoading: false,
    error: '',
    calls: { load: 0, create: [], update: [], delete: [] },
  };
  state.setError = (value) => { state.error = value; };
  state.load = async () => { state.calls.load += 1; return state.items; };
  state.create = async (data) => { state.calls.create.push(data); return true; };
  state.update = async (id, data) => { state.calls.update.push({ id, data }); return true; };
  state.delete = async (id) => { state.calls.delete.push(id); return true; };
  return state;
}

function qualityMock() {
  const state = {
    qualityReports: [],
    loading: false,
    formLoading: false,
    error: '',
    calls: { load: [], delete: [] },
  };
  state.setError = (value) => { state.error = value; };
  state.load = async (filters) => { state.calls.load.push(filters); return state.qualityReports; };
  state.delete = async (id) => { state.calls.delete.push(id); return true; };
  return state;
}

function createContinuityHookMocks(state) {
  return {
    useQualityReportActions: () => ({
      qualityReports: state.quality.qualityReports,
      loading: state.quality.loading,
      formLoading: state.quality.formLoading,
      error: state.quality.error,
      setError: state.quality.setError,
      loadQualityReports: state.quality.load,
      deleteQualityReport: state.quality.delete,
    }),
    useSceneActions: () => ({
      scenes: state.scene.items,
      loading: state.scene.loading,
      formLoading: state.scene.formLoading,
      error: state.scene.error,
      setError: state.scene.setError,
      loadScenes: state.scene.load,
      createScene: state.scene.create,
      updateScene: state.scene.update,
      deleteScene: state.scene.delete,
    }),
    usePacingBeatActions: () => ({
      pacingBeats: state.pacing.items,
      loading: state.pacing.loading,
      formLoading: state.pacing.formLoading,
      error: state.pacing.error,
      setError: state.pacing.setError,
      loadPacingBeats: state.pacing.load,
      createPacingBeat: state.pacing.create,
      updatePacingBeat: state.pacing.update,
      deletePacingBeat: state.pacing.delete,
    }),
    useChapterPatternActions: () => ({
      chapterPatterns: state.pattern.items,
      loading: state.pattern.loading,
      formLoading: state.pattern.formLoading,
      error: state.pattern.error,
      setError: state.pattern.setError,
      loadChapterPatterns: state.pattern.load,
      createChapterPattern: state.pattern.create,
      updateChapterPattern: state.pattern.update,
      deleteChapterPattern: state.pattern.delete,
    }),
  };
}

function createHarness(Component, props) {
  const realHooks = {
    useState: React.useState,
    useMemo: React.useMemo,
    useEffect: React.useEffect,
    useCallback: React.useCallback,
  };
  const stateValues = [];
  const effectDeps = [];
  let hookIndex = 0;
  let effectIndex = 0;
  let pendingEffects = [];
  const harness = {
    tree: null,
    render() {
      hookIndex = 0;
      effectIndex = 0;
      pendingEffects = [];
      React.useState = (initialValue) => {
        const index = hookIndex;
        hookIndex += 1;
        if (stateValues.length <= index) {
          stateValues[index] = typeof initialValue === 'function' ? initialValue() : initialValue;
        }
        const setValue = (nextValue) => {
          stateValues[index] = typeof nextValue === 'function' ? nextValue(stateValues[index]) : nextValue;
        };
        return [stateValues[index], setValue];
      };
      React.useMemo = (factory) => factory();
      React.useCallback = (callback) => callback;
      React.useEffect = (effect, deps) => {
        const index = effectIndex;
        effectIndex += 1;
        if (!depsEqual(effectDeps[index], deps)) {
          effectDeps[index] = deps;
          pendingEffects.push(effect);
        }
      };
      try {
        harness.tree = Component(props);
      } finally {
        React.useState = realHooks.useState;
        React.useMemo = realHooks.useMemo;
        React.useEffect = realHooks.useEffect;
        React.useCallback = realHooks.useCallback;
      }
      for (const effect of pendingEffects) effect();
      return harness.tree;
    },
    html() {
      return ReactDOMServer.renderToStaticMarkup(harness.tree);
    },
  };
  return harness;
}

function depsEqual(previous, next) {
  if (!previous || !next || previous.length !== next.length) return false;
  return previous.every((value, index) => Object.is(value, next[index]));
}

function childrenOf(node) {
  if (!node || typeof node !== 'object') return [];
  return React.Children.toArray(node.props?.children);
}

function findAll(node, predicate, result = []) {
  if (Array.isArray(node)) {
    node.forEach((item) => findAll(item, predicate, result));
    return result;
  }
  if (!React.isValidElement(node)) return result;
  if (predicate(node)) result.push(node);
  childrenOf(node).forEach((child) => findAll(child, predicate, result));
  if (node.props?.children && !childrenOf(node).length) findAll(node.props.children, predicate, result);
  return result;
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!React.isValidElement(node)) return '';
  return childrenOf(node).map(textOf).join('');
}

function findByPlaceholder(root, text) {
  const found = findAll(root, (node) => typeof node.props?.placeholder === 'string' && node.props.placeholder.includes(text))[0];
  if (!found) throw new Error(`Could not find control with placeholder containing "${text}"`);
  return found;
}

function findSelectWithOption(root, optionText) {
  const found = findAll(root, (node) => node.type === 'select' && childrenOf(node).some((child) => textOf(child).includes(optionText)))[0];
  if (!found) throw new Error(`Could not find select with option "${optionText}"`);
  return found;
}

function findFieldControl(root, labelText, controlType) {
  const field = findAll(root, (node) => typeof node.props?.label === 'string' && node.props.label.includes(labelText))[0];
  if (!field) throw new Error(`Could not find field "${labelText}"`);
  const control = findAll(field.props.children, (node) => node.type === controlType)[0];
  if (!control) throw new Error(`Could not find ${controlType} in field "${labelText}"`);
  return control;
}

function findButton(root, text) {
  const matches = findAll(root, (node) => node.type === 'button' && textOf(node).includes(text));
  if (!matches.length) throw new Error(`Could not find button containing "${text}"`);
  return matches[0];
}

function findExactButton(root, text) {
  const matches = findAll(root, (node) => node.type === 'button' && textOf(node).trim() === text);
  if (!matches.length) throw new Error(`Could not find button "${text}"`);
  return matches[0];
}

function change(control, value) {
  if (typeof control.props.onChange !== 'function') throw new Error('Control has no onChange handler');
  control.props.onChange({ target: { value } });
}

async function click(button) {
  if (typeof button.props.onClick !== 'function') throw new Error('Button has no onClick handler');
  return button.props.onClick({ preventDefault() {} });
}

function project() {
  return { id: 'project-alpha', title: '长篇测试项目', status: 'active' };
}

function chapters() {
  return [
    { id: 'chapter-1', volumeId: 'volume-1', chapterNo: 12, title: '破庙雨夜' },
    { id: 'chapter-2', volumeId: 'volume-1', chapterNo: 13, title: '旧城余波' },
  ];
}

function volumes() {
  return [{ id: 'volume-1', projectId: 'project-alpha', volumeNo: 1, title: '第一卷', status: 'active' }];
}

function baseSceneProps() {
  return { selectedProjectId: 'project-alpha', selectedProject: project(), volumes: volumes(), chapters: chapters() };
}

function scene(overrides) {
  return {
    id: 'scene-x',
    projectId: 'project-alpha',
    volumeId: 'volume-1',
    chapterId: 'chapter-1',
    sceneNo: 1,
    title: '场景',
    locationName: '地点',
    participants: [],
    purpose: '推进目标',
    conflict: '冲突',
    emotionalTone: '紧张',
    keyInformation: '关键信息',
    result: '结果',
    relatedForeshadowIds: [],
    status: 'planned',
    metadata: {},
    createdAt: '2026-05-05T12:00:00.000Z',
    updatedAt: '2026-05-05T12:00:00.000Z',
    ...overrides,
  };
}

function pacing(overrides) {
  return {
    id: 'beat-x',
    projectId: 'project-alpha',
    volumeId: 'volume-1',
    chapterId: 'chapter-1',
    chapterNo: 12,
    beatType: 'setup',
    emotionalTone: '紧张',
    emotionalIntensity: 50,
    tensionLevel: 50,
    payoffLevel: 50,
    notes: '节奏备注',
    metadata: {},
    createdAt: '2026-05-05T12:00:00.000Z',
    updatedAt: '2026-05-05T12:00:00.000Z',
    ...overrides,
  };
}

function pattern(overrides) {
  return {
    id: 'pattern-x',
    projectId: 'project-alpha',
    patternType: 'standard',
    name: '模板',
    applicableScenes: [],
    structure: {},
    pacingAdvice: {},
    emotionalAdvice: {},
    conflictAdvice: {},
    status: 'active',
    metadata: {},
    createdAt: '2026-05-05T12:00:00.000Z',
    updatedAt: '2026-05-05T12:00:00.000Z',
    ...overrides,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertAtLeast(actual, expected) {
  if (actual < expected) {
    throw new Error(`Expected ${actual} to be at least ${expected}`);
  }
}

function assertIncludes(value, fragments) {
  for (const fragment of fragments) {
    assert(String(value).includes(fragment), `Expected output to include ${JSON.stringify(fragment)}`);
  }
}

function assertNotIncludes(value, fragments) {
  for (const fragment of fragments) {
    assert(!String(value).includes(fragment), `Expected output not to include ${JSON.stringify(fragment)}`);
  }
}
