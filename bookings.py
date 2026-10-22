"""Bookings: database queries for creating, listing and cancelling bookings.

These functions only talk to the database. Checking who is allowed to do
what (login, player role, ownership) and validating input is done in
server.py.
"""
from db import get_connection

# Every query returns bookings in the same shape. total_price is computed
# from the field's current price: (end_hour - start_hour) * price_per_hour.
SELECT_BOOKINGS = (
    "SELECT bookings.id, bookings.field_id, fields.name AS field_name, "
    "fields.location AS field_location, bookings.player_id, "
    "users.username AS player_username, bookings.date, bookings.start_hour, "
    "bookings.end_hour, "
    "(bookings.end_hour - bookings.start_hour) * fields.price_per_hour AS total_price, "
    "bookings.created_at "
    "FROM bookings "
    "JOIN fields ON fields.id = bookings.field_id "
    "JOIN users ON users.id = bookings.player_id "
)

# Two slots on the same field and date overlap if each one starts before the
# other one ends. Back-to-back slots (10-12 then 12-14) do not overlap,
# because 12 < 12 is false.
OVERLAP_QUERY = (
    "SELECT start_hour, end_hour FROM bookings "
    "WHERE field_id = ? AND date = ? AND ? < end_hour AND ? > start_hour "
    "LIMIT 1"
)


class SlotTaken(Exception):
    """Raised when the requested slot overlaps an existing booking."""

    def __init__(self, start_hour, end_hour):
        super().__init__(f"{start_hour}-{end_hour}")
        self.start_hour = start_hour
        self.end_hour = end_hour


def create_booking(field_id, player_id, date, start_hour, end_hour):
    """Book a slot. Returns the new booking id, or None if the field does
    not exist. Raises SlotTaken if the slot overlaps an existing booking.

    Why a transaction: two players may send the same request at the same
    moment from two machines. If we first checked for an overlap and then
    inserted as two separate steps, both requests could pass the check
    before either one inserts, and the slot would be booked twice.

    "BEGIN IMMEDIATE" takes SQLite's write lock at the start of the
    transaction. Only one connection can hold it, so the second request
    waits (up to 5 seconds, sqlite3's default timeout) until the first one
    has committed. When the second request then runs its overlap check, it
    sees the first booking and gets SlotTaken. Check + insert behave like a
    single step.
    """
    conn = get_connection()
    # Turn off Python's automatic transactions so we control BEGIN/COMMIT.
    conn.isolation_level = None
    try:
        conn.execute("BEGIN IMMEDIATE")

        # Checked inside the transaction so the field cannot be deleted
        # between this check and the insert.
        field = conn.execute("SELECT id FROM fields WHERE id = ?", (field_id,)).fetchone()
        if field is None:
            return None

        taken = conn.execute(OVERLAP_QUERY, (field_id, date, start_hour, end_hour)).fetchone()
        if taken is not None:
            raise SlotTaken(taken["start_hour"], taken["end_hour"])

        cursor = conn.execute(
            "INSERT INTO bookings (field_id, player_id, date, start_hour, end_hour) "
            "VALUES (?, ?, ?, ?, ?)",
            (field_id, player_id, date, start_hour, end_hour),
        )
        conn.execute("COMMIT")
        return cursor.lastrowid
    finally:
        # If we left before COMMIT (field missing, slot taken, or an
        # unexpected error), undo the transaction and release the lock.
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        conn.close()


def get_booking(booking_id):
    """Return one booking as a dict, or None if it does not exist."""
    conn = get_connection()
    try:
        row = conn.execute(SELECT_BOOKINGS + "WHERE bookings.id = ?", (booking_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def list_player_bookings(player_id):
    """Return all bookings of a player, sorted by date and start hour."""
    conn = get_connection()
    try:
        rows = conn.execute(
            SELECT_BOOKINGS + "WHERE bookings.player_id = ? "
            "ORDER BY bookings.date, bookings.start_hour",
            (player_id,),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def list_field_bookings(field_id, date):
    """Return the bookings of one field on one date, sorted by start hour."""
    conn = get_connection()
    try:
        rows = conn.execute(
            SELECT_BOOKINGS + "WHERE bookings.field_id = ? AND bookings.date = ? "
            "ORDER BY bookings.start_hour",
            (field_id, date),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def delete_booking(booking_id):
    """Cancel (delete) a booking."""
    conn = get_connection()
    try:
        conn.execute("DELETE FROM bookings WHERE id = ?", (booking_id,))
        conn.commit()
    finally:
        conn.close()
