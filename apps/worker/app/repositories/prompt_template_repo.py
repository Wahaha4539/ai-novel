"""Repository for reading PromptTemplate records from the database.

Allows the worker pipeline to use DB-stored prompts (from the Prompt Manager UI)
instead of hardcoded file-system templates.
"""
import uuid

from sqlalchemy import select

from app.db.session import SessionLocal
from app.core.logging import get_logger
from app.models.sqlalchemy_models import PromptTemplateModel

logger = get_logger(__name__)


class PromptTemplateRepository:
    """Reads default prompt templates from the PromptTemplate table."""

    def get_default(self, step_key: str, project_id: str | None = None) -> dict | None:
        """Get the default prompt template for a given step.
        
        Priority: project-specific default > global default.
        
        Args:
            step_key: Template category key (e.g. 'write_chapter', 'polish_chapter')
            project_id: Optional project ID for project-specific templates
            
        Returns:
            Dict with systemPrompt and userTemplate, or None if not found.
        """
        with SessionLocal() as session:
            # 优先查找项目级默认模板
            if project_id:
                project_template = self._find_default(session, step_key, project_id)
                if project_template:
                    logger.info("prompt_template.resolved", extra={
                        "stepKey": step_key, "scope": "project",
                        "templateName": project_template["name"], "version": project_template["version"],
                    })
                    return project_template

            # 回退到全局默认模板（projectId IS NULL）
            global_template = self._find_default(session, step_key, project_id=None)
            if global_template:
                logger.info("prompt_template.resolved", extra={
                    "stepKey": step_key, "scope": "global",
                    "templateName": global_template["name"], "version": global_template["version"],
                })
            else:
                logger.warning("prompt_template.not_found", extra={"stepKey": step_key})
            return global_template

    @staticmethod
    def _find_default(session, step_key: str, project_id: str | None) -> dict | None:
        """Find the default template for a specific scope (project or global)."""
        stmt = (
            select(PromptTemplateModel)
            .where(
                PromptTemplateModel.step_key == step_key,
                PromptTemplateModel.is_default.is_(True),
            )
        )

        if project_id:
            stmt = stmt.where(PromptTemplateModel.project_id == uuid.UUID(project_id))
        else:
            stmt = stmt.where(PromptTemplateModel.project_id.is_(None))

        row = session.execute(stmt.limit(1)).scalar_one_or_none()
        if not row:
            return None

        return {
            "id": str(row.id),
            "stepKey": row.step_key,
            "name": row.name,
            "systemPrompt": row.system_prompt,
            "userTemplate": row.user_template,
            "version": row.version,
        }
