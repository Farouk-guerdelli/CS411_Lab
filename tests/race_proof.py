#!/usr/bin/env python3
"""Race proof: shows why create_booking() needs its BEGIN IMMEDIATE transaction.

What it shows:
    Booking is two steps: check that the slot is free, then insert. If two
    requests run at the same time, both can pass the check before either
    one inserts, and the slot gets booked twice.

    In real use the gap between check and insert is tiny, so a collision
    is rare and hard to show. This script makes the gap big on purpose:
    it pauses DELAY_SECONDS right after the overlap check. Then two threads
    try to book the same slot at the same instant, twice:

    1. naive_create_booking(): check, then insert, no transaction.
       Expected: BOTH threads succeed -> double booking.
    2. bookings.create_booking(): the real code from bookings.py.
       Expected: ONE thread succeeds, the other gets SlotTaken (409).

    With BEGIN IMMEDIATE, the second thread waits for the write lock until
    the first one has committed, so its check sees the first booking.

How to run (from the project folder, no server needed):
    python tests/race_proof.py

It uses a temporary database that is deleted at the end; app.db is never
opened. Exit code 0 means the result was as expected, 1 means it was not.
"""
import os
import sqlite3
import sys
import tempfile
import threading
import time

# Make the project modules (db.py, bookings.py) importable from tests/.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bookings
import db

DELAY_SECONDS = 0.3   # artificial pause between the check and the insert
FIELD_ID = 1
PLAYER_ID = 2


class CheckResult:
    """Holds the already-fetched row of the overlap check."""

    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


class SlowConnection:
    """Wraps a real connection and pauses right after the overlap check.
    Everything else (isolation_level, commit, close...) goes to the real
    connection."""

    def __init__(self, conn):
        self.__dict__["conn"] = conn

    def __getattr__(self, name):
        return getattr(self.conn, name)

    def __setattr__(self, name, value):
        setattr(self.conn, name, value)

    def execute(self, sql, params=()):
        cursor = self.conn.execute(sql, params)
        if sql == bookings.OVERLAP_QUERY:
            # Read the result first so no read is left open during the pause.
            row = cursor.fetchone()
            time.sleep(DELAY_SECONDS)
            return CheckResult(row)
        return cursor


def naive_create_booking(field_id, player_id, date, start_hour, end_hour):
    """The WRONG way: check, then insert, as two separate steps."""
    conn = bookings.get_connection()
    try:
        taken = conn.execute(bookings.OVERLAP_QUERY, (field_id, date, start_hour, end_hour)).fetchone()
        if taken is not None:
            raise bookings.SlotTaken(taken["start_hour"], taken["end_hour"])
        cursor = conn.execute(
            "INSERT INTO bookings (field_id, player_id, date, start_hour, end_hour) "
            "VALUES (?, ?, ?, ?, ?)",
            (field_id, player_id, date, start_hour, end_hour),
        )
        conn.commit()
        return cursor.lastrowid
    finally:
        conn.close()


def race(create_function, date):
    """Two threads book 10-12 on the same field and date at the same instant.
    Returns one result text per thread."""
    start_together = threading.Barrier(2)
    results = []

    def book():
        start_together.wait()
        try:
            booking_id = create_function(FIELD_ID, PLAYER_ID, date, 10, 12)
            results.append(f"booked (id {booking_id})")
        except bookings.SlotTaken:
            results.append("refused: slot taken (409)")

    threads = [threading.Thread(target=book) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return results


def count_bookings(date):
    conn = sqlite3.connect(db.DB_PATH)
    try:
        return conn.execute("SELECT COUNT(*) FROM bookings WHERE date = ?", (date,)).fetchone()[0]
    finally:
        conn.close()


def main():
    with tempfile.TemporaryDirectory() as temp_dir:
        # Point the project at a temporary database before anything opens it.
        db.DB_PATH = os.path.join(temp_dir, "race_proof.db")
        db.init_db()
        conn = sqlite3.connect(db.DB_PATH)
        conn.execute("INSERT INTO users (id, username, password_hash, salt, role) "
                     "VALUES (1, 'owner', 'x', 'x', 'owner'), (2, 'player', 'x', 'x', 'player')")
        conn.execute("INSERT INTO fields (id, owner_id, name, sport, location, price_per_hour) "
                     "VALUES (1, 1, 'Test Field', 'football', 'Tunis', 40)")
        conn.commit()
        conn.close()

        # Both versions get the artificial pause after the overlap check.
        real_get_connection = bookings.get_connection
        bookings.get_connection = lambda: SlowConnection(real_get_connection())

        print(f"Two threads book the same slot at once ({DELAY_SECONDS} s pause after the check).\n")

        print("1. Naive check-then-insert (no transaction):")
        for result in race(naive_create_booking, "2030-01-01"):
            print("   ", result)
        naive_count = count_bookings("2030-01-01")
        print(f"    bookings in the database for this slot: {naive_count}\n")

        print("2. Real create_booking() with BEGIN IMMEDIATE:")
        for result in race(bookings.create_booking, "2030-01-02"):
            print("   ", result)
        real_count = count_bookings("2030-01-02")
        print(f"    bookings in the database for this slot: {real_count}\n")

        bookings.get_connection = real_get_connection

    if naive_count == 2 and real_count == 1:
        print("OK: without the transaction the slot was booked twice; with it, only once.")
        return 0
    print("UNEXPECTED RESULT: see the counts above.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
