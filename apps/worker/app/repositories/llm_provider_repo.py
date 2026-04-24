"""
LlmProviderRepository — Resolves LLM config from a process-local snapshot.

Fallback chain:
  1. Step routing (LlmRouting[appStep] → LlmProvider)
  2. Default provider (isDefault=True, isActive=True)
  3. Environment variables (.env fallback)

The snapshot is loaded once at worker startup so LlmGateway does not query
PostgreSQL for every LLM call.
"""
from dataclasses import dataclass
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import joinedload

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models.sqlalchemy_models import LlmProviderModel, LlmRoutingModel


@dataclass
class ResolvedLlmConfig:
    """Resolved LLM connection details ready for API calls."""
    base_url: str
    api_key: str
    model: str
    params: dict
    source: str  # "routing" | "default_provider" | "env_fallback"


class LlmProviderRepository:
    """Reads LLM provider configuration from a startup-loaded in-memory cache."""

    _providers: list[dict] = []
    _routings: list[dict] = []
    _is_loaded: bool = False

    @classmethod
    def load_cache(cls) -> None:
        """
        Load all provider/routing rows into process memory.

        Side effect: opens one short-lived DB session during worker startup.
        Later resolve calls use only these lists and never touch the database.
        """
        with SessionLocal() as session:
            providers = session.scalars(select(LlmProviderModel)).all()
            routings = session.scalars(
                select(LlmRoutingModel).options(joinedload(LlmRoutingModel.provider))
            ).all()

            cls._providers = [cls._provider_to_cache(provider) for provider in providers]
            cls._routings = [
                {
                    "app_step": routing.app_step,
                    "model_override": routing.model_override,
                    "params_override": routing.params_override or {},
                    "provider": cls._provider_to_cache(routing.provider),
                }
                for routing in routings
                if routing.provider is not None
            ]
            cls._is_loaded = True

    @classmethod
    def cache_status(cls) -> dict[str, int | bool]:
        """Expose cache metadata for health/debug responses without leaking secrets."""
        return {
            "loaded": cls._is_loaded,
            "providerCount": len(cls._providers),
            "routingCount": len(cls._routings),
        }

    @staticmethod
    def _provider_to_cache(provider: LlmProviderModel) -> dict:
        """Convert an ORM provider row to a detached dict safe to keep after session close."""
        return {
            "id": str(provider.id),
            "base_url": provider.base_url,
            "api_key": provider.api_key,
            "default_model": provider.default_model,
            "extra_config": provider.extra_config or {},
            "is_default": provider.is_default,
            "is_active": provider.is_active,
        }

    @staticmethod
    def resolve_for_step(app_step: Optional[str] = None) -> ResolvedLlmConfig:
        """
        Resolve LLM config with 3-layer fallback:
          1. Step-specific routing → provider
          2. Default provider (isDefault=True)
          3. Environment variables
        """
        if not LlmProviderRepository._is_loaded:
            # Defensive fallback for tests/scripts that instantiate LlmGateway without FastAPI startup.
            LlmProviderRepository.load_cache()

        # 1. Try step-specific routing
        if app_step:
            config = LlmProviderRepository._resolve_from_routing(app_step)
            if config:
                return config

        # 2. Try default provider
        config = LlmProviderRepository._resolve_default_provider()
        if config:
            return config

        # 3. Fall back to environment variables
        return LlmProviderRepository._resolve_from_env()

    @staticmethod
    def _resolve_from_routing(app_step: str) -> Optional[ResolvedLlmConfig]:
        """Look up step routing from the in-memory startup snapshot."""
        routing = next(
            (item for item in LlmProviderRepository._routings if item["app_step"] == app_step),
            None,
        )

        if not routing or not routing["provider"].get("is_active"):
            return None

        provider = routing["provider"]
        # Merge extraConfig from provider with paramsOverride from routing
        params = {**provider.get("extra_config", {}), **routing.get("params_override", {})}

        return ResolvedLlmConfig(
            base_url=provider["base_url"],
            api_key=provider["api_key"],
            model=routing.get("model_override") or provider["default_model"],
            params=params,
            source="routing",
        )

    @staticmethod
    def _resolve_default_provider() -> Optional[ResolvedLlmConfig]:
        """Look up the default provider from the in-memory startup snapshot."""
        provider = next(
            (
                item
                for item in LlmProviderRepository._providers
                if item.get("is_default") and item.get("is_active")
            ),
            None,
        )

        if not provider:
            return None

        return ResolvedLlmConfig(
            base_url=provider["base_url"],
            api_key=provider["api_key"],
            model=provider["default_model"],
            params=provider.get("extra_config", {}),
            source="default_provider",
        )

    @staticmethod
    def _resolve_from_env() -> ResolvedLlmConfig:
        """Ultimate fallback: read from environment variables."""
        settings = get_settings()
        return ResolvedLlmConfig(
            base_url=settings.llm_base_url,
            api_key=settings.llm_api_key or "",
            model=settings.llm_model,
            params={},
            source="env_fallback",
        )
