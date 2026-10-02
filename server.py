#!/usr/bin/env python3
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "0.0.0.0"
PORT = 8000

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
}


def send_json(handler, status_code, payload):
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status_code)
    for key, value in CORS_HEADERS.items():
        handler.send_header(key, value)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class DemoHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Keep console output concise for lab use.
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        for key, value in CORS_HEADERS.items():
            self.send_header(key, value)
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def handle_route(self, method):
        path = self.path.split("?", 1)[0]

        if path in ("/", "/health", "/api/status"):
            if method == "GET":
                send_json(
                    self,
                    200,
                    {
                        "status": "ok",
                        "message": "Server is running",
                        "endpoint": path,
                    },
                )
                return
            if method == "POST":
                send_json(self, 405, {"error": "Method not allowed for this endpoint"})
                return

        if path == "/bad-request":
            send_json(self, 400, {"error": "Bad Request", "message": "The request payload is invalid."})
            return

        if path == "/unauthorized":
            send_json(self, 401, {"error": "Unauthorized", "message": "Authentication is required."})
            return

        if path == "/forbidden":
            send_json(self, 403, {"error": "Forbidden", "message": "You do not have permission."})
            return

        if path == "/missing":
            send_json(self, 404, {"error": "Not Found", "message": "The requested resource was not found."})
            return

        if path == "/method-only-get":
            if method == "GET":
                send_json(self, 200, {"status": "ok", "message": "GET is allowed here."})
            else:
                send_json(self, 405, {"error": "Method Not Allowed", "message": "This route accepts GET only."})
            return

        if path == "/method-only-post":
            if method == "POST":
                content_length = int(self.headers.get("Content-Length", "0"))
                raw_body = self.rfile.read(content_length).decode("utf-8")
                try:
                    payload = json.loads(raw_body) if raw_body else {}
                except json.JSONDecodeError:
                    send_json(self, 400, {"error": "Invalid JSON payload."})
                    return
                send_json(self, 200, {"status": "ok", "received": payload})
            else:
                send_json(self, 405, {"error": "Method Not Allowed", "message": "This route accepts POST only."})
            return

        if path == "/internal-error":
            send_json(self, 500, {"error": "Internal Server Error", "message": "A simulated server failure occurred."})
            return

        if path == "/api/echo":
            if method == "POST":
                content_length = int(self.headers.get("Content-Length", "0"))
                raw_body = self.rfile.read(content_length).decode("utf-8")
                try:
                    payload = json.loads(raw_body) if raw_body else {}
                except json.JSONDecodeError:
                    send_json(self, 400, {"error": "Invalid JSON payload."})
                    return
                send_json(self, 200, {"status": "ok", "echo": payload})
            else:
                send_json(self, 405, {"error": "Method Not Allowed", "message": "Use POST for this route."})
            return

        send_json(self, 404, {"error": "Not Found", "message": f"No route matched: {path}"})

    def do_GET(self):
        self.handle_route("GET")

    def do_POST(self):
        self.handle_route("POST")


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), DemoHandler)
    print(f"HTTP demo server running on http://{HOST}:{PORT}")
    server.serve_forever()
