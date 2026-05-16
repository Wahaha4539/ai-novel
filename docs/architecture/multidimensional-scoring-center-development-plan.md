# AI 小说多维评分中心开发任务计划

> 状态：计划草案  
> 对应设计：`docs/architecture/multidimensional-scoring-center-design.md`  
> 当前优先级：先做 `chapter_craft_brief` 评分，提前发现正文生成前的问题。

## 1. 总目标

建立独立的“评分中心”模块，支持对总大纲、卷大纲、章节细纲、章节执行卡、章节正文进行多维度评分，并根据平台画像调整评分角度和权重。

核心验收信号：

1. 用户可以选择评分对象和平台画像发起评分。
2. 系统能生成严格结构化评分报告。
3. 报告包含总分、结论、维度分、权重、证据、扣分原因、修改建议和修订优先级。
4. 章节执行卡评分可在正文生成前发现不可写、衔接弱、阻力缺失、信息设计不清等问题。
5. 评分失败时直接失败，不生成占位报告或默认补分。

## 2. 明确边界

### 2.1 本计划包含

- 评分维度库。
- 平台评分画像。
- 评分 prompt 母版。
- 评分结果结构化契约。
- 评分资产选择器和目标解析。
- 后端评分服务、API 和 Agent Tool。
- 评分驱动重写 Agent 入口和提示词构建。
- 独立前端评分中心页面。
- 评分报告历史、平台对比、基础趋势。
- 评分 prompt 回归样例。

### 2.2 本计划不包含

- 不重构当前章节细纲逐章生成链路。
- 不引入批次章节细纲链路作为默认方案。
- 不实现关键词、正则、黑名单式语义门禁。
- 不用低质量模板生成评分报告。
- 不把外部开源项目作为运行时依赖直接接入。
- 不由评分模块直接改写小说内容。评分报告可以作为 Agent 重写入口，但必须走预览、校验、审批、写入链路。

## 3. 质量与失败处理要求

所有进入审批、写入或后续生成链路的评分结果必须满足：

- LLM 调用失败、超时、JSON 结构不完整，直接失败。
- 必填字段缺失，直接失败。
- 维度数量不足，直接失败。
- 权重缺失或总权重非法，直接失败。
- `overallScore`、`score`、`weightedScore` 非法，直接失败。
- 维度缺少 `evidence`、`reason`、`suggestion`，直接失败。
- 不允许为缺失维度补默认分。
- 不允许为缺失 issue 补模板问题。
- 不允许在 normalize/merge 阶段补写小说内容或评分内容。

测试必须覆盖：

- LLM 超时直接抛错。
- LLM 返回 JSON 不完整直接抛错。
- 评分维度缺失直接抛错。
- 证据缺失直接抛错。
- 目标对象缺失直接抛错。
- 用户选择的资产不存在、跨项目、版本不匹配或快照缺失直接抛错。
- 平台画像权重不完整直接抛错。

## 4. 里程碑

| 里程碑 | 范围 | 验收信号 |
|---|---|---|
| MSC-M0 | 评分维度与 prompt 基线 | 维度库、平台画像、JSON 契约和 prompt fixtures 就绪。 |
| MSC-M1 | 章节执行卡评分闭环 | 可对 `Chapter.craftBrief` 评分并展示报告。 |
| MSC-M2 | 章节细纲和章节正文评分 | 可分别评分 `chapter_outline` 与 `chapter_draft`。 |
| MSC-M3 | 大纲和卷大纲评分 | 可评分 `project_outline` 与 `volume_outline`。 |
| MSC-M4 | 前端评分中心 | 独立页面支持对象选择、平台选择、报告展示、历史列表。 |
| MSC-M5 | 评分驱动重写入口 | 用户可按整份报告、维度或 issue 发起 Agent 重写预览。 |
| MSC-M6 | 平台对比与趋势 | 同一对象可多平台评分，章节序列可看趋势。 |
| MSC-M7 | 回归校准 | 建立评分样例集，支持 prompt/rubric 版本回归。 |

## 5. Phase 0：评分维度、画像与 prompt 基线

目标：先把“评什么、按什么权重评、怎么问模型、返回什么结构”固化为可测试资产。

