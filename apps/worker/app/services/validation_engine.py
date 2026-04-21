from app.models.enums import ValidationSeverity
from app.models.schemas import ValidationIssue


class ValidationEngine:
    def precheck_chapter(self, context: dict, hard_facts: list[str]) -> list[ValidationIssue]:
        issues: list[ValidationIssue] = []
        if not context.get("objective"):
            issues.append(
                ValidationIssue(
                    severity=ValidationSeverity.ERROR,
                    issueType="chapter_objective_missing",
                    message="当前章节缺少 objective，无法稳定生成正文。",
                    suggestion="先补充章节目标，再触发生成。",
                )
            )
        if not hard_facts:
            issues.append(
                ValidationIssue(
                    severity=ValidationSeverity.WARNING,
                    issueType="hard_fact_missing",
                    message="当前未注入明确硬事实，生成结果更容易漂移。",
                    suggestion="补充角色状态、地点规则或最近章节摘要。",
                )
            )
        return issues

    def validate_generated_text(self, text: str, chapter: dict) -> list[ValidationIssue]:
        issues: list[ValidationIssue] = []
        if len(text) < 300:
            issues.append(
                ValidationIssue(
                    severity=ValidationSeverity.WARNING,
                    issueType="chapter_too_short",
                    message="生成正文长度偏短，可能不足以支撑完整章节节奏。",
                    suggestion="提高字数目标，或拆分为更多场景。",
                )
            )
        if "解释" in text:
            issues.append(
                ValidationIssue(
                    severity=ValidationSeverity.INFO,
                    issueType="explicit_exposition",
                    message="正文中可能存在直接解释设定的倾向。",
                    suggestion="改为通过动作、对话或环境细节侧写。",
                )
            )
        if not chapter.get("conflict"):
            issues.append(
                ValidationIssue(
                    severity=ValidationSeverity.WARNING,
                    issueType="chapter_conflict_missing",
                    message="章节缺少显式 conflict 字段，后续校验质量会受影响。",
                    suggestion="在结构化大纲中补充 conflict。",
                )
            )
        return issues
