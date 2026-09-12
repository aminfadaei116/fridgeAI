"""SQLite persistence. One connection per operation, WAL on, so the camera thread and the
web workers never fight over a handle."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path

from backend.schemas import (
    Category,
    DetectedItem,
    InventoryItem,
    ItemStatus,
    LedgerTotals,
    PendingConfirmation,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    category        TEXT    NOT NULL DEFAULT 'other',
    quantity        REAL    NOT NULL DEFAULT 1,
    unit            TEXT    NOT NULL DEFAULT 'unit',
    added_at        TEXT    NOT NULL,
    shelf_life_days INTEGER,
    expires_at      TEXT,
    status          TEXT    NOT NULL DEFAULT 'present',
    confidence      REAL    NOT NULL DEFAULT 1.0,
    est_cost        REAL    NOT NULL DEFAULT 0,
    storage_tip     TEXT    NOT NULL DEFAULT '',
    removal_count   INTEGER NOT NULL DEFAULT 0,
    removed_at      TEXT,
    frame_ref       TEXT
);

CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_expires ON items(expires_at);

CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           TEXT NOT NULL,
    kind         TEXT NOT NULL,
    item_id      INTEGER,
    item_name    TEXT,
    confidence   REAL,
    frame_before TEXT,
    frame_after  TEXT,
    payload      TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);

CREATE TABLE IF NOT EXISTS pending (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    action     TEXT NOT NULL,
    payload    TEXT NOT NULL,
    question   TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS waste_ledger (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        TEXT NOT NULL,
    item_id   INTEGER,
    item_name TEXT NOT NULL,
    kind      TEXT NOT NULL,
    est_cost  REAL NOT NULL DEFAULT 0,
    reason    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS profile (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT NOT NULL,
    role    TEXT NOT NULL,
    content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shelf_life_cache (
    name            TEXT PRIMARY KEY,
    shelf_life_days INTEGER NOT NULL,
    est_cost        REAL NOT NULL DEFAULT 0,
    storage_tip     TEXT NOT NULL DEFAULT '',
    source          TEXT NOT NULL DEFAULT 'seed'
);
"""


