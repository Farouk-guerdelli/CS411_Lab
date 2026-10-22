# Backend: how it works (Stages 1-3)

Run it with `python server.py`. It listens on `0.0.0.0:8000` over plain HTTP,
so all traffic (including passwords and tokens) is readable in Wireshark.

## How the code is organized

| File        | What it does |
|-------------|--------------|
| `server.py` | Receives HTTP requests, picks the right function for the path and method (`ROUTES` table), checks permissions, sends JSON responses with CORS headers, turns every error into a JSON error. |
| `auth.py`   | Hashes passwords, creates users, logs in (creates tokens), finds the user for a token, logs out. |
| `fields.py` | SQL queries for sports fields: list, get one, create, update, delete. |
| `bookings.py` | SQL queries for bookings, including the double-booking check done inside one transaction. |
| `db.py`     | Opens the SQLite file `app.db` and creates the 4 tables (`users`, `sessions`, `fields`, `bookings`) on startup. |

A request goes through these steps:

1. Python's `ThreadingHTTPServer` accepts the TCP connection and parses the
   HTTP request (each request runs in its own thread).
2. `do_GET` / `do_POST` / `do_PUT` / ... all call `dispatch(method)`.
3. `dispatch` splits off the query string (`?sport=football`) and looks up
   the path in `ROUTES` with `match_route`:
   - path not found -> **404**
   - path found but method not allowed -> **405** with an `Allow` header
   - a path part written `<id>` in `ROUTES` matches any value, e.g.
     `/api/fields/7` matches `/api/fields/<id>`. The value must be an
     integer (else **400**) and is passed to the route function.
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

## Fields

Owners list their sports fields; everyone can browse them.

| Method | Path                | Who                    | Body | Success |
|--------|---------------------|------------------------|------|---------|
| GET    | `/api/fields`       | anyone (no login)      | -    | 200, all fields. Optional `?sport=football` (not case-sensitive) |
| GET    | `/api/fields/<id>`  | anyone (no login)      | -    | 200, one field with the owner's username |
| POST   | `/api/fields`       | logged-in owner        | `{name, sport, location, price_per_hour}` | 201, the new field |
| PUT    | `/api/fields/<id>`  | the owner of the field | same 4 values, all required | 200, the updated field |
| DELETE | `/api/fields/<id>`  | the owner of the field | -    | 200. **409** if the field has bookings |
| GET    | `/api/my/fields`    | logged-in owner        | -    | 200, only the caller's fields |

Every field in a response looks like:
`{id, owner_id, owner_username, name, sport, location, price_per_hour, created_at}`.

**Input rules (400 otherwise, the message names the bad value):**
`name`, `sport` and `location` must be text, are trimmed, and must be
1-100 characters. `price_per_hour` must be a number greater than 0.
The `<id>` in the path must be an integer.

**Why 409 on delete?** Deleting a field that has bookings would silently
destroy players' reservations. The server refuses and the owner must deal
with the bookings first. The check and the delete are one SQL statement, so a
booking cannot be created between them.

### 401 vs 403 vs 404, in simple words

The server checks these in this order:

1. **401 Unauthorized: "Who are you?"** No token, or a token we do not
   know. Logging in fixes it.
2. **404 Not Found: "That field does not exist."** Checked before
   ownership, so a missing field always gives 404, never 403.
3. **403 Forbidden: "I know who you are, but you are not allowed."** You
   are logged in, but you are a player trying to create a field, or an owner
   trying to edit/delete someone else's field. Logging in again does not fix
   it.

Example: owner B sends `DELETE /api/fields/1`, which belongs to owner A.
B's token is valid (not 401), field 1 exists (not 404), but B is not its
owner -> **403**.

## Bookings

Players book time slots on fields. A slot can never be booked twice.

