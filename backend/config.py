"""Runtime configuration. Everything tunable lives here, nothing is hardcoded downstream."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    """Application settings, sourced from the environment and `.env`."""

    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", REPO_ROOT / ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    openai_api_key: str = ""

    # Model routing. Vision and reasoning get the strong model; bulk work gets the cheap one.
    vision_model: str = "gpt-4o"
    reasoning_model: str = "gpt-4o"
    fast_model: str = "gpt-4o-mini"
    transcribe_model: str = "whisper-1"
    speech_model: str = "gpt-4o-mini-tts"
    speech_voice: str = "alloy"

    # Storage
    db_path: Path = REPO_ROOT / "var" / "fridge.db"
    frame_dir: Path = REPO_ROOT / "var" / "frames"

    # Door trigger. A camera inside a closed fridge sees black; brightness is the door sensor.
    camera_index: int = 0
    door_open_brightness: float = 60.0
    door_close_brightness: float = 40.0
    settle_frames: int = 8
    poll_interval_seconds: float = 0.2

    # Reconciliation. Above `auto_commit_confidence` the agent writes; below it, it asks.
    auto_commit_confidence: float = 0.8
    reject_confidence: float = 0.25

    # Behaviour
    expiring_soon_days: int = 3
    offline_mode: bool = False

    @property
    def has_api_key(self) -> bool:
        return bool(self.openai_api_key.strip())


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    settings.frame_dir.mkdir(parents=True, exist_ok=True)
    return settings
