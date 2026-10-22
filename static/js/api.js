// api.js - everything that talks to the server.
//
// Loaded before app.js. It contains:
//   1. Session         - token and user saved in sessionStorage
//   2. api()           - the ONLY function in the client that calls fetch()
//   3. Network panel   - the "Network activity" drawer at the bottom of the
//                        page, listing the last API requests (for the demo)
//   4. Offline banner  - shown when a request gets no HTTP answer at all
//
// The page and the API come from the same server, so every request uses a
// relative URL like "/api/fields": no server address has to be typed.

// ===================================================================
// 1. Session
// ===================================================================

// sessionStorage is separate for each browser tab, so two tabs can be
// logged in as two different users (handy for the demo).
const TOKEN_KEY = "token";
const USER_KEY = "user";

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

// The logged-in user {id, username, role}, or null for a guest.
function getUser() {
  const saved = sessionStorage.getItem(USER_KEY);
  return saved ? JSON.parse(saved) : null;
}

function saveSession(token, user) {
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
}

// Forgets the login in this tab only (does not call the server).
function clearSession() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
}

// ===================================================================
// 2. api(): every call to the server goes through here
// ===================================================================

// Thrown by api() when the answer is not 2xx, or when there is no answer.
class ApiError extends Error {
  constructor(status, statusText, message) {
    super(message);
    this.status = status;          // HTTP status code, 0 = no response
    this.statusText = statusText;  // "Conflict", "Unauthorized"...
  }
}

// Sends a request and returns {status, statusText, data}, where data is the
// parsed JSON answer. Throws ApiError with the server's "error" message if
// the status is not 2xx. The client never checks the input itself: the
// request is always sent and the server decides.
async function api(method, path, body) {
  const options = { method: method, headers: {} };
  const token = getToken();
  if (token) {
    options.headers["Authorization"] = "Bearer " + token;
  }
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  // What the network panel will show about this request.
  const entry = {
    time: new Date(),
    method: method,
    path: path,
    token: token,
    requestBody: hidePasswords(body),
    status: 0,
    statusText: "No response",
    responseBody: undefined,
    duration: 0,
  };
  const startedAt = performance.now();

  let response;
  let text;
  try {
    response = await fetch(path, options);
    text = await response.text();
  } catch (networkError) {
    // fetch only throws when there is no HTTP answer at all
    // (server stopped, wrong network, connection refused...).
    entry.duration = Math.round(performance.now() - startedAt);
    addNetworkEntry(entry);
    setServerReachable(false);
    throw new ApiError(0, "No response",
      "Cannot reach the server. Check that it is running and that this computer is on the same network.");
  }
  entry.duration = Math.round(performance.now() - startedAt);
  setServerReachable(true);

  // Every answer of our API is JSON; keep the raw text if it is not.
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (notJson) {
    data = null;
  }
  entry.status = response.status;
  entry.statusText = response.statusText;
  entry.responseBody = data !== null ? data : text;
  addNetworkEntry(entry);

  if (!response.ok) {
    const message = (data && data.error) || "Request failed.";
    throw new ApiError(response.status, response.statusText, message);
  }
  return { status: response.status, statusText: response.statusText, data: data };
}

// "409 Conflict". Without a status code (no response, or an error inside
// the page) only the text is shown: "No response".
function statusLine(status, statusText) {
  return status > 0 ? status + " " + statusText : statusText;
}

// Color group of a status code, used for badges and toasts:
// 2xx "ok" (green), 4xx "warn" (orange), 5xx "error" (red), none "none" (gray).
function statusKind(status) {
  if (status >= 200 && status < 300) return "ok";
  if (status >= 400 && status < 500) return "warn";
  if (status >= 500) return "error";
  return "none";
}

// A copy of the request body where every "password" value is replaced by
// "********", so a password is never displayed on screen.
function hidePasswords(body) {
  if (body === null || typeof body !== "object") return body;
  const copy = {};
  for (const key of Object.keys(body)) {
    copy[key] = key === "password" ? "********" : body[key];
  }
  return copy;
}

// ===================================================================
// 3. Network activity panel
// ===================================================================

const MAX_NETWORK_ENTRIES = 10;
let networkRequestCount = 0;

// Opens or closes the drawer.
function setUpNetworkPanel() {
  const toggle = document.getElementById("networkToggle");
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open));
    document.getElementById("networkPanel").hidden = !open;
    document.getElementById("network").classList.toggle("open", open);
  });
}

// Adds one request at the top of the list. Each row is a <details> element:
// clicking it shows the request and response bodies.
function addNetworkEntry(entry) {
  networkRequestCount++;
  const list = document.getElementById("networkList");
  document.getElementById("networkEmpty").hidden = true;

  const row = document.createElement("details");
  row.className = "network-row";

  const summary = document.createElement("summary");
  summary.appendChild(el("span", "net-time", formatClock(entry.time)));
  summary.appendChild(el("span", "net-method method-" + entry.method.toLowerCase(), entry.method));
  summary.appendChild(el("span", "net-path", entry.path));
  summary.appendChild(makeStatusBadge(entry.status, entry.statusText));
  summary.appendChild(el("span", "net-duration", entry.duration + " ms"));
  row.appendChild(summary);

  const body = el("div", "net-body");
  const authText = entry.token
    ? "Authorization: Bearer " + entry.token.slice(0, 8) + "... (token sent)"
    : "Authorization: none (no token sent)";
  body.appendChild(el("p", "net-auth", authText));
  body.appendChild(makeBodyBlock("Request body", entry.requestBody, "(no body)"));
  body.appendChild(makeBodyBlock("Response body", entry.responseBody,
    entry.status === 0 ? "(no response: the server could not be reached)" : "(empty)"));
  row.appendChild(body);

  // Newest first; keep only the last MAX_NETWORK_ENTRIES rows.
  list.prepend(row);
  while (list.children.length > MAX_NETWORK_ENTRIES) {
    list.lastElementChild.remove();
  }

  // The bar stays visible when the drawer is closed: it shows the latest request.
  document.getElementById("networkCount").textContent = networkRequestCount;
  const latest = document.getElementById("networkLatest");
  latest.textContent = "";
  latest.appendChild(el("span", "net-method", entry.method));
  latest.appendChild(el("span", "net-path", entry.path));
  latest.appendChild(makeStatusBadge(entry.status, entry.statusText));
}

// A colored badge such as "409 Conflict".
function makeStatusBadge(status, statusText) {
  return el("span", "status-badge status-" + statusKind(status), statusLine(status, statusText));
}

// "Request body" title + the body as pretty-printed JSON.
function makeBodyBlock(title, value, emptyText) {
  const block = el("div", "net-block");
  block.appendChild(el("h4", "", title));
  let text = emptyText;
  if (typeof value === "string" && value !== "") {
    text = value;
  } else if (value !== undefined && value !== null && typeof value === "object") {
    text = JSON.stringify(value, null, 2);
  }
  block.appendChild(el("pre", "", text));
  return block;
}

// Creates an element with plain text (textContent: never parsed as HTML).
// Also used by app.js to build every piece of the page that shows server data.
function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// "14:05:09"
function formatClock(date) {
  return date.toTimeString().slice(0, 8);
}

// ===================================================================
// 4. "Server unreachable" banner
// ===================================================================

function setServerReachable(reachable) {
  document.getElementById("offlineBanner").hidden = reachable;
}
