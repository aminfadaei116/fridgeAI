"""Thin model wrapper. Every model call in the system goes through this module so that
retries, structured-output binding and the offline fallback are all in one place.

Almost everything runs on the OpenAI SDK - Gemini included, through its OpenAI-compatible
endpoint. The one exception is video: that surface takes text and images only, so a clip has
to go through Google's own SDK. `structured_video` is that door, and it is the only place in
the app that knows Google's SDK exists.
"""

from __future__ import annotations

import base64
import json
import logging
import mimetypes
import re
import time
from pathlib import Path
from typing import Any, TypeVar

from openai import APIError, OpenAI
from pydantic import BaseModel, ValidationError

from backend.config import Settings, get_settings

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

# Gemini caps a single inline request at 20 MB; anything bigger goes through the Files API.
INLINE_LIMIT_BYTES = 20 * 1024 * 1024

# How long to wait for Gemini to finish processing a video it was handed via the Files API.
UPLOAD_POLL_SECONDS = 2.0
UPLOAD_TIMEOUT_SECONDS = 600.0

# The video types Gemini accepts, by extension. Consulted BEFORE mimetypes, which knows some
# containers by a name the API rejects - .m4v guesses video/x-m4v where Gemini wants video/mp4.
VIDEO_MIME = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".qt": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".mpg": "video/mpeg",
    ".mpeg": "video/mpeg",
}


class LLMUnavailable(RuntimeError):
    """Raised when no model backend is reachable and the caller must fall back."""


