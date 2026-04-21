from __future__ import annotations

import importlib.util
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import psycopg


ROOT = Path(__file__).resolve().parents[2]
VERIFY_MVP_PATH = ROOT / "scripts" / "dev" / "verify_mvp.py"
REQUEST_COUNT = 2


def load_verify_mvp_module():
    spec = importlib.util.spec_from_file_location("verify_mvp_module", VERIFY_MVP_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载脚本: {VERIFY_MVP_PATH}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    verify_mvp = load_verify_mvp_module()
    env = verify_mvp.parse_env(ROOT / ".env")
    summary: dict[str, object] = {
        "redis": verify_mvp.ensure_redis(),
        "worker": verify_mvp.ensure_worker(),
        "api": verify_mvp.ensure_api(),
        "requestCount": REQUEST_COUNT,
    }

    project_payload = {
        "title": f"幂等验证-{int(time.time())}",
        "genre": "悬疑",
        "theme": "重复触发",
        "tone": "冷峻克制",
        "targetWordCount": 20000,
    }
    status, project = verify_mvp.http_json("POST", f"{verify_mvp.API_BASE}/projects", project_payload, timeout=30)
    if status not in (200, 201) or not isinstance(project, dict):
        raise RuntimeError(f"创建项目失败: {json.dumps({'status': status, 'body': project}, ensure_ascii=False)}")

    chapter_payload = {
        "chapterNo": 1,
        "title": "重复生成测试",
        "objective": "验证同一章节重复触发生成时是否复用同一个任务。",
        "conflict": "需要在第一个生成任务尚未完成时快速再次触发生成。",
        "outline": "第一次请求入队；第二次请求立即并发发起；检查是否复用同一 job。",
        "expectedWordCount": 600,
    }
    status, chapter = verify_mvp.http_json(
        "POST",
        f"{verify_mvp.API_BASE}/projects/{project['id']}/chapters",
        chapter_payload,
        timeout=30,
    )
    if status not in (200, 201) or not isinstance(chapter, dict):
        raise RuntimeError(f"创建章节失败: {json.dumps({'status': status, 'body': chapter}, ensure_ascii=False)}")

    summary["project"] = project
    summary["chapter"] = chapter

    generate_payload = {
        "mode": "draft",
        "instruction": "请输出一段悬疑小说正文，保持第三人称近距离、冷峻、克制。",
        "wordCount": 600,
        "includeLorebook": True,
        "includeMemory": True,
        "validateBeforeWrite": True,
        "validateAfterWrite": True,
        "stream": False,
    }

    barrier = threading.Barrier(REQUEST_COUNT)

    def trigger_generate(index: int) -> dict[str, object]:
        barrier.wait()
        status_code, body = verify_mvp.http_json(
            "POST",
            f"{verify_mvp.API_BASE}/chapters/{chapter['id']}/generate",
            generate_payload,
            timeout=240,
        )
        return {
            "index": index,
            "httpStatus": status_code,
            "body": body,
        }

    with ThreadPoolExecutor(max_workers=REQUEST_COUNT) as executor:
        results = list(executor.map(trigger_generate, range(1, REQUEST_COUNT + 1)))

    summary["requests"] = results

    job_ids = []
    for result in results:
        body = result.get("body")
        if isinstance(body, dict) and isinstance(body.get("id"), str):
            job_ids.append(body["id"])

    unique_job_ids = sorted(set(job_ids))
    summary["uniqueJobIds"] = unique_job_ids
    summary["sameJobId"] = len(unique_job_ids) == 1 and len(job_ids) == REQUEST_COUNT

    final_job = None
    final_status = None
    if unique_job_ids:
        job_id = unique_job_ids[0]
        for poll_count in range(1, 121):
            time.sleep(1)
            final_status, final_job = verify_mvp.http_json("GET", f"{verify_mvp.API_BASE}/jobs/{job_id}", timeout=30)
            if (
                final_status == 200
                and isinstance(final_job, dict)
                and final_job.get("status") in {"completed", "failed"}
            ):
                summary["pollCount"] = poll_count
                break

    summary["finalJobHttpStatus"] = final_status
    summary["finalJob"] = final_job

    with psycopg.connect(env["DATABASE_URL"]) as conn:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT id::text, status::text, "createdAt" FROM "GenerationJob" WHERE "targetId" = %s ORDER BY "createdAt" ASC',
                (chapter["id"],),
            )
            rows = cur.fetchall()

    summary["databaseJobs"] = [
        {
            "id": row[0],
            "status": row[1],
            "createdAt": row[2].isoformat() if row[2] else None,
        }
        for row in rows
    ]
    summary["databaseJobCount"] = len(rows)

    print(json.dumps(summary, ensure_ascii=False, indent=2))

    requests_ok = all(result.get("httpStatus") in (200, 201) for result in results)
    same_job_id = summary["sameJobId"] is True
    final_completed = isinstance(final_job, dict) and final_job.get("status") == "completed"
    database_single_job = len(rows) == 1

    if requests_ok and same_job_id and final_completed and database_single_job:
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())