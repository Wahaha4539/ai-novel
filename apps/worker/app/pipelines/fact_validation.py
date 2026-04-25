from app.core.logging import get_logger, log_event
from app.repositories.fact_validation_repo import FactValidationRepository
from app.repositories.validation_repo import ValidationRepository

logger = get_logger(__name__)


class FactValidationPipeline:
    """Run deterministic cross-fact validation inside the worker process."""

    def __init__(self) -> None:
        self.fact_repo = FactValidationRepository()
        self.validation_repo = ValidationRepository()

    def run(self, project_id: str, chapter_id: str) -> dict:
        """Validate extracted facts and replace this chapter's fact-rule issues.

        Args:
            project_id: Project UUID.
            chapter_id: Chapter UUID.

        Returns:
            Counts and issue payloads compatible with the former API validation
            response fields used by the frontend.

        Side effects:
            Deletes/recreates deterministic fact-rule ValidationIssue rows.
        """
        log_context = {"projectId": project_id, "chapterId": chapter_id}
        log_event(logger, "fact_validation.started", **log_context)

        scope = self.fact_repo.load_scope(project_id, chapter_id)
        issues = self._compute_issues(scope)
        write_result = self.validation_repo.replace_fact_rule_issues(project_id, chapter_id, issues)

        log_event(
            logger,
            "fact_validation.completed",
            **log_context,
            deletedCount=write_result["deletedCount"],
            createdCount=write_result["createdCount"],
        )
        return {
            **write_result,
            "issues": issues,
            "factCounts": {
                "storyEvents": len(scope["storyEvents"]),
                "characterStateSnapshots": len(scope["characterStates"]),
                "foreshadowTracks": len(scope["foreshadowTracks"]),
            },
        }

    def _compute_issues(self, scope: dict[str, list[dict]]) -> list[dict]:
        """Compute the same fact-rule issue family that the API route used."""
        issues: list[dict] = []
        dead_character_map = {item["name"]: item for item in scope["deadCharacters"]}

        last_timeline_event: dict | None = None
        for event in scope["storyEvents"]:
            timeline_seq = event.get("timelineSeq")
            if timeline_seq is None:
                continue

            if last_timeline_event and timeline_seq < last_timeline_event["timelineSeq"]:
                issues.append(
                    {
                        "chapterId": event["chapterId"],
                        "issueType": "timeline_conflict",
                        "severity": "error",
                        "entityType": "story_event",
                        "entityId": event["id"],
                        "message": f"事件「{event['title']}」的 timelineSeq={timeline_seq} 早于前序事件「{last_timeline_event['title']}」的 timelineSeq={last_timeline_event['timelineSeq']}。",
                        "evidence": [
                            {
                                "currentEventId": event["id"],
                                "currentChapterNo": event.get("chapterNo"),
                                "currentTimelineSeq": timeline_seq,
                                "previousEventId": last_timeline_event["id"],
                                "previousChapterNo": last_timeline_event.get("chapterNo"),
                                "previousTimelineSeq": last_timeline_event["timelineSeq"],
                            }
                        ],
                        "suggestion": "检查章节 timelineSeq 与事件排序，必要时先修正结构化事实后再生成。",
                    }
                )

            last_timeline_event = {
                "id": event["id"],
                "title": event["title"],
                "chapterNo": event.get("chapterNo"),
                "timelineSeq": timeline_seq,
            }

        for event in scope["storyEvents"]:
            participants = [item for item in event.get("participants", []) if isinstance(item, str)]
            dead_participants = [name for name in participants if name in dead_character_map]
            if dead_participants:
                issues.append(
                    {
                        "chapterId": event["chapterId"],
                        "issueType": "dead_character_appearance",
                        "severity": "error",
                        "entityType": "story_event",
                        "entityId": event["id"],
                        "message": f"已标记死亡的角色 {'、'.join(dead_participants)} 仍出现在事件「{event['title']}」的参与者列表中。",
                        "evidence": [
                            {
                                "storyEventId": event["id"],
                                "title": event["title"],
                                "chapterNo": event.get("chapterNo"),
                                "participants": participants,
                            }
                        ],
                        "suggestion": "核对角色生死状态，或补充“回忆/幻觉/尸体”之类的明确说明。",
                    }
                )

        for snapshot in scope["characterStates"]:
            if snapshot["characterName"] not in dead_character_map or snapshot.get("status") == "rejected":
                continue
            issues.append(
                {
                    "chapterId": snapshot["chapterId"],
                    "issueType": "dead_character_appearance",
                    "severity": "warning",
                    "entityType": "character_state_snapshot",
                    "entityId": snapshot["id"],
                    "message": f"已标记死亡的角色 {snapshot['characterName']} 在角色状态快照中仍被写入「{snapshot['stateValue']}」。",
                    "evidence": [
                        {
                            "characterStateSnapshotId": snapshot["id"],
                            "chapterNo": snapshot.get("chapterNo"),
                            "stateType": snapshot["stateType"],
                            "stateValue": snapshot["stateValue"],
                            "reviewStatus": snapshot.get("status"),
                        }
                    ],
                    "suggestion": "如果这是回忆或尸体状态，请改写为更明确的事实类型；否则请修正角色档案。",
                }
            )

        foreshadow_group: dict[str, list[dict]] = {}
        for track in scope["foreshadowTracks"]:
            foreshadow_group.setdefault(track["title"], []).append(track)

        for title, tracks in foreshadow_group.items():
            chapter_nos = [track["chapterNo"] for track in tracks if isinstance(track.get("chapterNo"), int)]
            earliest_chapter_no = min(chapter_nos) if chapter_nos else None
            for track in tracks:
                if earliest_chapter_no is not None and track.get("firstSeenChapterNo") is not None and track["firstSeenChapterNo"] != earliest_chapter_no:
                    issues.append(
                        {
                            "chapterId": track["chapterId"],
                            "issueType": "foreshadow_first_seen_mismatch",
                            "severity": "warning",
                            "entityType": "foreshadow_track",
                            "entityId": track["id"],
                            "message": f"伏笔「{title}」的 firstSeenChapterNo={track['firstSeenChapterNo']}，但当前最早出现章节为第 {earliest_chapter_no} 章。",
                            "evidence": [{"foreshadowTrackId": track["id"], "chapterNo": track.get("chapterNo"), "firstSeenChapterNo": track["firstSeenChapterNo"], "expectedFirstSeenChapterNo": earliest_chapter_no}],
                            "suggestion": "执行 rebuild 或手动修正 firstSeenChapterNo，保证首次出现查询稳定。",
                        }
                    )
                if track.get("firstSeenChapterNo") is not None and track.get("lastSeenChapterNo") is not None and track["lastSeenChapterNo"] < track["firstSeenChapterNo"]:
                    issues.append(
                        {
                            "chapterId": track["chapterId"],
                            "issueType": "foreshadow_range_invalid",
                            "severity": "warning",
                            "entityType": "foreshadow_track",
                            "entityId": track["id"],
                            "message": f"伏笔「{title}」的 lastSeenChapterNo={track['lastSeenChapterNo']} 小于 firstSeenChapterNo={track['firstSeenChapterNo']}。",
                            "evidence": [{"foreshadowTrackId": track["id"], "chapterNo": track.get("chapterNo"), "firstSeenChapterNo": track["firstSeenChapterNo"], "lastSeenChapterNo": track["lastSeenChapterNo"]}],
                            "suggestion": "修正伏笔章节范围，避免首次/最近一次出现查询失真。",
                        }
                    )

        return issues