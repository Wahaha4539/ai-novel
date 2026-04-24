"""
LlmGateway — Sends chat completions to an OpenAI-Compatible LLM endpoint.

Config resolution:
  - When app_step is provided (e.g. "generate", "polish"), uses step routing → default → env
  - When app_step is omitted, uses default provider → env (for internal services like validation/summary)
"""
import json
import logging
import urllib.error
import urllib.request

from app.models.dto import BuiltPrompt
from app.repositories.llm_provider_repo import LlmProviderRepository, ResolvedLlmConfig

logger = logging.getLogger(__name__)


class LlmGateway:
    """Unified LLM API caller with startup-cached provider resolution."""

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
        # 长章节润色需要更大的输出空间；上限放宽到 10000，避免 6000+ 字章节被 4000 token 截断。
        max_tokens = max(800, min((target_word_count or 1800), 10000))

        request = urllib.request.Request(
            url=url,
            data=json.dumps(
                {
                    "model": config.model,
                    "messages": [
                        {"role": "system", "content": prompt.system},
                        {"role": "user", "content": prompt.user},
                    ],
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                },
                ensure_ascii=False,
            ).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {config.api_key}",
            },
            method="POST",
        )

        logger.info(
            "[LLM] → %s src=%s step=%s temp=%.1f max_tokens=%d",
            config.model, config.source, app_step or "default", temperature, max_tokens,
        )

        try:
            # 长篇章节生成可能超过默认 4 分钟，放宽到 10 分钟以减少慢模型误超时。
            with urllib.request.urlopen(request, timeout=600) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"LLM 请求失败: {exc.code} {detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"LLM 连接失败: {exc.reason}") from exc

        text = self._extract_text(payload)
        if not text:
            preview = json.dumps(payload, ensure_ascii=False)[:1000]
            raise RuntimeError(f"LLM 返回内容为空: {preview}")

        return text

    def get_config(self, app_step: str | None = None) -> ResolvedLlmConfig:
        """Expose resolved config for logging/metadata purposes."""
        return LlmProviderRepository.resolve_for_step(app_step)
