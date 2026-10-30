from concurrent.futures import ThreadPoolExecutor

from .identify import Namer, ReverseSearch
from .models import Decision, ScanResult, Tier
from .narrate import Narrator
from .retrieve import Retriever
from .scorer import decide
from .tts import TTS

REFUSAL_TEXT = "I can't identify this work reliably, so I won't guess."


class Pipeline:
    def __init__(self, namer: Namer, reverse: ReverseSearch, retriever: Retriever,
                 narrator: Narrator, tts: TTS | None = None):
        self.namer, self.reverse, self.retriever = namer, reverse, retriever
        self.narrator, self.tts = narrator, tts

    def identify(self, photo: bytes) -> Decision:
        with ThreadPoolExecutor(max_workers=2) as pool:
            named = pool.submit(self.namer.name, photo)
            found = pool.submit(self.reverse.search, photo)
            return decide(named.result(), found.result(), self.retriever)

    def scan(self, photo: bytes, audio_out: str | None = None) -> ScanResult:
        decision = self.identify(photo)
        # Phase 0 narrates only on HIGH. MEDIUM gets the candidate picker in Phase 1.
        if decision.tier is not Tier.HIGH:
            if self.tts and audio_out:
                self.tts.synthesize(REFUSAL_TEXT, audio_out)
                return ScanResult(decision, None, audio_out)
            return ScanResult(decision)
        script = self.narrator.script(decision.record, photo)
        audio = self.tts.synthesize(script.text, audio_out) if self.tts and audio_out else None
        return ScanResult(decision, script, audio)


def default_pipeline(with_tts: bool = True) -> Pipeline:
    from .identify import ClaudeNamer, GoogleVisionReverseSearch
    from .narrate import ClaudeNarrator
    from .retrieve import CompositeRetriever
    from .tts import GoogleTTS
    return Pipeline(ClaudeNamer(), GoogleVisionReverseSearch(), CompositeRetriever(),
                    ClaudeNarrator(), GoogleTTS() if with_tts else None)
