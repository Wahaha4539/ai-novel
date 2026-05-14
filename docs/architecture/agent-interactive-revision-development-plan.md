# Agent 交互修订与正文选区局部改写开发计划

> 日期：2026-05-14  
> 状态：待确认开发计划  
> 范围：Agent 工作流、章节正文编辑器、局部修订预览与写入、Artifact 交互修复  
> 目标：把当前“生成完整内容后审批”的固定流程，升级为“预览、交流、局部修订、确认写入”的日常写作 Agent 体验。

## 1. 背景

当前 Agent 流程偏批处理：用户提出目标后，Agent 一次性生成大纲、卷纲、章节细纲或正文，再进入审批/写入链路。这个模式适合目标明确的整块生成，但不贴合小说创作的日常使用。

实际创作里，用户常常是在阅读预览或正文时才发现问题：

- 大纲方向可以，但第二卷不想太黑。
- 卷纲节奏太固定，希望某几章重排。
- 第 12 章某段情绪不够。
- 某句对白不像角色会说的话。
- 只想优化选中的一小段，不想整章重写。

因此需要新增一层交互式修订能力：Agent 不只是“生成器”，还要能围绕已生成内容和正文局部片段与用户持续交流，并在确认后做可追踪写入。

## 2. 设计目标

### 2.1 产品目标

- 支持大纲、卷纲、章节细纲、`Chapter.craftBrief` 等预览产物的交互式修订。
- 支持正文编辑器内“划词/划段唤起 Agent”的局部修订体验。
- 用户划选正文后，系统自动携带卷、章节、段落、草稿版本和选中文本信息。
- Agent 能围绕选区和用户反馈多轮交流，而不是每次都重新定位。
- 写入正文前必须有修订预览和用户确认。
- 局部修订默认只改选区，不整章重写。

### 2.2 质量目标

- 进入审批、写入或后续生成链路的小说内容，不允许确定性模板 fallback、占位补齐或简单拼接。
- LLM 失败、超时、返回结构不完整、关键字段缺失时直接失败，让用户重试或缩小范围。
- 后端只做确定性结构校验，例如 ID、版本、range、字段完整性、编号连续性、引用合法性。
- 复杂创作语义由 LLM rubric 或 Planner 输出结构化结论，后端不通过关键词或正则猜测。
- 正文写入采用新草稿版本，不直接覆盖当前版本。

## 3. 非目标

- 不把段落修订做成整章 `polish_chapter` 的伪局部入口。
- 不直接覆盖当前 `ChapterDraft.content`。
- 不用程序关键词判断“角色口吻是否正确”“情绪是否足够”等创作语义。
- 不通过 normalize/merge 阶段偷偷补齐缺失的小说内容。
- 不在本专项中重构章节细纲生成架构；当前章节细纲链路仍保持逐章生成、预览合并、审批写入。
- 不强制每次生成都向用户提问；只有关键分歧或上下文不足时才提问。

## 4. 用户体验设计

### 4.1 Artifact 交互修订

适用于：

- 项目大纲
- 卷纲
- 章节细纲
- `Chapter.craftBrief`
- 场景卡
- 导入资产预览

推荐流程：

```text
用户提出生成目标
  -> Agent 生成可审预览 Artifact
  -> Agent 摘要关键创作选择和风险点
  -> 用户自然语言反馈
  -> Planner 生成结构化 RevisionPlan
  -> 局部重生成受影响 Artifact
  -> 展示差异和风险
  -> 用户确认后写入
```

示例反馈：

- “第二卷不要这么黑，保留希望感。”
- “男主不要太早知道真相。”
- “第 5-8 章节奏太散，压缩成连续危机。”
- “这个反派像工具人，改得更有长期威胁。”

Agent 应输出：

- 修改对象
- 修改范围
- 保留约束
- 受影响的章节、卷或设定
- 是否需要重建上游预览
- 是否需要用户确认额外创作选择

### 4.2 正文选区 Agent

用户在章节正文中划出一段或多段文字后，选区旁边出现类似划词翻译的小入口。

入口形态：

```text
AI · 第 8 段
AI · 第 8-10 段
```

鼠标悬停或点击后展开浮层，浮层包含：

- 自动定位：第几卷、第几章、第几段
- 当前草稿版本
- 选中文本预览
- 快捷修订意图
- 与 Agent 对话的输入框
- 当前修订计划或预览状态

快捷修订意图建议：

- 局部润色
- 压缩节奏
- 增强情绪
- 调整角色口吻
- 降低解释感
- 保留事件重写表达

### 4.3 多轮交流

段落修订需要保留同一选区会话上下文。用户可以继续说：

- “还是太用力了，收一点。”
- “保留第二句，其他重写。”
- “这版好，但最后一句改得更冷。”
- “不要让男主显得这么主动。”

