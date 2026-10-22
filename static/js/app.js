// app.js - screens and user interface of the field booking client.
//
// Loaded after api.js, which provides api(), ApiError, the session
// functions (getToken, getUser, saveSession, clearSession), the network
// activity panel and the small helpers el(), statusLine() and statusKind().
//
// Organization of this file:
//   1. Helpers         - dates, hours, prices
//   2. Feedback        - toasts, form errors, busy buttons, empty/error states
//   3. Dialogs         - confirmation, log in / sign up, add / edit field
//   4. Navigation      - top bar and the router (#/fields, #/my-bookings...)
//   5. Browse fields
//   6. Field page and booking
//   7. My bookings     (players)
//   8. My fields       (owners)
//   9. Account actions - log in, sign up, log out
//  10. Startup
//
// Two rules followed everywhere:
// - Data from the server (field names, usernames...) is put in the page with
//   textContent, never innerHTML, so a field named "<script>..." is shown as
//   text and cannot run code in someone's browser (no XSS).
// - The client never refuses to send a request because the input looks
//   wrong. It shows hints, but the server is the source of truth: its real
//   400/401/403/409 answers are shown on screen and visible in Wireshark.

// ===================================================================
// 1. Helpers
// ===================================================================

function $(id) {
  return document.getElementById(id);
}

// The slot grid and the owner's timeline show 08:00 to 23:00 (widened
// automatically if a booking is outside these hours).
const DAY_START = 8;
const DAY_END = 23;

function formatHour(hour) {
  return String(hour).padStart(2, "0") + ":00";
}

function formatHours(start, end) {
  return formatHour(start) + " - " + formatHour(end);
}

function formatPrice(price) {
  return Number(price).toFixed(2);
}

// plural(2, "hour") -> "2 hours"
function plural(count, word) {
  return count + " " + word + (count === 1 ? "" : "s");
}

// Today's date as YYYY-MM-DD in the local time zone.
function todayText() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return now.getFullYear() + "-" + month + "-" + day;
}

// "2026-11-21" -> Date at local midnight, or null if it is not a date.
function parseDay(text) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text || "");
  return parts ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) : null;
}

// "2026-11-21" -> "Sat 21 Nov 2026"
function formatDate(text) {
  const day = parseDay(text);
  if (day === null) return text || "No date";
  return day.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

// Empty input -> null, so the server answers with a clear 400 message.
function numberOrNull(text) {
  return text.trim() === "" ? null : Number(text);
}

// [first hour, last hour] of a day view: DAY_START-DAY_END, widened so that
// every booking fits.
function dayRange(slots) {
  let first = DAY_START;
  let last = DAY_END;
  for (const slot of slots) {
    first = Math.min(first, slot.start_hour);
    last = Math.max(last, slot.end_hour);
  }
  return [first, last];
}

// <div><dt>label</dt><dd>value</dd></div>, for the <dl> detail lists.
function detail(label, value) {
  const row = el("div");
  row.appendChild(el("dt", "", label));
  row.appendChild(el("dd", "", value));
  return row;
}

function makeButton(text, className, onClick) {
  const button = el("button", className, text);
  button.type = "button";
  button.addEventListener("click", () => onClick(button));
  return button;
}

function makeLink(text, className, href) {
  const link = el("a", className, text);
  link.href = href;
  return link;
}

// ===================================================================
// 2. Feedback: toasts, form errors, busy buttons, states
// ===================================================================

const TOAST_MS = 6000;
const MAX_TOASTS = 4;

// A notification in the top right corner, e.g.
// "409 Conflict - Field 3 is already booked on 2026-11-21 from 10:00 to 12:00."
// Its color follows the status code, like the badges of the network panel.
function showToast(status, statusText, message) {
  const kind = statusKind(status);
  const toast = el("div", "toast toast-" + kind);
  toast.setAttribute("role", kind === "ok" ? "status" : "alert");

  const text = el("p", "toast-text");
  text.appendChild(el("strong", "", statusLine(status, statusText)));
  text.appendChild(document.createTextNode(" - " + message));
  toast.appendChild(text);
  toast.appendChild(makeButton("×", "icon-btn", () => toast.remove()));
  toast.lastChild.setAttribute("aria-label", "Dismiss notification");

  const box = $("toasts");
  box.appendChild(toast);
  while (box.children.length > MAX_TOASTS) {
    box.firstElementChild.remove();
  }
  // The toast box is a "popover": showing it again puts it in the browser's
  // top layer, above an open dialog, so toasts are never hidden by a modal.
  if (box.showPopover) {
    if (box.matches(":popover-open")) box.hidePopover();
    box.showPopover();
  }
  // Errors stay a little longer than successes.
  setTimeout(() => toast.remove(), kind === "ok" ? TOAST_MS : TOAST_MS * 1.5);
}

// Success toast with the server's own message ("Booking created.") and
// optional details added by the client.
function toastSuccess(result, details) {
  const message = result.data.message + (details ? " " + details : "");
  showToast(result.status, result.statusText, message);
}

// Anything thrown that is not an answer of the server is a bug in the page.
function toApiError(error) {
  if (error instanceof ApiError) return error;
  console.error(error);
  return new ApiError(-1, "Error", "Unexpected error in the page: " + error.message);
}

// Every form has one <p class="form-error"> for the errors of its requests.
function showFormError(box, error) {
  box.textContent = statusLine(error.status, error.statusText) + " - " + error.message;
  box.hidden = false;
}

function hideFormError(box) {
  if (box) {
    box.hidden = true;
    box.textContent = "";
  }
}

// Shows an error everywhere it matters: a toast, the form's error box (if
// any), and for 401 the login dialog.
function reportError(error, errorBox) {
  error = toApiError(error);
  if (error.status === 401) {
    handleUnauthorized(); // first, so the toast below is shown above the dialog
  }
  showToast(error.status, error.statusText, error.message);
  if (errorBox) {
    showFormError(errorBox, error);
  }
}

// While a request is in progress, the button is disabled and shows a spinner.
function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle("is-busy", busy);
  if (busy) {
    button.setAttribute("aria-busy", "true");
  } else {
    button.removeAttribute("aria-busy");
  }
}

