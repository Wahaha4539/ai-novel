from __future__ import annotations

import json
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import psycopg


ROOT = Path(__file__).resolve().parents[2]
WORKER_URL = "http://127.0.0.1:8000/healthz"
API_BASE = "http://127.0.0.1:3001/api"
REDIS_HOST = "127.0.0.1"
REDIS_PORT = 6379


def parse_env(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        result[key.strip()] = value.strip()
    return result


def http_json(method: str, url: str, payload: dict | None = None, timeout: int = 30) -> tuple[int | None, object]:
    data = None
    headers = {"Content-Type": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
            return response.status, json.loads(body) if body else None
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body) if body else None
        except Exception:
            parsed = {"raw": body}
        return exc.code, parsed
    except Exception as exc:  # pragma: no cover - dev script
        return None, {"error": str(exc)}


def is_port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1.5):
            return True
    except OSError:
        return False


def tail_text(path: Path, size: int = 4000) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")[-size:]


def ensure_redis() -> dict[str, object]:
    if is_port_open(REDIS_PORT):
        return {
            "status": "already-running",
            "host": REDIS_HOST,
            "port": REDIS_PORT,
        }

    raise RuntimeError(f"Redis 未启动，请先确认 {REDIS_HOST}:{REDIS_PORT} 可访问")


def ensure_worker() -> dict[str, object]:
    status, payload = http_json("GET", WORKER_URL, timeout=3)
    if status == 200 and isinstance(payload, dict) and payload.get("status") == "ok":
        return {"status": "already-running"}

    stdout_path = ROOT / "worker.stdout.log"
    stderr_path = ROOT / "worker.stderr.log"
    for path in (stdout_path, stderr_path):
        if path.exists():
            path.unlink()

    stdout = open(stdout_path, "wb")
    stderr = open(stderr_path, "wb")
    proc = subprocess.Popen(
        [
            str(ROOT / ".venv" / "Scripts" / "python.exe"),
            "-m",
            "uvicorn",
            "main:app",
            "--app-dir",
            "apps/worker",
            "--host",
            "127.0.0.1",
            "--port",
            "8000",
        ],
        cwd=ROOT,
        stdout=stdout,
        stderr=stderr,
    )

    for _ in range(30):
        time.sleep(1)
        status, payload = http_json("GET", WORKER_URL, timeout=3)
        if status == 200 and isinstance(payload, dict) and payload.get("status") == "ok":
            return {"status": "started", "pid": proc.pid}

    stdout.close()
    stderr.close()
    raise RuntimeError(
        "Worker 启动失败\n"
        f"stderr:\n{tail_text(stderr_path)}\n\n"
        f"stdout:\n{tail_text(stdout_path)}"
    )


def ensure_api() -> dict[str, object]:
    if is_port_open(3001):
        return {"status": "already-running"}

    stdout_path = ROOT / "api.stdout.log"
    stderr_path = ROOT / "api.stderr.log"
    for path in (stdout_path, stderr_path):
        if path.exists():
            path.unlink()

    stdout = open(stdout_path, "wb")
    stderr = open(stderr_path, "wb")
    proc = subprocess.Popen(["node", "apps/api/dist/main.js"], cwd=ROOT, stdout=stdout, stderr=stderr)

    for _ in range(40):
        time.sleep(1)
        if is_port_open(3001):
            return {"status": "started", "pid": proc.pid}

    stdout.close()
    stderr.close()
    raise RuntimeError(
        "API 启动失败\n"
        f"stderr:\n{tail_text(stderr_path)}\n\n"
        f"stdout:\n{tail_text(stdout_path)}"
    )


