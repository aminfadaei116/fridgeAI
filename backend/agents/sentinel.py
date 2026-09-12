"""The sentinel agent: the daily briefing on what is about to spoil.

It writes from evidence the database already holds - dates, and how many times something has
been picked up and put back. That second signal is what makes the briefing feel like it has
been paying attention.
"""

from __future__ import annotations

import logging

from backend.agents.base import Agent
from backend.llm import LLMUnavailable, plain_text
from backend.schemas import DailyDigest, DigestAlert, InventoryItem

logger = logging.getLogger(__name__)

SYSTEM = """You write one short daily briefing about a fridge.

You are given every item on hand with the days left before it spoils, how many times each has \
been taken out and put back, and the week's waste ledger.

Write like someone who has been watching the fridge and has receipts. Cite the evidence: the \
item, the days, the number of times it has been handled. Dry and specific beats cheerful.

Write plain sentences. No markdown, no asterisks, no stage directions - this is read aloud.

- `headline`: one sentence. The single most useful thing to know this morning.
- `alerts`: one per item with 3 or fewer days left, most urgent first. Urgency is "today" for
  0-1 days, "soon" for 2-3, "watch" beyond that.
- `suggestion`: one sentence on what to cook or do about it.

Talk about food, dates and money. Never about the person's habits, discipline, or what they \
should or should not be eating. If nothing is urgent, say so in one line and stop."""


class SentinelAgent(Agent):
    name = "sentinel"
    role = "Writes the daily briefing on what is about to spoil."

    def digest(self) -> DailyDigest:
        expiring = self.store.expiring_within(self.settings.expiring_soon_days)
        if not self.llm.available:
            return self._fallback(expiring)

        try:
            digest = self.llm.structured(
                schema=DailyDigest,
                system=SYSTEM,
                user=self._prompt(expiring),
                model=self.settings.fast_model,
                temperature=0.6,
            )
            digest.headline = plain_text(digest.headline)
            digest.suggestion = plain_text(digest.suggestion)
            for alert in digest.alerts:
                alert.line = plain_text(alert.line)
            return digest
        except LLMUnavailable as exc:
            logger.warning("digest failed: %s", exc)
            return self._fallback(expiring)

    def _prompt(self, expiring: list[InventoryItem]) -> str:
        inventory = self.store.list_inventory()
        totals = self.store.ledger_totals()

        lines = [f"ITEMS ON HAND: {len(inventory)}", "", "SPOILING SOON:"]
        if not expiring:
            lines.append("- nothing within the window")
        for item in expiring:
            handled = (
                f", picked up and put back {item.removal_count}x" if item.removal_count else ""
            )
            lines.append(f"- {item.name}: {item.days_left} days left{handled}")

        lines += [
            "",
            "REST OF THE FRIDGE:",
            *(
                f"- {i.name}: {i.days_left} days left"
                for i in inventory
                if i not in expiring and i.days_left is not None
            ),
            "",
            f"THIS WEEK: ${totals.saved_cad:.2f} used in time, "
            f"${totals.wasted_cad:.2f} thrown out.",
        ]
        return "\n".join(lines)

    def _fallback(self, expiring: list[InventoryItem]) -> DailyDigest:
        if not expiring:
            return DailyDigest(headline="Nothing is close to its date today.", alerts=[])
        alerts = [
            DigestAlert(
                item_name=item.name,
                days_left=item.days_left or 0,
                urgency=_urgency(item.days_left or 0),
                line=f"{item.name}: {item.days_left} days left.",
            )
            for item in expiring
        ]
        first = expiring[0]
        return DailyDigest(
            headline=f"{len(expiring)} items are close to their date. {first.name} is first.",
            alerts=alerts,
            suggestion=f"Build something around the {first.name} today.",
        )


def _urgency(days: int) -> str:
    if days <= 1:
        return "today"
    return "soon" if days <= 3 else "watch"
