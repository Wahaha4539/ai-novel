# 架构概览

当前脚手架采用单仓多应用（monorepo）结构：

- `apps/web`：面向用户的管理后台与编辑器 UI
- `apps/api`：资源型 API、DTO 校验、任务投递与查询
- `apps/worker`：AI pipeline、召回、校验、摘要、回写
- `packages/shared-types`：跨端共享类型
- `packages/prompt-templates`：Prompt 模板目录

## 设计原则

1. **结构化优先**：章节、角色、设定、问题、记忆都优先落结构化模型。
2. **生成与记忆解耦**：生成结果先入草稿与待审核区，不直接覆盖事实库。
3. **工作流化**：复杂生成链路统一放 Worker pipeline。
4. **可追踪**：生成任务、召回、校验、回写都保留 job / issue / audit 边界。

## 当前代码边界

- API 层目前使用内存仓储，方便先验证接口形状。
- Prisma schema 已落核心模型，后续可直接补 migration。
- Worker 保留 mock repo + SQLAlchemy model 双轨：前者保证最小可运行，后者承接后续数据库接入。
