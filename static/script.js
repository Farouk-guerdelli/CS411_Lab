// Web client for the field booking API.
//
// The page is served by the same Python server as the API, so every request
// uses a relative URL like "/api/fields" (same origin, no server URL needed).
//
// Organization of this file:
//   1. Session      - token and user saved in sessionStorage
//   2. Messages     - red/green message box, "Last request" panel
//   3. api()        - the ONLY function that calls fetch()
//   4. DOM helpers  - build elements safely with textContent
//   5. Screens      - show/hide sections for the logged-in role
//   6. Features     - auth, fields, player bookings, owner fields
//   7. Startup      - connect buttons to functions, load the first data
//
// Security note: data from the server (field names, usernames...) is always
// put in the page with textContent, never innerHTML, so a field named
// "<script>..." is shown as text and cannot run code in someone's browser.

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

function getUser() {
  const saved = sessionStorage.getItem(USER_KEY);
  return saved ? JSON.parse(saved) : null;
}

function saveSession(token, user) {
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
}

// Forget the login in this tab only (does not call the server).
function logoutLocally() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
  updateView();
}

// ===================================================================
// 2. Messages
// ===================================================================

const messageBox = document.getElementById("message");

function showError(text) {
  messageBox.textContent = text;
  messageBox.className = "message error";
  messageBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function showSuccess(text) {
  messageBox.textContent = text;
  messageBox.className = "message success";
}

function hideMessage() {
  messageBox.className = "message hidden";
}

// The panel at the bottom lists the last API calls (method, URL, HTTP
// status), newest first. We keep a few, not only one, because an action is
// often followed by reloads: "POST /api/bookings -> 201" would otherwise be
// replaced at once by "GET /api/my/bookings -> 200".
const SHOWN_REQUESTS = 4;
const recentRequests = [];

// status is null when the server could not be reached.
function showLastRequest(method, url, status, statusText) {
  let text = "no response (server unreachable)";
  let kind = "status-error";
  if (status !== null) {
    text = status + " " + statusText;
    if (status < 300) kind = "status-ok";
    else if (status < 500) kind = "status-warn";
  }
  recentRequests.unshift({ request: method + " " + url, text: text, kind: kind });
  recentRequests.length = Math.min(recentRequests.length, SHOWN_REQUESTS);

  const panel = document.getElementById("lastRequest");
  panel.textContent = "";
  recentRequests.forEach((entry, index) => {
    const line = el("div", undefined, index === 0 ? "newest" : "older");
    line.appendChild(el("span", index === 0 ? "Last request: " : "before: ", "muted"));
    line.appendChild(el("code", entry.request));
    line.appendChild(document.createTextNode("  →  "));
    line.appendChild(el("strong", entry.text, entry.kind));
    panel.appendChild(line);
  });
}

// ===================================================================
// 3. api(): every call to the server goes through here
// ===================================================================

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status; // HTTP status code, 0 if the server is unreachable
  }
}

// Sends a request and returns the parsed JSON response.
// Throws ApiError with the server's error message if the status is not 2xx.
async function api(method, url, body) {
  const options = { method: method, headers: {} };
  const token = getToken();
  if (token) {
    options.headers["Authorization"] = "Bearer " + token;
  }
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, options);
  } catch (networkError) {
    // fetch only throws when there is no HTTP response at all.
    showLastRequest(method, url, null);
    throw new ApiError("Cannot reach the server. Check that it is running and that this machine can reach it on the network.", 0);
  }
  showLastRequest(method, url, response.status, response.statusText);

  let data = null;
  try {
    data = await response.json();
  } catch (notJson) {
    // Body is not JSON: data stays null, handled below.
  }

  if (response.ok) {
    return data;
  }

  const serverMessage = (data && data.error) || "Request failed.";
  if (response.status === 401 && token) {
    // We sent a token but the server no longer accepts it (logged out
    // elsewhere, or the session was deleted): forget it and ask to log in.
    logoutLocally();
    throw new ApiError(serverMessage + " Please log in again.", 401);
  }
  throw new ApiError(serverMessage, response.status);
}

// Runs an async action and shows any error in the red message box,
// so nothing ever fails silently.
async function run(action) {
  try {
    await action();
  } catch (error) {
    showErrorFor(error);
  }
}

// "Error 409: Field 3 is already booked ..." (status 0 = no response).
function showErrorFor(error) {
  if (error instanceof ApiError && error.status > 0) {
    showError("Error " + error.status + ": " + error.message);
  } else {
    showError(error.message);
  }
}

// ===================================================================
// 4. DOM helpers
// ===================================================================

