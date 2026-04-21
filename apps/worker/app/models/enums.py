from enum import StrEnum


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class ValidationSeverity(StrEnum):
    ERROR = "error"
    WARNING = "warning"
    INFO = "info"


class MemoryType(StrEnum):
    SUMMARY = "summary"
    FACT = "fact"
    EVENT = "event"
    STYLE = "style"
