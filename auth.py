"""Authentication: password hashing, user accounts and login sessions (tokens).

How it works:
- Passwords are never stored. We store a random salt and the PBKDF2 hash of
  (salt + password). To check a password we hash it again with the same salt
  and compare the results.
- At login we create a random token, save it in the sessions table and give
  it to the client. The client sends it back on every request in the header
  "Authorization: Bearer <token>". Logout deletes the token from the table.
"""
import hashlib
import secrets
import sqlite3

from db import get_connection

VALID_ROLES = ("owner", "player")

# PBKDF2 settings. A high iteration count makes brute-forcing stolen hashes slow.
HASH_ALGORITHM = "sha256"
HASH_ITERATIONS = 600_000
SALT_BYTES = 16
TOKEN_BYTES = 32


def hash_password(password, salt_hex):
    """Return the PBKDF2 hash of the password (hex string)."""
    digest = hashlib.pbkdf2_hmac(
        HASH_ALGORITHM, password.encode("utf-8"), bytes.fromhex(salt_hex), HASH_ITERATIONS
    )
    return digest.hex()


def create_user(username, password, role):
    """Insert a new user. Returns the new user's id, or None if the username
    is already taken."""
    salt_hex = secrets.token_hex(SALT_BYTES)
    password_hash = hash_password(password, salt_hex)
    conn = get_connection()
    try:
        cursor = conn.execute(
            "INSERT INTO users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)",
            (username, password_hash, salt_hex, role),
        )
        conn.commit()
        return cursor.lastrowid
    except sqlite3.IntegrityError:
        # The UNIQUE constraint on username was violated.
        return None
    finally:
        conn.close()


def login(username, password):
    """Check the credentials. Returns a new session token, or None if the
    username or password is wrong."""
    conn = get_connection()
    try:
        user = conn.execute(
            "SELECT id, password_hash, salt FROM users WHERE username = ?", (username,)
        ).fetchone()
        if user is None:
            return None

        # compare_digest takes the same time whether the hashes match or not,
        # so an attacker cannot learn anything from the response time.
        attempt = hash_password(password, user["salt"])
        if not secrets.compare_digest(attempt, user["password_hash"]):
            return None

        token = secrets.token_hex(TOKEN_BYTES)
        conn.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user["id"]))
        conn.commit()
        return token
    finally:
        conn.close()


def get_user_by_token(token):
    """Return the user (as a dict) that owns this session token, or None."""
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT users.id, users.username, users.role, users.created_at "
            "FROM sessions JOIN users ON users.id = sessions.user_id "
            "WHERE sessions.token = ?",
            (token,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def logout(token):
    """Delete the session so the token can no longer be used."""
    conn = get_connection()
    try:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()
    finally:
        conn.close()
