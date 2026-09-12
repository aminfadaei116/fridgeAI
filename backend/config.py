"""Runtime configuration. Everything tunable lives here, nothing is hardcoded downstream."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parent.parent

Provider = Literal["openai", "gemini"]

# Google ships an OpenAI-compatible surface, so the same SDK and the same structured-output
# call work against Gemini with nothing but a base URL swap.
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"

# Per-provider model defaults. Override any of them individually in .env.local.
PROVIDER_MODELS: dict[str, dict[str, str]] = {
    "openai": {
        "vision_model": "gpt-4o",
        "reasoning_model": "gpt-4o",
        "fast_model": "gpt-4o-mini",
    },
    "gemini": {
        # The -latest aliases track Google's current flash models, so these do not go stale
        # the way a pinned version does. Pin explicitly in .env.local if you need to.
        "vision_model": "gemini-flash-latest",
        "reasoning_model": "gemini-flash-latest",
        "fast_model": "gemini-flash-lite-latest",
    },
}


class Settings(BaseSettings):
    """Application settings, sourced from the environment and `.env`."""

    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", REPO_ROOT / ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Which provider backs the agents. Gemini is reached through its OpenAI-compatible
    # endpoint, so every model call in the app is unchanged.
    llm_provider: Provider = "openai"

    openai_api_key: str = ""
    gemini_api_key: str = ""
    base_url_override: str = ""

    # Model routing. Vision and reasoning get the strong model; bulk work gets the cheap one.
    # Left blank, each falls back to the provider default in PROVIDER_MODELS.
    vision_model: str = ""
    reasoning_model: str = ""
    fast_model: str = ""

    # OpenAI-only: Gemini's compatible surface does not serve the audio endpoints, so on
    # Gemini the dashboard falls back to the browser's own speech engine.
    transcribe_model: str = "whisper-1"
    speech_model: str = "gpt-4o-mini-tts"
    speech_voice: str = "alloy"

    # Storage
    db_path: Path = REPO_ROOT / "var" / "fridge.db"
    frame_dir: Path = REPO_ROOT / "var" / "frames"
    clip_dir: Path = REPO_ROOT / "var" / "clips"

    # Door trigger. A camera inside a closed fridge sees black; brightness is the door sensor.
    camera_index: int = 0
    door_open_brightness: float = 60.0
    door_close_brightness: float = 40.0
    settle_frames: int = 8
    poll_interval_seconds: float = 0.2

    # Clip recording. The door cycle is recorded end to end and the whole clip goes to the
    # model, so the crossing itself is observed rather than inferred from two shelf states.
    clip_fps: float = 15.0  # fallback when the camera will not report its own frame rate
    clip_max_seconds: float = 60.0  # a door left hanging open must not record forever

    # Frames per second the model samples from the clip. Google's default of 1 fps misses a
    # fast hand-through-the-door crossing; 2 fps catches them.
    clip_sample_fps: float = 2.0

    # Reconciliation. Above `auto_commit_confidence` the agent writes; below it, it asks.
    auto_commit_confidence: float = 0.8
    reject_confidence: float = 0.25

    # Behaviour
    expiring_soon_days: int = 3
    offline_mode: bool = False

    @property
    def api_key(self) -> str:
        """The key for the selected provider."""
        chosen = self.gemini_api_key if self.llm_provider == "gemini" else self.openai_api_key
        return chosen.strip()

    @property
    def base_url(self) -> str | None:
        """Where the OpenAI SDK should point. None means OpenAI's own API."""
        if self.base_url_override.strip():
            return self.base_url_override.strip()
        return GEMINI_BASE_URL if self.llm_provider == "gemini" else None

    @property
    def has_api_key(self) -> bool:
        return bool(self.api_key)

    @property
    def supports_video_input(self) -> bool:
        """Whether the provider can be sent a video clip rather than a pair of stills.

        Only Gemini, and only through its native SDK - the OpenAI-compatible surface this app
        otherwise uses takes text and images only. Everywhere else the vision agent falls back
        to comparing two frames pulled out of the same clip.
        """
        return self.llm_provider == "gemini" and not self.base_url_override.strip()

    @property
    def supports_audio_endpoints(self) -> bool:
        """Whether the provider serves /audio/transcriptions and /audio/speech.

        Only OpenAI does. On Gemini the browser's Web Speech API handles both ends, which
        costs nothing and keeps the voice demo alive.
        """
        return self.llm_provider == "openai" and not self.base_url_override.strip()

    def model_post_init(self, _context: object) -> None:
        """Fill any model left blank with this provider's default."""
        defaults = PROVIDER_MODELS[self.llm_provider]
        for field, default in defaults.items():
            if not getattr(self, field).strip():
                object.__setattr__(self, field, default)


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    settings.frame_dir.mkdir(parents=True, exist_ok=True)
    settings.clip_dir.mkdir(parents=True, exist_ok=True)
    return settings
