"""Thin backend so provider keys stay off the phone. uvicorn artguide.server:app"""
import os
import tempfile
import uuid

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import FileResponse

from .pipeline import REFUSAL_TEXT, default_pipeline

app = FastAPI()
pipeline = default_pipeline()
AUDIO_DIR = os.environ.get("ARTGUIDE_AUDIO_DIR", tempfile.mkdtemp(prefix="artguide-"))


@app.post("/scan")
async def scan(photo: UploadFile = File(...)):
    audio_id = uuid.uuid4().hex
    result = pipeline.scan(await photo.read(), os.path.join(AUDIO_DIR, f"{audio_id}.mp3"))
    d = result.decision
    return {
        "tier": d.tier.value,
        "reason": d.reason,
        "text": REFUSAL_TEXT if result.refused else result.script.text,
        "source": None if result.refused else result.script.citations,
        "audio_url": f"/audio/{audio_id}" if result.audio_path else None,
    }


@app.get("/audio/{audio_id}")
def audio(audio_id: str):
    return FileResponse(os.path.join(AUDIO_DIR, f"{os.path.basename(audio_id)}.mp3"), media_type="audio/mpeg")
