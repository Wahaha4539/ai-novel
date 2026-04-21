from fastapi import FastAPI

from app.api.routes import router
from app.core.logging import configure_logging, get_logger, log_event

configure_logging()
logger = get_logger(__name__)

app = FastAPI(
    title="AI Novel Worker",
    description="长篇小说创作系统 Worker / Pipeline 服务",
    version="0.1.0",
)

app.include_router(router)


@app.on_event("startup")
def on_startup() -> None:
    log_event(logger, "worker.started")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}
