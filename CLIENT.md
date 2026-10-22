# Web client: how it works (Stage 4)

Start the server with `python server.py`, then open `http://<server-IP>:8000/`
in a browser (`http://localhost:8000/` on the server machine itself).
Stop the server with Ctrl+C.

The client is plain HTML, CSS and JavaScript: no framework, no build step, no
files loaded from the internet. The same Python server sends both the page
and the API answers.

## Files

| File | What it contains |
|------|------------------|
| `static/index.html` | All screens as `<section>` elements: login/register, fields list, player section, owner section, the message box and the "Last request" panel. |
| `static/script.js`  | All the logic: session, the `api()` function, building tables, one function per action (login, book, add field...). |
| `static/style.css`  | Dark theme, layout, red/green messages, colors of the status codes. |

## How the page is served

`GET /` returns `static/index.html`. The browser then asks for
`/script.js` and `/style.css`. The server looks for these files in `static/`
and sends them with the right `Content-Type` (`text/html`, `text/javascript`,
`text/css`). An unknown file gives 404. Paths that try to leave `static/`
(like `/../server.py` or `/..%2Fapp.db`) also give 404: the server resolves
the real path and refuses anything outside the folder.

Because the page and the API come from the same server (same origin), the
JavaScript uses relative URLs like `/api/fields`. No server address has to be
typed, and the browser does not need CORS for these requests.

## One page, several screens

There is only one HTML page. `updateView()` shows or hides sections depending
on who is logged in:

| Logged in as | Visible sections |
|--------------|------------------|
| nobody       | Login + Register, Fields list |
| player       | Fields list (with a Book button), Book a slot, My bookings |
| owner        | Fields list, My fields, Add/Edit field form, Bookings of my field |

## How the client talks to the API

Every request goes through one function, `api(method, url, body)` in
`script.js`. It:

1. adds `Authorization: Bearer <token>` if the user is logged in,
2. sends the body as JSON (`Content-Type: application/json`),
3. calls `fetch()`,
4. writes the method, URL and status code in the "Last request" panel,
5. returns the JSON on success (2xx), or throws an error containing the
   server's `error` message.

Each button calls its action through `run(action)`, which catches any error
and shows it in the red message box, e.g.
`Error 409: Field 3 is already booked on 2026-11-21 from 10:00 to 12:00.`
Nothing fails silently.

Special cases handled in `api()`:
- **Server unreachable:** `fetch()` throws (no HTTP answer at all). The
  message says "Cannot reach the server..." and the panel says "no response".
- **401 while logged in:** the token is no longer valid (logged out
  elsewhere, session deleted). The client forgets the token, shows the login
  screen and asks the user to log in again.

## Login and the token

1. Login sends `POST /api/login`, gets the token, then calls `GET /api/me`
   to learn the username and role.
2. Token and user are saved in **sessionStorage**. Unlike localStorage,
   sessionStorage is separate for each browser tab, so one tab can be logged
   in as an owner and another as a player at the same time.
3. Reloading the page keeps the login. On load, the client checks the token
   with `GET /api/me` (a 401 there logs out automatically).
4. Logout sends `POST /api/logout` and forgets the token in this tab, even if
   the server cannot be reached.

## The "Last request" panel

The bar at the bottom shows the last 4 API calls, newest first, for example
`POST /api/bookings → 409 Conflict`. Green = 2xx, orange = 4xx, red = 5xx or
no response. We keep 4 lines, not 1, because an action is often followed by
reloads (after booking, the client reloads the slots and "My bookings"), which
would otherwise hide the interesting status code at once.

## Design choices worth knowing for the jury

- **Server data is displayed with `textContent`, never `innerHTML`.** A field
  named `<img src=x onerror=alert(1)>` is shown as text and cannot run code
  in other users' browsers (no XSS).
- **No `required` attributes on the forms.** The server does all the
  validation; the client shows its 400 messages. This keeps the rules in one
  place and makes the errors visible in the demo.
- **Hours are drop-down lists** (00:00-23:00 for "From", 01:00-24:00 for
  "To"), so only whole hours can be chosen.
- **Delete and Cancel ask for confirmation** with the browser's `confirm()`.
- **The player only sees times in "Already booked"**; the owner sees who
  booked, because the server adds `player_username` only for the field's owner.
