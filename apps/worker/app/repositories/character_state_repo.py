import uuid

from sqlalchemy import delete

from app.db.session import SessionLocal
from app.models.sqlalchemy_models import CharacterStateSnapshotModel


class CharacterStateRepository:
    def replace_for_chapter(
        self,
        project_id: str,
        chapter_id: str,
        chapter_no: int | None,
        source_draft_id: str | None,
        states: list[dict],
        character_lookup: dict[str, str],
    ) -> dict:
        project_uuid = uuid.UUID(project_id)
        chapter_uuid = uuid.UUID(chapter_id)
        draft_uuid = uuid.UUID(source_draft_id) if source_draft_id else None
        created: list[dict] = []
        with SessionLocal.begin() as session:
            deleted = session.execute(
                delete(CharacterStateSnapshotModel).where(
                    CharacterStateSnapshotModel.project_id == project_uuid,
                    CharacterStateSnapshotModel.chapter_id == chapter_uuid,
                )
            ).rowcount or 0

            for state in states:
                character_id = character_lookup.get(state["character"])
                row = CharacterStateSnapshotModel(
                    project_id=project_uuid,
                    chapter_id=chapter_uuid,
                    chapter_no=chapter_no,
                    source_draft_id=draft_uuid,
                    character_id=uuid.UUID(character_id) if character_id else None,
                    character_name=state["character"],
                    state_type=state.get("stateType", "state"),
                    state_value=state["stateValue"],
                    summary=state.get("summary"),
                    status=state.get("status", "auto"),
                    metadata_json=state.get("metadata", {}),
                )
                session.add(row)
                session.flush()
                created.append(
                    {
                        "id": str(row.id),
                        "characterName": row.character_name,
                        "stateType": row.state_type,
                        "status": row.status,
                    }
                )

        return {"deleted": deleted, "created": created}