// Runs an action started by the user. Any error is reported, so nothing
// ever fails silently.
async function runAction(button, errorBox, action) {
  hideFormError(errorBox);
  setBusy(button, true);
  try {
    await action();
  } catch (error) {
    reportError(error, errorBox);
  } finally {
    setBusy(button, false);
  }
}

// Fills a container with a friendly message instead of content.
// kind: "loading", "empty" or "error". action: optional button or link.
function showState(container, kind, title, text, action) {
  container.textContent = "";
  container.hidden = false;
  const box = el("div", "state state-" + kind);
  if (kind === "loading") {
    box.appendChild(el("span", "spinner"));
    box.setAttribute("aria-busy", "true");
  }
  box.appendChild(el("p", "state-title", title));
  if (text) box.appendChild(el("p", "state-text", text));
  if (action) box.appendChild(action);
  container.appendChild(box);
}

function showErrorState(container, error) {
  error = toApiError(error);
  showState(container, "error", statusLine(error.status, error.statusText), error.message);
}

function hideState(container) {
  container.hidden = true;
  container.textContent = "";
}

// ===================================================================
// 3. Dialogs
// ===================================================================

// --- Confirmation ("Cancel this booking?", "Delete this field?") ---

// Opens the confirmation dialog and resolves to true if the user confirms.
function confirmAction(title, message, confirmLabel, cancelLabel) {
  const dialog = $("confirmDialog");
  $("confirmTitle").textContent = title;
  $("confirmMessage").textContent = message;
  $("confirmOk").textContent = confirmLabel;
  $("confirmCancel").textContent = cancelLabel;
  dialog.returnValue = "";
  dialog.showModal();
  // The buttons are in a <form method="dialog">: clicking one closes the
  // dialog and sets returnValue to the button's value. Esc leaves it "".
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
  });
}

// --- Log in / Sign up ---

function openAuthDialog(tab, notice) {
  const dialog = $("authDialog");
  if (!dialog.open) {
    for (const box of dialog.querySelectorAll(".form-error")) hideFormError(box);
    dialog.showModal();
  }
  $("authNotice").textContent = notice || "";
  $("authNotice").hidden = !notice;
  selectAuthTab(tab);
}

function selectAuthTab(tab) {
  const login = tab === "login";
  for (const [tabId, selected] of [["loginTab", login], ["signupTab", !login]]) {
    $(tabId).setAttribute("aria-selected", String(selected));
    $(tabId).tabIndex = selected ? 0 : -1;
  }
  $("loginForm").hidden = !login;
  $("signupForm").hidden = login;
  $("authTitle").textContent = login ? "Welcome back" : "Create your account";
  (login ? $("loginUsername") : $("signupUsername")).focus();
}

// Called for every 401 answer.
function handleUnauthorized() {
  if ($("authDialog").open) return; // e.g. wrong password: the form shows it
  let notice = "Please log in or create an account to continue.";
  if (getToken()) {
    // We sent a token and the server refused it: it expired or was deleted
    // (logged out from another tab, database reset...). Forget it.
    clearSession();
    updateNav();
    notice = "Your session is no longer valid. Please log in again.";
  }
  openAuthDialog("login", notice);
}

// When the dialog closes (logged in, or cancelled), redraw the current
// screen for the current user. A guest who cancels on a page that needs a
// login goes back to Browse fields.
function onAuthDialogClosed() {
  if (getUser() === null && isPrivateRoute()) {
    location.hash = "#/fields";
  } else {
    route(true);
  }
}

// --- Add / edit a field (owners) ---

