from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")


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