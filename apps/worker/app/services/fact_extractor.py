class FactExtractor:
    def extract_events(self, text: str, project: dict, chapter: dict) -> list[dict]:
        _ = (text, project)
        return [
            {
                "title": f"{chapter.get('title')}：夜谈试探",
                "eventType": "dialogue_conflict",
                "description": "顾三川借口供试探主角，主角选择保留信息。",
                "participants": ["顾三川", "主角"],
                "timelineSeq": chapter.get("timelineSeq") or chapter.get("chapterNo"),
                "status": "detected",
            }
        ]

    def extract_character_states(self, text: str, project: dict, chapter: dict) -> list[dict]:
        _ = (text, project, chapter)
        return [
            {
                "character": "顾三川",
                "stateType": "mental_state",
                "stateValue": "怀疑加深但未表露",
                "summary": "顾三川表面平静，但怀疑明显增强。",
            },
            {
                "character": "主角",
                "stateType": "mental_state",
                "stateValue": "警惕，保持克制",
                "summary": "主角持续警惕，没有主动暴露更多信息。",
            },
        ]

    def extract_foreshadows(self, text: str, project: dict, chapter: dict) -> list[dict]:
        _ = (text, project, chapter)
        return [
            {
                "title": "顾三川后续调查主角",
                "detail": "夜谈结束后，顾三川不会停止追查主角与失踪案的关联。",
                "status": "planned",
            }
        ]
