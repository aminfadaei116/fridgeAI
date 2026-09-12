"""Shared fixtures. Every test runs against a throwaway database with the model switched off,
so the suite is deterministic and costs nothing."""

from __future__ import annotations

import pytest

from backend.agents.base import AgentContext
from backend.agents.curator import CuratorAgent
from backend.agents.shelf_life import ShelfLifeAgent
from backend.config import Settings
from backend.db import Store
from backend.llm import LLM
from backend.schemas import DetectedItem


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        openai_api_key="",
        offline_mode=True,
        db_path=tmp_path / "test.db",
        frame_dir=tmp_path / "frames",
        auto_commit_confidence=0.8,
        reject_confidence=0.25,
    )


@pytest.fixture
def store(settings: Settings) -> Store:
    return Store(settings.db_path)


@pytest.fixture
def ctx(store: Store, settings: Settings) -> AgentContext:
    return AgentContext(store=store, llm=LLM(settings), settings=settings)


@pytest.fixture
def shelf_life(ctx: AgentContext) -> ShelfLifeAgent:
    agent = ShelfLifeAgent(ctx)
    agent.seed()
    return agent


@pytest.fixture
def curator(ctx: AgentContext, shelf_life: ShelfLifeAgent) -> CuratorAgent:
    return CuratorAgent(ctx, shelf_life=shelf_life)


def detected(name: str, confidence: float = 1.0, **kwargs) -> DetectedItem:
    """Build a detection the way the vision agent would emit one."""
    return DetectedItem(name=name, confidence=confidence, **kwargs)