def main() -> int:
    env = parse_env(ROOT / ".env")
    summary: dict[str, object] = {
        "redis": ensure_redis(),
        "worker": ensure_worker(),
        "api": ensure_api(),
    }

    project_payload = {
        "title": f"MVP链路验证-{int(time.time())}",
        "genre": "悬疑",
        "theme": "秘密与代价",
        "tone": "冷峻克制",
        "targetWordCount": 50000,
    }
    status, project = http_json("POST", f"{API_BASE}/projects", project_payload, timeout=30)
    if status not in (200, 201) or not isinstance(project, dict):
        raise RuntimeError(f"创建项目失败: {json.dumps({'status': status, 'body': project}, ensure_ascii=False)}")
    project_id = project["id"]
    summary["project"] = project

    chapter_payload = {
        "chapterNo": 1,
        "title": "雨夜的钥匙",
        "objective": "主角在雨夜潜入旧宅寻找一把钥匙，并确认父亲失踪前留下的线索。",
        "conflict": "她必须在看守返回前找到钥匙，但每靠近真相一步，恐惧都在迫使她后退。",
        "outline": "抵达旧宅；潜入书房；找到钥匙与纸条；带着不安离开。",
        "expectedWordCount": 800,
    }
    status, chapter = http_json(
        "POST",
        f"{API_BASE}/projects/{project_id}/chapters",
        chapter_payload,
        timeout=30,
    )
    if status not in (200, 201) or not isinstance(chapter, dict):
        raise RuntimeError(f"创建章节失败: {json.dumps({'status': status, 'body': chapter}, ensure_ascii=False)}")
    chapter_id = chapter["id"]
    summary["chapter"] = chapter

    generate_payload = {
        "mode": "draft",
        "instruction": "请直接输出章节正文，保持第三人称近距离、冷峻、克制、悬疑推进。",
        "wordCount": 800,
        "includeLorebook": True,
        "includeMemory": True,
        "validateBeforeWrite": True,
        "validateAfterWrite": True,
        "stream": False,
    }
    status, generation = http_json(
        "POST",
        f"{API_BASE}/chapters/{chapter_id}/generate",
        generate_payload,
        timeout=240,
    )
    summary["generationEnqueueHttpStatus"] = status
    summary["generationEnqueue"] = generation

    if status not in (200, 201) or not isinstance(generation, dict) or not generation.get("id"):
        raise RuntimeError(f"创建生成任务失败: {json.dumps({'status': status, 'body': generation}, ensure_ascii=False)}")

    job_id = generation["id"]
    final_generation: object = generation
    final_status = status
    poll_count = 0
    for poll_count in range(1, 121):
        time.sleep(2)
        final_status, final_generation = http_json("GET", f"{API_BASE}/jobs/{job_id}", timeout=30)
        if (
            final_status == 200
            and isinstance(final_generation, dict)
            and final_generation.get("status") in {"completed", "failed"}
        ):
            break

    summary["generationPollHttpStatus"] = final_status
    summary["generationPollCount"] = poll_count
    summary["generation"] = final_generation
    generation = final_generation

    status, validation_issues = http_json(
        "GET",
        f"{API_BASE}/chapters/{chapter_id}/validation-issues",
        timeout=30,
    )
    summary["validationIssuesHttpStatus"] = status
    summary["validationIssues"] = validation_issues

    query = urllib.parse.urlencode({"q": "钥匙"})
    status, memory_items = http_json(
        "GET",
        f"{API_BASE}/projects/{project_id}/memory/search?{query}",
        timeout=30,
    )
    summary["memorySearchHttpStatus"] = status
    summary["memorySearch"] = memory_items

    status, rebuild_dry_run = http_json(
        "POST",
        f"{API_BASE}/projects/{project_id}/memory/rebuild?dryRun=true",
        timeout=120,
    )
    summary["memoryRebuildDryRunHttpStatus"] = status
    summary["memoryRebuildDryRun"] = rebuild_dry_run

    status, rebuild_result = http_json(
        "POST",
        f"{API_BASE}/projects/{project_id}/memory/rebuild",
        timeout=120,
    )
    summary["memoryRebuildHttpStatus"] = status
    summary["memoryRebuild"] = rebuild_result

    status, projects_list = http_json("GET", f"{API_BASE}/projects", timeout=30)
    summary["projectsListHttpStatus"] = status
    summary["projectsList"] = projects_list

    status, dashboard = http_json(
        "GET",
        f"{API_BASE}/projects/{project_id}/memory/dashboard",
        timeout=30,
    )
    summary["memoryDashboardHttpStatus"] = status
    summary["memoryDashboard"] = dashboard

    status, story_events = http_json(
        "GET",
        f"{API_BASE}/projects/{project_id}/story-events",
        timeout=30,
    )
    summary["storyEventsHttpStatus"] = status
    summary["storyEvents"] = story_events

    status, character_states = http_json(
        "GET",
        f"{API_BASE}/projects/{project_id}/character-state-snapshots",
        timeout=30,
    )
    summary["characterStatesHttpStatus"] = status
    summary["characterStates"] = character_states

    status, foreshadow_tracks = http_json(
        "GET",
        f"{API_BASE}/projects/{project_id}/foreshadow-tracks",
        timeout=30,
    )
    summary["foreshadowTracksHttpStatus"] = status
    summary["foreshadowTracks"] = foreshadow_tracks

    status, review_queue = http_json(
        "GET",
        f"{API_BASE}/projects/{project_id}/memory/reviews",
        timeout=30,
    )
    summary["reviewQueueHttpStatus"] = status
    summary["reviewQueue"] = review_queue

    if status == 200 and isinstance(review_queue, list) and review_queue:
        first_review = review_queue[0]
        review_id = first_review.get("id")
        if isinstance(review_id, str):
            confirm_status, confirm_result = http_json(
                "POST",
                f"{API_BASE}/projects/{project_id}/memory/reviews/{review_id}/confirm",
                timeout=30,
            )
            summary["reviewConfirmHttpStatus"] = confirm_status
            summary["reviewConfirm"] = confirm_result

        if len(review_queue) > 1:
            second_review = review_queue[1]
            second_review_id = second_review.get("id")
            if isinstance(second_review_id, str):
                reject_status, reject_result = http_json(
                    "POST",
                    f"{API_BASE}/projects/{project_id}/memory/reviews/{second_review_id}/reject",
                    timeout=30,
                )
                summary["reviewRejectHttpStatus"] = reject_status
                summary["reviewReject"] = reject_result

    status, review_queue_after = http_json(
        "GET",
        f"{API_BASE}/projects/{project_id}/memory/reviews",
        timeout=30,
    )
    summary["reviewQueueAfterHttpStatus"] = status
    summary["reviewQueueAfter"] = review_queue_after

    status, validation_run = http_json(
        "POST",
        f"{API_BASE}/projects/{project_id}/validation/run",
        timeout=60,
    )
    summary["validationRunHttpStatus"] = status
    summary["validationRun"] = validation_run

    status, project_validation_issues = http_json(
        "GET",
        f"{API_BASE}/projects/{project_id}/validation-issues",
        timeout=30,
    )
    summary["projectValidationIssuesHttpStatus"] = status
    summary["projectValidationIssues"] = project_validation_issues

    with psycopg.connect(env["DATABASE_URL"]) as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT COUNT(*) FROM "ChapterDraft" WHERE "chapterId" = %s', (chapter_id,))
            chapter_draft_count = cur.fetchone()[0]

            cur.execute('SELECT COUNT(*) FROM "ValidationIssue" WHERE "chapterId" = %s', (chapter_id,))
            validation_issue_count = cur.fetchone()[0]

            cur.execute('SELECT COUNT(*) FROM "MemoryChunk" WHERE "projectId" = %s', (project_id,))
            memory_chunk_count = cur.fetchone()[0]

            cur.execute('SELECT COUNT(*) FROM "StoryEvent" WHERE "projectId" = %s', (project_id,))
            story_event_count = cur.fetchone()[0]

            cur.execute('SELECT COUNT(*) FROM "CharacterStateSnapshot" WHERE "projectId" = %s', (project_id,))
            character_state_count = cur.fetchone()[0]

            cur.execute('SELECT COUNT(*) FROM "ForeshadowTrack" WHERE "projectId" = %s', (project_id,))
            foreshadow_count = cur.fetchone()[0]

            cur.execute(
                'SELECT COUNT(*) FROM "MemoryChunk" WHERE "projectId" = %s AND status = %s',
                (project_id, "pending_review"),
            )
            pending_review_count = cur.fetchone()[0]

            cur.execute(
                'SELECT COUNT(*) FROM "MemoryChunk" WHERE "projectId" = %s AND status = %s',
                (project_id, "user_confirmed"),
            )
            confirmed_review_count = cur.fetchone()[0]

            cur.execute(
                'SELECT COUNT(*) FROM "MemoryChunk" WHERE "projectId" = %s AND status = %s',
                (project_id, "rejected"),
            )
            rejected_review_count = cur.fetchone()[0]

            job_status = None
            if isinstance(generation, dict) and generation.get("id"):
                cur.execute('SELECT "status"::text FROM "GenerationJob" WHERE id = %s', (generation["id"],))
                row = cur.fetchone()
                job_status = row[0] if row else None

    summary["databaseSummary"] = {
        "chapterDraftCount": chapter_draft_count,
        "validationIssueCount": validation_issue_count,
        "memoryChunkCount": memory_chunk_count,
        "storyEventCount": story_event_count,
        "characterStateSnapshotCount": character_state_count,
        "foreshadowTrackCount": foreshadow_count,
        "pendingReviewMemoryCount": pending_review_count,
        "confirmedReviewMemoryCount": confirmed_review_count,
        "rejectedReviewMemoryCount": rejected_review_count,
        "jobStatus": job_status,
    }

    print(json.dumps(summary, ensure_ascii=False, indent=2))

    if isinstance(generation, dict) and generation.get("status") == "completed":
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())