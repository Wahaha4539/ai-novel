"""验证真实数据上的 embedding backfill 与召回质量。

脚本只通过 API 访问现有能力，不直接改数据库。默认先执行 dry-run backfill；
只有传入 --apply-backfill 时才会触发真实 embedding 回填。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from urllib import parse, request


def call_json(method: str, url: str, payload: dict | None = None) -> dict:
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = request.Request(url, data=body, method=method, headers={"Content-Type": "application/json"})
    with request.urlopen(req, timeout=120) as resp:  # noqa: S310 - 本地开发验证脚本，目标 URL 由调用者显式传入。
        return json.loads(resp.read().decode("utf-8"))


def load_cases(path: str | None) -> list[dict]:
    if not path:
        return []
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("benchmark cases 文件必须是 JSON 数组")
    return data


def main() -> int:
    parser = argparse.ArgumentParser(description="验证 API 内 embedding 回填和召回 benchmark。")
    parser.add_argument("--api", default="http://127.0.0.1:3001/api", help="API base URL，默认 http://127.0.0.1:3001/api")
    parser.add_argument("--project-id", required=True, help="真实项目 ID")
    parser.add_argument("--chapter-id", help="可选：限定单章 MemoryChunk")
    parser.add_argument("--query", required=True, help="召回评测查询文本")
    parser.add_argument("--expected-memory-ids", default="", help="逗号分隔的期望 MemoryChunk ID，用于计算 recall/precision/MRR")
    parser.add_argument("--cases", help="可选 benchmark cases JSON 文件，格式：[{id, query, expectedMemoryIds}]")
    parser.add_argument("--limit", type=int, default=20, help="backfill 单批数量")
    parser.add_argument("--apply-backfill", action="store_true", help="执行真实 embedding 回填；默认只 dry-run")
    args = parser.parse_args()

    base = args.api.rstrip("/")
    query = parse.urlencode({"chapterId": args.chapter_id or "", "dryRun": "false" if args.apply_backfill else "true", "limit": str(args.limit)})
    backfill_url = f"{base}/projects/{args.project_id}/memory/embeddings/backfill?{query}"
    backfill = call_json("POST", backfill_url)

    expected = [item.strip() for item in args.expected_memory_ids.split(",") if item.strip()]
    evaluate_url = f"{base}/projects/{args.project_id}/memory/retrieval/evaluate?{parse.urlencode({'q': args.query, 'expectedMemoryIds': ','.join(expected)})}"
    evaluation = call_json("GET", evaluate_url)

    cases = load_cases(args.cases)
    benchmark = call_json("POST", f"{base}/projects/{args.project_id}/memory/retrieval/benchmark", {"cases": cases}) if cases else None

    print(json.dumps({"backfill": backfill, "evaluation": evaluation, "benchmark": benchmark}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())