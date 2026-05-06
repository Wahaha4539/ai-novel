# Agent 任务执行窗口 UX 开发设计与任务计划

> 日期：2026-05-06  
> 范围：前端 Agent Workspace / Floating Agent Panel 的执行体验重构  
> 目标：把 Agent 的工作过程从“聊天消息 + 散装面板”升级为“规划、待办、执行、总结”的可扫描任务窗口。

## 1. 背景问题

当前 Agent 已具备 Plan / Approval / Act / Trace / Artifact / Result 能力，但前端体验存在明显割裂：

- 用户输入后只看到普通聊天流，Agent 的规划、步骤、工具调用和结果没有形成清晰层级。
- 计划、时间线、审批、产物、审计、最终输出分散在多个卡片里，用户需要自己拼接“现在进行到哪一步”。
- 全屏 Agent 页和悬浮 Agent 面板呈现逻辑不统一，产品感不足。
- 成功/失败后的总结偏原始 JSON，不像一个任务完成报告。

竞品参考中的体验更接近：

```text
用户指令
  → Agent 先规划
  → 显示待办任务
  → 按步骤执行并更新状态
  → 最后给出结构化总结
```

本次重构的核心不是新增 Agent 能力，而是把已有能力产品化呈现。

## 2. 设计目标

### 2.1 用户心智

用户应该能一眼回答四个问题：

- Agent 理解了什么？
- 它准备做哪些步骤？
- 当前执行到哪里了？
- 最终交付了什么，失败时卡在哪里？

### 2.2 信息架构

新体验采用四阶段任务窗口：

```text
规划：目标理解、计划摘要、步骤数量、风险等级
待办：可折叠 todo list、完成标记、审批范围、工具名称、步骤状态
执行：工具调用进度、成功/失败/运行中记录
总结：结果摘要、产物提示、失败原因
```

高级信息不删除，但默认收纳：

```text
产物预览
审计轨迹
原始 JSON 输出
```

### 2.3 产品原则

- 普通用户优先看阶段和任务，不先看 JSON。
- 写入类步骤必须保留审批边界，不为了“丝滑”绕过风险确认。
- 全屏工作台和悬浮面板复用同一任务窗口组件，避免两套体验分裂。
- 卡片半径控制在 8px 左右，界面更像工作台而不是营销页。
- 文案表达任务状态，不解释界面本身。

## 3. 技术设计

### 3.1 新增组件

新增：

```text
apps/web/components/agent/AgentMissionWindow.tsx
```

职责：

- 接收 `AgentRun`、最新 `AgentPlanPayload`、`AgentStep`、`AgentArtifact`、`AgentAuditEvent`。
- 派生四阶段状态：`plan / todo / execute / summary`。
- 派生进度百分比、完成步骤数、失败步骤、结果摘要。
- 渲染任务窗口主视图。
- 继续承载审批、澄清、产物、审计和原始结果的入口。

### 3.2 接入点

全屏工作台：

```text
apps/web/components/agent/AgentWorkspace.tsx
```

改造方向：

- 从“顶部介绍 + 左右散装卡片”改成一个完整工作窗口。
- 左侧保留聊天输入与历史 Run。
- 右侧使用 `AgentMissionWindow` 展示任务执行过程。

悬浮面板：

```text
apps/web/components/agent/AgentFloatingPanel.tsx
```

改造方向：

- Tab 保留：任务 / 执行窗口 / 历史。
- “执行窗口”不再堆叠 PlanPanel、TimelinePanel、ArtifactPanel，而是复用 `AgentMissionWindow`。
- 面板宽度从 480px 提升到响应式 `min(860px, 100vw - 32px)`，给执行窗口足够空间。

样式：

```text
apps/web/app/globals.css
```

新增样式块：

- `.agent-workspace-stage`
- `.agent-workspace-window`
- `.agent-mission-window`
- `.agent-mission-phases`
- `.agent-mission-card`
- `.agent-todo-list`
- `.agent-mission-todo`
- `.agent-mission-runlog`
- `.agent-tool-calls`
- `.agent-mission-advanced`

### 3.3 数据派生

阶段状态从现有状态机派生：

| Run 状态 | 规划 | 待办 | 执行 | 总结 |
|---|---|---|---|---|
| 无 Run | pending | pending | pending | pending |
| planning | active | pending | pending | pending |
| waiting_approval / waiting_review | done | active | pending | pending |
| acting / running | done | done | active | pending |
| succeeded | done | done | done | done |
| failed | done | done | blocked | blocked |
| cancelled | done/pending | blocked | blocked | blocked |

步骤状态优先读取当前 planVersion 下的 `AgentStep`：

```text
act 记录优先
plan 记录兜底
无记录时按 requiresApproval / approvedStepNos 显示待审批或待执行
```

结果摘要优先从 `AgentRun.output` 中提取可读字段：

```text
draftId
chapterId
createdCount
updatedCount
issueCount
acceptedCount
wordCount
```

无法摘要时展示产物数量、工具记录数量，原始 JSON 仍放在高级区域。

### 3.4 Agent's todo List

在阶段进度下方新增全宽折叠列表：

