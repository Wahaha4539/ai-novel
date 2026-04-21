# OpenAPI 草案

## 项目

- `POST /api/projects`
- `GET /api/projects/{projectId}`

## 角色

- `POST /api/projects/{projectId}/characters`
- `GET /api/projects/{projectId}/characters`

## Lorebook

- `POST /api/projects/{projectId}/lorebook`
- `GET /api/projects/{projectId}/lorebook/search?q=...`

## 章节

- `POST /api/projects/{projectId}/chapters`
- `GET /api/projects/{projectId}/chapters`
- `GET /api/chapters/{chapterId}`

## 生成

- `POST /api/chapters/{chapterId}/generate`

## 任务

- `GET /api/jobs/{jobId}`

## 校验 / 记忆

- `GET /api/chapters/{chapterId}/validation-issues`
- `GET /api/projects/{projectId}/memory/search?q=...`
- `POST /api/projects/{projectId}/memory/rebuild`
