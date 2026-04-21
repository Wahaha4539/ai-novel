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
    CHARACTER_STATE = "character_state"
    FORESHADOW = "foreshadow"
    STYLE = "style"


class MemoryStatus(StrEnum):
    AUTO = "auto"
    PENDING_REVIEW = "pending_review"
    USER_CONFIRMED = "user_confirmed"
    REJECTED = "rejected"