Agent 应知道这些反馈仍然针对当前选区，不应重新定位到整章任务。

## 5. 前端设计

### 5.1 选区捕获

第一阶段基于当前正文编辑器实现：

- `selectionStart`
- `selectionEnd`
- `selectedText`
- `selectedParagraphRange`
- `currentDraftId`
- `currentDraftVersion`
- 当前章节、卷、项目上下文

段落范围可以先以前端当前文本按非空行计算：

```ts
type SelectedParagraphRange = {
  start: number;
  end: number;
  count: number;
};
```

后端写入时不依赖段落序号做替换，只把它作为展示和辅助上下文。真正写入依赖 `selectedRange` 和 `originalText` 精确校验。

### 5.2 Agent context payload

前端发送 Agent 请求时自动带结构化上下文：

```ts
type PassageAgentContext = {
  sourcePage: 'editor_passage_agent';
  selectionIntent: 'chapter_passage_revision';

  currentProjectId: string;
  currentVolumeId?: string;
  currentVolumeNo?: number;
  currentVolumeTitle?: string;

  currentChapterId: string;
  currentChapterNo: number;
  currentChapterTitle?: string;

  currentDraftId: string;
  currentDraftVersion: number;
  currentDraftViewMode?: 'draft' | 'polished';

  selectedRange: { start: number; end: number };
  selectedParagraphRange: SelectedParagraphRange;
  selectedText: string;
};
```

### 5.3 UI 接入点

推荐新增组件：

```text
apps/web/components/editor/PassageAgentPopover.tsx
apps/web/components/editor/usePassageSelection.ts
```

接入：

```text
apps/web/components/EditorPanel.tsx
```

职责拆分：

- `usePassageSelection`：只负责捕获选区、计算段落范围、定位浮层。
- `PassageAgentPopover`：负责浮层展示、快捷意图、对话输入、提交 Agent。
- `EditorPanel`：提供当前章节、卷、草稿和刷新回调。

### 5.4 交互边界

- 选区为空或只包含空白时，不显示入口。
- 正在生成整章正文时，不允许提交局部修订。
- 当前草稿有未保存手动修改时，提示用户先保存，避免 range 与数据库版本不一致。
- 浮层关闭不清空正文选区，但清空前端修订会话状态。

## 6. 后端设计

### 6.1 新增局部修订预览工具

```text
revise_chapter_passage_preview
```

职责：

- 读取指定 `draftId` 的正文。
- 校验 `chapterId`、`draftId`、`draftVersion` 属于当前项目。
- 校验 `selectedRange` 合法。
- 校验数据库正文中 `content.slice(start, end)` 与 `originalText` 一致。
- 调用 LLM 生成局部替换文本。
- 返回可审预览，不写库。

输入：

```ts
type ReviseChapterPassagePreviewInput = {
  chapterId: string;
  draftId: string;
  draftVersion: number;
  selectedRange: { start: number; end: number };
  selectedParagraphRange?: { start: number; end: number; count?: number };
  originalText: string;
  instruction: string;
  context?: {
    beforeText?: string;
    afterText?: string;
    chapterOutline?: string;
    craftBrief?: unknown;
    volumeSummary?: string;
    characterHints?: unknown[];
  };
};
```

输出：

```ts
type ChapterPassageRevisionPreview = {
  previewId: string;
  chapterId: string;
  draftId: string;
  draftVersion: number;
  selectedRange: { start: number; end: number };
  selectedParagraphRange?: { start: number; end: number; count?: number };
  originalText: string;
  replacementText: string;
  editSummary: string;
  preservedFacts: string[];
  risks: string[];
  validation: {
    valid: boolean;
    issues: string[];
  };
};
```

失败规则：

- LLM 失败，直接抛错。
- 返回 JSON 不完整，直接抛错。
- `replacementText` 为空，直接抛错。
- `originalText` 与当前 draft range 不一致，直接抛错。
- 质量 rubric 不通过，可重试一次；仍不通过则失败。

### 6.2 新增局部修订写入工具

```text
apply_chapter_passage_revision
```

职责：

- 只做确定性写入。
- 不调用 LLM。
- 不判断创作语义。
- 按 `selectedRange` 替换正文。
- 创建新的 `ChapterDraft` 版本。

写入算法：

```ts
const current = draft.content.slice(start, end);

if (current !== originalText) {
  throw new Error('正文已变化，请重新选择该段落');
}

const nextContent =
  draft.content.slice(0, start) +
  replacementText +
  draft.content.slice(end);
```

写入策略：

- 旧 current draft：`isCurrent = false`
- 新 draft：