let editingFieldId = null; // null = adding a new field

function openFieldDialog(field) {
  editingFieldId = field ? field.id : null;
  $("fieldDialogTitle").textContent = field ? "Edit field" : "Add a field";
  $("fieldFormSubmit").textContent = field ? "Save changes" : "Add field";
  $("fieldFormName").value = field ? field.name : "";
  $("fieldFormSport").value = field ? field.sport : "";
  $("fieldFormLocation").value = field ? field.location : "";
  $("fieldFormPrice").value = field ? field.price_per_hour : "";
  hideFormError($("fieldForm").querySelector(".form-error"));

  // Suggest the sports that already exist (only a suggestion).
  const list = $("sportList");
  list.textContent = "";
  for (const sport of sportsOf(allFields.concat(myFields))) {
    const option = el("option");
    option.value = sport;
    list.appendChild(option);
  }

  $("fieldDialog").showModal();
  $("fieldFormName").focus();
}

// POST /api/fields to add, PUT /api/fields/<id> to edit.
async function saveField() {
  const body = {
    name: $("fieldFormName").value,
    sport: $("fieldFormSport").value,
    location: $("fieldFormLocation").value,
    price_per_hour: numberOrNull($("fieldFormPrice").value),
  };
  const result = editingFieldId === null
    ? await api("POST", "/api/fields", body)
    : await api("PUT", "/api/fields/" + editingFieldId, body);
  toastSuccess(result, result.data.field.name + ".");
  $("fieldDialog").close();
  await route(true);
}

// ===================================================================
// 4. Navigation: top bar and router
// ===================================================================

// Shows the links and buttons that match the logged-in user.
function updateNav() {
  const user = getUser();
  $("navGuest").hidden = user !== null;
  $("navUser").hidden = user === null;
  for (const link of document.querySelectorAll(".nav-links [data-role]")) {
    link.hidden = user === null || user.role !== link.dataset.role;
  }
  if (user) {
    $("navUsername").textContent = user.username;
    $("navRole").textContent = user.role === "owner" ? "Owner" : "Player";
    $("navRole").className = "badge badge-" + user.role;
  }
}

// Each screen: its render function, its title, the element used for the
// loading/empty/error messages and the elements holding its content.
const VIEWS = {
  "fields":      { render: renderBrowse,     title: "Browse fields", state: "fieldsState",     content: ["fieldsGrid"] },
  "field":       { render: renderFieldPage,  title: "Field",         state: "fieldState",      content: ["fieldContent"] },
  "my-bookings": { render: renderMyBookings, title: "My bookings",   state: "myBookingsState", content: ["myBookingsContent"] },
  "my-fields":   { render: renderMyFields,   title: "My fields",     state: "myFieldsState",   content: ["myFieldsGrid", "timelineCard"] },
};

// Reads the address after "#": "#/fields/3" -> {view: "field", id: "3"}.
// The id is sent to the server as it is: the server answers 400 or 404 if
// it is not a valid field.
function currentRoute() {
  const hash = location.hash;
  if (hash === "#/my-bookings") return { view: "my-bookings" };
  if (hash === "#/my-fields") return { view: "my-fields" };
  const match = /^#\/fields\/([^/]+)$/.exec(hash);
  if (match) return { view: "field", id: match[1] };
  return { view: "fields" };
}

function isPrivateRoute() {
  const view = currentRoute().view;
  return view === "my-bookings" || view === "my-fields";
}

// Increased at each render. A render that gets its answer after the user
// moved to another screen sees a different number and stops.
let renderNumber = 0;

function isStale(ticket) {
  return ticket !== renderNumber;
}