| Method | Path                                    | Who                     | Success |
|--------|-----------------------------------------|-------------------------|---------|
| POST   | `/api/bookings`                         | logged-in player        | 201, the booking. Body: `{field_id, date, start_hour, end_hour}` |
| GET    | `/api/my/bookings`                      | logged-in player        | 200, the caller's bookings with field name and location, sorted by date then hour |
| GET    | `/api/fields/<id>/bookings?date=YYYY-MM-DD` | anyone (no login)   | 200, the booked slots of that field on that day. The field's owner also sees who booked each slot |
| DELETE | `/api/bookings/<id>`                    | the player who booked   | 200, booking cancelled |

Every booking in a response contains `id, field_id, field_name,
field_location, player_id, player_username, date, start_hour, end_hour,
total_price, created_at`, where
`total_price = (end_hour - start_hour) * price_per_hour`.

**Input rules (400 otherwise, the message names the bad value):**
- `date`: a real date written exactly `YYYY-MM-DD` (`2026-02-30` and
  `2026-1-5` are refused), today or later by the server's clock.
- `start_hour` and `end_hour`: whole numbers (whole hours only),
  `0 <= start_hour < end_hour <= 24`. Example: 22 to 24 means 22:00 to midnight.
- `field_id`: a positive whole number.

**Status codes for `POST /api/bookings`, in the order they are checked:**
401 not logged in -> 403 logged in as an owner -> 400 bad input ->
404 field does not exist -> 409 slot already taken (the message says which
slot, e.g. "already booked on 2026-11-21 from 10:00 to 12:00").
For cancelling: 401 -> 404 no such booking -> 403 someone else's booking.
Deleting a field that has bookings is refused with 409 (see Fields).

### The overlap rule

Two bookings on the same field and the same date overlap when

    new.start < existing.end  AND  new.end > existing.start

In words: each one starts before the other one ends. With 10-12 already
booked:

| New slot | Overlaps? | Why |
|----------|-----------|-----|
| 11-13    | yes (409) | 11 < 12 and 13 > 10 |
| 9-11     | yes (409) | 9 < 12 and 11 > 10 |
| 8-14     | yes (409) | covers the whole 10-12 slot |
| 12-14    | no (201)  | 12 < 12 is false: back-to-back is allowed |
| 8-10     | no (201)  | 10 > 10 is false: back-to-back is allowed |

### Why the transaction prevents double booking

Booking is two steps: (1) check that the slot is free, (2) insert the
booking. Imagine two players, on two different machines, clicking "book
10-12" at the same moment. Without protection this can happen:

    Player A: check -> free
    Player B: check -> free      (A has not inserted yet)
    Player A: insert -> booked
    Player B: insert -> booked   (double booking!)

To prevent this, `create_booking` starts with `BEGIN IMMEDIATE`. That takes
the database's write lock before the check. Only one request can hold this
lock at a time, so the second request waits at `BEGIN IMMEDIATE` until the
first one has inserted and committed. Then the second request's check sees
the first booking and gets 409:

    Player A: BEGIN IMMEDIATE (gets the lock) -> check -> free -> insert -> COMMIT
    Player B: BEGIN IMMEDIATE (waits...)      -> check -> taken -> 409

The check and the insert act as one step that nobody can cut into. This
works because both requests go to the same SQLite database. The server
handles each request in its own thread, so the two requests really do run
at the same time.

We tested it: 10 threads booking the same slot at the same instant gave
exactly one 201 and nine 409s, every time. When we removed the transaction
and added a small delay between the check and the insert, the same slot was
booked twice. Run `python tests/race_proof.py` to see this yourself (it uses
a temporary database, not `app.db`).

## Known limitations (for later stages)

- Plain HTTP: anyone on the network can read passwords and tokens (we want
  this for the Wireshark captures; HTTPS would fix it).
- Tokens never expire on their own; they only end at logout.
- No limit on login attempts.
- `total_price` is computed from the field's current price, so if an owner
  changes the price, existing bookings show the new total (the `bookings`
  table has no price column).
- A booking for today is accepted even if its hours have already passed
  (only the date is checked).
