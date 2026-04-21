from app.models.enums import MemoryStatus, MemoryType


class MemoryWriter:
    def write_summary_memory(self, project_id: str, chapter: dict, summary: str) -> dict:
        return {
            "projectId": project_id,
            "sourceId": chapter["id"],
            "sourceType": "chapter",
            "memoryType": MemoryType.SUMMARY.value,
            "content": summary,
            "summary": summary,
            "tags": ["chapter", "summary"],
            "status": MemoryStatus.AUTO.value,
            "importanceScore": 90,
            "freshnessScore": 95,
            "recencyScore": 95,
            "sourceTrace": {
                "projectId": project_id,
                "chapterId": chapter["id"],
                "chapterNo": chapter.get("chapterNo"),
                "kind": "chapter_summary",
            },
        }

    def write_event_memories(self, project_id: str, chapter: dict, events: list[dict]) -> list[dict]:
        return [
            {
                "projectId": project_id,
                "sourceType": "chapter",
                "sourceId": chapter["id"],
                "memoryType": MemoryType.EVENT.value,
                "content": event["description"],
                "summary": event["title"],
                "tags": ["chapter", "event", event.get("eventType", "event")],
                "status": MemoryStatus.AUTO.value,
                "importanceScore": 75,
                "freshnessScore": 85,
                "recencyScore": 85,
                "metadata": {
                    "eventType": event.get("eventType"),
                    "participants": event.get("participants", []),
                },
                "sourceTrace": {
                    "projectId": project_id,
                    "chapterId": chapter["id"],
                    "chapterNo": chapter.get("chapterNo"),
                    "kind": "event",
                },
            }
            for event in events
        ]

    def write_character_state_memories(self, project_id: str, chapter: dict, states: list[dict]) -> list[dict]:
        return [
            {
                "projectId": project_id,
                "sourceType": "chapter",
                "sourceId": chapter["id"],
                "memoryType": MemoryType.CHARACTER_STATE.value,
                "content": f"{state['character']}：{state['stateValue']}",
                "summary": state.get("summary") or f"{state['character']}状态更新",
                "tags": ["chapter", "character_state", state["character"]],
                "status": MemoryStatus.PENDING_REVIEW.value,
                "importanceScore": 70,
                "freshnessScore": 80,
                "recencyScore": 80,
                "metadata": {
                    "character": state["character"],
                    "stateType": state.get("stateType", "state"),
                },
                "sourceTrace": {
                    "projectId": project_id,
                    "chapterId": chapter["id"],
                    "chapterNo": chapter.get("chapterNo"),
                    "kind": "character_state",
                },
            }
            for state in states
        ]

    def write_foreshadow_memories(self, project_id: str, chapter: dict, foreshadows: list[dict]) -> list[dict]:
        return [
            {
                "projectId": project_id,
                "sourceType": "chapter",
                "sourceId": chapter["id"],
                "memoryType": MemoryType.FORESHADOW.value,
                "content": foreshadow.get("detail") or foreshadow["title"],
                "summary": foreshadow["title"],
                "tags": ["chapter", "foreshadow"],
                "status": MemoryStatus.PENDING_REVIEW.value,
                "importanceScore": 65,
                "freshnessScore": 75,
                "recencyScore": 75,
                "metadata": {
                    "foreshadowStatus": foreshadow.get("status", "planned"),
                },
                "sourceTrace": {
                    "projectId": project_id,
                    "chapterId": chapter["id"],
                    "chapterNo": chapter.get("chapterNo"),
                    "kind": "foreshadow",
                },
            }
            for foreshadow in foreshadows
        ]
