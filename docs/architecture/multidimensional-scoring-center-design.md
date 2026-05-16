# AI 小说多维评分中心设计文档

> 状态：设计草案  
> 范围：评分角度、平台画像、提示词结构、评分驱动重写入口、评分报告展示目标  
> 相关任务计划：`docs/architecture/multidimensional-scoring-center-development-plan.md`

## 1. 背景

当前系统已经具备 `QualityReport`、`ai_quality_review`、章节细纲 LLM rubric review、Agent eval 等质量能力，但这些能力偏分散：

- 评分结果展示不足，用户难以横向比较不同章节、不同对象、不同平台画像。
- 当前 AI 审稿主要面向章节正文，不足以覆盖总大纲、卷大纲、章节细纲、章节执行卡等前置规划资产。
- 评分维度固定，不能根据起点向、番茄向、晋江向、出版向等平台画像调整权重。
- 一些评分归一化逻辑存在默认补分风险，新评分中心必须改为缺失即失败。

评分中心的核心目标不是“再加一个审稿按钮”，而是建立独立模块：

> 同一份小说内容，可以选择评分对象、平台画像和 rubric 版本，生成可视化、多维度、可追踪、可对比的评分报告。

## 2. 设计原则

1. **评分角度优先，不照搬工程框架**  
   借鉴开源项目的评估维度、评估流程和提示词结构，但不把外部项目直接嵌入生成链路。

2. **LLM 语义判断，后端只做结构校验**  
   小说质量、角色动机、平台适配、情绪回报等语义判断必须由 LLM rubric 输出显式结构字段。后端只校验 JSON 类型、必填字段、枚举值、分数范围、维度覆盖和引用合法性。

3. **失败即失败**  
   LLM 调用失败、超时、JSON 不完整、评分维度缺失、证据缺失、权重缺失、目标对象解析失败时，直接返回失败，不生成可审批或可写入的评分报告。

4. **不使用关键词或正则阻断创作语义**  
   不用程序关键词判断“角色是否崩”“节奏是否拖”“平台是否适配”“爽点是否足够”等复杂语义。

5. **先评前置规划，再评正文执行**  
   章节执行卡 `Chapter.craftBrief` 是正文生成前的关键质量门，第一版应优先支持评分，提前发现“这章还不能写”的问题。

6. **平台画像是可编辑权重，不是官方标准**  
   起点向、番茄向、晋江向、出版向只作为项目内可编辑评分画像，不能宣称代表平台官方规则。

7. **不改变当前章节细纲生成链路**  
   当前项目保持逐章生成章节细纲。评分中心可评估 `generate_chapter_outline_preview` 的输出，但不得主动把链路改回批次章节细纲生成。

8. **评分驱动重写只构建 Agent 任务，不直接改写资产**  
   用户可以基于评分报告发起“针对评分重写”，但评分中心只负责构建结构化 Agent 指令和入口。具体重写必须走对应 Agent 工具的预览、校验、审批、写入流程，不允许评分模块绕过审批直接覆盖资产。

## 3. 开源项目借鉴点