| ID | 状态 | 任务 | 影响文件 | 验收标准 |
|---|---|---|---|---|
| MSC-P0-01 | todo | 定义评分对象枚举 | `apps/api/src/modules/scoring/*` 或 shared types | 包含 `project_outline`、`volume_outline`、`chapter_outline`、`chapter_craft_brief`、`chapter_draft`。 |
| MSC-P0-02 | todo | 定义评分维度库 | `apps/api/src/modules/scoring/scoring-dimensions.ts` | 维度 key、中文名、说明、适用对象、是否关键维度完整。 |
| MSC-P0-03 | todo | 定义平台画像模板 | `apps/api/src/modules/scoring/platform-scoring-profiles.ts` | 通用长篇、起点向、番茄向第一批就绪。 |
| MSC-P0-04 | todo | 定义评分 JSON schema | `apps/api/src/modules/scoring/scoring-contracts.ts` | 覆盖 run、dimension、issue、extractedElements、revisionPriorities。 |
| MSC-P0-05 | todo | 编写 prompt 母版 | `apps/api/src/modules/scoring/scoring-prompts.ts` | 包含全局 system、平台画像片段、各 targetType prompt。 |
| MSC-P0-06 | todo | 添加 contract 单元测试 | `apps/api/src/modules/scoring/*.spec.ts` | 缺字段、缺维度、非法分数、非法权重全部失败。 |
| MSC-P0-07 | todo | 定义可评分资产选择契约 | `apps/api/src/modules/scoring/scoring-targets.ts` | 统一 `targetType`、`targetId`、`targetRef`、`targetSnapshot`、`sourceTrace`、资产摘要字段。 |

建议优先内置平台画像：

1. `generic_longform`
2. `qidian_like`
3. `fanqie_like`

后续再加：

1. `jinjiang_like`
2. `published_literary`
3. `custom`

## 6. Phase 1：章节执行卡评分闭环

目标：优先支持 `chapter_craft_brief`，在正文生成前发现问题。

| ID | 状态 | 任务 | 影响文件 | 验收标准 |
|---|---|---|---|---|
| MSC-P1-01 | todo | 新增评分服务骨架 | `apps/api/src/modules/scoring/scoring.service.ts` | 可接收 projectId、targetType、targetId、profileKey 发起评分。 |
| MSC-P1-02 | todo | 实现 `chapter_craft_brief` 上下文读取 | `scoring-target-loader.service.ts` | 能读取章节、卷、项目、craftBrief、前后章摘要和必要上下文。 |
| MSC-P1-03 | todo | 实现执行卡评分 prompt | `scoring-prompts.ts` | 使用 `scene_executability`、`action_chain`、`obstacle_result`、`entry_exit_state` 等维度。 |
| MSC-P1-04 | todo | 调用 LLM 严格 JSON 评分 | `scoring.service.ts` | LLM 输出不完整或维度缺失时失败，不补默认值。 |
| MSC-P1-05 | todo | 保存评分报告 | Prisma migration + `scoring-runs` service | 保存总分、结论、维度、issues、平台画像、rubricVersion。 |
| MSC-P1-06 | todo | 新增 API | `scoring.controller.ts` | 支持创建评分、查询评分历史、查询单个评分报告。 |
| MSC-P1-07 | todo | 新增 Agent Tool | `score_content_preview` 或 `score_chapter_craft_brief` | Tool 默认为只读评分；如写入报告，需要审批边界清晰。 |
| MSC-P1-08 | todo | 单元测试覆盖失败即失败 | scoring spec | LLM 超时、缺维度、缺 evidence、craftBrief 缺失均抛错。 |

执行卡评分关键失败场景：

- `craftBrief` 为空。
- `actionBeats` 缺失。
- `sceneBeats` 缺失。
- `continuityState` 缺失。
- LLM 未返回全部关键维度。
- 任一维度缺 `evidence`、`reason`、`suggestion`。

## 7. Phase 2：章节细纲与章节正文评分

目标：支持正文前后两类评分：先评章节细纲，再评正文是否执行计划。

