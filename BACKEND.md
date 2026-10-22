# Backend: how it works (Stage 1)

Run it with `python server.py`. It listens on `0.0.0.0:8000` over plain HTTP,
so all traffic (including passwords and tokens) is readable in Wireshark.

## How the code is organized

| File        | What it does |
|-------------|--------------|
| `server.py` | Receives HTTP requests, picks the right function for the path and method (`ROUTES` table), sends JSON responses with CORS headers, turns every error into a JSON error. |
| `auth.py`   | Hashes passwords, creates users, logs in (creates tokens), finds the user for a token, logs out. |
| `db.py`     | Opens the SQLite file `app.db` and creates the 4 tables (`users`, `sessions`, `fields`, `bookings`) on startup. |

A request goes through these steps:

1. Python's `ThreadingHTTPServer` accepts the TCP connection and parses the
   HTTP request (each request runs in its own thread).
2. `do_GET` / `do_POST` / `do_PUT` / ... all call `dispatch(method)`.
3. `dispatch` looks up the path in `ROUTES`:
   - path not found -> **404**
   - path found but method not allowed -> **405** with an `Allow` header
   - otherwise it calls the route function, which returns `(status, data)`.
4. Route functions raise `ApiError(status, message)` for expected problems
   (bad input, wrong password...). `dispatch` turns it into a JSON error.
5. Any other exception (a bug) is caught too: the traceback is printed on the
   server console and the client gets a JSON **500**. The connection is never
   just dropped.
6. One log line is printed per request: time, client IP, method, path, status.

## Endpoints

| Method | Path            | Body / header                           | Success | Errors |
|--------|-----------------|-----------------------------------------|---------|--------|
| GET    | `/health`       | -                                       | 200 | - |
| POST   | `/api/register` | `{username, password, role}`            | 201 | 400 missing field or bad role, 409 username taken |
| POST   | `/api/login`    | `{username, password}`                  | 200 + token | 400 missing field, 401 wrong credentials |
| GET    | `/api/me`       | `Authorization: Bearer <token>`         | 200 + user | 401 missing/invalid token |
| POST   | `/api/logout`   | `Authorization: Bearer <token>`         | 200 | 401 missing/invalid token |

All endpoints also return 400 for invalid JSON, a non-numeric `Content-Length`,
or a body that is not UTF-8.

## How passwords are stored

We never store the password itself. At registration:

1. Generate a random **salt** (16 random bytes, `secrets.token_hex`).
2. Compute `hashlib.pbkdf2_hmac("sha256", password, salt, 600000)`.
3. Store the salt and the hash in `users`.

At login we hash the typed password again with the stored salt and compare
with the stored hash (`secrets.compare_digest`, which takes the same time
whether they match or not).

- **Why a salt?** Two users with the same password get different hashes, and
  precomputed hash tables (rainbow tables) are useless.
- **Why 600,000 iterations?** Each guess costs an attacker 600,000 hash
  computations, so brute-forcing a stolen database is very slow.

## How login and tokens work

1. `POST /api/login` with correct credentials -> the server creates a random
   token (`secrets.token_hex(32)`, 64 hex characters), saves
   `(token, user_id)` in the `sessions` table and returns it.
2. The client sends the token on every later request in the header
   `Authorization: Bearer <token>`.
3. The server looks the token up in `sessions` to know who is calling
   (`/api/me`). Unknown token -> 401.
4. `POST /api/logout` deletes the row, so the token stops working immediately.

HTTP is stateless: the server does not "remember" a connection. The token is
how each new request proves who sent it.

Wrong username and wrong password give the same message, so an attacker cannot
find out which usernames exist.

## Known limitations (for later stages)

- Plain HTTP: anyone on the network can read passwords and tokens (we want
  this for the Wireshark captures; HTTPS would fix it).
- Tokens never expire on their own; they only end at logout.
- No limit on login attempts.
