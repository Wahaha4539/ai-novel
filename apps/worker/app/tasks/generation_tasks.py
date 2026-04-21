from app.models.schemas import GenerateChapterJobRequest
from app.pipelines.generate_chapter import GenerateChapterPipeline


def run_generate_chapter(payload: GenerateChapterJobRequest):
    pipeline = GenerateChapterPipeline()
    return pipeline.run(payload)