// Creates an element with text content (safe: text is never parsed as HTML).
function el(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function makeButton(text, onClick, className) {
  const button = el("button", text, className);
  button.type = "button";
  button.addEventListener("click", () => run(onClick));
  return button;
}

// Adds a table row: cells is a list of texts, buttons a list of <button>.
function addRow(tbody, cells, buttons) {
  const row = document.createElement("tr");
  for (const cell of cells) {
    row.appendChild(el("td", cell));
  }
  const actions = el("td", undefined, "actions");
  for (const button of buttons || []) {
    actions.appendChild(button);
  }
  row.appendChild(actions);
  tbody.appendChild(row);
}

function showEmptyRow(tbody, columns, text) {
  const row = document.createElement("tr");
  const cell = el("td", text, "muted");
  cell.colSpan = columns;
  row.appendChild(cell);
  tbody.appendChild(row);
}

// Fills a <select> with fields, keeping the current choice if possible.
function fillFieldSelect(select, fields) {
  const previous = select.value;
  select.textContent = "";
  for (const field of fields) {
    const option = el("option", field.name + " (" + field.sport + ", " + field.location + ")");
    option.value = field.id;
    select.appendChild(option);
  }
  if (fields.some((field) => String(field.id) === previous)) {
    select.value = previous;
  }
}

function formatHour(hour) {
  return String(hour).padStart(2, "0") + ":00";
}

function formatPrice(price) {
  return Number(price).toFixed(2);
}

// Today's date as YYYY-MM-DD in the local time zone.
function todayText() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return now.getFullYear() + "-" + month + "-" + day;
}

// Empty input -> null, so the server answers with a clear 400 message.
function numberOrNull(text) {
  return text.trim() === "" ? null : Number(text);
}

// ===================================================================
// 5. Screens
// ===================================================================

function setVisible(id, visible) {
  document.getElementById(id).classList.toggle("hidden", !visible);
}

// Shows the sections that match the logged-in user's role.
function updateView() {
  const user = getUser();
  setVisible("authSection", user === null);
  setVisible("userBar", user !== null);
  setVisible("playerSection", user !== null && user.role === "player");
  setVisible("ownerSection", user !== null && user.role === "owner");
  if (user) {
    document.getElementById("userName").textContent = user.username;
    document.getElementById("userRole").textContent = user.role;
  }
}

// Loads the data needed by the current screen.
async function loadScreen() {
  updateView();
  await loadFields();
  const user = getUser();
  if (user && user.role === "player") {
    await loadMyBookings();
  }
  if (user && user.role === "owner") {
    await loadMyFields();
  }
}

// ===================================================================
// 6a. Login, register, logout
// ===================================================================

async function login() {
  const username = document.getElementById("loginUsername").value;
  const password = document.getElementById("loginPassword").value;
  const result = await api("POST", "/api/login", { username: username, password: password });

  // The login response only contains the token; ask who we are.
  sessionStorage.setItem(TOKEN_KEY, result.token);
  let me;
  try {
    me = await api("GET", "/api/me");
  } catch (error) {
    logoutLocally(); // do not keep a token without its user
    throw error;
  }
  saveSession(result.token, me.user);

  document.getElementById("loginPassword").value = "";
  showSuccess("Welcome, " + me.user.username + "!");
  await loadScreen();
}

async function register() {
  const username = document.getElementById("registerUsername").value;
  const password = document.getElementById("registerPassword").value;
  const role = document.getElementById("registerRole").value;
  await api("POST", "/api/register", { username: username, password: password, role: role });

  document.getElementById("registerPassword").value = "";
  document.getElementById("loginUsername").value = username;
  document.getElementById("loginPassword").focus();
  showSuccess("Account created. You can now log in as " + username + ".");
}

async function logout() {
  try {
    await api("POST", "/api/logout");
    showSuccess("You are logged out.");
  } finally {
    // Even if the server cannot be reached, forget the token in this tab.
    logoutLocally();
  }
}

// ===================================================================
// 6b. Fields (everyone)
// ===================================================================

async function loadFields() {
  const sport = document.getElementById("sportFilter").value.trim();
  let url = "/api/fields";
  if (sport) {
    url += "?sport=" + encodeURIComponent(sport);
  }
  const result = await api("GET", url);

  const user = getUser();
  const tbody = document.getElementById("fieldsTable");
  tbody.textContent = "";
  for (const field of result.fields) {
    const buttons = [];
    if (user && user.role === "player") {
      buttons.push(makeButton("Book", () => chooseFieldToBook(field)));
    }
    addRow(tbody, [field.name, field.sport, field.location,
                   formatPrice(field.price_per_hour), field.owner_username], buttons);
  }
  if (result.fields.length === 0) {
    showEmptyRow(tbody, 6, "No fields found.");
  }

  // The player's "Book a slot" list always offers all fields, not only the
  // filtered ones, so it needs its own request when a filter is active.
  if (user && user.role === "player") {
    const all = sport ? (await api("GET", "/api/fields")).fields : result.fields;
    fillFieldSelect(document.getElementById("bookField"), all);
  }
}

