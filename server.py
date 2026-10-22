#!/usr/bin/env python3
"""HTTP server for the sports field booking app (CS411, stage 1).

Only uses the Python standard library. Every response is JSON and carries
CORS headers so the browser client can call it from another origin.

Files:
- server.py  HTTP handling: reading requests, routing, sending JSON responses
- db.py      SQLite connection and table creation
- auth.py    password hashing, users and login sessions (tokens)
"""
import json
import traceback
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import auth
from db import init_db

HOST = "0.0.0.0"
PORT = 8000

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
}


class ApiError(Exception):
    """Raise this anywhere in a route to send a JSON error response."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------------------
# Request helpers
# ---------------------------------------------------------------------------

def read_json_body(handler):
    """Read the request body and parse it as a JSON object.
    Raises ApiError(400) if the body is not valid."""
    length_header = handler.headers.get("Content-Length", "0")
    try:
        length = int(length_header)
    except ValueError:
        raise ApiError(400, "Content-Length must be a number.")
    if length < 0:
        raise ApiError(400, "Content-Length must not be negative.")
    if length == 0:
        return {}

    raw = handler.rfile.read(length)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise ApiError(400, "Request body must be valid UTF-8.")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        raise ApiError(400, "Request body must be valid JSON.")
    if not isinstance(data, dict):
        raise ApiError(400, "Request body must be a JSON object.")
    return data


def require_fields(data, names):
    """Return the values of the given fields. Raises ApiError(400) if one is
    missing, not a string, or empty."""
    values = []
    for name in names:
        value = data.get(name)
        if not isinstance(value, str) or not value.strip():
            raise ApiError(400, f"Field '{name}' is required and must be a non-empty string.")
        values.append(value)
    return values


def get_token(handler):
    """Extract the token from the header 'Authorization: Bearer <token>'."""
    header = handler.headers.get("Authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme != "Bearer" or not token.strip():
        raise ApiError(401, "Missing or malformed Authorization header. Use 'Bearer <token>'.")
    return token.strip()


def require_user(handler):
    """Return (user, token) for the logged-in user, or raise ApiError(401)."""
    token = get_token(handler)
    user = auth.get_user_by_token(token)
    if user is None:
        raise ApiError(401, "Invalid or expired token.")
    return user, token


# ---------------------------------------------------------------------------
# Route handlers. Each one returns (status_code, payload_dict).
# ---------------------------------------------------------------------------

def handle_health(handler):
    return 200, {"status": "ok", "message": "Server is running"}


def handle_register(handler):
    data = read_json_body(handler)
    username, password, role = require_fields(data, ["username", "password", "role"])
    username = username.strip()
    if role not in auth.VALID_ROLES:
        raise ApiError(400, "Field 'role' must be 'owner' or 'player'.")

    user_id = auth.create_user(username, password, role)
    if user_id is None:
        raise ApiError(409, "Username already exists.")
    return 201, {"message": "User registered.", "user": {"id": user_id, "username": username, "role": role}}


def handle_login(handler):
    data = read_json_body(handler)
    username, password = require_fields(data, ["username", "password"])
    token = auth.login(username.strip(), password)
    if token is None:
        # Same message for unknown user and wrong password, so we do not
        # reveal which usernames exist.
        raise ApiError(401, "Wrong username or password.")
    return 200, {"message": "Logged in.", "token": token}


def handle_me(handler):
    user, _ = require_user(handler)
    return 200, {"user": user}


def handle_logout(handler):
    _, token = require_user(handler)
    auth.logout(token)
    return 200, {"message": "Logged out."}


# path -> {HTTP method -> handler function}
ROUTES = {
    "/": {"GET": handle_health},
    "/health": {"GET": handle_health},
    "/api/status": {"GET": handle_health},
    "/api/register": {"POST": handle_register},
    "/api/login": {"POST": handle_login},
    "/api/me": {"GET": handle_me},
    "/api/logout": {"POST": handle_logout},
}


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class AppHandler(BaseHTTPRequestHandler):

    def send_json(self, status, payload, extra_headers=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        for key, value in CORS_HEADERS.items():
            self.send_header(key, value)
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_request(self, code="-", size="-"):
        # One line per request: time, client IP, method, path, status.
        # (code can be an HTTPStatus enum; .value turns it into a plain number)
        status = getattr(code, "value", code)
        time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        print(f"[{time}] {self.client_address[0]} {self.command} {self.path} -> {status}", flush=True)

    def dispatch(self, method):
        """Find the route for this request and run it. Every error becomes a
        JSON response, so the client always gets an answer."""
        path = self.path.split("?", 1)[0]
        try:
            methods = ROUTES.get(path)
            if methods is None:
                raise ApiError(404, f"No route matched: {path}")
            if method not in methods:
                allowed = ", ".join(list(methods) + ["OPTIONS"])
                self.send_json(405, {"error": f"Method {method} not allowed. Allowed: {allowed}"},
                               {"Allow": allowed})
                return
            status, payload = methods[method](self)
            self.send_json(status, payload)
        except ApiError as e:
            self.send_json(e.status, {"error": e.message})
        except Exception:
            # Unexpected bug: print the details on the server console, but only
            # send a generic message to the client.
            traceback.print_exc()
            self.send_json(500, {"error": "Internal server error."})

    def do_OPTIONS(self):
        # CORS preflight: the browser asks which methods/headers are allowed.
        self.send_response(204)
        for key, value in CORS_HEADERS.items():
            self.send_header(key, value)
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    # We handle these ourselves so the client gets a JSON 404/405 instead of
    # Python's default HTML "501 Unsupported method" page.
    def do_PUT(self):
        self.dispatch("PUT")

    def do_PATCH(self):
        self.dispatch("PATCH")

    def do_DELETE(self):
        self.dispatch("DELETE")


if __name__ == "__main__":
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), AppHandler)
    print(f"Server running on http://{HOST}:{PORT}", flush=True)
    server.serve_forever()
