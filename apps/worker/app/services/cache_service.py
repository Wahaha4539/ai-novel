from __future__ import annotations

import hashlib
import json
from typing import Any, Callable, TypeVar

from redis import Redis

from app.core.config import get_settings
from app.core.logging import get_logger, log_event

logger = get_logger(__name__)

T = TypeVar("T")


class CacheService:
    def __init__(self) -> None:
        self.settings = get_settings()
        self._redis: Redis | None = None

    def get_project_snapshot(self, project_id: str, loader: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        return self._cache_aside(
            key=self.project_snapshot_key(project_id),
            ttl_seconds=self.settings.cache_project_snapshot_ttl_seconds,
            loader=loader,
            cache_kind="project_snapshot",
            log_context={"projectId": project_id},
        )

    def get_chapter_context(
        self,
        project_id: str,
        chapter_id: str,
        loader: Callable[[], dict[str, Any]],
    ) -> dict[str, Any]:
        return self._cache_aside(
            key=self.chapter_context_key(project_id, chapter_id),
            ttl_seconds=self.settings.cache_chapter_context_ttl_seconds,
            loader=loader,
            cache_kind="chapter_context",
            log_context={"projectId": project_id, "chapterId": chapter_id},
        )

    def get_recall_result(
        self,
        project_id: str,
        context: dict[str, Any],
        include_lorebook: bool,
        include_memory: bool,
        loader: Callable[[], dict[str, Any]],
    ) -> dict[str, Any]:
        key = self.recall_result_key(project_id, context, include_lorebook, include_memory)
        signature = key.rsplit(":", 1)[-1]
        return self._cache_aside(
            key=key,
            ttl_seconds=self.settings.cache_recall_result_ttl_seconds,
            loader=loader,
            cache_kind="recall_result",
            log_context={
                "projectId": project_id,
                "includeLorebook": include_lorebook,
                "includeMemory": include_memory,
                "contextSignature": signature,
            },
        )

    def invalidate_project_recall_results(self, project_id: str) -> int:
        deleted = self._delete_by_pattern(self.recall_result_pattern(project_id))
        log_event(
            logger,
            "cache.invalidate",
            cacheKind="recall_result",
            projectId=project_id,
            deletedKeys=deleted,
        )
        return deleted

    @staticmethod
    def project_snapshot_key(project_id: str) -> str:
        return f"ai_novel:project:{project_id}:snapshot"

    @staticmethod
    def chapter_context_key(project_id: str, chapter_id: str) -> str:
        return f"ai_novel:project:{project_id}:chapter:{chapter_id}:context"

    def recall_result_key(
        self,
        project_id: str,
        context: dict[str, Any],
        include_lorebook: bool,
        include_memory: bool,
    ) -> str:
        signature_payload = {
            "queryText": self._normalize_string(context.get("queryText")),
            "objective": self._normalize_string(context.get("objective")),
            "conflict": self._normalize_string(context.get("conflict")),
            "characters": [self._normalize_string(item) for item in context.get("characters", [])],
            "includeLorebook": bool(include_lorebook),
            "includeMemory": bool(include_memory),
        }
        payload = json.dumps(signature_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        signature = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]
        return f"ai_novel:project:{project_id}:recall:bundle:{signature}"

    @staticmethod
    def recall_result_pattern(project_id: str) -> str:
        return f"ai_novel:project:{project_id}:recall:*"

    def _cache_aside(
        self,
        *,
        key: str,
        ttl_seconds: int,
        loader: Callable[[], T],
        cache_kind: str,
        log_context: dict[str, Any],
    ) -> T:
        cached = self._get_json(key)
        if cached is not None:
            log_event(
                logger,
                "cache.hit",
                cacheKind=cache_kind,
                cacheKey=key,
                ttlSeconds=ttl_seconds,
                **log_context,
            )
            return cached

        value = loader()
        self._set_json(key, value, ttl_seconds)
        log_event(
            logger,
            "cache.miss",
            cacheKind=cache_kind,
            cacheKey=key,
            ttlSeconds=ttl_seconds,
            **log_context,
        )
        return value

    def _get_redis(self) -> Redis:
        if self._redis is None:
            self._redis = Redis.from_url(self.settings.redis_url, decode_responses=True)

        return self._redis

    def _get_json(self, key: str) -> Any | None:
        raw = self._get_redis().get(key)
        if raw is None:
            return None

        return json.loads(raw)

    def _set_json(self, key: str, value: Any, ttl_seconds: int) -> None:
        self._get_redis().set(key, json.dumps(value, ensure_ascii=False), ex=ttl_seconds)

    def _delete_by_pattern(self, pattern: str) -> int:
        client = self._get_redis()
        deleted = 0
        cursor = 0

        while True:
            cursor, keys = client.scan(cursor=cursor, match=pattern, count=100)
            if keys:
                deleted += client.delete(*keys)

            if cursor == 0:
                break

        return deleted

    @staticmethod
    def _normalize_string(value: Any) -> str:
        if value is None:
            return ""
        return str(value).strip().lower()