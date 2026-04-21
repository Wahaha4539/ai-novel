# generate_chapter 时序草图

```text
用户请求生成章节
  ↓
API 创建 generation_job
  ↓
API 调用 Worker /internal/jobs/generate-chapter
  ↓
Worker 读取 project / chapter / related characters（当前为 mock repo）
  ↓
召回 lorebook + memory，并做 rerank/compress
  ↓
precheck：检查章节目标、硬事实是否存在
  ↓
Prompt Builder 读取模板并组装 prompt
  ↓
LLM Gateway 生成正文（当前为 mock writer）
  ↓
摘要 / 事件 / 状态 / 伏笔提取
  ↓
后置校验，生成 validation issues
  ↓
记忆回写对象组装
  ↓
返回 draftId + summary + retrievalPayload + validationIssues
```

## 下一步落地建议

1. 把 mock repository 替换成 SQLAlchemy repository。
2. 把 API 的同步调用改为队列投递 + 任务回调/轮询。
3. 加入 SSE / WebSocket 状态流，暴露 `retrieving_memory / validating_context / generating_text ...` 阶段。
