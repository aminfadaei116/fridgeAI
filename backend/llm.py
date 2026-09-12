"""Thin OpenAI wrapper. Every model call in the system goes through this module so that
retries, structured-output binding and the offline fallback are all in one place."""

from __future__ import annotations

import base64
import json
import logging
from pathlib import Path
from typing import Any, TypeVar

from openai import APIError, OpenAI
from pydantic import BaseModel

from backend.config import Settings, get_settings

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


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
