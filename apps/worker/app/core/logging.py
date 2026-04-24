from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any


WORKER_LOG_FILE = Path("logs/worker.log")


def configure_logging() -> None:
    """配置 Worker 日志输出到控制台和独立文件。

    输出:
        None。为根 logger 安装 stdout 与 logs/worker.log 两类 handler。
    副作用:
        创建 logs 目录，并覆盖当前进程根 logger 的 handler 配置。
    """
    WORKER_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)

    formatter = logging.Formatter("%(message)s")
    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)

    # 限制单文件大小，避免长期运行时日志无限增长；旧日志仍位于 logs 目录并被 git 忽略。
    file_handler = RotatingFileHandler(
        WORKER_LOG_FILE,
        maxBytes=10 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)

    logging.basicConfig(level=logging.INFO, handlers=[stream_handler, file_handler], force=True)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


def log_event(logger: logging.Logger, event: str, *, level: str = "info", **payload: Any) -> None:
    record = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "service": "worker",
        "event": event,
        **payload,
    }
    getattr(logger, level)(json.dumps(record, ensure_ascii=False))