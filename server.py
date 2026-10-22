#!/usr/bin/env python3
"""HTTP server for the sports field booking app (CS411, stage 2).

Only uses the Python standard library. Every response is JSON and carries
CORS headers so the browser client can call it from another origin.

Files:
- server.py  HTTP handling: reading requests, routing, permission checks,
             sending JSON responses
- db.py      SQLite connection and table creation
- auth.py    password hashing, users and login sessions (tokens)
- fields.py  database queries for sports fields
"""
import json
import math
import traceback
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import auth
import fields
from db import init_db

HOST = "0.0.0.0"
PORT = 8000

# Maximum length of the text values of a field (name, sport, location).
MAX_TEXT_LENGTH = 100

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


def require_owner(handler):
    """Return the logged-in user if they are an owner.
    401 if not logged in, 403 if logged in as a player."""
    user, _ = require_user(handler)
    if user["role"] != "owner":
        raise ApiError(403, "Only owners can do this.")
    return user


def parse_id(text):
    """Turn the <id> part of a path into an integer, or raise ApiError(400)."""
    # isascii() rejects other digit characters such as '²' that int() refuses.
    if not (text.isascii() and text.isdigit()):
        raise ApiError(400, f"Id must be an integer, got '{text}'.")
    # SQLite integers are 64-bit; a bigger number would crash the query.
    if len(text) > 18:
        raise ApiError(400, "Id is too large.")
    return int(text)


def get_field_or_404(field_id):
    field = fields.get_field(field_id)
    if field is None:
        raise ApiError(404, f"Field {field_id} not found.")
    return field


def require_field_owner(handler, field_id):
    """Return the field if the logged-in user owns it.
    The checks are in this order on purpose:
    401 not logged in -> 404 field does not exist -> 403 not your field."""
    user, _ = require_user(handler)
    field = get_field_or_404(field_id)
    if field["owner_id"] != user["id"]:
        raise ApiError(403, "You can only change your own fields.")
    return field


def read_text_value(data, name):
    """Return data[name] trimmed. Raises ApiError(400) naming the field if it
    is missing, not a string, empty or too long."""
    if name not in data:
        raise ApiError(400, f"Field '{name}' is required.")
    value = data[name]
    if not isinstance(value, str) or not value.strip():
        raise ApiError(400, f"Field '{name}' must be a non-empty string.")
    value = value.strip()
    if len(value) > MAX_TEXT_LENGTH:
        raise ApiError(400, f"Field '{name}' must be at most {MAX_TEXT_LENGTH} characters.")
    return value


def read_price(data):
    """Return data['price_per_hour'] as a float. Raises ApiError(400) if it is
    missing or not a positive number."""
    if "price_per_hour" not in data:
        raise ApiError(400, "Field 'price_per_hour' is required.")
    value = data["price_per_hour"]
    # bool is a subclass of int in Python, so true/false must be refused explicitly.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ApiError(400, "Field 'price_per_hour' must be a number.")
    try:
        price = float(value)
    except OverflowError:
        # An integer with hundreds of digits cannot become a float.
        raise ApiError(400, "Field 'price_per_hour' is too large.")
    # isfinite() refuses NaN and Infinity, which Python's json module accepts.
    if not math.isfinite(price) or price <= 0:
        raise ApiError(400, "Field 'price_per_hour' must be a positive number.")
    return price


def read_field_body(handler):
    """Read and validate the body of POST/PUT /api/fields.
    Returns (name, sport, location, price_per_hour)."""
    data = read_json_body(handler)
    name = read_text_value(data, "name")
    sport = read_text_value(data, "sport")
    location = read_text_value(data, "location")
    price = read_price(data)
    return name, sport, location, price


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


def handle_list_fields(handler):
    # Optional filter: /api/fields?sport=football (an empty value means no filter)
    sport = handler.query.get("sport", [""])[0].strip() or None
    return 200, {"fields": fields.list_fields(sport=sport)}


def handle_get_field(handler, field_id):
    return 200, {"field": get_field_or_404(field_id)}


def handle_create_field(handler):
    user = require_owner(handler)
    name, sport, location, price = read_field_body(handler)
    field_id = fields.create_field(user["id"], name, sport, location, price)
    return 201, {"message": "Field created.", "field": fields.get_field(field_id)}


def handle_update_field(handler, field_id):
    require_field_owner(handler, field_id)
    name, sport, location, price = read_field_body(handler)
    fields.update_field(field_id, name, sport, location, price)
    return 200, {"message": "Field updated.", "field": fields.get_field(field_id)}


def handle_delete_field(handler, field_id):
    require_field_owner(handler, field_id)
    if not fields.delete_field(field_id):
        raise ApiError(409, "This field has bookings and cannot be deleted.")
    return 200, {"message": "Field deleted."}


def handle_my_fields(handler):
    user = require_owner(handler)
    return 200, {"fields": fields.list_fields(owner_id=user["id"])}


# path -> {HTTP method -> handler function}
# A path part written "<id>" matches any value; it is converted to an integer
# and passed to the handler function as an extra argument.
ROUTES = {
    "/": {"GET": handle_health},
    "/health": {"GET": handle_health},
    "/api/status": {"GET": handle_health},
    "/api/register": {"POST": handle_register},
    "/api/login": {"POST": handle_login},
    "/api/me": {"GET": handle_me},
    "/api/logout": {"POST": handle_logout},
    "/api/fields": {"GET": handle_list_fields, "POST": handle_create_field},
    "/api/fields/<id>": {"GET": handle_get_field, "PUT": handle_update_field,
                         "DELETE": handle_delete_field},
    "/api/my/fields": {"GET": handle_my_fields},
}


def match_route(path):
    """Find the route for a path. Returns (methods, ids) where ids are the
    raw text values of the "<id>" parts, or (None, None) if nothing matches.
    Example: "/api/fields/7" matches "/api/fields/<id>" with ids ["7"]."""
    path_parts = path.strip("/").split("/")
    for pattern, methods in ROUTES.items():
        pattern_parts = pattern.strip("/").split("/")
        if len(pattern_parts) != len(path_parts):
            continue
        ids = []
        for pattern_part, path_part in zip(pattern_parts, path_parts):
            if pattern_part == "<id>":
                ids.append(path_part)
            elif pattern_part != path_part:
                break
        else:
            # The loop did not "break": every part matched.
            return methods, ids
    return None, None


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
        # Split "/api/fields?sport=football" into the path and the query
        # string. self.query becomes {"sport": ["football"]}.
        url = urlsplit(self.path)
        path = url.path
        self.query = parse_qs(url.query)
        try:
            methods, ids = match_route(path)
            if methods is None:
                raise ApiError(404, f"No route matched: {path}")
            if method not in methods:
                allowed = ", ".join(list(methods) + ["OPTIONS"])
                self.send_json(405, {"error": f"Method {method} not allowed. Allowed: {allowed}"},
                               {"Allow": allowed})
                return
            args = [parse_id(text) for text in ids]
            status, payload = methods[method](self, *args)
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