| ID | 状态 | 任务 | 影响文件 | 验收标准 |
|---|---|---|---|---|
| MSC-P2-01 | todo | 实现 `chapter_outline` target loader | `scoring-target-loader.service.ts` | 能读取章节 outline、目标、冲突、伏笔、前后章信息。 |
| MSC-P2-02 | todo | 实现章节细纲评分 prompt | `scoring-prompts.ts` | 重点评章节目标、场景链、冲突压力、信息设计、连续性。 |
| MSC-P2-03 | todo | 实现 `chapter_draft` target loader | `scoring-target-loader.service.ts` | 能读取正文、章节细纲、craftBrief、相关设定和质量历史。 |
| MSC-P2-04 | todo | 实现正文评分 prompt | `scoring-prompts.ts` | 先抽取主要人物、核心事件、关键场景、新增信息、章末钩子，再评分。 |
| MSC-P2-05 | todo | 正文评分对比执行卡 | `scoring.service.ts` | `plan_adherence` 必须比较正文与章节细纲/craftBrief。 |
| MSC-P2-06 | todo | 测试章节细纲评分失败路径 | scoring spec | 缺目标、缺维度、缺证据直接失败。 |
| MSC-P2-07 | todo | 测试正文评分失败路径 | scoring spec | 草稿缺失、上下文缺失、LLM 输出不完整直接失败。 |

## 8. Phase 3：总大纲与卷大纲评分

目标：让评分中心覆盖项目前置规划资产。

| ID | 状态 | 任务 | 影响文件 | 验收标准 |
|---|---|---|---|---|
| MSC-P3-01 | todo | 实现 `project_outline` target loader | `scoring-target-loader.service.ts` | 能读取项目 logline、synopsis、outline、creativeProfile、Story Bible 摘要。 |
| MSC-P3-02 | todo | 实现总大纲评分 prompt | `scoring-prompts.ts` | 评核心设定、主线、冲突引擎、人物弧光、长篇可持续性和平台钩子。 |
| MSC-P3-03 | todo | 实现 `volume_outline` target loader | `scoring-target-loader.service.ts` | 能读取 Volume、narrativePlan、chapterCount、相邻卷信息。 |
| MSC-P3-04 | todo | 实现卷大纲评分 prompt | `scoring-prompts.ts` | 评卷目标、阶段冲突、节奏曲线、中段转折、卷末高潮、下一卷承接。 |
| MSC-P3-05 | todo | 覆盖目标章数一致性结构校验 | scoring contracts | 只校验结构事实，不用程序猜测用户语义。 |
| MSC-P3-06 | todo | 测试大纲/卷纲评分 | scoring spec | 上下文缺失、LLM 输出缺维度、权重非法均失败。 |

## 9. Phase 4：独立前端评分中心

目标：评分结果不再藏在质量报告列表里，而是有独立模块展示。

| ID | 状态 | 任务 | 影响文件 | 验收标准 |
|---|---|---|---|---|
| MSC-P4-01 | todo | 新增 `ScoringCenterPanel` | `apps/web/components/ScoringCenterPanel.tsx` | 第一屏提供资产选择器、平台画像选择和评分入口。 |
| MSC-P4-02 | todo | 新增可评分资产列表 API/hooks | `apps/web/hooks/useScoringActions.ts`、scoring API | 按资产类型列出总大纲、卷大纲、章节细纲、章节执行卡、章节正文 draft 版本。 |
| MSC-P4-03 | todo | 新增评分 API hooks | `apps/web/hooks/useScoringActions.ts` | 支持创建评分、加载历史、加载详情。 |
| MSC-P4-04 | todo | 侧边栏接入评分中心 | `WorkspaceSidebar.tsx`、`page.tsx` | 新增独立入口，状态可持久化。 |
| MSC-P4-05 | todo | 已选资产摘要展示 | `ScoringCenterPanel.tsx` | 展示资产类型、标题、卷号、章节号、draft 版本、来源、更新时间。 |
| MSC-P4-06 | todo | 报告总览展示 | `ScoringCenterPanel.tsx` | 展示总分、verdict、summary、profile、rubricVersion、模型。 |
| MSC-P4-07 | todo | 维度分展示 | `ScoringCenterPanel.tsx` | 展示维度分、权重、weightedScore、confidence。 |
| MSC-P4-08 | todo | 问题与建议展示 | `ScoringCenterPanel.tsx` | 展示 evidence、reason、suggestion、revisionPriorities。 |
| MSC-P4-09 | todo | 前端测试 | `scripts/dev/test_web_longform_interactions.cjs` 或组件测试 | 覆盖资产选择、空状态、错误状态、JSON fallback、维度列表、issues。 |

