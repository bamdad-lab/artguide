import base64
import os
from typing import Protocol

import httpx


class TTS(Protocol):
    def synthesize(self, text: str, out_path: str) -> str: ...


class GoogleTTS:
    """Cloud Text-to-Speech. Needs GOOGLE_TTS_API_KEY (can be the same key as Vision).
    A placeholder choice: spec section 9 says pick the voice provider by ear."""

    URL = "https://texttospeech.googleapis.com/v1/text:synthesize"

    def __init__(self, api_key: str | None = None, voice: str | None = None, http: httpx.Client | None = None):
        self.api_key = api_key or os.environ.get("GOOGLE_TTS_API_KEY") or os.environ["GOOGLE_VISION_API_KEY"]
        self.voice = voice or os.environ.get("ARTGUIDE_VOICE", "en-GB-Neural2-B")
        self.http = http or httpx.Client(timeout=30)

    def synthesize(self, text: str, out_path: str) -> str:
        body = {
            "input": {"text": text},
            "voice": {"languageCode": "-".join(self.voice.split("-")[:2]), "name": self.voice},
            "audioConfig": {"audioEncoding": "MP3", "speakingRate": 0.95},
        }
        r = self.http.post(self.URL, params={"key": self.api_key}, json=body)
        r.raise_for_status()
        with open(out_path, "wb") as f:
            f.write(base64.b64decode(r.json()["audioContent"]))
        return out_path
