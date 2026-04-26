"""
LlmGateway — Sends chat completions to an OpenAI-Compatible LLM endpoint.

Config resolution:
  - When app_step is provided (e.g. "generate", "polish"), uses step routing → default → env
  - When app_step is omitted, uses default provider → env (for internal services like validation/summary)
"""
import json
import logging
import http.client
import time
import urllib.error
import urllib.request

from app.models.dto import BuiltPrompt
from app.repositories.llm_provider_repo import LlmProviderRepository, ResolvedLlmConfig

logger = logging.getLogger(__name__)


class LlmGateway:
    """Unified LLM API caller with startup-cached provider resolution."""

    # 上游兼容网关偶发提前关闭 chunked 响应，短重试能避免整条业务链路直接 500。
    _MAX_ATTEMPTS = 3
    _RETRY_DELAY_SECONDS = 1.5

    @staticmethod
    def _extract_text(response_payload: dict) -> str:
        """Extract text content from OpenAI-compatible response payload."""
        choices = response_payload.get("choices") or []
        if not choices:
            return ""

        message = choices[0].get("message") or {}
        content = message.get("content")
        if isinstance(content, str):
            return content

        # Handle structured content (array of text blocks)
        if isinstance(content, list):
            texts: list[str] = []
            for item in content:
                if not isinstance(item, dict):
                    continue
                if item.get("type") in {"text", "output_text"} and isinstance(item.get("text"), str):
                    texts.append(item["text"])
            return "".join(texts)

        return ""

    def generate(
        self,
        prompt: BuiltPrompt,
        *,
        target_word_count: int | None = None,
        app_step: str | None = None,
    ) -> str:
        """
        Send a chat completion request.

        Args:
            prompt: System + user prompt pair.
            target_word_count: Hint for max_tokens calculation.
            app_step: Optional step identifier for provider routing
                      ("generate", "polish", or None for default provider).
        """
        # Resolve config from the startup-loaded snapshot; this path should not hit DB per LLM call.
        config = LlmProviderRepository.resolve_for_step(app_step)

        if not config.api_key:
            raise ValueError("缺少 LLM API Key，无法调用模型。请在 LLM 配置中设置 Provider。")

        url = f"{config.base_url.rstrip('/')}/chat/completions"
        temperature = config.params.get("temperature", 0.8)
        # 不主动传 max_tokens，让供应商按模型默认上限处理长文本输出，避免本地估算字数/token 不准导致截断。
        request_body = {
            "model": config.model,
            "messages": [
                {"role": "system", "content": prompt.system},
                {"role": "user", "content": prompt.user},
            ],
            "temperature": temperature,
        }

        request = urllib.request.Request(
            url=url,
            data=json.dumps(request_body, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {config.api_key}",
            },
            method="POST",
        )

        logger.info(
            "[LLM] → %s src=%s step=%s temp=%.1f max_tokens=provider_default",
            config.model, config.source, app_step or "default", temperature,
        )

        payload: dict | None = None
        last_error: Exception | None = None
        for attempt in range(1, self._MAX_ATTEMPTS + 1):
            try:
                payload = self._post_chat_completion(request, timeout=600)
                break
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"LLM 请求失败: {exc.code} {detail}") from exc
            except (urllib.error.URLError, http.client.IncompleteRead, json.JSONDecodeError) as exc:
                last_error = exc
                if attempt >= self._MAX_ATTEMPTS:
                    break

                # IncompleteRead 通常表示供应商/代理在 chunked body 结束前断开；重试同一请求。
                logger.warning(
                    "[LLM] 请求读取失败，准备重试 model=%s attempt=%d/%d error=%s",
                    config.model,
                    attempt,
                    self._MAX_ATTEMPTS,
                    exc,
                )
                time.sleep(self._RETRY_DELAY_SECONDS * attempt)

        else:
            # 理论上不会走到这里；保留防御分支避免静态分析误判 payload 未定义。
            raise RuntimeError("LLM 请求失败: 未知错误")

        if payload is None and last_error is not None:
            if isinstance(last_error, urllib.error.URLError):
                raise RuntimeError(f"LLM 连接失败: {last_error.reason}") from last_error
            if isinstance(last_error, http.client.IncompleteRead):
                raise RuntimeError(
                    f"LLM 响应读取不完整，已重试 {self._MAX_ATTEMPTS} 次: "
                    f"已读取 {len(last_error.partial)} 字节"
                ) from last_error
            raise RuntimeError(f"LLM 返回的 JSON 无法解析，已重试 {self._MAX_ATTEMPTS} 次") from last_error

        if payload is None:
            raise RuntimeError("LLM 请求失败: 未收到响应内容")

        text = self._extract_text(payload)
        if not text:
            preview = json.dumps(payload, ensure_ascii=False)[:1000]
            raise RuntimeError(f"LLM 返回内容为空: {preview}")

        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else None
        tokens = ""
        if usage:
            tokens = f" in={usage.get('prompt_tokens', '?')} out={usage.get('completion_tokens', '?')}"
        logger.info("[LLM] ← %s %dch%s", config.model, len(text), tokens)

        return text

    @staticmethod
    def _post_chat_completion(request: urllib.request.Request, timeout: int) -> dict:
        """
        Execute the HTTP request and parse a JSON response.

        Args:
            request: Prepared OpenAI-compatible chat completion request.
            timeout: Socket timeout in seconds.

        Returns:
            Parsed response payload.

        Raises:
            HTTPError/URLError for transport failures, IncompleteRead when the
            upstream closes chunked responses early, and JSONDecodeError for
            malformed response bodies.
        """
        try:
            # 长篇章节生成可能超过默认 4 分钟，放宽到 10 分钟以减少慢模型误超时。
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except http.client.IncompleteRead:
            # 保留原始异常给上层重试/报告；partial 内容通常不是完整 JSON，不能安全使用。
            raise

    def get_config(self, app_step: str | None = None) -> ResolvedLlmConfig:
        """Expose resolved config for logging/metadata purposes."""
        return LlmProviderRepository.resolve_for_step(app_step)
