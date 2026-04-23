from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/ai_novel_mvp"
    redis_url: str = "redis://127.0.0.1:6379/0"
    cache_project_snapshot_ttl_seconds: int = 300
    cache_chapter_context_ttl_seconds: int = 300
    cache_recall_result_ttl_seconds: int = 120
    llm_base_url: str = "http://localhost:8318/v1"
    llm_api_key: str | None = None
    llm_model: str = "gpt-5.4"
    # Embedding 服务地址（独立部署的 bge-base-zh 模型）
    embedding_base_url: str = "http://localhost:18319/v1"
    embedding_dimensions: int = 768

    model_config = SettingsConfigDict(
        env_file=str(Path(__file__).resolve().parents[4] / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
