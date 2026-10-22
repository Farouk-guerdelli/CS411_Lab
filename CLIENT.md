# Web client: how it works

Start the server with `python server.py`, then open `http://<server-IP>:8000/`
in a browser (`http://localhost:8000/` on the server machine itself).
Stop the server with Ctrl+C.

The client is plain HTML, CSS and JavaScript: no framework, no build step, no
CDN and no web fonts (the client VMs may have no internet access, so the page
uses the system's own fonts). The same Python server sends both the page and
the API answers.

## Files

| File | What it contains |
|------|------------------|
| `static/index.html` | Every screen as a `<section class="view">`, the three dialogs (log in / sign up, add / edit field, confirmation), the toast area and the "Network activity" drawer. |
| `static/css/style.css` | Design tokens (colors, spacing scale, radius), components (buttons, cards, chips, badges), the slot grid, the timeline, the drawer, and the rules for narrow screens. |
| `static/js/api.js` | Everything that talks to the server: the session (token in `sessionStorage`), `api()`, the only function that calls `fetch()`, the "Network activity" drawer and the "server unreachable" banner. |
| `static/js/app.js` | Screens and UI logic: the router, toasts, dialogs, and one section per screen. |
| `static/favicon.svg` | The icon in the browser tab. |

`index.html` loads `api.js` first, then `app.js`. They are plain scripts that
share global functions, so there is nothing to compile.

## How the page is served

`GET /` returns `static/index.html`. The browser then asks for
`/css/style.css`, `/js/api.js`, `/js/app.js` and `/favicon.svg`. The server
looks for these files in `static/` and its sub-folders and sends each one with
the right `Content-Type` (`text/html`, `text/css`, `text/javascript`,
`image/svg+xml`). An unknown file, or a folder like `/css/`, gives 404.

Paths that try to leave `static/` also give 404, for example
`/../server.py`, `/css/../../server.py` or `/js/..%2F..%2Fapp.db`. The server
decodes the path, resolves the real absolute path and refuses anything outside
the folder.

Because the page and the API come from the same server (same origin), the
JavaScript uses relative URLs like `/api/fields`. No server address has to be
typed, and the browser does not need CORS for these requests.

## Screens

There is one HTML page. The part of the address after `#` says which screen
to show, and `route()` in `app.js` shows that `<section>` and loads its data.
The browser's Back button works between screens.

| Address | Screen | Requests |
|---------|--------|----------|
| `#/fields` | **Browse fields**: search box, sport chips, grid of field cards | `GET /api/fields` (+ `?sport=...` when a chip is selected) |
| `#/fields/<id>` | **Field page**: details, date picker, hourly slot grid, "Your booking" summary | `GET /api/fields/<id>`, `GET /api/fields/<id>/bookings?date=...`, `POST /api/bookings` |
| `#/my-bookings` | **My bookings** (players): Upcoming and Past cards, Cancel | `GET /api/my/bookings`, `DELETE /api/bookings/<id>` |
| `#/my-fields` | **My fields** (owners): field cards with Edit / Delete, Add field, "Bookings by day" timeline | `GET /api/my/fields`, `POST`/`PUT`/`DELETE /api/fields...`, `GET /api/fields/<id>/bookings?date=...` |

The top bar shows "Browse fields" to everyone, "My bookings" to players and
"My fields" to owners. On the right it shows the user with a role badge and
a Log out button, or "Log in" and "Sign up" for guests.

The client does not hide the private screens with its own checks. If a guest
types `#/my-bookings`, the request is still sent, the server answers 401 and
the login dialog opens. An owner who opens `#/my-bookings` sees the server's
403.

**Log in / Sign up** is one dialog with two tabs. In Sign up the role is
chosen with two large cards ("Player - I want to book fields", "Owner - I
want to list my fields"), which are real radio buttons. After a successful
sign up, the client logs in automatically with the same username and
password.

**Field page.** The grid shows one button per hour from 08:00 to 23:00. The
range is widened if a booking falls outside it. Booked hours are disabled,
striped and labeled "Booked". The field's owner sees "Booked by <player>",
because the server adds the username only for the owner. To select, click a
start hour, then an end hour. The summary shows for example
`2 hours × 120.00 = 240.00` and the Book button.

**Owner timeline.** For the chosen field and date, each booking is a block
spanning its hours (a CSS grid with one row per hour) with the player's
username.

## The server decides: hints never block a request

The rule we follow: **the client never refuses to send a request because the
input looks wrong.** The server is the source of truth, and we want its real
400/401/403/409 answers on screen and in Wireshark.

- Forms have `novalidate` and no `required` attributes, so the browser never
  blocks them either.
- The Book button is never disabled because of the input. Hints under the
  summary explain the problem ("You are not logged in", "Only players can
  book fields", "Your selection includes an hour that is already booked",
  "This date is in the past"), but pressing Book always sends
  `POST /api/bookings`.
- Selecting across booked hours is allowed: those hours are outlined in red,
  and the server answers 409.
- Sign up without choosing a role sends the request without `role`, and the
  server answers 400.
- Buttons are disabled only *while their own request is in progress*, to
  avoid double clicks. They show a spinner at that time.

**Guest booking.** A guest who presses Book sends `POST /api/bookings`
without a token. The server answers 401, the page shows that message (toast
and red box under the summary) and the login dialog opens. Nothing is saved.
After logging in, the guest is back on the same field with the same date and
hours selected, and can press Book again. The success message is shown only
for a 201 answer, so nothing suggests success for a guest.

## Feedback

- **Toasts** (top right, bottom on narrow screens) show the status code and
  the server's own message, e.g.
  `409 Conflict - Field 3 is already booked on 2026-11-21 from 10:00 to 12:00.`
  Their color follows the status code. They are shown in the browser's
  top layer (Popover API), so an open dialog never hides them.
- **Form errors.** An error caused by a form is also shown in a red box next
  to that form (login, sign up, field dialog, booking summary).
- **Loading and empty states**: "Loading...", "No fields yet",
  "No bookings yet", "No matching fields". If a screen cannot be loaded, its
  error state shows the status code and message.
- **Server unreachable:** `fetch()` throws only when there is no HTTP answer
  at all. Then a red banner says "Cannot reach the server" with a Retry
  button. It disappears as soon as a request gets an answer.
- **401 with a token** (expired or deleted session): the client forgets the
  token, the top bar goes back to "Log in" / "Sign up", and the login dialog
  opens with "Your session is no longer valid". Log out never opens the dialog, even if the
  server answers 401.

## How the client talks to the API

Every request goes through one function, `api(method, path, body)` in
`api.js`. It:

1. adds `Authorization: Bearer <token>` if the user is logged in,
2. sends the body as JSON (`Content-Type: application/json`),
3. calls `fetch()` and measures how long the answer takes,
4. adds the request to the "Network activity" drawer,
5. returns `{status, statusText, data}` for 2xx, or throws an `ApiError`
   with the status code and the server's `error` message.

User actions go through `runAction(button, errorBox, action)` in `app.js`. It
shows the spinner on the button, and if the action throws, it calls
`reportError()`, which shows the toast, fills the form's error box and, for
a 401, opens the login dialog. Nothing fails silently.

## The "Network activity" drawer

The bar at the bottom of the page shows the number of API requests and the
latest one, for example `POST /api/bookings 409 Conflict`. Clicking it opens
the drawer with the **last 10 requests, newest first**. Each row has the
time, method, path, a colored status badge (2xx green, 4xx orange, 5xx red,
no response gray) and the duration in ms.

Clicking a row shows:
- whether a token was sent (`Authorization: Bearer 8c827fba... (token sent)`
  or `none`), which explains 401 answers,
- the request body and the response body, pretty-printed as JSON.

**Passwords are never shown:** before a request is added to the drawer, every
`password` value in its body is replaced by `"********"`
(`hidePasswords()` in `api.js`). The real password is still sent to the
server, and is visible in Wireshark because we use plain HTTP.

## Login and the token

1. Login sends `POST /api/login`, gets the token, then calls `GET /api/me`
   to learn the username and role.
2. Token and user are saved in **sessionStorage**. Unlike localStorage,
   sessionStorage is separate for each browser tab, so one tab can be logged
   in as an owner and another as a player at the same time.
3. Reloading the page keeps the login. On load, the client checks the token
   with `GET /api/me`. A 401 there logs out and opens the login dialog.
4. Log out sends `POST /api/logout` and forgets the token in this tab, even
   if the server cannot be reached.

## Design and accessibility

- Light theme, one accent color (deep pitch green `#136f3f`), neutral grays,
  a spacing scale of 4/8/12/16/24/32/48 px and rounded cards. All are
  defined as CSS variables at the top of `style.css`.
- Responsive. Field cards use `repeat(auto-fill, minmax(270px, 1fr))`. On
  narrow windows:
  - the slot grid and the summary stack;
  - the top bar wraps;
  - the drawer hides its time column.
- Real `<button>`, `<a>`, `<label>` and radio elements are used everywhere,
  and the dialogs are native `<dialog>` elements (focus stays inside, Esc
  closes them).
- Keyboard focus is always visible (`:focus-visible` outline), there is a
  "Skip to content" link, and the text colors have at least 4.5:1 contrast.
- **Server data is displayed with `textContent`, never `innerHTML`.** A field
  named `<img src=x onerror=alert(1)>` is shown as text and cannot run code
  in other users' browsers (no XSS).
