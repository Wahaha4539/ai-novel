class SummaryService:
    def summarize_chapter(self, text: str, project: dict, chapter: dict) -> str:
        _ = project
        return (
            f"《{chapter.get('title')}》中，顾三川借夜谈试探主角对失踪案线索的掌握程度，"
            "主角以模糊回答与动作细节维持表面平静，双方的互相怀疑正式建立。"
        )
