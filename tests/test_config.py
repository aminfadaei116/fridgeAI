"""Provider selection.

The whole point of the provider seam is that switching backends changes a base URL and a set
of model names, and nothing else in the system. These pin that.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from backend.config import GEMINI_BASE_URL, Settings
from backend.llm import LLM, LLMUnavailable


def test__openai_provider__talks_to_openai_directly():
    # Act
    settings = Settings(openai_api_key="sk-test")

    # Assert: no base URL means the SDK uses OpenAI's own API.
    assert settings.base_url is None
    assert settings.api_key == "sk-test"
    assert settings.vision_model == "gpt-4o"


def test__gemini_provider__points_at_the_openai_compatible_endpoint():
    # Act
    settings = Settings(llm_provider="gemini", gemini_api_key="AIza-test")

    # Assert
    assert settings.base_url == GEMINI_BASE_URL
    assert settings.api_key == "AIza-test"
    assert settings.vision_model.startswith("gemini")


def test__gemini_provider__ignores_an_openai_key():
    # Arrange: both keys present, Gemini selected.
    settings = Settings(llm_provider="gemini", openai_api_key="sk-test", gemini_api_key="AIza")

    # Act / Assert: the selected provider's key wins, so a stale key cannot leak into calls.
    assert settings.api_key == "AIza"


def test__missing_key_for_the_selected_provider__reads_as_unavailable():
    # Arrange: an OpenAI key is set but Gemini is selected.
    settings = Settings(llm_provider="gemini", openai_api_key="sk-test")

    # Act / Assert
    assert settings.has_api_key is False
    assert LLM(settings).available is False


def test__base_url_override__wins_over_the_provider_default():
    # Arrange: a LiteLLM proxy or Azure deployment in front of OpenAI.
    settings = Settings(openai_api_key="sk", base_url_override="https://proxy.internal/v1")

    # Act / Assert
    assert settings.base_url == "https://proxy.internal/v1"


@pytest.mark.parametrize(
    ("provider", "expected"),
    [("openai", True), ("gemini", False)],
)
def test__audio_endpoint_support__is_declared_per_provider(provider, expected):
    # Arrange
    settings = Settings(llm_provider=provider, openai_api_key="sk", gemini_api_key="AIza")

    # Act / Assert: the dashboard reads this to decide whether to use the browser's voice.
    assert settings.supports_audio_endpoints is expected


def test__base_url_override__also_disables_the_audio_endpoints():
    # Arrange: a proxy in front of OpenAI may not forward /audio/*, so do not assume it does.
    settings = Settings(openai_api_key="sk", base_url_override="https://proxy.internal/v1")

    # Act / Assert
    assert settings.supports_audio_endpoints is False


def test__transcribe__fails_loudly_on_a_provider_without_audio(tmp_path):
    # Arrange
    settings = Settings(llm_provider="gemini", gemini_api_key="AIza")
    audio = tmp_path / "speech.webm"
    audio.write_bytes(b"not really audio")

    # Act / Assert: a clear reason, not an opaque 404 from the compatibility layer.
    with pytest.raises(LLMUnavailable, match="audio/transcriptions"):
        LLM(settings).transcribe(audio)


def test__speak__fails_loudly_on_a_provider_without_audio():
    # Arrange
    settings = Settings(llm_provider="gemini", gemini_api_key="AIza")

    # Act / Assert
    with pytest.raises(LLMUnavailable, match="audio/speech"):
        LLM(settings).speak("hello")


def test__explicit_model_override__survives_the_provider_default():
    # Arrange
    settings = Settings(llm_provider="gemini", gemini_api_key="AIza", vision_model="gemini-3-pro")

    # Act / Assert: a model named in the environment is never overwritten by a default.
    assert settings.vision_model == "gemini-3-pro"


def test__the_suite_is_isolated_from_local_configuration():
    """Guard for the isolation fixture itself.

    If this fails, every other config test is silently reading the developer's `.env.local`
    and the suite proves nothing portable.
    """
    # Act: a bare Settings, with no arguments at all.
    settings = Settings()

    # Assert: the defaults, not whatever is configured on this machine.
    assert settings.llm_provider == "openai"
    assert settings.api_key == ""
    assert settings.has_api_key is False


def test__the_cli_runs_from_any_directory(tmp_path):
    """The README tells people to run `fridge seed` after cloning.

    Running pytest from the repo root puts the root on sys.path, which hides a packaging
    gap: the console script does not, so a package left out of pyproject imports fine here
    and fails for everyone who installs the project. Shelling out from an unrelated
    directory is the only way to catch that.
    """
    # Arrange
    repo_root = Path(__file__).resolve().parent.parent
    fridge = repo_root / ".venv" / "bin" / "fridge"
    if not fridge.exists():
        pytest.skip("no installed console script to exercise")

    # Act: run from a directory that is not the repo.
    result = subprocess.run(
        [str(fridge), "--help"], cwd=tmp_path, capture_output=True, text=True, timeout=60
    )

    # Assert
    assert result.returncode == 0, result.stderr
    assert "seed" in result.stdout


def test__the_demo_seeder_is_importable_from_the_installed_package(tmp_path):
    # Arrange
    repo_root = Path(__file__).resolve().parent.parent
    python = repo_root / ".venv" / "bin" / "python"
    if not python.exists():
        pytest.skip("no virtualenv to exercise")

    # Act: import the seeder with the repo root deliberately NOT on sys.path.
    result = subprocess.run(
        [str(python), "-c", "import data.demo_seed; print('ok')"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=60,
    )

    # Assert
    assert result.returncode == 0, result.stderr
    assert "ok" in result.stdout
