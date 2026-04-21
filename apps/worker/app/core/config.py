from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/ai_novel_mvp"
    redis_url: str = "redis://localhost:6379/0"
    llm_base_url: str = "http://localhost:8318/v1"
    llm_api_key: str | None = None
    llm_model: str = "gpt-5.4"
    embedding_dimensions: int = 1536

    model_config = SettingsConfigDict(
        env_file=str(Path(__file__).resolve().parents[4] / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
