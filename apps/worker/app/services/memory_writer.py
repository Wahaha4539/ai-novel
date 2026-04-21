import uuid

from app.models.enums import MemoryType


class MemoryWriter:
    def write_summary_memory(self, project_id: str, chapter_id: str, summary: str) -> dict:
        return {
            "projectId": project_id,
            "sourceId": chapter_id,
            "sourceType": "chapter",
            "memoryType": MemoryType.SUMMARY.value,
            "content": summary,
            "summary": summary,
            "tags": ["chapter", "summary"],
        }

    def write_event_memories(self, project_id: str, events: list[dict]) -> list[dict]:
        return [
            {
                "projectId": project_id,
                "sourceType": "event",
                "sourceId": str(uuid.uuid4()),
                "memoryType": MemoryType.EVENT.value,
                "content": event["description"],
                "summary": event["title"],
                "tags": ["event"],
            }
            for event in events
        ]
