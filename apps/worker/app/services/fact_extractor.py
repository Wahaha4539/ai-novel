class FactExtractor:
    def extract_events(self, text: str, project: dict, chapter: dict) -> list[dict]:
        _ = (text, project)
        return [
            {
                "title": f"{chapter.get('title')}：夜谈试探",
                "eventType": "dialogue_conflict",
                "description": "顾三川借口供试探主角，主角选择保留信息。",
            }
        ]

    def extract_character_states(self, text: str, project: dict, chapter: dict) -> list[dict]:
        _ = (text, project, chapter)
        return [
            {"character": "顾三川", "mentalState": "怀疑加深但未表露"},
            {"character": "主角", "mentalState": "警惕，保持克制"},
        ]

    def extract_foreshadows(self, text: str, project: dict, chapter: dict) -> list[dict]:
        _ = (text, project, chapter)
        return [
            {"title": "顾三川后续调查主角", "status": "planned"}
        ]