展示要求：

- 不做营销式页面。
- 第一屏就是可操作的评分工作台。
- 维度分和问题列表要适合反复查看、对比和修改。
- 文案避免解释“如何使用系统”，控件本身要清楚。

## 10. Phase 5：评分驱动重写入口

目标：评分报告可以作为修改入口，用户点击整份报告、低分维度或具体 issue 后，由评分中心构建 Agent 指令并发起重写预览。

| ID | 状态 | 任务 | 影响文件 | 验收标准 |
|---|---|---|---|---|
| MSC-P5-01 | todo | 定义评分驱动重写请求契约 | `apps/api/src/modules/scoring/scoring-revision.types.ts` | 包含 scoringRunId、targetSnapshot、selectedIssues、selectedDimensions、platformProfile、userInstruction。 |
| MSC-P5-02 | todo | 构建 Agent 重写提示词 | `apps/api/src/modules/scoring/scoring-revision-prompt.ts` | 生成结构化 Agent 指令，禁止只传“根据评分优化一下”。 |
| MSC-P5-03 | todo | 新增评分报告重写入口 API | scoring API / agent-runs API | 支持按报告、维度、issue、revisionPriority 发起 Agent run 草稿或直接创建 run。 |
| MSC-P5-04 | todo | 按资产类型映射 Agent 目标 | scoring revision service | `chapter_craft_brief` 走执行卡 preview，`chapter_draft` 走新 draft/修订预览，大纲类走 preview。 |
| MSC-P5-05 | todo | 前端报告操作入口 | `ScoringCenterPanel.tsx` | 报告级、维度级、issue 级均可点击“按评分重写”。 |
| MSC-P5-06 | todo | 已选问题传递 | `ScoringCenterPanel.tsx` / hooks | 用户可勾选多个 issue 后发起重写，Agent 指令只包含选中问题和必要上下文。 |
| MSC-P5-07 | todo | 审批边界测试 | api tests | 重写入口不得直接 persist/apply；写入类工具仍需用户审批。 |
| MSC-P5-08 | todo | 提示词构建测试 | api tests | 验证包含评分、资产快照、平台画像、选中问题、禁止事项和输出要求。 |

## 11. Phase 6：平台对比与趋势

目标：同一内容可以按不同平台画像评分，并按章节形成趋势视图。

| ID | 状态 | 任务 | 影响文件 | 验收标准 |
|---|---|---|---|---|
| MSC-P6-01 | todo | 支持多平台批量评分 | scoring service/API | 同一 target 可一次生成多个 profile 的评分 run。 |
| MSC-P6-02 | todo | 平台对比展示 | `ScoringCenterPanel.tsx` | 展示不同平台总分和关键维度差异。 |
| MSC-P6-03 | todo | 章节趋势查询 | scoring API | 可按 targetType、profileKey、chapterNo 返回趋势。 |
| MSC-P6-04 | todo | 趋势图展示 | frontend | 展示章节序列中的可执行性、节奏、人物、钩子等曲线。 |
| MSC-P6-05 | todo | 平台画像说明 | profile metadata | 说明权重倾向，但不宣称平台官方标准。 |
| MSC-P6-06 | todo | 测试平台对比 | api/web tests | 多平台评分失败时不得生成部分伪成功结果，除非明确标记单项失败。 |

## 12. Phase 7：评分样例库与 prompt 校准

目标：让评分 prompt 可回归、可调参、可比较，不靠主观感觉迭代。