// ===================================================================
// 6c. Player: book a slot, my bookings
// ===================================================================

// "Book" button in the fields list: select that field in the booking form.
async function chooseFieldToBook(field) {
  document.getElementById("bookField").value = field.id;
  document.getElementById("playerSection").scrollIntoView({ behavior: "smooth" });
  await loadBookedSlots();
}

// Shows the booked slots of the chosen field and date (availability).
async function loadBookedSlots() {
  const fieldId = document.getElementById("bookField").value;
  const date = document.getElementById("bookDate").value;
  const list = document.getElementById("bookedSlots");
  if (!fieldId) {
    throw new Error("There are no fields to book yet.");
  }
  const result = await api("GET", "/api/fields/" + fieldId + "/bookings?date=" + encodeURIComponent(date));

  list.textContent = "";
  for (const slot of result.booked_slots) {
    list.appendChild(el("li", formatHour(slot.start_hour) + " - " + formatHour(slot.end_hour), "taken"));
  }
  if (result.booked_slots.length === 0) {
    list.appendChild(el("li", "Nothing booked yet: every hour is free.", "muted"));
  }
}

async function book() {
  const fieldId = document.getElementById("bookField").value;
  const body = {
    field_id: fieldId ? Number(fieldId) : null,
    date: document.getElementById("bookDate").value,
    start_hour: Number(document.getElementById("bookStart").value),
    end_hour: Number(document.getElementById("bookEnd").value),
  };
  const result = await api("POST", "/api/bookings", body);
  const booking = result.booking;
  showSuccess("Booked " + booking.field_name + " on " + booking.date + " from " +
              formatHour(booking.start_hour) + " to " + formatHour(booking.end_hour) +
              ". Total: " + formatPrice(booking.total_price) + ".");
  await loadBookedSlots();
  await loadMyBookings();
}

async function loadMyBookings() {
  const result = await api("GET", "/api/my/bookings");
  const tbody = document.getElementById("myBookingsTable");
  tbody.textContent = "";
  for (const booking of result.bookings) {
    addRow(tbody, [
      booking.date,
      formatHour(booking.start_hour) + " - " + formatHour(booking.end_hour),
      booking.field_name,
      booking.field_location,
      formatPrice(booking.total_price),
    ], [makeButton("Cancel", () => cancelBooking(booking), "danger")]);
  }
  if (result.bookings.length === 0) {
    showEmptyRow(tbody, 6, "You have no bookings yet.");
  }
}

async function cancelBooking(booking) {
  const question = "Cancel your booking of " + booking.field_name + " on " + booking.date + "?";
  if (!confirm(question)) return;
  await api("DELETE", "/api/bookings/" + booking.id);
  showSuccess("Booking cancelled.");
  await loadMyBookings();
}

// ===================================================================
// 6d. Owner: my fields, add/edit/delete, bookings of a field
// ===================================================================

async function loadMyFields() {
  const result = await api("GET", "/api/my/fields");
  const tbody = document.getElementById("myFieldsTable");
  tbody.textContent = "";
  for (const field of result.fields) {
    addRow(tbody, [field.name, field.sport, field.location, formatPrice(field.price_per_hour)], [
      makeButton("Edit", () => startEditField(field), "secondary"),
      makeButton("Bookings", () => chooseFieldBookings(field), "secondary"),
      makeButton("Delete", () => deleteField(field), "danger"),
    ]);
  }
  if (result.fields.length === 0) {
    showEmptyRow(tbody, 5, "You have no fields yet. Add one below.");
  }
  fillFieldSelect(document.getElementById("ownerBookingsField"), result.fields);
}

// The field form adds a field when fieldId is empty, and edits one otherwise.
async function submitFieldForm() {
  const fieldId = document.getElementById("fieldId").value;
  const body = {
    name: document.getElementById("fieldName").value,
    sport: document.getElementById("fieldSport").value,
    location: document.getElementById("fieldLocation").value,
    price_per_hour: numberOrNull(document.getElementById("fieldPrice").value),
  };
  if (fieldId) {
    await api("PUT", "/api/fields/" + fieldId, body);
    showSuccess("Field updated.");
  } else {
    await api("POST", "/api/fields", body);
    showSuccess("Field added.");
  }
  resetFieldForm();
  await loadMyFields();
  await loadFields();
}