```ts
{
  chapterId,
  versionNo: old.versionNo + 1,
  content: nextContent,
  source: 'agent_passage_revision',
  isCurrent: true,
  generationContext: {
    type: 'passage_revision',
    originalDraftId: old.id,
    originalDraftVersion: old.versionNo,
    selectedRange,
    selectedParagraphRange,
    originalText,
    replacementText,
    editSummary,
    agentRunId
  }
}
```

### 6.3 预览持久化

推荐把 revision preview 作为 Agent Artifact 保存，而不是直接建业务表。第一阶段可以使用 `AgentRunArtifact`：

```text
artifactType = 'chapter_passage_revision_preview'
content = ChapterPassageRevisionPreview
status = 'preview'
```

如果后续需要长期管理段落修订会话，再新增业务表：

```text
TextRevisionSession
TextRevisionPreview
TextRevisionApplication
```

## 7. Planner 与工具包接入

### 7.1 Tool bundle

新增或扩展 revision 工具包：

```text
revision.passage
```

推荐工具链：

```text
collect_chapter_context
  -> revise_chapter_passage_preview
  -> apply_chapter_passage_revision
```

其中：

- `revise_chapter_passage_preview` 可在 plan/act 中作为只读预览工具运行。
- `apply_chapter_passage_revision` 只能在 act 中运行，必须审批。

### 7.2 Planner guidance

当上下文满足以下条件时，优先规划局部修订：

```text
sourcePage = editor_passage_agent
selectionIntent = chapter_passage_revision
selectedText 非空
selectedRange 存在
currentDraftId 存在
```

Planner 要求：

- 不默认使用 `rewrite_chapter`。
- 不默认使用整章 `polish_chapter`。
- 用户明确要求“整章润色/整章重写”时，才转向现有整章工具。
- 用户只对选区提出修改要求时，必须使用局部 preview/apply 工具链。
- 如选区与当前正文版本冲突，应要求用户重新选择，不要猜测替换位置。

## 8. LLM Rubric

`revise_chapter_passage_preview` 应在生成后做一次 LLM rubric 判断，要求 LLM 返回结构化结果。

建议 rubric：

```ts
type PassageRevisionQualityReview = {
  valid: boolean;
  issues: Array<{
    severity: 'error' | 'warning';
    message: string;
  }>;
  checks: {
    followsInstruction: boolean;
    preservesRequiredFacts: boolean;
    keepsCharacterVoice: boolean;
    fitsLocalContext: boolean;
    replacementIsConcrete: boolean;
    noUnexpectedPlotRewrite: boolean;
  };
};
```

失败处理：

- `valid=false` 且存在 error 时，把 issues 传回 LLM 重生成一次。
- 重试仍失败则工具失败。
- 后端不通过关键词或正则二次判断语义。

## 9. 任务计划

### P0：开发文档与方案确认

- [x] 梳理交互式修订目标。
- [x] 明确正文选区写入策略。
- [x] 编写本开发计划文档。
- [ ] 用户确认范围、交互形态和实施顺序。

### P1：前端选区浮层

- [ ] 新增 `usePassageSelection`。
- [ ] 新增 `PassageAgentPopover`。
- [ ] 在 `EditorPanel` 接入选区捕获。
- [ ] 展示卷、章节、段落、草稿版本和选中文本。
- [ ] 提供快捷修订意图按钮。
- [ ] 提交 Agent 请求时自动带 `PassageAgentContext`。
- [ ] 处理未保存正文、空选区、生成中禁用等边界。

### P2：局部修订预览工具

- [ ] 新增 `revise_chapter_passage_preview` tool。
- [ ] 读取 draft 并校验 project/chapter/draft/version。
- [ ] 校验 `selectedRange` 与 `originalText` 一致。
- [ ] 构造局部上下文：前后若干段、章节细纲、craftBrief、相关角色提示。
- [ ] 调用 LLM 生成 `replacementText`。
- [ ] 做结构校验和 LLM rubric 质量判断。
- [ ] 输出 `chapter_passage_revision_preview` Artifact。
- [ ] 覆盖 LLM 失败、缺字段、range 冲突、质量不通过测试。

### P3：局部修订写入工具

- [ ] 新增 `apply_chapter_passage_revision` tool。
- [ ] 仅允许 act 模式执行。
- [ ] 必须用户审批。
- [ ] 写入前重新校验 draft 版本和 range。
- [ ] 创建新的 `ChapterDraft` 版本。
- [ ] 旧 current draft 置为非 current。
- [ ] 写入 `generationContext.type='passage_revision'`。
- [ ] 返回新 draftId、versionNo、字数、替换范围。
- [ ] 覆盖版本冲突、正文变化、replacementText 为空、审批缺失测试。

### P4：Planner 接入

