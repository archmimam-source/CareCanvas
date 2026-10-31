"""Gemini client used by every AI feature in CareCanvas.

Talks to Google's Gemini API directly through the official `google-genai`
SDK. Configure with:

    GEMINI_API_KEY   required — key from https://aistudio.google.com/apikey
    GEMINI_MODEL_TEXT, GEMINI_MODEL_FAST, GEMINI_MODEL_PDF, GEMINI_MODEL_IMAGE
                     optional — override the default model per task
"""
from __future__ import annotations

import os
from typing import List, Optional, Tuple

from fastapi import HTTPException

# Default model per task. Override with the env vars above if Google renames
# or retires a model.
MODELS = {
    "text":  os.environ.get("GEMINI_MODEL_TEXT",  "gemini-2.5-pro"),
    "fast":  os.environ.get("GEMINI_MODEL_FAST",  "gemini-3-flash-preview"),
    "pdf":   os.environ.get("GEMINI_MODEL_PDF",   "gemini-2.5-flash"),
    "image": os.environ.get("GEMINI_MODEL_IMAGE", "gemini-3.1-flash-image-preview"),
}

_client = None


def api_key() -> Optional[str]:
    return (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or "").strip() or None


def is_configured() -> bool:
    return api_key() is not None


def require_key() -> None:
    """Raise a clean 500 when AI is called without a configured key."""
    if not is_configured():
        raise HTTPException(500, "GEMINI_API_KEY not configured")


def _get_client():
    global _client
    if _client is None:
        from google import genai
        _client = genai.Client(api_key=api_key())
    return _client


async def generate_text(prompt: str, *, system: Optional[str] = None,
                        model: str = "fast",
                        pdf_bytes: Optional[bytes] = None) -> str:
    """Single-turn text generation. Optionally attaches a PDF."""
    require_key()
    from google.genai import types
    contents: list = []
    if pdf_bytes is not None:
        contents.append(types.Part.from_bytes(data=pdf_bytes, mime_type="application/pdf"))
    contents.append(prompt)
    config = types.GenerateContentConfig(system_instruction=system) if system else None
    resp = await _get_client().aio.models.generate_content(
        model=MODELS.get(model, model), contents=contents, config=config,
    )
    return (resp.text or "").strip()


async def generate_image(prompt: str, *, system: Optional[str] = None) -> Tuple[str, List[bytes]]:
    """Generate image(s) from a prompt. Returns (text, [png_bytes, ...])."""
    require_key()
    from google.genai import types
    config = types.GenerateContentConfig(
        system_instruction=system,
        response_modalities=["IMAGE", "TEXT"],
    )
    resp = await _get_client().aio.models.generate_content(
        model=MODELS["image"], contents=[prompt], config=config,
    )
    text_parts: List[str] = []
    images: List[bytes] = []
    for cand in resp.candidates or []:
        for part in (cand.content.parts if cand.content else []) or []:
            if getattr(part, "inline_data", None) and part.inline_data.data:
                images.append(part.inline_data.data)
            elif getattr(part, "text", None):
                text_parts.append(part.text)
    return "\n".join(text_parts).strip(), images