```text
Agent's todo List  已完成数 / 总数  折叠箭头
  ✓ 步骤 1: xxx  tool_name  已完成
  2 步骤 2: xxx  tool_name  待执行
```

状态规则：

- `succeeded / skipped`：绿色勾选，标题与工具名删除线。
- `running / acting / planning`：高亮运行中。
- `failed`：红色失败态。
- 待审批步骤：圆点可点击切换审批范围，但不等于完成。
- 完成数量只来自真实 step record，不用用户审批勾选伪造成完成。

### 3.5 Tool Calls 执行审计区

在任务窗口的执行与总结之间新增 `Tool Calls` 区块，把每一次工具调用从普通时间线里独立出来：

```text
默认行：序号 / tool / 状态 / 耗时 / 产物
展开后：入参摘要 / 输出摘要 / 错误 / 原始 JSON
```

设计规则：

- 每个 tool call 使用一张 `<details>` 可折叠行，默认保持高密度摘要。
- tool 名使用等宽字体，状态、耗时、产物保持固定列宽，避免长名称撑乱布局。
- 入参和输出先提取前 5 个可读字段，完整结构仍保留在原始 JSON。
- 错误独立展示，成功时显示“无错误”。
- 产物优先通过 `sourceStepNo` 关联到步骤，缺失时不强行猜测来源。

## 4. 任务计划

### P0：任务窗口骨架

- [x] 新增 `AgentMissionWindow`。
- [x] 显示四阶段状态条：规划 / 待办 / 执行 / 总结。
- [x] 显示整体进度条。
- [x] 显示计划摘要、步骤数、置信度和风险等级。
- [x] 显示待办步骤、审批勾选和步骤状态。
- [x] 新增可折叠 `Agent's todo List`，完成一项自动标记一项。
- [x] 显示工具执行记录和最终摘要。
- [x] 新增 `Tool Calls` 可折叠明细，展示入参、输出、错误和原始 JSON。
- [x] 将产物、审计、原始输出折叠进高级区域。

### P1：接入全屏工作台

- [x] 改造 `AgentWorkspace` 为“聊天区 + 任务窗口”的双栏布局。
- [x] 保留新会话、Run 状态、上下文和错误/动作提示。
- [x] 保留历史 Run 选择能力。
- [x] 保留审批、重试、取消、重新规划、澄清选择等既有行为。

### P2：接入悬浮面板

- [x] 将 `detail` Tab 改为复用 `AgentMissionWindow`。
- [x] 扩大悬浮面板宽度，适配任务窗口。
- [x] 去掉 Tab 文案中的 emoji，降低杂乱感。
- [x] 保留任务输入和历史 Tab。

### P3：响应式与视觉质量

- [x] 桌面端：任务窗口双列卡片，阶段条横向排列。
- [x] 中等宽度：全屏工作台切换为单列滚动。
- [x] 小屏：阶段条、指标、结果列表降为单列。
- [x] 控制卡片圆角与文字溢出，避免长工具名/Run ID 撑破布局。

### P4：验证

- [x] 执行 `pnpm --filter web build`。
- [x] 使用本地浏览器检查项目页进入 Agent 工作台后的视觉表现。
- [ ] 检查悬浮 Agent 面板打开后的执行窗口表现。
- [x] 检查一个已有 `succeeded` Run 的 Tool Calls 列表和展开态。
- [ ] 补齐 planning / waiting_approval / failed 状态覆盖。
- [ ] 视需要补一组轻量截图或交互回归脚本。

## 5. 后续增强

### 实时进度

当前 `useAgentRun` 仍以请求完成后刷新为主。后续可以加入轮询或 SSE：

```text
acting/running 时每 1.5-2 秒刷新当前 Run
终态后停止
```

### 更好的总结

后端可补充统一 `AgentRun.output.summary` 契约，前端就不需要从未知 JSON 中猜字段。

建议结构：

```json
{
  "summary": "已生成第 12 章草稿并完成事实校验",
  "deliverables": [
    { "label": "草稿", "value": "draftId..." },
    { "label": "校验问题", "value": 0 }
  ],
  "nextActions": ["继续润色", "查看事实层写入"]
}
```

### 失败恢复

失败时任务窗口可以进一步显示：

```text
失败步骤
失败原因
已完成且可复用步骤
建议操作：重试 / 重新规划 / 取消
```

### 任务模板

可以把常见任务做成快捷入口：

```text
写章节
拆文案
设计大纲
检查连续性
重建记忆
```

但快捷入口必须服务于任务，不要回到“功能按钮堆叠”的旧体验。

## 6. 验收标准

- 用户提交任务后，不需要读聊天长文也能看懂 Agent 的计划和待办。
- 任务执行期间，用户能看到当前步骤和工具状态。
- 等待审批时，用户能清楚知道哪些步骤会写入或有风险。
- 成功后，用户先看到摘要，再按需展开产物和原始 JSON。
- 失败后，用户能定位失败步骤和下一步操作。
- 全屏 Agent 页和悬浮 Agent 面板体验一致。
- `pnpm --filter web build` 通过。
