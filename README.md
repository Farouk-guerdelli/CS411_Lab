# Sports Field Booking (CS411 Computer Networks)

A web app where sports field owners list their fields and players book time
slots. The server is written in Python with the standard library only
(`http.server`, `sqlite3`); the client is plain HTML, CSS and JavaScript.
Traffic is plain HTTP on purpose, so every request and response can be read
in Wireshark.

## Architecture

```
                    VirtualBox internal network (192.168.100.x)
   ┌───────────────────────────┐          ┌─────────────────────────────────┐
   │ Client1 (Ubuntu Desktop)  │          │ Server VM (Ubuntu Server)       │
   │ 192.168.100.102 (DHCP)    │──HTTP───▶│ 192.168.100.10:8000 (fixed)     │
   │ browser                   │          │ server.py                       │
   └───────────────────────────┘          │  ├─ /           web client      │
   ┌───────────────────────────┐          │  ├─ /api/...    JSON API        │
   │ Client2 (Ubuntu Desktop)  │          │  └─ app.db      SQLite database │
   │ 192.168.100.103 (DHCP)    │──HTTP───▶│                                 │
   │ browser                   │          │                                 │
   └───────────────────────────┘          └─────────────────────────────────┘
```

- **Server VM** (Ubuntu Server, `192.168.100.10`): runs `server.py`, which
  serves both the web page and the JSON API on port 8000 and stores
  everything in `app.db`.
- **Client1 and Client2** (Ubuntu Desktop) on the same internal network: open
  the page in a browser. Two clients let us show two users at once, for
  example two players trying to book the same slot.

**Addressing:** the server's address `192.168.100.10` is fixed, so the clients
always find it at the same URL. The clients get their addresses from the
VirtualBox DHCP server (range `192.168.100.101`-`192.168.100.200`), so
`.102` and `.103` are only their current addresses and can change after a
reboot. Check them with `ip -4 addr` before a Wireshark capture.

## How to run

On the server VM:

```bash
git clone https://github.com/Farouk-guerdelli/CS411_Lab.git && cd CS411_Lab
python3 server.py              # listens on 0.0.0.0:8000, Ctrl+C to stop
sudo ufw allow 8000/tcp        # only if the ufw firewall is enabled
```

`app.db` is created automatically on the first start. No packages to install.

On each client VM, open **http://192.168.100.10:8000/** in the browser.
Check connectivity first with `ping 192.168.100.10` or
`curl http://192.168.100.10:8000/health`.

To capture the traffic, run Wireshark on a client (or `tcpdump` on the server)
with the filter `tcp.port == 8000`, then use *Follow → HTTP Stream*.

## HTTP scenarios

| Scenario | Request | Status |
|----------|---------|--------|
| Server is up | `GET /health` | 200 OK |
| Load the web page | `GET /` | 200 OK |
| Register a user | `POST /api/register` | 201 Created |
| Register with a missing field or invalid role | `POST /api/register` | 400 Bad Request |
| Register a username that already exists | `POST /api/register` | 409 Conflict |
| Log in | `POST /api/login` | 200 OK |
| Log in with a wrong password | `POST /api/login` | 401 Unauthorized |
| Use the API without a token / with a deleted token | e.g. `GET /api/me` | 401 Unauthorized |
| Owner adds a field | `POST /api/fields` | 201 Created |
| Invalid field (empty name, negative price...) | `POST /api/fields` | 400 Bad Request |
| Player tries to add a field | `POST /api/fields` | 403 Forbidden |
| Owner edits another owner's field | `PUT /api/fields/<id>` | 403 Forbidden |
| Field that does not exist | `GET /api/fields/99999` | 404 Not Found |
| Player books a free slot | `POST /api/bookings` | 201 Created |
| Booking in the past or end before start | `POST /api/bookings` | 400 Bad Request |
| Owner tries to book | `POST /api/bookings` | 403 Forbidden |
| Slot overlaps an existing booking | `POST /api/bookings` | 409 Conflict |
| Two players book the same slot at the same moment | `POST /api/bookings` ×2 | one 201, one 409 |
| Player cancels another player's booking | `DELETE /api/bookings/<id>` | 403 Forbidden |
| Owner deletes a field that has bookings | `DELETE /api/fields/<id>` | 409 Conflict |
| Wrong method on a route | e.g. `PUT /api/login` | 405 Method Not Allowed (+ `Allow` header) |
| Unknown path or file | e.g. `GET /nope` | 404 Not Found |
| Path traversal attempt | e.g. `GET /../server.py` | 404 Not Found |
| Unexpected server error | any | 500 Internal Server Error (JSON) |

Every error is a JSON object like `{"error": "..."}`. The web client shows it in
a red box, and the panel at the bottom of the page shows the method, URL and
status code of the last requests.

## Documentation

- [BACKEND.md](BACKEND.md): server code organization, every endpoint, password
  hashing, tokens, 401 vs 403 vs 404, the overlap rule and why the booking
  transaction prevents double booking.
- [CLIENT.md](CLIENT.md): how the web client is organized and how it talks to
  the API.
- [tests/race_proof.py](tests/race_proof.py): shows that two simultaneous
  bookings of the same slot cannot both succeed. Run it with
  `python3 tests/race_proof.py` (it uses a temporary database).