| 项目 | 借鉴角度 | 对本项目的吸收方式 |
|---|---|---|
| [WebNovelBench](https://github.com/OedonLestrange42/webnovelbench) | 先抽取主要人物、主要情节、重要场景，再做正文多维评分。维度包括修辞、感官描写、角色平衡、对白独特性、角色一致性、意境匹配、语境适配、场景衔接。 | 正文评分采用“要素抽取 -> 多维评分 -> 证据与建议”的流程。借鉴正文维度，不照搬标签解析和正则输出。 |
| [NousResearch/autonovel](https://github.com/NousResearch/autonovel) | 分别评估 planning docs、单章、整本小说。关注 beat coverage、voice、continuity、canon compliance、lore integration、engagement、arc completion、theme coherence 等。 | 建立总大纲、卷大纲、章节细纲、章节执行卡、章节正文的分层评分对象。 |
| [Story-Bench](https://github.com/clchinkc/story-bench) | 按叙事理论评估 beat execution、bridge、continuity、character、cross-beat coherence。 | 大纲、卷纲、章节细纲、执行卡重点评“叙事功能是否执行”，不只评文笔。 |
| [WritingBench](https://github.com/X-PLUG/WritingBench) | 动态 criteria：每个写作任务生成实例级评分标准，逐项打分并给理由。 | 不同评分对象、不同平台画像使用不同维度和权重。支持后续自定义评分画像。 |
| [EQ-Bench Creative Writing](https://github.com/EQ-bench/creative-writing-bench) | 绝对评分之外引入 A/B 对比，控制长度偏差、位置偏差。 | 后续支持两个版本的大纲、执行卡或正文进行对比评分。 |
| [CharacterEval](https://github.com/morecry/CharacterEval) | 中文角色一致性和角色表现评估。关注角色语言、行为、人格、吸引力、多轮稳定性。 | 角色维度不只判断“是否崩”，还评语言、行为、动机、情绪反应是否像该角色。 |

## 4. 评分对象

第一版评分中心支持以下对象：

| targetType | 中文名称 | 评分目的 |
|---|---|---|
| `project_outline` | 总大纲 | 判断核心设定、主线、商业钩子、长篇可持续性是否成立。 |
| `volume_outline` | 卷大纲 | 判断卷目标、阶段冲突、节奏曲线、卷高潮、伏笔回收和下一卷承接。 |
| `chapter_outline` | 章节细纲 | 判断章节目标、场景链、信息设计、冲突压力和前后章衔接。 |
| `chapter_craft_brief` | 章节执行卡 / `craftBrief` | 判断正文生成前是否已经具备可写性。优先级最高。 |
| `chapter_draft` | 章节正文 | 判断正文质量、计划执行度、人物一致性、沉浸感和平台追读效果。 |

### 4.1 资产选择与目标解析

评分中心必须提供独立的资产选择器。用户不是只能从“当前章节”发起评分，而是可以在评分模块内明确选择要评分的项目资产。

第一版资产选择器至少支持：

| 资产类别 | 对应 targetType | 选择粒度 | 备注 |
|---|---|---|---|
| 项目总大纲 | `project_outline` | 当前项目 | 读取项目 logline、synopsis、outline、creativeProfile 和必要 Story Bible 摘要。 |
| 卷大纲 | `volume_outline` | 指定卷 | 用户可按卷号、卷名选择。必须绑定 `volumeId` 或稳定卷引用。 |
| 章节细纲 | `chapter_outline` | 指定章节 | 用户可按卷、章节号、章节标题选择。 |
| 章节执行卡 | `chapter_craft_brief` | 指定章节的 `craftBrief` | 这是正文生成前的优先评分资产。 |
| 章节正文 | `chapter_draft` | 指定章节草稿版本 | 必须能选择具体 draft/version，不能只隐式评分最新版本。 |
| Agent 预览资产 | 与预览内容匹配 | 指定 Agent run/step artifact | 后续支持。用于评分尚未持久化的大纲、细纲、执行卡、导入预览。 |

资产选择器展示信息：

- 资产类型。
- 标题、卷号、章节号。
- 草稿版本号或 Agent step 编号。
- 持久化状态：已写入、预览中、历史版本。
- 最近更新时间。
- 来源：人工编辑、LLM 生成、导入、Agent 预览、正文生成。
- 是否已有评分报告。

目标解析规则：

1. 用户明确选择资产时，以用户选择为准。
2. 如果从章节页面或 Agent artifact 跳转到评分中心，可以预填目标资产，但仍要在 UI 中显示清楚。
3. 对章节正文评分必须绑定具体 `draftId` 或 `draftVersion`，不得静默切换到最新草稿。
4. 对预览资产评分必须保存目标快照，不能在报告生成后重新读取已变化的预览输出。
5. 评分报告必须记录 `targetType`、`targetId` 或 `targetRef`、`targetSnapshot`、`sourceTrace` 和平台画像版本。
6. 如果资产不存在、引用跨项目、版本不匹配或快照缺失，评分必须失败。

后续可扩展：

| targetType | 中文名称 | 说明 |
|---|---|---|
| `scene_card` | 场景卡 | 判断单场景是否具备地点、参与者、目的、冲突、结果和感官锚点。 |
| `import_preview` | 导入资产预览 | 判断导入大纲、设定、角色、规则是否可写入项目资产。 |
| `volume_character_plan` | 卷级角色规划 | 判断角色出场、成长、关系变化和阶段任务是否清晰。 |
| `full_book_snapshot` | 全书快照 | 判断整本书的结构趋势、伏笔回收、人物弧光、风格一致性。 |

## 5. 评分维度库

评分维度分为公共维度和对象专用维度。不同目标对象和平台画像只启用其中一部分。

### 5.1 叙事结构类

| key | 名称 | 判断问题 |
|---|---|---|
| `premise_strength` | 核心设定强度 | 故事钩子是否清楚、有张力、可持续。 |
| `mainline_clarity` | 主线清晰度 | 主角目标、主要阻力、阶段路径是否明确。 |
| `conflict_engine` | 冲突引擎 | 冲突是否能持续驱动长篇，而不是只靠偶发事件。 |
| `beat_execution` | 叙事节拍执行 | 当前对象是否完成应有叙事功能。 |
| `scene_bridge` | 场景/章节衔接 | 场景、章节、卷之间是否自然递进。 |
| `pacing_curve` | 节奏曲线 | 信息、冲突、情绪、回报是否有起伏。 |
| `payoff_design` | 伏笔与回收设计 | 埋设、误导、触发、回收是否有对象和计划。 |
| `chapter_hook` | 章节钩子 | 章末是否产生继续阅读欲望。 |

### 5.2 人物类

| key | 名称 | 判断问题 |
|---|---|---|
| `character_motivation` | 人物动机 | 行动选择是否有可理解的动机。 |
| `character_consistency` | 人物一致性 | 语言、行为、情绪反应是否符合已知人设和状态。 |
| `character_arc` | 人物弧光 | 人物变化是否有阶段、触发点和后果。 |
| `relationship_tension` | 关系张力 | 人物关系是否产生推进、误解、试探、冲突或亲近。 |
| `dialogue_distinctiveness` | 对白区分度 | 遮住名字后，不同角色说话方式是否仍可区分。 |
| `character_balance` | 角色平衡 | 主要角色是否承担清晰功能，配角是否挤占或空转。 |

### 5.3 章节执行卡类

| key | 名称 | 判断问题 |
|---|---|---|
| `scene_executability` | 场景可执行性 | 是否有地点、参与者、可见动作、阻力、转折、结果。 |
| `action_chain` | 行动链 | `actionBeats` 是否形成连续行动，而不是抽象意图。 |
| `obstacle_result` | 阻力与结果 | 本章阻力如何出现，行动后造成什么状态变化。 |
| `entry_exit_state` | 入场/离场状态 | 人物和章节的进入状态、离开状态是否清楚。 |
| `continuity_handoff` | 连续性递交 | 是否能接住前一章，并把下一章自然递出去。 |
| `information_design` | 信息设计 | 揭示、隐藏、误导、伏笔、回收对象是否明确。 |
| `drafting_clarity` | 正文生成清晰度 | 写作模型是否无需发明重大剧情即可开写。 |
| `sensory_anchor` | 感官锚点 | 场景是否有可落地的视觉、听觉、气味、触感或物件锚点。 |

### 5.4 正文表现类

| key | 名称 | 判断问题 |
|---|---|---|
| `prose_quality` | 语言质感 | 语言是否顺滑、准确、有节制。 |
| `sensory_detail` | 感官描写 | 是否有具体感官和动作，而不是空泛概括。 |
| `rhetoric_control` | 修辞控制 | 修辞是否服务人物和场景，是否堆砌。 |
| `atmosphere_fit` | 氛围匹配 | 氛围是否与场景目标和人物状态一致。 |
| `immersion` | 沉浸感 | 读者是否容易进入场景。 |
| `readability` | 阅读流畅度 | 句段节奏、信息密度、理解成本是否适合连载阅读。 |
| `plan_adherence` | 计划执行度 | 正文是否执行章节细纲和执行卡。 |

### 5.5 世界观与连续性类

| key | 名称 | 判断问题 |
|---|---|---|
| `worldbuilding_integration` | 世界观参与度 | 世界观是否进入冲突和选择，而非背景摆设。 |
| `canon_compliance` | 设定一致性 | 是否违背已知设定、规则、人物状态。 |
| `timeline_consistency` | 时间线一致性 | 时间、地点、人物行动顺序是否合理。 |
| `knowledge_boundary` | 知情边界 | 角色是否提前知道不该知道的信息。 |
| `foreshadowing_integrity` | 伏笔完整性 | 伏笔是否有对象、触发点、遮蔽方式和预期回收。 |
| `lore_integration` | 设定融入 | 设定是否通过行动、代价、物件和选择体现。 |

### 5.6 平台适配类

| key | 名称 | 判断问题 |
|---|---|---|
| `market_hook` | 市场钩子 | 卖点是否清楚，是否能吸引目标读者。 |
| `pacing_density` | 节奏密度 | 单章推进和信息回报是否匹配平台阅读习惯。 |
| `emotional_reward` | 情绪回报 | 是否给到爽感、甜感、虐感、悬疑感、期待感等目标回报。 |
| `reader_retention` | 追读动力 | 是否制造下一章点击欲。 |
| `genre_expectation_fit` | 类型期待匹配 | 是否满足对应类型和平台读者期待。 |
| `platform_fit` | 平台综合适配 | 按当前平台画像看是否适合继续投入生成。 |

### 5.7 对象专用维度

这些维度只在特定评分对象中启用。

| key | 适用对象 | 名称 | 判断问题 |
|---|---|---|---|
| `longform_sustainability` | `project_outline` | 长篇可持续性 | 核心冲突、人物成长、世界观扩展和伏笔系统是否足以支撑长篇。 |
| `theme_coherence` | `project_outline`、`chapter_draft`、出版/文学向 | 主题一致性 | 主题是否通过人物选择、冲突后果和叙事结构表达，而不是停留在口号。 |
| `volume_goal` | `volume_outline` | 卷目标 | 本卷开始要解决什么、结束要改变什么。 |
| `phase_conflict` | `volume_outline` | 阶段冲突 | 本卷冲突是否有阶段推进，而不是重复同一压力。 |
| `midpoint_turn` | `volume_outline` | 中段转折 | 中段是否出现改变局面的转折。 |
| `climax_design` | `volume_outline` | 卷末高潮 | 卷末高潮是否兑现本卷压力和读者期待。 |
| `chapter_goal` | `chapter_outline` | 章节目标 | 本章要推进什么剧情、人物、信息或关系变化。 |
| `conflict_pressure` | `chapter_outline`、`chapter_craft_brief` | 冲突压力 | 阻力是否具体，压力如何出现在页面上。 |
| `plot_progress` | `chapter_draft` | 剧情推进 | 正文是否造成新的事实、状态变化、关系变化或信息推进。 |

## 6. 各评分对象默认维度

### 6.1 总大纲 `project_outline`

| 维度 | 默认权重 |
|---|---:|
| `premise_strength` | 14 |
| `mainline_clarity` | 14 |
| `conflict_engine` | 14 |
| `character_arc` | 12 |
| `worldbuilding_integration` | 10 |
| `payoff_design` | 10 |
| `market_hook` | 14 |
| `longform_sustainability` | 12 |

`longform_sustainability` 是总大纲专用维度，判断核心冲突、人物成长、世界观扩展和伏笔系统是否足以支撑长篇。

### 6.2 卷大纲 `volume_outline`

| 维度 | 默认权重 |
|---|---:|
| `volume_goal` | 14 |
| `phase_conflict` | 14 |
| `pacing_curve` | 12 |
| `midpoint_turn` | 10 |
| `climax_design` | 14 |
| `payoff_design` | 12 |
| `character_arc` | 10 |
| `continuity_handoff` | 14 |

卷级专用维度：

- `volume_goal`：本卷开始要解决什么、结束要改变什么。
- `phase_conflict`：本卷冲突是否有阶段推进。
- `midpoint_turn`：中段是否有改变局面的转折。
- `climax_design`：卷末高潮是否兑现本卷压力。

### 6.3 章节细纲 `chapter_outline`

| 维度 | 默认权重 |
|---|---:|
| `chapter_goal` | 12 |
| `beat_execution` | 16 |
| `conflict_pressure` | 14 |
| `scene_bridge` | 12 |
| `information_design` | 12 |
| `character_motivation` | 10 |
| `chapter_hook` | 12 |
| `continuity_handoff` | 12 |

### 6.4 章节执行卡 `chapter_craft_brief`

章节执行卡是正文生成前的优先评分对象。它不主要评文笔，而是评“这张卡是否已经足以支撑正文生成”。

| 维度 | 默认权重 |
|---|---:|
| `scene_executability` | 18 |
| `action_chain` | 16 |
| `obstacle_result` | 14 |
| `entry_exit_state` | 12 |
| `continuity_handoff` | 12 |
| `information_design` | 12 |
| `drafting_clarity` | 12 |
| `platform_fit` | 4 |

执行卡高风险问题：

- `actionBeats` 只有“主角成长”“关系推进”等抽象目标，没有可见动作。
- `sceneBeats` 缺地点、参与者、阻力、转折或结果。
- 本章没有 `entryState`、`exitState` 或 `handoffToNextChapter`。
- 人物只列名字，没有行动功能、状态变化或冲突参与方式。
- 伏笔只写“埋下伏笔”，没有具体物件、台词、误导、信息差或回收预期。
- 正文模型必须自行发明重大剧情、地点、阻力、角色决定或章节结尾才能开写。

### 6.5 章节正文 `chapter_draft`

| 维度 | 默认权重 |
|---|---:|
| `plan_adherence` | 12 |
| `plot_progress` | 14 |
| `character_consistency` | 12 |
| `dialogue_distinctiveness` | 8 |
| `prose_quality` | 10 |
| `sensory_detail` | 8 |
| `immersion` | 10 |
| `pacing_density` | 10 |
| `canon_compliance` | 8 |
| `chapter_hook` | 8 |

## 7. 平台评分画像

平台画像用于调整维度权重和评价重点。第一版建议内置以下模板。

### 7.1 通用长篇

适用：未明确平台、需要稳定长篇质量的项目。

重点：

- 主线清晰
- 人物动机
- 连续性
- 伏笔完整
- 章节可执行性
- 正文计划执行度

### 7.2 起点向

重点：

- 长线主线和阶段目标
- 升级、成长、势力变化
- 世界观规则参与冲突
- 强敌压力和危机递进
- 长线伏笔和卷末爆点
- 连续追读动力

权重倾向：

- 提高 `mainline_clarity`、`conflict_engine`、`worldbuilding_integration`、`payoff_design`、`reader_retention`。
- 降低纯文风类维度权重，但不允许忽略可读性和设定一致性。

### 7.3 番茄向

重点：

- 开篇抓力
- 单章爽点密度
- 情绪反馈明确
- 短周期回报
- 阅读流畅度
- 章末点击欲

权重倾向：

- 提高 `market_hook`、`pacing_density`、`emotional_reward`、`readability`、`chapter_hook`。
- 对大段铺设、慢热设定、长期悬念给更严格的扣分理由。

### 7.4 晋江向

重点：

- 人物关系
- 情绪递进
- 对话张力
- 角色弧光
- 关系变化的细腻度
- 人物选择的心理可信度

权重倾向：

- 提高 `character_motivation`、`character_consistency`、`relationship_tension`、`dialogue_distinctiveness`、`character_arc`。
- 世界观和主线不消失，但服务人物关系与情绪推进。

### 7.5 出版/文学向

重点：

- 主题表达
- 语言质感
- 人物复杂度
- 结构完整
- 叙事节制
- 意象和氛围一致性

权重倾向：

- 提高 `prose_quality`、`rhetoric_control`、`atmosphere_fit`、`theme_coherence`、`character_arc`。
- 降低单章爽点和高频钩子的权重，但仍需判断叙事推进是否成立。

## 8. 评分结论

所有评分均使用 0 到 100 分。

| 分数段 | 解释 |
|---|---|
| 0-49 | 不可用。存在重大缺失或严重偏离目标。 |
| 50-59 | 高风险。勉强能理解，但不建议进入下一步。 |
| 60-74 | 可修。基础成立，但有明显问题。 |
| 75-84 | 可进入下一步。建议修改重点问题。 |
| 85-92 | 稳定。质量较好，可作为当前阶段合格输出。 |
| 93-100 | 优秀。必须谨慎使用，只有证据充分时才能给出。 |

默认结论：

| verdict | 条件 |
|---|---|
| `pass` | 总分大于等于 80，且无 blocking issue，关键维度均大于等于 70。 |
| `warn` | 总分 60-79，或存在 warning issue，或关键维度低于 70 但可局部修复。 |
| `fail` | 总分低于 60，或存在 blocking issue，或目标对象不足以进入下一步。 |

关键维度由目标对象决定。例如 `chapter_craft_brief` 的关键维度是 `scene_executability`、`action_chain`、`obstacle_result`、`continuity_handoff`、`drafting_clarity`。

## 9. 提示词结构

### 9.1 全局 system prompt 母版

```text
你是严苛但专业的中文长篇小说编辑、网文平台化内容评估员和创作结构顾问。

你的任务不是改写内容，而是基于给定评分画像，对目标文本进行多维度评分。
必须先理解目标对象的类型：总大纲、卷大纲、章节细纲、章节执行卡、章节正文。

不要使用关键词、正则或表面长度判断质量。
必须结合项目上下文、目标对象、平台画像和 rubric，判断叙事功能是否成立。

只输出严格 JSON。
不要输出 Markdown。
不要补写剧情。
不要重写正文。
不要替用户新增设定。
```

### 9.2 通用 scoring instruction

```text
评分要求：
- 每个维度使用 0-100 分。
- 60 分代表勉强可用但有明显问题。
- 75 分代表可进入下一步但需要修改。
- 85 分代表质量稳定。
- 95 分以上必须极少使用，只有非常成熟且证据充分的内容才可给出。
- 如果某维度缺少足够证据，不要猜测高分，应指出信息不足。
- 每个扣分点必须给出 evidence、reason、suggestion。
- evidence 必须来自输入内容或明确的上下文，不得编造。
- 如果目标对象缺少关键字段或内容不足以评分，返回 verdict=fail，并在 blockingIssues 中说明。
```

### 9.3 先抽取再评分

借鉴 WebNovelBench，章节正文和复杂规划对象必须先抽取叙事要素，再评分。

```text
评分前先抽取：
- 主要人物
- 核心事件
- 关键场景
- 本章或本卷的目标
- 主要阻力
- 信息揭示与隐藏
- 伏笔或回收对象
- 结尾递交点

抽取结果只用于评分，不得补写或改写原内容。
```

### 9.4 平台画像提示片段

```text
当前评分画像：{platformProfile.name}

请不要按通用文学审美平均打分。
如果是起点向，优先看长线主线、升级成长、世界观规则、强敌压力、卷末爆点和连续追读。
如果是番茄向，优先看开篇抓力、爽点密度、情绪回报、单章推进、阅读流畅度和章末点击欲。
如果是晋江向，优先看人物关系、情绪递进、对话张力、角色弧光和关系变化。
如果是出版向，优先看主题表达、语言质感、人物复杂度、结构完整和叙事节制。

平台画像只影响权重和评价重点，不允许忽略目标对象的基本可用性。
```

### 9.5 章节执行卡评分 prompt

```text
请评估以下章节执行卡是否足以支撑正文生成。

重点判断：
1. 是否有可见场景链：地点、参与者、动作、阻力、转折、结果。
2. actionBeats 是否是可写动作，而不是抽象意图。
3. 每个关键人物是否有入场状态、行动功能、离场变化。
4. 本章信息设计是否清楚：揭示什么、隐藏什么、误导什么、埋什么伏笔、是否回收旧伏笔。
5. 是否能接住前一章，并把下一章递出去。
6. 是否有感官锚点、物件锚点或可见页面动作，帮助正文生成落地。
7. 按平台画像判断，这一章是否有足够的情绪回报、爽点、关系张力或章末钩子。
8. 如果正文模型需要自行发明重大剧情、地点、阻力、结果或角色选择才能开写，应判为高风险。

不要因为文字简洁就扣分；只在缺少可执行信息时扣分。
不要把“主题、成长、关系推进”等抽象词自动判为失败；必须结合整张执行卡判断是否有对应可见动作。
```

### 9.6 章节细纲评分 prompt

```text
请评估章节细纲是否能支撑后续生成章节执行卡和正文。

重点判断：
1. 本章目标是否明确。
2. 本章是否有具体冲突和阻力。
3. 是否存在场景链，而不是只有剧情摘要。
4. 人物行动是否有动机和结果。
5. 信息揭示、伏笔、误导、回收是否清楚。
6. 章首状态和章末状态是否能接住前后章节。
7. 按平台画像判断，本章是否提供足够的追读动力。
```

### 9.7 章节正文评分 prompt

```text
请评估章节正文是否完成章节计划，并判断其作为平台连载章节的质量。

先抽取：
- 本章主要人物
- 本章核心事件
- 本章关键场景
- 本章新增信息
- 本章结尾钩子

再评分：
- 是否执行章节细纲和章节执行卡
- 剧情是否有实际推进
- 人物语言和行为是否一致
- 冲突是否在页面上可见
- 文笔是否有具体感官和动作，而不是空泛概括
- 章末是否制造继续阅读的欲望
- 是否违背已知设定、时间线、人物状态或知情边界
```

### 9.8 总大纲评分 prompt

```text
请评估总大纲是否足以支撑长篇小说项目。

重点判断：
1. 核心设定是否一句话可理解，并能形成独特卖点。
2. 主角目标、主要阻力、长期冲突是否清楚。
3. 世界观是否能参与冲突，而不是背景介绍。
4. 人物弧光是否有长期变化空间。
5. 主线和支线是否有扩展余地。
6. 是否存在足够的中长期伏笔、升级、关系变化或悬念。
7. 按平台画像判断，是否适合该目标读者和连载节奏。
```

### 9.9 卷大纲评分 prompt

```text
请评估卷大纲是否能承担整卷叙事功能。

重点判断：
1. 本卷目标是否明确。
2. 本卷开始和结束时，主角、世界、关系或主线状态是否发生实质变化。
3. 冲突是否有阶段推进，而不是重复同一压力。
4. 中段是否有改变局面的转折。
5. 卷末高潮是否兑现本卷压力和读者期待。
6. 本卷伏笔是否有埋设、推进或回收计划。
7. 是否自然递交到下一卷或下一阶段。
```

## 10. JSON 输出契约

评分模型必须返回严格 JSON。示例：

```json
{
  "targetType": "chapter_craft_brief",
  "platformProfile": "generic_longform",
  "overallScore": 78,
  "verdict": "warn",
  "summary": "章节执行卡已有基本场景链，但阻力和章末递交偏弱。",
  "extractedElements": {
    "mainCharacters": ["主角"],
    "coreEvents": ["主角进入黑市调查失踪线索"],
    "keyScenes": ["地下黑市入口", "药摊交易"],
    "reveals": ["失踪者与黑市货单有关"],
    "openLoops": ["斗篷人为何跟踪主角"]
  },
  "dimensions": [
    {
      "key": "scene_executability",
      "label": "场景可执行性",
      "score": 82,
      "weight": 18,
      "weightedScore": 14.76,
      "confidence": "medium",
      "evidence": "执行卡列出黑市入口、守门人、药摊交易等场景。",
      "reason": "地点和行动较清楚，但第二个场景缺少明确转折。",
      "suggestion": "补充药摊交易中阻力升级和主角取得线索的具体方式。"
    }
  ],
  "blockingIssues": [
    {
      "dimensionKey": "continuity_handoff",
      "severity": "warning",
      "path": "continuityState.handoffToNextChapter",
      "evidence": "只写下一章继续调查。",
      "reason": "缺少具体递交动作或悬念对象。",
      "suggestion": "明确斗篷人的行动、主角是否察觉、下一章冲突入口。"
    }
  ],
  "revisionPriorities": [
    "补强章末递交点",
    "补充第二场景的阻力和转折"
  ]
}
```

必填字段：

- `targetType`
- `platformProfile`
- `overallScore`
- `verdict`
- `summary`
- `extractedElements`
- `dimensions`
- `blockingIssues`
- `revisionPriorities`

每个 `dimensions[]` 必填：

- `key`
- `label`
- `score`
- `weight`
- `weightedScore`
- `confidence`
- `evidence`
- `reason`
- `suggestion`

结构校验失败必须整体失败，不得补默认分、默认维度或默认建议。

## 11. 评分驱动重写入口

评分报告必须能成为后续修改入口。用户可以在评分中心点击“针对评分重写”，把当前评分报告、目标资产和选择的问题传给 Agent，由 Agent 执行具体重写逻辑。

### 11.1 入口位置

评分中心提供以下入口：

1. 报告级入口：按整份评分报告重写资产。
2. 维度级入口：只针对某个低分维度重写，例如 `scene_executability` 或 `chapter_hook`。
3. Issue 级入口：只针对用户勾选的 blocking issue / warning issue 重写。
4. 修订优先级入口：按 `revisionPriorities` 生成重写任务。
5. 平台画像入口：按当前平台画像重写，或切换平台画像后重写。

入口默认行为：

- 不直接修改资产。
- 打开 Agent 输入框或直接创建 Agent run 草稿。
- 将评分报告、资产快照、用户选择的问题、平台画像和期望输出格式写入 Agent 指令。
- 需要写入数据库的重写结果必须先生成 preview，再由用户审批 persist/apply。

### 11.2 可重写资产与 Agent 目标

| 资产类型 | 重写目标 | 推荐 Agent 行为 |
|---|---|---|
| `project_outline` | 重写或局部修订总大纲 | 生成总大纲 preview，保留已确认设定，不直接写入。 |
| `volume_outline` | 重写或局部修订卷大纲 | 生成卷大纲 preview，校验 chapterCount、卷目标和上下游引用。 |
| `chapter_outline` | 重写章节细纲 | 生成章节细纲 preview，保留章节号、卷号和已确认上下文。 |
| `chapter_craft_brief` | 重写章节执行卡 | 生成新的 `craftBrief` preview，重点修复可执行性、行动链、阻力、递交点。 |
| `chapter_draft` | 重写章节正文或生成新 draft | 基于评分问题、章节细纲和 `craftBrief` 生成新草稿或修订预览，不覆盖旧草稿。 |
| Agent 预览资产 | 重写预览内容 | 在当前 Agent run 上生成新的 preview 或新 step，不直接持久化。 |

### 11.3 Agent 指令构建字段

评分中心构建 Agent 指令时，必须包含：

- `scoringRunId`
- `targetType`
- `targetId` 或 `targetRef`
- `targetSnapshot`
- `platformProfile`
- `rubricVersion`
- `overallScore`
- `verdict`
- 用户选择的 `dimensions`
- 用户选择的 `issues`
- `revisionPriorities`
- 用户补充指令
- 期望输出：preview、new draft、局部 patch 或需要澄清
- 审批要求：是否需要 persist/apply 前审批

不能只传“请根据评分优化一下”这种模糊指令。

### 11.4 Agent 指令母版

```text
你将根据评分报告修订一个小说资产。

任务边界：
- 你不是重新评分员，而是根据已有评分报告执行修订。
- 不要直接写入数据库；先生成可预览的修订结果。
- 不要发明与评分问题无关的新设定、新角色、新主线。
- 不要用模板或占位内容补齐缺失。
- 如果评分报告、资产快照或上下文不足以安全修订，先提出澄清或返回失败。

目标资产：
- targetType: {targetType}
- targetId/targetRef: {targetRef}
- assetSummary: {assetSummary}
- targetSnapshot: {targetSnapshot}

评分画像：
- platformProfile: {platformProfile}
- rubricVersion: {rubricVersion}
- overallScore: {overallScore}
- verdict: {verdict}

本次要修的问题：
{selectedIssues}

低分维度：
{selectedDimensions}

修订优先级：
{revisionPriorities}

用户补充要求：
{userInstruction}

输出要求：
- 返回修订后的 preview 或新 draft。
- 同时返回 changeSummary，逐条说明修复了哪些评分问题。
- 返回 preservedFacts，说明保留了哪些已确认事实、章节号、卷号、人物状态和设定。
- 返回 remainingRisks，说明哪些问题仍需人工确认。
- 如果目标是章节执行卡，必须补足可执行场景链、行动链、阻力、转折、结果、连续性递交和信息设计。
- 如果目标是正文，必须说明如何执行章节细纲和 craftBrief，不得只做文风润色。
```

### 11.5 输出质量边界

评分驱动重写仍然遵守项目内容质量规则：

- LLM 重写失败、超时、JSON 不完整或 preview 缺关键字段时，直接失败。
- 不在重写 normalize 阶段补占位剧情、占位执行卡或默认章节内容。
- 重写结果如果进入审批、写入或后续生成链路，必须通过对应结构校验和必要的 LLM rubric 质量判断。
- 用户只选择部分 issue 时，Agent 应优先修复选中问题，并避免无关大改。
- 如果用户选择“按平台画像重写”，Agent 必须说明平台画像影响了哪些修订方向。

## 12. 报告展示目标

评分中心独立页面应展示：

1. 资产选择器：总大纲、卷大纲、章节细纲、章节执行卡、章节正文草稿版本、Agent 预览资产。
2. 平台画像选择：通用长篇、起点向、番茄向、晋江向、出版向、自定义。
3. 已选资产摘要：资产类型、标题、卷号、章节号、draft 版本、来源、更新时间。
4. 总分、结论、模型、rubric 版本、生成时间。
5. 维度条形图或雷达图。
6. 问题列表：维度、严重级别、证据、扣分原因、修改建议。
7. 评分驱动重写入口：支持按整份报告、维度、issue 或修订优先级发起 Agent 重写。
8. 平台对比：同一对象按不同平台画像评分。
9. 趋势视图：按章节展示节奏、冲突、人物、钩子、可执行性等曲线。

第一版展示优先级：

1. 最新评分报告。
2. 维度分数和权重。
3. blocking issues。
4. 修订优先级。
5. 平台对比分数。

## 13. MVP 建议

第一版优先支持：

1. `chapter_craft_brief` 评分。
2. `chapter_outline` 评分。
3. `chapter_draft` 评分。
4. 平台画像：通用长篇、起点向、番茄向。
5. 针对 `chapter_craft_brief` 评分报告发起 Agent 重写预览。

第二版扩展：

1. `project_outline` 评分。
2. `volume_outline` 评分。
3. 晋江向、出版向、自定义画像。
4. 平台对比报告。

第三版扩展：

1. A/B 版本对比评分。
2. 全书趋势评分。
3. 评分样例库和 prompt 校准集。
4. 评分结果驱动的局部重生成建议。
