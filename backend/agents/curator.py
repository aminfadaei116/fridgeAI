"""The curator agent: the gate between what the camera thinks it saw and what the fridge
believes is true.

This is deliberately deterministic. A confidence threshold decides commit-versus-ask, and the
consumed-versus-wasted call is a date comparison, not an opinion. The interesting behaviour -
asking the human when it is unsure - is a rule, so it is testable and it never surprises you
on stage.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime

from backend.agents.base import Agent
from backend.agents.shelf_life import ShelfLifeAgent
from backend.schemas import DetectedItem, InventoryItem, ItemStatus, VisionDiff

logger = logging.getLogger(__name__)


@dataclass
class CurationResult:
    """What the curator did with one vision diff."""

    added: list[InventoryItem] = field(default_factory=list)
    removed: list[InventoryItem] = field(default_factory=list)
    questions: list[str] = field(default_factory=list)
    ignored: list[str] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.added or self.removed or self.questions)


class CuratorAgent(Agent):
    name = "curator"
    role = "Decides which detections are trustworthy enough to write to the inventory."

    def __init__(self, ctx, shelf_life: ShelfLifeAgent | None = None) -> None:
        super().__init__(ctx)
        self.shelf_life = shelf_life or ShelfLifeAgent(ctx)

    def reconcile(self, diff: VisionDiff, frame_ref: str | None = None) -> CurationResult:
        result = CurationResult()

        for detected in diff.added:
            if detected.confidence < self.settings.reject_confidence:
                result.ignored.append(f"{detected.name} ({detected.confidence:.2f})")
                self.store.log_event(
                    "rejected",
                    item_name=detected.name,
                    confidence=detected.confidence,
                    payload={"action": "add", "reason": "below reject threshold"},
                )
                continue
            if detected.confidence < self.settings.auto_commit_confidence:
                question = (
                    f"I think a {detected.name} went in, but I am only "
                    f"{detected.confidence:.0%} sure. Is that right?"
                )
                self.store.add_pending("add", detected, question)
                result.questions.append(question)
                continue
            result.added.append(self.commit_add(detected, frame_ref=frame_ref))

        for detected in diff.removed:
            match = self._match_present(detected.name)
            if match is None:
                result.ignored.append(f"{detected.name} (not in inventory)")
                self.store.log_event(
                    "rejected",
                    item_name=detected.name,
                    confidence=detected.confidence,
                    payload={"action": "remove", "reason": "no matching item on hand"},
                )
                continue
            if detected.confidence < self.settings.auto_commit_confidence:
                question = (
                    f"Did the {match.name} come out? I am only "
                    f"{detected.confidence:.0%} sure it left."
                )
                self.store.add_pending("remove", detected, question)
                result.questions.append(question)
                continue
            result.removed.append(self.commit_remove(match))

        return result

    # --- commits (also used by the confirm endpoint) --------------------------

    def commit_add(self, detected: DetectedItem, frame_ref: str | None = None) -> InventoryItem:
        verdict = self.shelf_life.resolve(detected.name)
        item_id = self.store.add_item(
            detected,
            shelf_life_days=verdict.shelf_life_days,
            est_cost=verdict.est_cost,
            storage_tip=verdict.storage_tip,
            frame_ref=frame_ref,
        )
        self.store.log_event(
            "added",
            item_id=item_id,
            item_name=detected.name,
            confidence=detected.confidence,
            payload={"shelf_life_days": verdict.shelf_life_days},
        )
        item = self.store.find_present(detected.name)
        return item or _fallback_item(item_id, detected)

    def commit_remove(self, item: InventoryItem) -> InventoryItem:
        """An item leaving is money either saved or lost. The expiry date decides which."""
        expired = item.expires_at is not None and item.expires_at < datetime.now()
        status = ItemStatus.DISCARDED if expired else ItemStatus.CONSUMED
        kind = "wasted" if expired else "saved"
        reason = "left the fridge after its date" if expired else "used before its date"

        self.store.mark_removed(item.id, status)
        self.store.record_ledger(item.name, kind, item.est_cost, reason, item_id=item.id)
        self.store.log_event(
            "removed",
            item_id=item.id,
            item_name=item.name,
            payload={"status": status.value, "ledger": kind, "est_cost": item.est_cost},
        )
        return item

    def resolve_pending(self, pending_id: int, confirmed: bool) -> InventoryItem | None:
        """Apply a human answer to a question the curator asked."""
        pending = self.store.get_pending(pending_id)
        if pending is None:
            return None

        self.store.close_pending(pending_id, "confirmed" if confirmed else "rejected")
        if not confirmed:
            self.store.log_event(
                "correction",
                item_name=pending.item.name,
                payload={"action": pending.action, "confirmed": False},
            )
            return None

        # A human confirmation is ground truth, so the stored confidence becomes 1.
        confirmed_item = pending.item.model_copy(update={"confidence": 1.0})
        if pending.action == "add":
            return self.commit_add(confirmed_item)

        match = self._match_present(pending.item.name)
        return self.commit_remove(match) if match else None

    # --- matching ------------------------------------------------------------

    def _match_present(self, name: str) -> InventoryItem | None:
        """Exact name first, then the closest token overlap among what is on hand.

        The vision agent says "red bell pepper" one day and "bell pepper" the next; without
        this the fridge would quietly accumulate duplicates.
        """
        exact = self.store.find_present(name)
        if exact:
            return exact

        target = set(name.lower().split())
        best: tuple[float, InventoryItem] | None = None
        for candidate in self.store.list_inventory():
            tokens = set(candidate.name.lower().split())
            if not tokens or not target:
                continue
            overlap = len(tokens & target) / len(tokens | target)
            if overlap >= 0.5 and (best is None or overlap > best[0]):
                best = (overlap, candidate)
        return best[1] if best else None


def _fallback_item(item_id: int, detected: DetectedItem) -> InventoryItem:
    """Only reached if a row vanishes between insert and read-back."""
    return InventoryItem(
        id=item_id,
        name=detected.name,
        category=detected.category,
        quantity=detected.quantity,
        unit=detected.unit,
        added_at=datetime.now(),
        expires_at=None,
        shelf_life_days=None,
        status=ItemStatus.PRESENT,
        confidence=detected.confidence,
        est_cost=0.0,
    )
