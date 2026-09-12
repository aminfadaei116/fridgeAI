"""Model-plumbing tests against a stub client.

These do not test OpenAI - they test our side of the wire: that structured output lands in the
right pydantic model, that a tool-calling turn actually dispatches and feeds results back, and
that a failing tool is handled as data rather than taking the turn down.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from openai.lib._pydantic import to_strict_json_schema

from backend.agents.base import AgentContext
from backend.agents.chef import ChefAgent
from backend.agents.concierge import ConciergeAgent
from backend.llm import LLM, LLMUnavailable
from backend.schemas import (
    DailyDigest,
    NutritionReport,
    RecipeBoard,
    ShelfLifeVerdict,
    VisionDiff,
)
from tests.conftest import detected


class StubCompletions:
    """Stands in for `client.chat.completions`."""

    def __init__(self, parsed=None, script=None):
        self._parsed = parsed
        self._script = list(script or [])
        self.parse_calls: list[dict] = []
        self.create_calls: list[dict] = []

    def parse(self, **kwargs):
        self.parse_calls.append(kwargs)
        message = SimpleNamespace(parsed=self._parsed)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    def create(self, **kwargs):
        self.create_calls.append(kwargs)
        message = self._script.pop(0)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def stub_client(parsed=None, script=None) -> tuple[object, StubCompletions]:
    completions = StubCompletions(parsed=parsed, script=script)
    client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    return client, completions


def tool_message(name: str, arguments: dict):
    """A message the way the SDK hands one back when the model calls a tool."""
    call = SimpleNamespace(
        id=f"call_{name}",
        function=SimpleNamespace(name=name, arguments=json.dumps(arguments)),
    )
    return SimpleNamespace(
        content=None,
        tool_calls=[call],
        model_dump=lambda exclude_none=False: {"role": "assistant", "tool_calls": [name]},
    )


def text_message(content: str):
    return SimpleNamespace(content=content, tool_calls=None)


@pytest.fixture
def online_llm(settings):
    """An LLM that believes it has a key, so the offline short-circuits do not fire."""
    settings.openai_api_key = "test-key"
    settings.offline_mode = False
    return LLM(settings)


def test__structured__binds_the_reply_to_the_requested_schema(online_llm):
    # Arrange
    expected = ShelfLifeVerdict(
        name="kimchi", shelf_life_days=90, est_cost=8.99, storage_tip="Seal it."
    )
    client, completions = stub_client(parsed=expected)
    online_llm._client = client

    # Act
    verdict = online_llm.structured(schema=ShelfLifeVerdict, system="sys", user="kimchi")

    # Assert
    assert verdict.shelf_life_days == 90
    assert completions.parse_calls[0]["response_format"] is ShelfLifeVerdict


def test__structured__raises_rather_than_returning_none(online_llm):
    # Arrange: the model replied with nothing parsable.
    client, _ = stub_client(parsed=None)
    online_llm._client = client

    # Act / Assert: callers need the signal so they can fall back deliberately.
    with pytest.raises(LLMUnavailable):
        online_llm.structured(schema=ShelfLifeVerdict, system="sys", user="kimchi")


def test__tool_loop__dispatches_the_call_and_feeds_the_result_back(online_llm):
    # Arrange: one tool call, then a plain answer.
    client, completions = stub_client(
        script=[tool_message("read_inventory", {}), text_message("Two peppers and some milk.")]
    )
    online_llm._client = client
    seen = {}

    def read_inventory():
        seen["ran"] = True
        return {"count": 3}

    # Act
    text, called = online_llm.tool_loop(
        system="sys",
        messages=[{"role": "user", "content": "what's in there?"}],
        tools=[],
        dispatch={"read_inventory": read_inventory},
    )

    # Assert
    assert seen["ran"] is True
    assert called == ["read_inventory"]
    assert text == "Two peppers and some milk."

    # The second round must carry the tool result back to the model.
    second_round = completions.create_calls[1]["messages"]
    tool_reply = [m for m in second_round if m.get("role") == "tool"]
    assert json.loads(tool_reply[0]["content"]) == {"count": 3}


def test__tool_loop__treats_a_failing_tool_as_data(online_llm):
    # Arrange
    client, completions = stub_client(
        script=[tool_message("read_inventory", {}), text_message("I could not read the shelf.")]
    )
    online_llm._client = client

    def explode():
        raise RuntimeError("database on fire")

    # Act
    text, called = online_llm.tool_loop(
        system="sys", messages=[], tools=[], dispatch={"read_inventory": explode}
    )

    # Assert: the turn completes, and the model is told what went wrong.
    assert called == ["read_inventory"]
    assert text == "I could not read the shelf."
    tool_reply = [m for m in completions.create_calls[1]["messages"] if m.get("role") == "tool"]
    assert "database on fire" in tool_reply[0]["content"]


def test__tool_loop__names_an_unknown_tool_instead_of_crashing(online_llm):
    # Arrange
    client, completions = stub_client(
        script=[tool_message("teleport", {}), text_message("I do not have that.")]
    )
    online_llm._client = client

    # Act
    _, called = online_llm.tool_loop(system="sys", messages=[], tools=[], dispatch={})

    # Assert
    assert called == ["teleport"]
    tool_reply = [m for m in completions.create_calls[1]["messages"] if m.get("role") == "tool"]
    assert "unknown tool" in tool_reply[0]["content"]


def test__concierge__saves_a_standing_diet_through_the_profile_tool(store, settings):
    # Arrange: the model chooses save_profile, then confirms in words.
    settings.openai_api_key = "test-key"
    settings.offline_mode = False
    llm = LLM(settings)
    client, _ = stub_client(
        script=[
            tool_message("save_profile", {"diet_plan": "vegetarian", "household_size": 4}),
            text_message("Noted - vegetarian, four of you."),
        ]
    )
    llm._client = client
    concierge = ConciergeAgent(AgentContext(store=store, llm=llm, settings=settings))

    # Act
    reply = concierge.chat("We're vegetarian, and there are four of us.")

    # Assert: the fact is durable, not just acknowledged in prose.
    assert reply.profile_updated is True
    assert store.get_profile() == {"diet_plan": "vegetarian", "household_size": 4}


def test__concierge__returns_recipe_cards_alongside_the_prose(store, settings, shelf_life):
    # Arrange
    settings.openai_api_key = "test-key"
    settings.offline_mode = False
    store.add_item(detected("spinach"), shelf_life_days=1, est_cost=4.49)

    llm = LLM(settings)
    client, _ = stub_client(
        script=[
            tool_message("plan_meals", {"meals": ["dinner"], "servings": 2}),
            text_message("Spinach first - it goes tomorrow."),
        ]
    )
    llm._client = client
    concierge = ConciergeAgent(AgentContext(store=store, llm=llm, settings=settings))
    # The chef gets no stub script, so it takes its own offline path - which is the point:
    # the concierge must still surface whatever the chef returned as structured cards.
    offline = settings.model_copy(update={"openai_api_key": ""})
    concierge.chef = ChefAgent(AgentContext(store=store, llm=LLM(offline), settings=offline))

    # Act
    reply = concierge.chat("what's for dinner?")

    # Assert
    assert reply.recipes
    assert "spinach" in reply.recipes[0].uses_expiring


def walk_objects(node, path="$"):
    """Yield every object-typed node in a JSON schema, with the path that reached it."""
    if isinstance(node, dict):
        if node.get("type") == "object":
            yield path, node
        for key, value in node.items():
            if key in {"properties", "$defs", "definitions"} and isinstance(value, dict):
                for name, child in value.items():
                    yield from walk_objects(child, f"{path}.{name}")
            elif key in {"items", "anyOf", "allOf", "oneOf"}:
                children = value if isinstance(value, list) else [value]
                for index, child in enumerate(children):
                    yield from walk_objects(child, f"{path}[{index}]")


@pytest.mark.parametrize(
    "schema",
    [VisionDiff, ShelfLifeVerdict, RecipeBoard, NutritionReport, DailyDigest],
    ids=lambda s: s.__name__,
)
def test__response_schemas__are_legal_under_strict_structured_outputs(schema):
    """Every schema we bind a model call to must be strict-legal all the way down.

    The SDK's converter will happily emit a NESTED `additionalProperties: true` (a bare `dict`
    field does exactly that) which the API then rejects at request time. Checking only the top
    level misses it, so walk the whole tree - otherwise an innocuous new field breaks the agent
    against the real API while every offline test still passes.
    """
    # Act
    strict = to_strict_json_schema(schema)

    # Assert: every object in the tree is closed and fully required.
    for path, node in walk_objects(strict):
        assert node.get("additionalProperties") is False, f"{path} is an open object"
        assert set(node.get("required", [])) == set(node.get("properties", {})), (
            f"{path} has optional properties, which strict mode forbids"
        )


def test__tool_loop__reports_an_api_failure_as_unavailable(online_llm):
    """A rejected key must degrade, not crash the request.

    `structured` already wraps provider errors; without the same treatment here, a typo'd or
    expired key turns every chat turn into a 500 instead of falling back to the offline path.
    """

    # Arrange
    class ExplodingCompletions:
        def create(self, **kwargs):
            raise RuntimeError("Error code: 400 - Please pass a valid API key")

    online_llm._client = SimpleNamespace(chat=SimpleNamespace(completions=ExplodingCompletions()))

    # Act / Assert
    with pytest.raises(LLMUnavailable):
        online_llm.tool_loop(system="sys", messages=[], tools=[], dispatch={})


def test__concierge__falls_back_to_the_offline_path_on_a_bad_key(store, settings, shelf_life):
    # Arrange: a key that the provider rejects.
    settings.openai_api_key = "sk-wrong"
    settings.offline_mode = False
    store.add_item(detected("spinach"), shelf_life_days=1, est_cost=4.49)

    class ExplodingCompletions:
        def create(self, **kwargs):
            raise RuntimeError("Error code: 401 - invalid api key")

    llm = LLM(settings)
    llm._client = SimpleNamespace(chat=SimpleNamespace(completions=ExplodingCompletions()))
    concierge = ConciergeAgent(AgentContext(store=store, llm=llm, settings=settings))

    # Act
    reply = concierge.chat("what should I cook?")

    # Assert: an answer, not an exception.
    assert reply.reply
    assert store.recent_messages()[-1]["role"] == "assistant"