class LLM:
    """Structured-output-first client. Free text is the exception, not the default."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self._client: OpenAI | None = None

    @property
    def available(self) -> bool:
        return self.settings.has_api_key and not self.settings.offline_mode

    @property
    def provider(self) -> str:
        return self.settings.llm_provider

    @property
    def client(self) -> OpenAI:
        if not self.available:
            key_name = (
                "GEMINI_API_KEY" if self.settings.llm_provider == "gemini" else "OPENAI_API_KEY"
            )
            raise LLMUnavailable(f"{key_name} is not set (or offline mode is on)")
        if self._client is None:
            # Gemini is reached through its OpenAI-compatible endpoint, so the only
            # difference between providers is this base URL.
            self._client = OpenAI(
                api_key=self.settings.api_key,
                base_url=self.settings.base_url,
                timeout=60.0,
            )
        return self._client

    # --- structured output ---------------------------------------------------

    def structured(
        self,
        *,
        schema: type[T],
        system: str,
        user: str | list[dict[str, Any]],
        model: str | None = None,
        temperature: float = 0.3,
    ) -> T:
        """Call the model and parse the reply straight into `schema`.

        Raises LLMUnavailable so callers can choose a deterministic fallback rather than
        crashing the request.
        """
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        try:
            parse = getattr(self.client.chat.completions, "parse", None)
            if parse is None:  # older SDKs keep it behind .beta
                parse = self.client.beta.chat.completions.parse
            completion = parse(
                model=model or self.settings.reasoning_model,
                messages=messages,
                response_format=schema,
                temperature=temperature,
            )
            parsed = completion.choices[0].message.parsed
            if parsed is None:
                raise LLMUnavailable("model returned no parsable content")
            return parsed
        except LLMUnavailable:
            raise
        except APIError as exc:
            logger.warning("structured call failed: %s", exc)
            raise LLMUnavailable(str(exc)) from exc
        except Exception as exc:  # SDK shape drift, network, schema rejection
            logger.warning("structured call failed: %s", exc)
            raise LLMUnavailable(str(exc)) from exc

    # --- video --------------------------------------------------------------

    def structured_video(
        self,
        *,
        schema: type[T],
        system: str,
        prompt: str,
        video: Path,
        model: str | None = None,
        fps: float = 2.0,
        temperature: float = 0.0,
    ) -> T:
        """Send a whole video clip to Gemini and parse the reply straight into `schema`.

        `fps` is how densely the model samples the clip, not the clip's own frame rate. The
        default of 1 fps on Google's side is too coarse for a hand passing through a fridge
        door, which is why callers raise it.

        Raises LLMUnavailable for every failure - no key, no SDK, a rejected schema - so the
        caller can fall back rather than lose the door cycle.
        """
        if not self.available:
            raise LLMUnavailable("no model access (missing key or offline mode)")
        if not self.settings.supports_video_input:
            raise LLMUnavailable(f"{self.provider} does not accept video input")
        if not video.is_file():
            raise LLMUnavailable(f"clip not found: {video}")

        try:
            from google import genai
            from google.genai import types
        except ImportError as exc:  # optional dependency; the frame-pair path still works
            raise LLMUnavailable(f"google-genai is not installed: {exc}") from exc

        client = genai.Client(api_key=self.settings.api_key)
        part, uploaded = self._video_part(client, types, video, fps)
        try:
            response = client.models.generate_content(
                model=model or self.settings.vision_model,
                contents=[part, f"{system}\n\n{prompt}"],
                config=types.GenerateContentConfig(
                    temperature=temperature,
                    response_mime_type="application/json",
                    response_schema=schema,
                    # No tools here; silences the SDK's "AFC in generate_content" warning.
                    automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
                ),
            )
        except Exception as exc:  # rejected key, rate limit, schema refusal, network
            logger.warning("video call failed: %s", exc)
            raise LLMUnavailable(str(exc)) from exc
        finally:
            if uploaded is not None:
                try:
                    client.files.delete(name=uploaded.name)
                except Exception as exc:  # best-effort cleanup; never fatal
                    logger.warning("could not delete uploaded clip %s: %s", uploaded.name, exc)

        text = response.text
        if not text:
            raise LLMUnavailable("model returned an empty response for the clip")
        try:
            return schema.model_validate_json(text)
        except ValidationError as exc:
            logger.warning("video reply did not match the schema: %s", exc)
            raise LLMUnavailable(f"video reply did not match the schema: {exc}") from exc

    def _video_part(self, client: Any, types: Any, video: Path, fps: float) -> tuple[Any, Any]:
        """Build the request part for `video`, uploading it only if it is too big to inline.

        Returns (part, uploaded_file); uploaded_file is None when the clip went inline, which
        is the normal case for a door cycle.
        """
        mime = _video_mime(video)
        metadata = types.VideoMetadata(fps=fps)

        if video.stat().st_size <= INLINE_LIMIT_BYTES:
            part = types.Part.from_bytes(data=video.read_bytes(), mime_type=mime)
            part.video_metadata = metadata
            return part, None

        logger.info("clip is over the inline limit; uploading %s", video.name)
        uploaded = client.files.upload(
            file=video, config=types.UploadFileConfig(mime_type=mime, display_name=video.name)
        )
        deadline = time.monotonic() + UPLOAD_TIMEOUT_SECONDS
        while uploaded.state == types.FileState.PROCESSING:
            if time.monotonic() > deadline:
                raise LLMUnavailable(f"timed out waiting for Gemini to process {uploaded.name}")
            time.sleep(UPLOAD_POLL_SECONDS)
            uploaded = client.files.get(name=uploaded.name)
        if uploaded.state != types.FileState.ACTIVE:
            reason = uploaded.error.message if uploaded.error else "unknown error"
            raise LLMUnavailable(f"Gemini could not process the clip ({uploaded.state}): {reason}")

        part = types.Part.from_uri(file_uri=uploaded.uri, mime_type=uploaded.mime_type or mime)
        part.video_metadata = metadata
        return part, uploaded

    # --- tool-calling loop ---------------------------------------------------

    def tool_loop(
        self,
        *,
        system: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        dispatch: dict[str, Any],
        model: str | None = None,
        max_rounds: int = 4,
    ) -> tuple[str, list[str]]:
        """Run a bounded tool-calling conversation.

        `dispatch` maps a tool name to a callable taking parsed kwargs. Returns the final
        assistant text plus the ordered list of tools that actually ran.
        """
        convo: list[dict[str, Any]] = [{"role": "system", "content": system}, *messages]
        called: list[str] = []

        for _ in range(max_rounds):
            try:
                response = self.client.chat.completions.create(
                    model=model or self.settings.reasoning_model,
                    messages=convo,
                    tools=tools,
                    temperature=0.4,
                )
            except Exception as exc:  # rejected key, rate limit, network
                logger.warning("tool loop call failed: %s", exc)
                raise LLMUnavailable(str(exc)) from exc
            message = response.choices[0].message
            if not message.tool_calls:
                return message.content or "", called

            convo.append(message.model_dump(exclude_none=True))
            for call in message.tool_calls:
                name = call.function.name
                handler = dispatch.get(name)
                called.append(name)
                if handler is None:
                    result: Any = {"error": f"unknown tool {name}"}
                else:
                    try:
                        kwargs = json.loads(call.function.arguments or "{}")
                        result = handler(**kwargs)
                    except Exception as exc:  # a failed tool is data, not a crash
                        logger.warning("tool %s failed: %s", name, exc)
                        result = {"error": str(exc)}
                convo.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.id,
                        "content": json.dumps(result, default=str)[:12000],
                    }
                )

        # Ran out of rounds: ask for a plain-language wrap-up of what we have.
        try:
            final = self.client.chat.completions.create(
                model=model or self.settings.fast_model,
                messages=[*convo, {"role": "user", "content": "Summarise the result for me now."}],
                temperature=0.4,
            )
        except Exception as exc:
            logger.warning("tool loop wrap-up failed: %s", exc)
            raise LLMUnavailable(str(exc)) from exc
        return final.choices[0].message.content or "", called

    # --- speech --------------------------------------------------------------

    def transcribe(self, audio_path: Path) -> str:
        if not self.settings.supports_audio_endpoints:
            raise LLMUnavailable(
                f"{self.provider} does not serve /audio/transcriptions - "
                "the dashboard uses the browser's speech engine instead"
            )
        with audio_path.open("rb") as handle:
            result = self.client.audio.transcriptions.create(
                model=self.settings.transcribe_model, file=handle
            )
        return (result.text or "").strip()

    def speak(self, text: str) -> bytes:
        if not self.settings.supports_audio_endpoints:
            raise LLMUnavailable(
                f"{self.provider} does not serve /audio/speech - "
                "the dashboard uses the browser's speech engine instead"
            )
        response = self.client.audio.speech.create(
            model=self.settings.speech_model,
            voice=self.settings.speech_voice,
            input=text[:4000],
            response_format="mp3",
        )
        return response.read()


_MARKDOWN_NOISE = (
    (re.compile(r"\*\*(.+?)\*\*", re.S), r"\1"),  # **bold**
    (re.compile(r"__(.+?)__", re.S), r"\1"),  # __bold__
    (re.compile(r"(?<!\w)\*(?!\s)(.+?)(?<!\s)\*", re.S), r"\1"),  # *italic*
    (re.compile(r"`{1,3}(.+?)`{1,3}", re.S), r"\1"),  # `code`
    (re.compile(r"^\s{0,3}#{1,6}\s+", re.M), ""),  # # heading
    (re.compile(r"^\s{0,3}[-*+]\s+", re.M), ""),  # - bullet
)


def plain_text(text: str) -> str:
    """Strip markdown emphasis from a model reply.

    The dashboard renders replies as plain text and the browser reads them aloud, so an
    asterisk is both visible and audible. Gemini in particular emphasises heavily however
    firmly the prompt asks it not to, which is why this is a function and not a sentence in
    a system prompt.
    """
    for pattern, replacement in _MARKDOWN_NOISE:
        text = pattern.sub(replacement, text)
    return text.strip()


def image_part(image_path: Path, detail: str = "high") -> dict[str, Any]:
    """Encode a local frame as an inline image part for a vision call."""
    encoded = base64.b64encode(image_path.read_bytes()).decode("ascii")
    suffix = image_path.suffix.lstrip(".").lower() or "jpeg"
    mime = "jpeg" if suffix in {"jpg", "jpeg"} else suffix
    return {
        "type": "image_url",
        "image_url": {"url": f"data:image/{mime};base64,{encoded}", "detail": detail},
    }


def text_part(text: str) -> dict[str, Any]:
    return {"type": "text", "text": text}


def _video_mime(video: Path) -> str:
    suffix = video.suffix.lower()
    if suffix in VIDEO_MIME:
        return VIDEO_MIME[suffix]
    guessed, _ = mimetypes.guess_type(video.name)
    if guessed and guessed.startswith("video/"):
        return guessed
    raise LLMUnavailable(f"unsupported clip type: {video.suffix!r}")
