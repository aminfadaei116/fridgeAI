"""Agent behaviour with the model switched off.

Every agent has to degrade to something honest rather than crash or invent - that is what
keeps the demo alive when the venue wifi does not cooperate.
"""

from __future__ import annotations

from backend.agents.chef import ChefAgent
from backend.agents.concierge import ConciergeAgent
from backend.agents.sentinel import SentinelAgent
from backend.agents.vision import VisionAgent
from backend.schemas import MealRequest
from tests.conftest import detected


def test__vision__returns_an_empty_diff_when_no_model_is_reachable(ctx, tmp_path):
    # Arrange
    agent = VisionAgent(ctx)
    frame = tmp_path / "frame.jpg"
    frame.write_bytes(b"not really a jpeg")

    # Act
    diff = agent.diff(frame, frame)

    # Assert: no invented items, and the reason is stated.
    assert diff.added == []
    assert diff.removed == []
    assert "offline" in diff.scene_note


def test__chef__names_the_urgent_items_even_offline(ctx, store, shelf_life):
    # Arrange
    store.add_item(detected("spinach"), shelf_life_days=1, est_cost=4.49)
    agent = ChefAgent(ctx)

    # Act
    board = agent.propose(MealRequest(meals=["dinner"]))

    # Assert
    assert board.recipes
    assert "spinach" in board.recipes[0].uses_expiring


def test__chef__returns_nothing_for_an_empty_fridge(ctx):
    # Act
    board = ChefAgent(ctx).propose(MealRequest(meals=["dinner"]))

    # Assert: an empty fridge yields no suggestions rather than an invented one.
    assert board.recipes == []


def test__sentinel__says_so_plainly_when_nothing_is_urgent(ctx, store):
    # Arrange
    store.add_item(detected("carrot"), shelf_life_days=28)

    # Act
    digest = SentinelAgent(ctx).digest()

    # Assert
    assert digest.alerts == []
    assert "Nothing" in digest.headline


def test__sentinel__ranks_the_soonest_item_first(ctx, store):
    # Arrange
    store.add_item(detected("milk"), shelf_life_days=3)
    store.add_item(detected("spinach"), shelf_life_days=1)

    # Act
    digest = SentinelAgent(ctx).digest()

    # Assert
    assert digest.alerts[0].item_name == "spinach"
    assert digest.alerts[0].urgency == "today"


def test__concierge__routes_a_cooking_request_to_the_chef_offline(ctx, store, shelf_life):
    # Arrange
    store.add_item(detected("spinach"), shelf_life_days=1, est_cost=4.49)

    # Act
    reply = ConciergeAgent(ctx).chat("what can I cook for dinner?")

    # Assert
    assert reply.agents_called == ["chef"]
    assert reply.recipes


def test__concierge__persists_both_sides_of_the_turn(ctx, store):
    # Act
    ConciergeAgent(ctx).chat("what is in the fridge?")

    # Assert: context survives a page reload.
    roles = [m["role"] for m in store.recent_messages()]
    assert roles == ["user", "assistant"]
