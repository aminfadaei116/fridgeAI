"""Shared base for the agent roster."""

from __future__ import annotations

from dataclasses import dataclass

from backend.config import Settings, get_settings
from backend.db import Store
from backend.llm import LLM


@dataclass
class AgentContext:
    """Everything an agent is allowed to touch. Passed in, never constructed inside."""

    store: Store
    llm: LLM
    settings: Settings

    @classmethod
    def build(cls, store: Store | None = None, llm: LLM | None = None) -> AgentContext:
        settings = get_settings()
        return cls(
            store=store or Store(settings.db_path),
            llm=llm or LLM(settings),
            settings=settings,
        )


class Agent:
    """An agent is a named specialist with one job and one output contract."""

    name: str = "agent"
    role: str = ""

    def __init__(self, ctx: AgentContext) -> None:
        self.ctx = ctx

    @property
    def store(self) -> Store:
        return self.ctx.store

    @property
    def llm(self) -> LLM:
        return self.ctx.llm

    @property
    def settings(self) -> Settings:
        return self.ctx.settings