| ID | 状态 | 任务 | 影响文件 | 验收标准 |
|---|---|---|---|---|
| MSC-P7-01 | todo | 建立评分 fixtures | `apps/api/test/fixtures/scoring-eval-cases.json` | 覆盖执行卡、章节细纲、正文、大纲。 |
| MSC-P7-02 | todo | 编写评分 eval 脚本 | `scripts/dev/eval_scoring.ts` | 可离线评估 mock 输出结构和真实 LLM 样本。 |
| MSC-P7-03 | todo | 定义评分回归指标 | eval script | 包含维度覆盖、blocking issue 命中、误判率、结构失败率。 |
| MSC-P7-04 | todo | 加入 prompt/rubric 版本 | scoring metadata | 每份报告记录 promptVersion、rubricVersion、profileVersion。 |
| MSC-P7-05 | todo | 评分历史报告 | `tmp/scoring-eval-report.json` | 支持历史趋势和回归对比。 |
| MSC-P7-06 | todo | 加入 CI 可选 gate | `apps/api/package.json` | 可手动运行，不默认阻塞普通开发，待稳定后再纳入 gate。 |

## 13. 推荐实现顺序

第一轮最小闭环：

1. MSC-P0-02：评分维度库。
2. MSC-P0-03：平台画像模板。
3. MSC-P0-04：评分 JSON schema。
4. MSC-P0-05：prompt 母版。
5. MSC-P0-07：可评分资产选择契约。
6. MSC-P1-02：执行卡 target loader。
7. MSC-P1-03：执行卡评分 prompt。
8. MSC-P1-04：严格 JSON 评分。
9. MSC-P1-08：失败即失败测试。
10. MSC-P4-01 到 MSC-P4-08：前端最小展示。
11. MSC-P5-01 到 MSC-P5-08：评分驱动重写入口。

第二轮扩展：

1. 章节细纲评分。
2. 章节正文评分。
3. 起点向/番茄向平台对比。
4. 正文和章节细纲的评分驱动重写入口。

第三轮扩展：

1. 总大纲评分。
2. 卷大纲评分。
3. 评分趋势。
4. 回归样例库。

## 14. 验收命令

涉及真实测试时，按项目要求使用 Docker Compose。

推荐完整验收：

```bash
docker compose ps
docker compose up -d --build
pnpm db:generate
pnpm exec prisma validate --schema apps/api/prisma/schema.prisma
pnpm db:migrate
pnpm exec prisma migrate status --schema apps/api/prisma/schema.prisma
pnpm --filter api build
pnpm --filter web build
pnpm --filter api test:agent
git diff --check
```

评分 eval 稳定后补充：

```bash
pnpm --dir apps/api run eval:scoring
pnpm --dir apps/api run eval:scoring:report
```

## 15. 风险与处理

| 风险 | 处理 |
|---|---|
| LLM 打分漂移 | 通过 promptVersion、rubricVersion、fixtures、历史报告做回归。 |
| 平台画像被误解为官方标准 | UI 和 metadata 明确标注为“项目内评分画像”。 |
| 分数看似精确但证据不足 | 每维必须有 evidence、reason、suggestion；缺失即失败。 |
| 评分中心变成绕过审批的自动改文工具 | 评分中心只构建 Agent 重写任务；具体修改必须先生成 preview 或新 draft，写入前仍需审批。 |
| 程序语义门禁误判 | 后端只做结构校验；语义判断只来自 LLM rubric 结构化输出。 |
| 旧 `QualityReport` 语义混淆 | 新评分报告独立展示；如需兼容，只同步摘要，不把旧报告当评分中心主数据。 |

## 16. 第一版完成定义

第一版完成后，用户应能完成以下流程：

1. 打开评分中心。
2. 在资产选择器中选择某一章的章节执行卡。
3. 确认资产摘要，包括卷号、章节号、标题、来源和更新时间。
4. 选择通用长篇、起点向或番茄向。
5. 发起评分。
6. 看到总分、结论、维度分、权重、证据、扣分原因、修改建议。
7. 明确知道这张执行卡能否进入正文生成。
8. 对同一张执行卡按不同平台画像重新评分并比较差异。
9. 勾选评分报告中的低分维度或具体 issue，点击“按评分重写”。
10. 看到 Agent 根据评分报告和资产快照生成的执行卡重写预览，并在写入前进行审批。
