"""Database layer: opens the SQLite file and creates the tables.

The database is a single file (app.db) next to this script. It is created
automatically the first time the server starts.
"""
import os
import sqlite3

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app.db")

# All tables are created now, even the ones only used in later stages.
# "IF NOT EXISTS" makes this safe to run on every startup.
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,              -- PBKDF2 hash, hex encoded
    salt          TEXT    NOT NULL,              -- random salt, hex encoded
    role          TEXT    NOT NULL CHECK (role IN ('owner', 'player')),
    created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT    PRIMARY KEY,              -- random token given at login
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fields (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           TEXT    NOT NULL,
    sport          TEXT    NOT NULL,
    location       TEXT    NOT NULL,
    price_per_hour REAL    NOT NULL CHECK (price_per_hour >= 0),
    created_at     TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bookings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    field_id   INTEGER NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
    player_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date       TEXT    NOT NULL,                 -- 'YYYY-MM-DD'
    start_hour INTEGER NOT NULL CHECK (start_hour BETWEEN 0 AND 23),
    end_hour   INTEGER NOT NULL CHECK (end_hour BETWEEN 1 AND 24 AND end_hour > start_hour),
    created_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


def get_connection():
    """Open a new connection. Each request uses its own connection because
    the server handles requests in several threads at once."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row          # rows behave like dicts: row["username"]
    conn.execute("PRAGMA foreign_keys = ON")  # SQLite does not enforce them by default
    return conn


def init_db():
    """Create the database file and all tables if they do not exist yet."""
    conn = get_connection()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()