class Store:
    """All database access goes through here. No SQL anywhere else in the codebase."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    # --- connection ----------------------------------------------------------

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_schema(self) -> None:
        with self.connect() as conn:
            conn.executescript(SCHEMA)

    # --- inventory -----------------------------------------------------------

    def add_item(
        self,
        item: DetectedItem,
        *,
        shelf_life_days: int | None,
        est_cost: float = 0.0,
        storage_tip: str = "",
        added_at: datetime | None = None,
        frame_ref: str | None = None,
    ) -> int:
        added_at = added_at or datetime.now()
        expires_at = (
            (added_at + timedelta(days=shelf_life_days)).isoformat()
            if shelf_life_days is not None
            else None
        )
        with self.connect() as conn:
            cur = conn.execute(
                """
                INSERT INTO items (name, category, quantity, unit, added_at, shelf_life_days,
                                   expires_at, status, confidence, est_cost, storage_tip, frame_ref)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'present', ?, ?, ?, ?)
                """,
                (
                    item.name.lower().strip(),
                    item.category.value,
                    item.quantity,
                    item.unit,
                    added_at.isoformat(),
                    shelf_life_days,
                    expires_at,
                    item.confidence,
                    est_cost,
                    storage_tip,
                    frame_ref,
                ),
            )
            return int(cur.lastrowid)

    def find_present(self, name: str) -> InventoryItem | None:
        """Oldest present item matching a name — first in, first out."""
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT * FROM items
                WHERE status = 'present' AND name = ?
                ORDER BY datetime(added_at) ASC LIMIT 1
                """,
                (name.lower().strip(),),
            ).fetchone()
        return _row_to_item(row) if row else None

    def list_inventory(self, status: ItemStatus = ItemStatus.PRESENT) -> list[InventoryItem]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM items WHERE status = ?
                ORDER BY (expires_at IS NULL), datetime(expires_at) ASC, name ASC
                """,
                (status.value,),
            ).fetchall()
        return [_row_to_item(r) for r in rows]

    def expiring_within(self, days: int) -> list[InventoryItem]:
        cutoff = (datetime.now() + timedelta(days=days)).isoformat()
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM items
                WHERE status = 'present' AND expires_at IS NOT NULL AND expires_at <= ?
                ORDER BY datetime(expires_at) ASC
                """,
                (cutoff,),
            ).fetchall()
        return [_row_to_item(r) for r in rows]

    def mark_removed(self, item_id: int, status: ItemStatus, reason: str = "") -> None:
        with self.connect() as conn:
            conn.execute(
                "UPDATE items SET status = ?, removed_at = ? WHERE id = ?",
                (status.value, datetime.now().isoformat(), item_id),
            )
            if reason:
                conn.execute(
                    "INSERT INTO events (ts, kind, item_id, payload) VALUES (?, 'note', ?, ?)",
                    (datetime.now().isoformat(), item_id, json.dumps({"reason": reason})),
                )

    def bump_removal_count(self, item_id: int) -> int:
        """Tracks the 'taken out and put back' behaviour the sentinel calls out."""
        with self.connect() as conn:
            conn.execute(
                "UPDATE items SET removal_count = removal_count + 1 WHERE id = ?", (item_id,)
            )
            row = conn.execute(
                "SELECT removal_count FROM items WHERE id = ?", (item_id,)
            ).fetchone()
        return int(row["removal_count"]) if row else 0

    # --- events --------------------------------------------------------------

    def log_event(
        self,
        kind: str,
        *,
        item_id: int | None = None,
        item_name: str | None = None,
        confidence: float | None = None,
        frame_before: str | None = None,
        frame_after: str | None = None,
        payload: dict | None = None,
    ) -> int:
        with self.connect() as conn:
            cur = conn.execute(
                """
                INSERT INTO events (ts, kind, item_id, item_name, confidence,
                                    frame_before, frame_after, payload)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    datetime.now().isoformat(),
                    kind,
                    item_id,
                    item_name,
                    confidence,
                    frame_before,
                    frame_after,
                    json.dumps(payload or {}),
                ),
            )
            return int(cur.lastrowid)

    def recent_events(self, limit: int = 30) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [{**dict(r), "payload": json.loads(r["payload"])} for r in rows]

    # --- pending confirmations ----------------------------------------------

    def add_pending(self, action: str, item: DetectedItem, question: str) -> int:
        with self.connect() as conn:
            cur = conn.execute(
                "INSERT INTO pending (created_at, action, payload, question) VALUES (?, ?, ?, ?)",
                (datetime.now().isoformat(), action, item.model_dump_json(), question),
            )
            return int(cur.lastrowid)

    def list_pending(self) -> list[PendingConfirmation]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM pending WHERE status = 'open' ORDER BY id ASC"
            ).fetchall()
        return [
            PendingConfirmation(
                id=r["id"],
                created_at=datetime.fromisoformat(r["created_at"]),
                action=r["action"],
                item=DetectedItem.model_validate_json(r["payload"]),
                question=r["question"],
            )
            for r in rows
        ]

    def get_pending(self, pending_id: int) -> PendingConfirmation | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM pending WHERE id = ? AND status = 'open'", (pending_id,)
            ).fetchone()
        if not row:
            return None
        return PendingConfirmation(
            id=row["id"],
            created_at=datetime.fromisoformat(row["created_at"]),
            action=row["action"],
            item=DetectedItem.model_validate_json(row["payload"]),
            question=row["question"],
        )

    def close_pending(self, pending_id: int, status: str) -> None:
        with self.connect() as conn:
            conn.execute("UPDATE pending SET status = ? WHERE id = ?", (status, pending_id))

    # --- waste ledger --------------------------------------------------------

    def record_ledger(
        self,
        item_name: str,
        kind: str,
        est_cost: float,
        reason: str = "",
        item_id: int | None = None,
    ) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO waste_ledger (ts, item_id, item_name, kind, est_cost, reason)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (datetime.now().isoformat(), item_id, item_name, kind, est_cost, reason),
            )

    def ledger_totals(self, since_days: int = 7) -> LedgerTotals:
        cutoff = (datetime.now() - timedelta(days=since_days)).isoformat()
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT kind, COUNT(*) AS n, COALESCE(SUM(est_cost), 0) AS total
                FROM waste_ledger WHERE ts >= ? GROUP BY kind
                """,
                (cutoff,),
            ).fetchall()
        totals = LedgerTotals()
        for row in rows:
            if row["kind"] == "saved":
                totals.saved_cad = round(float(row["total"]), 2)
                totals.items_saved = int(row["n"])
            elif row["kind"] == "wasted":
                totals.wasted_cad = round(float(row["total"]), 2)
                totals.items_wasted = int(row["n"])
        return totals

    def ledger_entries(self, limit: int = 20) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM waste_ledger ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    # --- profile -------------------------------------------------------------

    def set_profile(self, key: str, value: object) -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO profile (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, json.dumps(value)),
            )

    def get_profile(self) -> dict:
        with self.connect() as conn:
            rows = conn.execute("SELECT key, value FROM profile").fetchall()
        return {r["key"]: json.loads(r["value"]) for r in rows}

    # --- chat ----------------------------------------------------------------

    def add_message(self, role: str, content: str) -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO messages (ts, role, content) VALUES (?, ?, ?)",
                (datetime.now().isoformat(), role, content),
            )

    def recent_messages(self, limit: int = 12) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM messages ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in reversed(rows)]

    # --- shelf life cache ----------------------------------------------------

    def get_shelf_life(self, name: str) -> dict | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM shelf_life_cache WHERE name = ?", (name.lower().strip(),)
            ).fetchone()
        return dict(row) if row else None

    def put_shelf_life(
        self, name: str, days: int, est_cost: float, storage_tip: str, source: str
    ) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO shelf_life_cache (name, shelf_life_days, est_cost, storage_tip, source)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    shelf_life_days = excluded.shelf_life_days,
                    est_cost = excluded.est_cost,
                    storage_tip = excluded.storage_tip,
                    source = excluded.source
                """,
                (name.lower().strip(), days, est_cost, storage_tip, source),
            )

    def shelf_life_names(self) -> list[str]:
        with self.connect() as conn:
            rows = conn.execute("SELECT name FROM shelf_life_cache ORDER BY name").fetchall()
        return [r["name"] for r in rows]

    # --- maintenance ---------------------------------------------------------

    def reset(self) -> None:
        """Drops every row but keeps the shelf-life cache. Used by the demo seeder."""
        with self.connect() as conn:
            for table in ("items", "events", "pending", "waste_ledger", "messages", "profile"):
                conn.execute(f"DELETE FROM {table}")  # noqa: S608 - fixed table allowlist


def _row_to_item(row: sqlite3.Row) -> InventoryItem:
    return InventoryItem(
        id=row["id"],
        name=row["name"],
        category=Category(row["category"]),
        quantity=row["quantity"],
        unit=row["unit"],
        added_at=datetime.fromisoformat(row["added_at"]),
        expires_at=datetime.fromisoformat(row["expires_at"]) if row["expires_at"] else None,
        shelf_life_days=row["shelf_life_days"],
        status=ItemStatus(row["status"]),
        confidence=row["confidence"],
        est_cost=row["est_cost"],
        storage_tip=row["storage_tip"],
        removal_count=row["removal_count"],
        frame_ref=row["frame_ref"],
    )
