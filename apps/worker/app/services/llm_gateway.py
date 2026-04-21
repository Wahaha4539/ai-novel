import json
import urllib.error
import urllib.request

from app.models.dto import BuiltPrompt
from app.core.config import get_settings


class LlmGateway:
    def __init__(self) -> None:
        self.settings = get_settings()

    @staticmethod
    def _extract_text(response_payload: dict) -> str:
        choices = response_payload.get("choices") or []
        if not choices:
            return ""

        message = choices[0].get("message") or {}
        content = message.get("content")
        if isinstance(content, str):
            return content

        if isinstance(content, list):
            texts: list[str] = []
            for item in content:
                if not isinstance(item, dict):
                    continue
                if item.get("type") in {"text", "output_text"} and isinstance(item.get("text"), str):
                    texts.append(item["text"])
            return "".join(texts)

        return ""

    def generate(self, prompt: BuiltPrompt, *, target_word_count: int | None = None) -> str:
        if not self.settings.llm_api_key:
            raise ValueError("缺少 LLM_API_KEY，无法调用真实模型")

        request = urllib.request.Request(
            url=f"{self.settings.llm_base_url.rstrip('/')}/chat/completions",
            data=json.dumps(
                {
                    "model": self.settings.llm_model,
                    "messages": [
                        {"role": "system", "content": prompt.system},
                        {"role": "user", "content": prompt.user},
                    ],
                    "temperature": 0.8,
                    "max_tokens": max(800, min((target_word_count or 1800), 4000)),
                },
                ensure_ascii=False,
            ).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.settings.llm_api_key}",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=240) as response:
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