// Shows the screen that matches the address and loads its data.
// refresh = true reloads the current screen without the loading message
// (used after an action, e.g. after cancelling a booking).
async function route(refresh) {
  const current = currentRoute();
  const view = VIEWS[current.view];
  const ticket = ++renderNumber;

  for (const section of document.querySelectorAll(".view")) {
    section.hidden = section.id !== "view-" + current.view;
  }
  const activeNav = current.view === "field" ? "fields" : current.view;
  for (const link of document.querySelectorAll(".nav-links a")) {
    if (link.dataset.nav === activeNav) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
  document.title = view.title + " - Field Booking";

  if (refresh !== true) {
    showState($(view.state), "loading", "Loading...");
    for (const id of view.content) $(id).hidden = true;
  }
  try {
    await view.render(current, ticket);
  } catch (error) {
    if (isStale(ticket)) return; // the user already went to another screen
    for (const id of view.content) $(id).hidden = true;
    showErrorState($(view.state), error);
    // A 401 while the login dialog is already open (e.g. the saved token was
    // refused at startup) was already announced: no second toast.
    if (!(error.status === 401 && $("authDialog").open)) {
      reportError(error);
    }
  }
}

// ===================================================================
// 5. Browse fields (everyone)
// ===================================================================

let allFields = [];    // every field: used to build the sport chips
let shownFields = [];  // fields of the selected sport, before the search box
let activeSport = "";  // "" = all sports

async function renderBrowse(current, ticket) {
  const result = await api("GET", "/api/fields");
  if (isStale(ticket)) return;
  allFields = result.data.fields;

  const sports = sportsOf(allFields);
  if (!sports.some((sport) => sameSport(sport, activeSport))) {
    activeSport = ""; // the selected sport no longer exists
  }
  renderSportChips(sports);

  shownFields = allFields;
  if (activeSport) {
    shownFields = (await api("GET", "/api/fields?sport=" + encodeURIComponent(activeSport))).data.fields;
    if (isStale(ticket)) return;
  }
  renderFieldGrid();
}

function sameSport(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

// The sports that exist, sorted, without duplicates ("Football" and
// "football" are the same sport, like for the server's ?sport= filter).
function sportsOf(fieldList) {
  const sports = [];
  for (const field of fieldList) {
    if (!sports.some((sport) => sameSport(sport, field.sport))) {
      sports.push(field.sport);
    }
  }
  return sports.sort((a, b) => a.localeCompare(b));
}

function renderSportChips(sports) {
  const box = $("sportChips");
  box.textContent = "";
  for (const sport of [""].concat(sports)) {
    const chip = makeButton(sport || "All sports", "chip", () => selectSport(sport, chip));
    chip.setAttribute("aria-pressed", String(sameSport(sport, activeSport)));
    box.appendChild(chip);
  }
}

// A sport chip asks the server for that sport: GET /api/fields?sport=...
async function selectSport(sport, chip) {
  activeSport = sport;
  for (const other of $("sportChips").children) {
    other.setAttribute("aria-pressed", String(other === chip));
  }
  await runAction(chip, null, async () => {
    const url = sport ? "/api/fields?sport=" + encodeURIComponent(sport) : "/api/fields";
    const result = await api("GET", url);
    if (activeSport !== sport) return; // another chip was clicked meanwhile
    shownFields = result.data.fields;
    renderFieldGrid();
  });
}

// Draws the field cards. The search box only hides cards in the page; the
// sport filter is done by the server.
function renderFieldGrid() {
  const search = $("searchInput").value.trim().toLowerCase();
  const visible = shownFields.filter((field) =>
    [field.name, field.location, field.owner_username, field.sport]
      .some((text) => text.toLowerCase().includes(search)));

  const grid = $("fieldsGrid");
  grid.textContent = "";
  grid.hidden = false;
  for (const field of visible) {
    grid.appendChild(makeFieldCard(field));
  }

  const state = $("fieldsState");
  if (allFields.length === 0) {
    showState(state, "empty", "No fields yet", "When owners add their fields, they will appear here.");
  } else if (visible.length === 0) {
    showState(state, "empty", "No matching fields", "Try another search or another sport.");
  } else {
    hideState(state);
  }
}

// Top line of a field card: sport tag and price.
function makeFieldCardTop(field) {
  const top = el("div", "field-card-top");
  top.appendChild(el("span", "tag", field.sport));
  const price = el("span", "field-card-price");
  price.appendChild(el("strong", "", formatPrice(field.price_per_hour)));
  price.appendChild(document.createTextNode(" / hour"));
  top.appendChild(price);
  return top;
}

function makeFieldCard(field) {
  const card = el("article", "card field-card");
  card.appendChild(makeFieldCardTop(field));
  card.appendChild(el("h3", "field-card-name", field.name));
  const details = el("dl", "details");
  details.appendChild(detail("Location", field.location));
  details.appendChild(detail("Owner", field.owner_username));
  card.appendChild(details);
  card.appendChild(makeLink("View & book", "btn btn-primary btn-block", "#/fields/" + field.id));
  return card;
}

// ===================================================================
// 6. Field page and booking
// ===================================================================

// State of the field page. It is kept while the user stays on the same
// field, so a guest who presses Book, logs in and comes back still has the
// chosen date and hours.
const booking = {
  fieldId: null,        // id from the address (#/fields/<id>)
  field: null,          // the field returned by GET /api/fields/<id>
  date: "",
  bookedSlots: [],      // [{start_hour, end_hour, player_username (owner only)}]
  start: null,          // selected hours: from start to end (end excluded)
  end: null,
  waitingForEnd: false, // after the first click, the next click picks the end
};

async function renderFieldPage(current, ticket) {
  if (booking.fieldId !== current.id) {
    Object.assign(booking, { fieldId: current.id, field: null, date: todayText(),
                             bookedSlots: [], start: null, end: null, waitingForEnd: false });
  }
  const result = await api("GET", "/api/fields/" + current.id);
  if (isStale(ticket)) return;

  const field = result.data.field;
  booking.field = field;
  document.title = field.name + " - Field Booking";
  $("fieldName").textContent = field.name;
  $("fieldSport").textContent = field.sport;
  $("fieldLocation").textContent = field.location;
  $("fieldOwner").textContent = field.owner_username;
  $("fieldPrice").textContent = formatPrice(field.price_per_hour);
  $("bookDate").value = booking.date;
  $("bookDate").min = todayText(); // only a hint for the date picker
  hideFormError($("bookError"));
  hideState($("fieldState"));
  $("fieldContent").hidden = false;
  updateSummary();
  await loadSlots();
}

// Asks the server which hours are booked on the chosen date, then draws
// the slot grid.
async function loadSlots() {
  const field = booking.field;
  booking.date = $("bookDate").value;
  const url = "/api/fields/" + field.id + "/bookings?date=" + encodeURIComponent(booking.date);
  $("slotGrid").setAttribute("aria-busy", "true");
  try {
    const result = await api("GET", url);
    if (booking.field !== field) return; // the user opened another field
    booking.bookedSlots = result.data.booked_slots;
    hideState($("slotsState"));
    drawSlotGrid();
  } catch (error) {
    booking.bookedSlots = [];
    $("slotGrid").textContent = "";
    showErrorState($("slotsState"), error);
    throw error;
  } finally {
    $("slotGrid").removeAttribute("aria-busy");
    updateSummary();
  }
}

// One button per hour. Booked hours are disabled.
function drawSlotGrid() {
  const grid = $("slotGrid");
  grid.textContent = "";
  const [first, last] = dayRange(booking.bookedSlots);
  for (let hour = first; hour < last; hour++) {
    const button = makeButton("", "slot", () => selectHour(hour));
    button.dataset.hour = hour;
    button.appendChild(el("span", "slot-time", formatHour(hour)));
    button.appendChild(el("span", "slot-label"));
    grid.appendChild(button);
  }
  paintSlots();
}

function bookedSlotAt(hour) {
  return booking.bookedSlots.find((slot) => slot.start_hour <= hour && hour < slot.end_hour);
}

function isSelected(hour) {
  return booking.start !== null && booking.start <= hour && hour < booking.end;
}

// Updates the look of every slot without rebuilding the buttons, so the
// keyboard focus stays where it is.
function paintSlots() {
  for (const button of $("slotGrid").children) {
    const hour = Number(button.dataset.hour);
    const taken = bookedSlotAt(hour);
    const selected = isSelected(hour);

    let label = "Free";
    if (taken) {
      // The server only sends player_username to the field's owner.
      label = taken.player_username ? "Booked by " + taken.player_username : "Booked";
    } else if (selected) {
      label = "Selected";
    }
    button.disabled = Boolean(taken);
    button.classList.toggle("slot-booked", Boolean(taken));
    button.classList.toggle("slot-selected", selected && !taken);
    button.classList.toggle("slot-conflict", selected && Boolean(taken));
    button.setAttribute("aria-pressed", String(selected && !taken));
    button.setAttribute("aria-label", formatHours(hour, hour + 1) + ", " + label);
    button.querySelector(".slot-label").textContent = label;
  }
}

// First click: start hour (a one-hour selection). Next click on the same or
// a later hour: the end. Any other click starts a new selection.
function selectHour(hour) {
  if (booking.waitingForEnd && hour >= booking.start) {
    booking.end = hour + 1;
    booking.waitingForEnd = false;
  } else {
    booking.start = hour;
    booking.end = hour + 1;
    booking.waitingForEnd = true;
  }
  hideFormError($("bookError"));
  paintSlots();
  updateSummary();
}

function clearSelection() {
  booking.start = null;
  booking.end = null;
  booking.waitingForEnd = false;
  paintSlots();
  updateSummary();
}

// The "Your booking" panel: date, hours, "2 hours x 120.00 = 240.00".
function updateSummary() {
  const price = booking.field.price_per_hour;
  const hasSelection = booking.start !== null;
  $("summaryDate").textContent = formatDate(booking.date);
  if (hasSelection) {
    const hours = booking.end - booking.start;
    $("summaryTime").textContent = formatHours(booking.start, booking.end);
    $("summaryCalc").textContent = plural(hours, "hour") + " × " + formatPrice(price) +
                                   " = " + formatPrice(hours * price);
    $("summaryTotal").textContent = formatPrice(hours * price);
  } else {
    $("summaryTime").textContent = "Not selected";
    $("summaryCalc").textContent = formatPrice(price) + " per hour";
    $("summaryTotal").textContent = "-";
  }
  $("clearSelectionBtn").hidden = !hasSelection;
  showBookingHints();
}

// Hints under the summary. They never disable the Book button: the request
// is always sent and the server's answer is shown.
function showBookingHints() {
  const hints = [];
  const user = getUser();
  if (user === null) {
    hints.push(["info", "You are not logged in. Log in as a player to book."]);
  } else if (user.role !== "player") {
    hints.push(["info", "You are logged in as an owner. Only players can book fields."]);
    if (user.id === booking.field.owner_id) {
      hints.push(["info", "This is your field: you can see who booked each hour."]);
    }
  }
  if (booking.start === null) {
    hints.push(["info", "Select a start hour and an end hour in the grid."]);
  } else {
    for (let hour = booking.start; hour < booking.end; hour++) {
      if (bookedSlotAt(hour)) {
        hints.push(["warn", "Your selection includes an hour that is already booked."]);
        break;
      }
    }
    if (booking.waitingForEnd) {
      hints.push(["info", "Click a later hour to make the booking longer."]);
    }
  }
  if (booking.date && booking.date < todayText()) {
    hints.push(["warn", "This date is in the past."]);
  }

  const list = $("bookHints");
  list.textContent = "";
  for (const [kind, text] of hints) {
    list.appendChild(el("li", "hint hint-" + kind, text));
  }
}

// POST /api/bookings. Sent for everyone, even guests and owners: the
// server answers 401 / 403 / 400 / 409 and the page shows it.
async function book() {
  const body = {
    field_id: booking.field.id,
    date: $("bookDate").value,
    start_hour: booking.start, // null when nothing is selected: the server answers 400
    end_hour: booking.end,
  };
  let result;
  try {
    result = await api("POST", "/api/bookings", body);
  } catch (error) {
    if (error.status === 409) {
      // Someone else booked these hours meanwhile: show the new availability.
      loadSlots().catch(() => {});
    }
    throw error;
  }
  const created = result.data.booking;
  toastSuccess(result, created.field_name + ", " + formatDate(created.date) + ", " +
    formatHours(created.start_hour, created.end_hour) + ". Total " + formatPrice(created.total_price) + ".");
  booking.start = null;
  booking.end = null;
  booking.waitingForEnd = false;
  await loadSlots();
}

// ===================================================================
// 7. My bookings (players)
// ===================================================================

async function renderMyBookings(current, ticket) {
  const result = await api("GET", "/api/my/bookings");
  if (isStale(ticket)) return;
  const all = result.data.bookings; // sorted by date then hour by the server

  if (all.length === 0) {
    $("myBookingsContent").hidden = true;
    showState($("myBookingsState"), "empty", "No bookings yet", "Find a field and book your first game.",
              makeLink("Browse fields", "btn btn-primary", "#/fields"));
    return;
  }
  const upcoming = all.filter((item) => !isPast(item));
  const past = all.filter(isPast).reverse(); // most recent first
  fillBookingList($("upcomingList"), upcoming, true, "No upcoming bookings.");
  fillBookingList($("pastList"), past, false, "No past bookings.");
  $("upcomingCount").textContent = upcoming.length;
  $("pastCount").textContent = past.length;
  hideState($("myBookingsState"));
  $("myBookingsContent").hidden = false;
}

// A booking is past when its last hour is over (by this computer's clock).
function isPast(item) {
  const today = todayText();
  return item.date < today || (item.date === today && item.end_hour <= new Date().getHours());
}

function fillBookingList(list, items, upcoming, emptyText) {
  list.textContent = "";
  for (const item of items) {
    list.appendChild(makeBookingCard(item, upcoming));
  }
  if (items.length === 0) {
    list.appendChild(el("p", "muted list-empty", emptyText));
  }
}

function makeBookingCard(item, upcoming) {
  const card = el("article", "card booking-card" + (upcoming ? "" : " booking-past"));

  // Calendar-like date block: NOV / 21 / Sat
  const day = parseDay(item.date);
  const dateBox = el("div", "date-box");
  dateBox.appendChild(el("span", "date-box-month", day.toLocaleDateString("en-GB", { month: "short" })));
  dateBox.appendChild(el("span", "date-box-day", String(day.getDate())));
  dateBox.appendChild(el("span", "date-box-weekday", day.toLocaleDateString("en-GB", { weekday: "short" })));
  card.appendChild(dateBox);

  const info = el("div", "booking-info");
  info.appendChild(el("h3", "", item.field_name));
  info.appendChild(el("p", "muted", item.field_location));
  info.appendChild(el("p", "booking-time", formatHours(item.start_hour, item.end_hour) + "  ·  " +
                                           plural(item.end_hour - item.start_hour, "hour")));
  card.appendChild(info);

  const side = el("div", "booking-side");
  side.appendChild(el("span", "booking-total", formatPrice(item.total_price)));
  if (upcoming) {
    side.appendChild(makeButton("Cancel", "btn btn-danger-ghost btn-small", (button) => cancelBooking(item, button)));
  } else {
    side.appendChild(el("span", "badge badge-muted", "Played"));
  }
  card.appendChild(side);
  return card;
}

async function cancelBooking(item, button) {
  const confirmed = await confirmAction(
    "Cancel this booking?",
    item.field_name + ", " + formatDate(item.date) + ", " + formatHours(item.start_hour, item.end_hour) +
      ". The hours become free for other players.",
    "Cancel booking", "Keep booking");
  if (!confirmed) return;
  await runAction(button, null, async () => {
    const result = await api("DELETE", "/api/bookings/" + item.id);
    toastSuccess(result);
    await route(true);
  });
}

// ===================================================================
// 8. My fields (owners)
// ===================================================================

let myFields = [];

async function renderMyFields(current, ticket) {
  const result = await api("GET", "/api/my/fields");
  if (isStale(ticket)) return;
  myFields = result.data.fields;

  const grid = $("myFieldsGrid");
  grid.textContent = "";
  grid.hidden = false;
  if (myFields.length === 0) {
    $("timelineCard").hidden = true;
    showState($("myFieldsState"), "empty", "No fields yet", "Add a field so players can find and book it.",
              makeButton("Add your first field", "btn btn-primary", () => openFieldDialog(null)));
    return;
  }
  hideState($("myFieldsState"));
  for (const field of myFields) {
    grid.appendChild(makeOwnerFieldCard(field));
  }

  // The "Bookings by day" card: keep the chosen field if it still exists.
  const select = $("timelineField");
  const previous = select.value;
  select.textContent = "";
  for (const field of myFields) {
    const option = el("option", "", field.name);
    option.value = field.id;
    select.appendChild(option);
  }
  if (myFields.some((field) => String(field.id) === previous)) {
    select.value = previous;
  }
  if (!$("timelineDate").value) {
    $("timelineDate").value = todayText();
  }
  $("timelineCard").hidden = false;
  try {
    await loadTimeline();
  } catch (error) {
    reportError(error); // shown inside the timeline card, the rest of the page works
  }
}

function makeOwnerFieldCard(field) {
  const card = el("article", "card field-card");
  card.appendChild(makeFieldCardTop(field));
  card.appendChild(el("h3", "field-card-name", field.name));
  const details = el("dl", "details");
  details.appendChild(detail("Location", field.location));
  card.appendChild(details);

  const actions = el("div", "card-actions");
  actions.appendChild(makeButton("Bookings", "btn btn-ghost btn-small", (button) => showFieldTimeline(field, button)));
  actions.appendChild(makeButton("Edit", "btn btn-ghost btn-small", () => openFieldDialog(field)));
  actions.appendChild(makeButton("Delete", "btn btn-danger-ghost btn-small", (button) => deleteField(field, button)));
  actions.appendChild(makeLink("Public page", "btn btn-link btn-small", "#/fields/" + field.id));
  card.appendChild(actions);
  return card;
}

async function deleteField(field, button) {
  const confirmed = await confirmAction(
    "Delete “" + field.name + "”?",
    "This cannot be undone. A field that has bookings cannot be deleted.",
    "Delete field", "Keep field");
  if (!confirmed) return;
  await runAction(button, null, async () => {
    const result = await api("DELETE", "/api/fields/" + field.id);
    toastSuccess(result);
    await route(true);
  });
}

// "Bookings" button of a field card: show that field in the timeline.
async function showFieldTimeline(field, button) {
  $("timelineField").value = field.id;
  $("timelineCard").scrollIntoView({ behavior: "smooth", block: "start" });
  await runAction(button, null, loadTimeline);
}

// GET /api/fields/<id>/bookings?date=... As the owner, the answer also
// contains the username of the player of each booking.
async function loadTimeline() {
  const url = "/api/fields/" + $("timelineField").value + "/bookings?date=" +
              encodeURIComponent($("timelineDate").value);
  let result;
  try {
    result = await api("GET", url);
  } catch (error) {
    $("timeline").textContent = "";
    $("timelineSummary").textContent = "";
    showErrorState($("timelineState"), error);
    throw error;
  }
  hideState($("timelineState"));
  drawTimeline(result.data.booked_slots, result.data.date);
}

// A day as a vertical timeline: one CSS grid row per hour, each booking is
// a block spanning its hours.
function drawTimeline(slots, date) {
  const box = $("timeline");
  box.textContent = "";
  const [first, last] = dayRange(slots);
  box.style.gridTemplateRows = "repeat(" + (last - first) + ", var(--timeline-row))";

  for (let hour = first; hour < last; hour++) {
    const label = el("div", "timeline-hour", formatHour(hour));
    label.style.gridRow = String(hour - first + 1);
    const line = el("div", "timeline-line");
    line.style.gridRow = String(hour - first + 1);
    box.appendChild(label);
    box.appendChild(line);
  }

  let bookedHours = 0;
  for (const slot of slots) {
    const block = el("div", "timeline-booking");
    block.style.gridRow = (slot.start_hour - first + 1) + " / " + (slot.end_hour - first + 1);
    block.appendChild(el("strong", "", slot.player_username || "Booked"));
    block.appendChild(el("span", "", formatHours(slot.start_hour, slot.end_hour)));
    box.appendChild(block);
    bookedHours += slot.end_hour - slot.start_hour;
  }

  $("timelineSummary").textContent = slots.length === 0
    ? "No bookings on " + formatDate(date) + ". Every hour is free."
    : plural(slots.length, "booking") + " on " + formatDate(date) + ", " + plural(bookedHours, "hour") + " booked.";
}

// ===================================================================
// 9. Account actions: log in, sign up, log out
// ===================================================================

async function logIn() {
  await logInWith($("loginUsername").value, $("loginPassword").value);
}

async function logInWith(username, password) {
  const result = await api("POST", "/api/login", { username: username, password: password });
  const token = result.data.token;

  // The login answer only contains the token: ask the server who we are.
  saveSession(token, null);
  let me;
  try {
    me = await api("GET", "/api/me");
  } catch (error) {
    clearSession(); // never keep a token without its user
    throw error;
  }
  saveSession(token, me.data.user);

  $("loginPassword").value = "";
  $("signupPassword").value = "";
  updateNav();
  toastSuccess(result, "Welcome, " + me.data.user.username + "!");
  $("authDialog").close(); // its "close" event redraws the current screen
}

// POST /api/register, then log in with the same username and password.
async function signUp() {
  const checked = document.querySelector("#signupForm input[name=role]:checked");
  const username = $("signupUsername").value;
  const password = $("signupPassword").value;
  const result = await api("POST", "/api/register", {
    username: username,
    password: password,
    role: checked ? checked.value : undefined, // no choice: the server answers 400
  });
  toastSuccess(result);
  $("loginUsername").value = username;
  await logInWith(username, password);
}

async function logOut() {
  try {
    const result = await api("POST", "/api/logout");
    toastSuccess(result);
  } catch (error) {
    // Not reportError(): a 401 here must not open the login dialog.
    error = toApiError(error);
    showToast(error.status, error.statusText, error.message);
  } finally {
    // Even if the server cannot be reached, forget the token in this tab.
    clearSession();
    updateNav();
    if (isPrivateRoute()) {
      location.hash = "#/fields";
    } else {
      route(true);
    }
  }
}

// ===================================================================
// 10. Startup
// ===================================================================

// Connects a form's submit (button click or Enter key) to an action. The
// form's submit button shows the spinner, its .form-error box the errors.
function onSubmit(form, action) {
  form.addEventListener("submit", (event) => {
    event.preventDefault(); // stay on the page, we send the request with fetch
    runAction(form.querySelector("[type=submit]"), form.querySelector(".form-error"), action);
  });
}

function setUp() {
  setUpNetworkPanel();

  // Dialogs
  for (const button of document.querySelectorAll("[data-close]")) {
    button.addEventListener("click", () => button.closest("dialog").close());
  }
  $("authDialog").addEventListener("close", onAuthDialogClosed);
  $("navLoginBtn").addEventListener("click", () => openAuthDialog("login"));
  $("navSignupBtn").addEventListener("click", () => openAuthDialog("signup"));
  $("loginTab").addEventListener("click", () => selectAuthTab("login"));
  $("signupTab").addEventListener("click", () => selectAuthTab("signup"));
  // Left/Right arrows move between the two tabs (usual keyboard behavior).
  document.querySelector("#authDialog .tabs").addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      selectAuthTab($("loginForm").hidden ? "login" : "signup");
      (($("loginForm").hidden) ? $("signupTab") : $("loginTab")).focus();
    }
  });
  onSubmit($("loginForm"), logIn);
  onSubmit($("signupForm"), signUp);
  onSubmit($("fieldForm"), saveField);
  $("logoutBtn").addEventListener("click", () => runAction($("logoutBtn"), null, logOut));

  // Screens
  window.addEventListener("hashchange", () => {
    window.scrollTo(0, 0);
    route();
  });
  $("retryBtn").addEventListener("click", () => route());
  $("searchInput").addEventListener("input", renderFieldGrid);
  $("bookDate").addEventListener("change", () => runAction(null, null, loadSlots));
  $("bookBtn").addEventListener("click", () => runAction($("bookBtn"), $("bookError"), book));
  $("clearSelectionBtn").addEventListener("click", clearSelection);
  $("addFieldBtn").addEventListener("click", () => openFieldDialog(null));
  $("timelineField").addEventListener("change", () => runAction(null, null, loadTimeline));
  $("timelineDate").addEventListener("change", () => runAction(null, null, loadTimeline));
}

async function start() {
  setUp();
  updateNav();
  // Page reload: check that the saved token still works. A 401 forgets it
  // and opens the login dialog (see handleUnauthorized).
  if (getToken()) {
    try {
      const me = await api("GET", "/api/me");
      saveSession(getToken(), me.data.user);
      updateNav();
    } catch (error) {
      reportError(error);
    }
  }
  await route();
}

start();
