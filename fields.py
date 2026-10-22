"""Sports fields: database queries for listing, creating, updating and
deleting fields.

These functions only talk to the database. Checking who is allowed to do
what (login, owner role, ownership) is done in server.py.
"""
from db import get_connection

# Every query returns fields in the same shape, including the owner's username.
SELECT_FIELDS = (
    "SELECT fields.id, fields.owner_id, users.username AS owner_username, "
    "fields.name, fields.sport, fields.location, fields.price_per_hour, fields.created_at "
    "FROM fields JOIN users ON users.id = fields.owner_id "
)


def list_fields(sport=None, owner_id=None):
    """Return all fields as a list of dicts. Optional filters:
    sport (case-insensitive) and owner_id."""
    conditions = []
    params = []
    if sport is not None:
        conditions.append("lower(fields.sport) = lower(?)")
        params.append(sport)
    if owner_id is not None:
        conditions.append("fields.owner_id = ?")
        params.append(owner_id)

    query = SELECT_FIELDS
    if conditions:
        query += "WHERE " + " AND ".join(conditions) + " "
    query += "ORDER BY fields.id"

    conn = get_connection()
    try:
        return [dict(row) for row in conn.execute(query, params).fetchall()]
    finally:
        conn.close()


def get_field(field_id):
    """Return one field as a dict, or None if it does not exist."""
    conn = get_connection()
    try:
        row = conn.execute(SELECT_FIELDS + "WHERE fields.id = ?", (field_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def create_field(owner_id, name, sport, location, price_per_hour):
    """Insert a new field and return its id."""
    conn = get_connection()
    try:
        cursor = conn.execute(
            "INSERT INTO fields (owner_id, name, sport, location, price_per_hour) "
            "VALUES (?, ?, ?, ?, ?)",
            (owner_id, name, sport, location, price_per_hour),
        )
        conn.commit()
        return cursor.lastrowid
    finally:
        conn.close()


def update_field(field_id, name, sport, location, price_per_hour):
    """Replace the 4 editable values of a field."""
    conn = get_connection()
    try:
        conn.execute(
            "UPDATE fields SET name = ?, sport = ?, location = ?, price_per_hour = ? "
            "WHERE id = ?",
            (name, sport, location, price_per_hour, field_id),
        )
        conn.commit()
    finally:
        conn.close()


def delete_field(field_id):
    """Delete a field only if it has no bookings.
    Returns True if it was deleted, False if bookings exist.

    The check and the delete are a single SQL statement, so a booking
    created at the same moment cannot slip in between them."""
    conn = get_connection()
    try:
        cursor = conn.execute(
            "DELETE FROM fields WHERE id = ? "
            "AND NOT EXISTS (SELECT 1 FROM bookings WHERE bookings.field_id = fields.id)",
            (field_id,),
        )
        conn.commit()
        return cursor.rowcount == 1
    finally:
        conn.close()
