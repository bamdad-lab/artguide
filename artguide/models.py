from dataclasses import dataclass, field
from enum import Enum


class SourceType(str, Enum):
    CANONICAL = "canonical"  # museum collection page with a structured record
    REFERENCE = "reference"  # Wikipedia and similar
    WEAK = "weak"            # shops, stock photo, marketplaces, unknown sites


class Tier(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


@dataclass
class NamerResult:
    title: str | None
    artist: str | None
    self_confidence: str | None = None  # logged only, never used for gating


@dataclass
class ReverseCandidate:
    source_url: str
    source_type: SourceType
    work_id: str | None  # e.g. "met:436535", set only for canonical URLs we can resolve
    score: float


@dataclass
class Record:
    work_id: str
    source_url: str
    source_type: SourceType
    institution: str
    facts: dict[str, str]          # title, artist, date, medium, dimensions, credit_line ...
    source_text: str = ""          # descriptive text from the record, if the source has any


@dataclass
class Decision:
    tier: Tier
    record: Record | None
    reason: str
    evidence: dict = field(default_factory=dict)


@dataclass
class Script:
    text: str
    facts_text: str
    interpretation: str
    citations: list[str]
    guard_violations: list[str] = field(default_factory=list)
    interpretation_dropped: bool = False


@dataclass
class ScanResult:
    decision: Decision
    script: Script | None = None
    audio_path: str | None = None

    @property
    def refused(self) -> bool:
        return self.script is None