function startEditField(field) {
  document.getElementById("fieldId").value = field.id;
  document.getElementById("fieldName").value = field.name;
  document.getElementById("fieldSport").value = field.sport;
  document.getElementById("fieldLocation").value = field.location;
  document.getElementById("fieldPrice").value = field.price_per_hour;
  document.getElementById("fieldFormTitle").textContent = "Edit field: " + field.name;
  document.getElementById("fieldSubmitBtn").textContent = "Save changes";
  setVisible("cancelEditBtn", true);
  document.getElementById("fieldForm").scrollIntoView({ behavior: "smooth" });
}

function resetFieldForm() {
  document.getElementById("fieldForm").reset();
  document.getElementById("fieldId").value = "";
  document.getElementById("fieldFormTitle").textContent = "Add a field";
  document.getElementById("fieldSubmitBtn").textContent = "Add field";
  setVisible("cancelEditBtn", false);
}

async function deleteField(field) {
  if (!confirm("Delete the field " + field.name + "?")) return;
  // The server refuses with 409 if the field has bookings; run() shows it.
  await api("DELETE", "/api/fields/" + field.id);
  showSuccess("Field deleted.");
  if (document.getElementById("fieldId").value === String(field.id)) {
    resetFieldForm();
  }
  await loadMyFields();
  await loadFields();
}

async function chooseFieldBookings(field) {
  document.getElementById("ownerBookingsField").value = field.id;
  await loadOwnerBookings();
}

// The owner sees who booked each slot (the server adds player_username
// because our token belongs to the field's owner).
async function loadOwnerBookings() {
  const fieldId = document.getElementById("ownerBookingsField").value;
  const date = document.getElementById("ownerBookingsDate").value;
  const list = document.getElementById("ownerBookings");
  if (!fieldId) {
    throw new Error("You have no fields yet.");
  }
  const result = await api("GET", "/api/fields/" + fieldId + "/bookings?date=" + encodeURIComponent(date));

  list.textContent = "";
  for (const slot of result.booked_slots) {
    const text = formatHour(slot.start_hour) + " - " + formatHour(slot.end_hour) + "  booked by " + slot.player_username;
    list.appendChild(el("li", text, "taken"));
  }
  if (result.booked_slots.length === 0) {
    list.appendChild(el("li", "No bookings on " + result.date + ".", "muted"));
  }
}

// ===================================================================
// 7. Startup
// ===================================================================

// Connects a form's submit (button click or Enter key) to an action.
function onSubmit(formId, action) {
  document.getElementById(formId).addEventListener("submit", (event) => {
    event.preventDefault(); // stay on the page, we send the request with fetch
    run(action);
  });
}

function onClick(buttonId, action) {
  document.getElementById(buttonId).addEventListener("click", () => run(action));
}

function fillHourSelect(select, first, last, selected) {
  for (let hour = first; hour <= last; hour++) {
    const option = el("option", formatHour(hour));
    option.value = hour;
    select.appendChild(option);
  }
  select.value = selected;
}

function setUp() {
  fillHourSelect(document.getElementById("bookStart"), 0, 23, 18);
  fillHourSelect(document.getElementById("bookEnd"), 1, 24, 20);
  for (const id of ["bookDate", "ownerBookingsDate"]) {
    document.getElementById(id).value = todayText();
  }
  // Only a hint for the date picker; the server refuses past dates anyway.
  document.getElementById("bookDate").min = todayText();

  onSubmit("loginForm", login);
  onSubmit("registerForm", register);
  onClick("logoutBtn", logout);
  onSubmit("filterForm", loadFields);
  onClick("clearFilterBtn", () => {
    document.getElementById("sportFilter").value = "";
    return loadFields();
  });
  onClick("showSlotsBtn", loadBookedSlots);
  onClick("bookBtn", book);
  onSubmit("fieldForm", submitFieldForm);
  onClick("cancelEditBtn", async () => resetFieldForm());
  onClick("ownerBookingsBtn", loadOwnerBookings);

  // Typing in any input hides the old message.
  document.querySelector("main").addEventListener("input", hideMessage);
}

async function start() {
  setUp();
  // If this tab was already logged in (page reload), check that the token
  // still works. A 401 logs out automatically inside api(); we show the
  // message and still load the public fields list.
  if (getToken()) {
    try {
      const me = await api("GET", "/api/me");
      saveSession(getToken(), me.user);
    } catch (error) {
      showErrorFor(error);
    }
  }
  await run(loadScreen);
}

start();
