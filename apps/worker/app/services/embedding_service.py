"""Embedding service — calls the BGE embedding API to generate vectors.

Uses a separate lightweight embedding server (BAAI/bge-base-zh-v1.5)
that exposes an OpenAI-compatible /v1/embeddings endpoint.

Failure policy: fail-fast with retry. No silent degradation.
"""
import json
import time
import urllib.request

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)

# 重试配置
_MAX_RETRIES = 3
_RETRY_DELAY_SECONDS = 2


class EmbeddingService:
    """Generates text embeddings via the BGE embedding API.
    
    All methods raise on failure — no silent None returns.
    """

    def __init__(self) -> None:
        settings = get_settings()
        self.base_url = settings.embedding_base_url.rstrip("/")
        self.dimensions = settings.embedding_dimensions
        logger.info("embedding.init", extra={"base_url": self.base_url, "dimensions": self.dimensions})

    def embed_text(self, text: str) -> list[float]:
        """Generate embedding vector for a single text string.
        Raises RuntimeError if the service is unavailable after retries."""
        logger.info("embedding.text", extra={"text_len": len(text), "preview": text[:80]})
        result = self._call_with_retry(text)
        logger.info("embedding.text.done", extra={"dim": len(result)})
        return result

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings for multiple texts in one request.
        Raises RuntimeError if the service is unavailable after retries."""
        if not texts:
            return []
        logger.info("embedding.batch", extra={"count": len(texts), "total_chars": sum(len(t) for t in texts)})
        result = self._call_with_retry(texts)
        logger.info("embedding.batch.done", extra={"count": len(result)})
        return result

    def _call_with_retry(self, input_data: str | list[str]) -> list[float] | list[list[float]]:
        """Call embedding API with retry logic. Raises on final failure."""
        last_error = None
        for attempt in range(1, _MAX_RETRIES + 1):
            try:
                return self._call_api(input_data)
            except Exception as e:
                last_error = e
                logger.warning("embedding.retry", extra={
                    "attempt": attempt, "max": _MAX_RETRIES, "error": str(e),
                })
                if attempt < _MAX_RETRIES:
                    time.sleep(_RETRY_DELAY_SECONDS)

        # 所有重试都失败，直接抛异常
        raise RuntimeError(
            f"Embedding 服务连续 {_MAX_RETRIES} 次请求失败，"
            f"地址: {self.base_url}/embeddings，"
            f"最后一次错误: {last_error}"
        )

    def _call_api(self, input_data: str | list[str]) -> list[float] | list[list[float]]:
        """Call the embedding API endpoint. Raises on any failure."""
        is_batch = isinstance(input_data, list)
        payload = json.dumps({
            "input": input_data,
            "model": "bge-base-zh",
        }).encode("utf-8")

        url = f"{self.base_url}/embeddings"
        logger.info("embedding.api.request", extra={
            "url": url, "is_batch": is_batch,
            "input_count": len(input_data) if is_batch else 1,
        })

        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
        )

        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())

        logger.info("embedding.api.response", extra={
            "data_count": len(result.get('data', [])),
            "model": result.get('model', '?'),
        })

        data = result.get("data", [])
        if not data:
            raise RuntimeError(f"Embedding API 返回空 data，响应: {json.dumps(result)[:200]}")

        if is_batch:
            # Sort by index to ensure correct ordering
            sorted_data = sorted(data, key=lambda x: x.get("index", 0))
            return [item["embedding"] for item in sorted_data]
        else:
            return data[0]["embedding"]