- [ ] 新增或扩展 `revision.passage` tool bundle。
- [ ] 更新 Planner guidance。
- [ ] `sourcePage='editor_passage_agent'` 时优先局部修订工具链。
- [ ] 明确拒绝把选区任务误判成整章重写。
- [ ] 增加 planner eval case：
  - 选区润色。
  - 选区压缩节奏。
  - 选区调整角色口吻。
  - 用户明确要求整章重写。
  - 选区 range 缺失或 draftId 缺失。

### P5：Artifact 与 Diff 展示

- [ ] Agent Artifact 面板支持 `chapter_passage_revision_preview`。
- [ ] 展示原文、替换文本、摘要、风险。
- [ ] 展示 diff。
- [ ] 提供“应用到正文”审批入口。
- [ ] 应用成功后刷新 `EditorPanel` 当前 draft。

### P6：多轮段落修订会话

- [ ] 前端保留当前选区会话状态。
- [ ] 支持用户基于上一版 preview 继续反馈。
- [ ] Replan 时保留 `previewId`、选区和上一版 replacementText。
- [ ] 支持“保留第二句，其他重写”等细化反馈。

## 10. 测试计划

### 10.1 后端单元测试

- LLM 调用失败时，`revise_chapter_passage_preview` 直接抛错。
- LLM 返回非 JSON 或 JSON 缺字段时直接抛错。
- `replacementText` 为空时直接抛错。
- `selectedRange` 越界时直接抛错。
- `originalText` 与当前 draft 内容不一致时直接抛错。
- rubric 首次失败可重试一次。
- rubric 重试后仍失败时直接抛错。
- `apply_chapter_passage_revision` 无审批时拒绝执行。
- `apply_chapter_passage_revision` 版本冲突时拒绝执行。
- 写入后创建新 draft 版本，旧 draft 不丢失。

### 10.2 前端测试

- 选中正文后出现浮层入口。
- 空选区不出现入口。
- 多段选区显示 `第 X-Y 段`。
- 提交时 payload 包含卷、章节、段落、draft、range 和 selectedText。
- 当前正文未保存时提示用户先保存。
- Agent 成功写入后刷新当前章节正文。

### 10.3 集成测试

推荐真实测试流程仍使用 Docker Compose：

```bash
docker compose ps
docker compose down
docker compose up -d --build
```

验证路径：

```text
打开项目
  -> 进入章节正文
  -> 选中一段
  -> 展开段落 Agent
  -> 输入“更压抑一点，保留事实”
  -> 查看修订预览
  -> 确认应用
  -> 当前章节出现新 draft 版本
  -> 原 draft 可回退
```

## 11. 验收标准

- 用户可以在正文中选中一段，看到段落 Agent 入口。
- Agent 面板自动显示第几卷、第几章、第几段和草稿版本。
- 用户无需手动说明位置，Agent 请求里自动带结构化上下文。
- 局部修订 preview 只返回选区替换建议，不整章重写。
- 写入前用户能看到原文、修改后和风险。
- 确认写入后创建新的 `ChapterDraft` 版本。
- 如果正文在预览后发生变化，写入失败并提示重新选择。
- LLM 失败、返回缺字段、质量不通过时直接失败，不生成占位内容。
- 后端不使用关键词或正则判断复杂创作语义。
- Planner 不把普通选区修订误规划为整章重写。

## 12. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| textarea 的字符 range 与用户视觉段落不一致 | 浮层定位或段落显示不准 | 写入只依赖字符 range 和 originalText；段落序号仅展示 |
| 用户预览后手动改正文 | range 失效，可能错位替换 | 写入前重新校验 `content.slice(start,end) === originalText` |
| Planner 误用整章工具 | 选区任务变成整章润色 | 新增 `revision.passage` bundle 和 eval case |
| LLM 改动事实 | 破坏正文连续性 | 生成后 LLM rubric 检查 preserved facts 和 unexpected plot rewrite |
| 前端浮层遮挡正文 | 编辑体验受影响 | 浮层位置 clamp，支持关闭和点击外部收起 |
| 多轮反馈丢失选区 | Agent 变成新任务 | 前端保留 `TextRevisionSession` 状态，Replan 携带 previewId |
| 新版本过多 | draft 列表膨胀 | 后续可加版本筛选和 revision 来源标签 |

## 13. 推荐实施顺序

建议做成完整小闭环，而不是只做前端入口：

1. 先实现选区浮层和自动上下文。
2. 再实现 `revise_chapter_passage_preview`。
3. 再实现 `apply_chapter_passage_revision`。
4. 然后接入 Planner 工具包。
5. 最后补 diff 展示和多轮会话体验。

这样第一版就能保证“划段 -> 交流 -> 预览 -> 确认 -> 新版本写入”，不会退化成“选了一段但整章被润色”的体验。

