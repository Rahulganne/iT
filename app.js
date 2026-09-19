const ticket = document.getElementById("ticket");
const holdNote = document.getElementById("hold-note");
const schedulePanel = document.getElementById("schedule-panel");
const API_ORIGIN = window.location.protocol === "file:" ? "http://localhost:3000" : "";
let lastSubmittedBookingKey = null;
const isAdminPage = window.location.pathname.endsWith("admin.html");
const isSalesPage = window.location.pathname.endsWith("sales.html");
const isSettingsPage = window.location.pathname.endsWith("settings.html");
const isCredentialsPage = window.location.pathname.endsWith("credentials.html");

const bookingState = new Map();
let adminToken = sessionStorage.getItem("iturf-admin-token") || "";
let adminChallenge = "";
const selectedSlots = new Set();
const CUSTOMER_BOOKING_KEY = "iturf-customer-booking-v1";
const CUSTOMER_PROFILE_KEY = "iturf-customer-profile-v1";
let pricing = { big_morning: 500, big_later: 600, small_all_day: 250 };
let adminFilter = "pending";
let adminSearch = "";

const slotTimeline = [
  "6:00 am",
  "7:00 am",
  "8:00 am",
  "9:00 am",
  "10:00 am",
  "11:00 am",
  "12:00 pm",
  "1:00 pm",
  "2:00 pm",
  "3:00 pm",
  "4:00 pm",
  "5:00 pm",
  "6:00 pm",
  "7:00 pm",
  "8:00 pm",
  "9:00 pm",
  "10:00 pm",
  "11:00 pm",
  "12:00 am",
];
const turfOptions = [
  ["big", "Big Turf"],
  ["small", "Small Turf"],
];

async function apiRequest(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (adminToken) headers.Authorization = `Bearer ${adminToken}`;
  const response = await fetch(`${API_ORIGIN}${path}`, {
    headers,
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed.");
  return payload;
}

async function loadBookings() {
  try {
    pricing = await apiRequest("/api/pricing");
  } catch (error) {
    console.error(error);
  }
  const bookings = await apiRequest("/api/bookings");
  bookingState.clear();
  bookings.forEach((entry) => bookingState.set(entry.key, entry));
  updateDateOptions();
  if (isSalesPage) {
    renderSalesPage();
  } else if (isSettingsPage) {
    renderSettingsPage();
  } else if (isCredentialsPage) {
    renderCredentialsPage();
  } else {
    renderSchedule();
    restoreCustomerBooking();
  }
}

function bookingEndTime(booking) {
  const match = booking.slot.match(/^(\d+):00 (am|pm)$/i);
  if (!match) return 0;
  let hour = Number(match[1]) % 12;
  if (match[2].toLowerCase() === "pm") hour += 12;
  const end = new Date(`${booking.when}T${String(hour).padStart(2, "0")}:00:00`);
  end.setHours(end.getHours() + 1);
  return end.getTime();
}

function renderCustomerBooking(bookings, name, phone) {
  const statusPanel = document.getElementById("customer-booking-status");
  if (!statusPanel || !bookings.length) return;
  const rejected = bookings.filter((booking) => booking.status === "rejected").length;
  document.getElementById("customer-booking-title").textContent = `Reservation ${bookings.map((booking) => `#${booking.reservationNo}`).join(", ")}`;
  document.getElementById("customer-booking-details").textContent = `${name} · ${phone} · ${turfLabel(bookings[0].turf)} · ${bookings.map((booking) => booking.slot).join(", ")} · ${priceLabel(bookings[0].turf, bookings[0].slot)}`;
  document.getElementById("customer-booking-state").textContent = rejected === bookings.length ? "Rejected" : bookings.every((booking) => booking.status === "approved") ? "Approved" : "Pending admin approval";
  statusPanel.hidden = false;
}

function restoreCustomerProfile() {
  const profile = JSON.parse(localStorage.getItem(CUSTOMER_PROFILE_KEY) || "null");
  if (!profile?.name || !profile?.phone) return;
  const nameInput = document.querySelector('#book-form input[name="name"]');
  const phoneInput = document.querySelector('#book-form input[name="phone"]');
  if (nameInput) nameInput.value = profile.name;
  if (phoneInput) phoneInput.value = profile.phone;
  const welcome = document.getElementById("welcome-message");
  if (welcome) welcome.textContent = `Welcome back, ${profile.name}`;
}

function restoreCustomerBooking() {
  const saved = JSON.parse(localStorage.getItem(CUSTOMER_BOOKING_KEY) || "null");
  if (!saved?.bookings?.length) return;
  const latest = saved.bookings.reduce((last, booking) => bookingEndTime(booking) > bookingEndTime(last) ? booking : last);
  if (bookingEndTime(latest) <= Date.now()) {
    localStorage.removeItem(CUSTOMER_BOOKING_KEY);
    return;
  }
  const currentBookings = saved.bookings.map((booking) => bookingState.get(booking.key) || booking);
  renderCustomerBooking(currentBookings, saved.name, saved.phone);
}

async function createBooking(booking) {
  const savedBooking = await apiRequest("/api/bookings", {
    method: "POST",
    body: JSON.stringify(booking),
  });
  bookingState.set(savedBooking.key, savedBooking);
  return savedBooking;
}

async function createBookings(bookings) {
  const savedBookings = await apiRequest("/api/bookings/bulk", {
    method: "POST",
    body: JSON.stringify({ bookings }),
  });
  savedBookings.forEach((booking) => bookingState.set(booking.key, booking));
  return savedBookings;
}

async function changeBookingStatus(key, action) {
  return apiRequest(`/api/bookings/${encodeURIComponent(key)}/action`, {
    method: "PATCH",
    body: JSON.stringify({ action }),
  });
}

function codeFor(name) {
  const stamp = Date.now().toString(36).slice(-4).toUpperCase();
  const initials = name
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return `IT-${initials}${stamp}`;
}

function dayLabel(value) {
  const date = dateForValue(value);
  const today = dateKey(0);
  const tomorrow = dateKey(1);
  const valueKey = formatDateKey(date);
  if (valueKey === today) return "Today";
  if (valueKey === tomorrow) return "Tomorrow";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function dateLabel(value) {
  const date = dateForValue(value);
  const formatted = new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
  return dayLabel(value) === formatted ? formatted : `${dayLabel(value)} · ${formatted}`;
}

function dateForValue(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T00:00:00`);
  const date = new Date();
  if (value === "tomorrow") date.setDate(date.getDate() + 1);
  return date;
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateKey(offset = 0) {
  const date = new Date();
  const baseDay = new Date(date.getFullYear(), date.getMonth(), 20);
  date.setFullYear(baseDay.getFullYear(), baseDay.getMonth(), baseDay.getDate() + offset);
  return formatDateKey(date);
}

function updateDateOptions() {
  const whenSelect = document.getElementById("when");
  if (whenSelect && whenSelect.tagName === "SELECT") {
    const todayOption = whenSelect.querySelector('option[value="today"]');
    const tomorrowOption = whenSelect.querySelector('option[value="tomorrow"]');
    if (todayOption) {
      todayOption.value = dateKey(0);
      todayOption.textContent = dateLabel(todayOption.value);
    }
    if (tomorrowOption) {
      tomorrowOption.value = dateKey(1);
      tomorrowOption.textContent = dateLabel(tomorrowOption.value);
    }
  }

  document.querySelectorAll(".date-card").forEach((card, index) => {
    const value = dateKey(index);
    card.dataset.date = value;
    const date = dateForValue(value);
    const small = card.querySelector("small");
    const strong = card.querySelector("strong");
    const span = card.querySelector("span");
    if (small) small.textContent = new Intl.DateTimeFormat("en-IN", { weekday: "short" }).format(date);
    if (strong) strong.textContent = date.getDate();
    if (span) span.textContent = new Intl.DateTimeFormat("en-IN", { month: "short" }).format(date);
  });
}

function turfLabel(value) {
  return value === "small" ? "Small Turf" : "Big Turf";
}

function priceFor(turf, slot) {
  if (turf === "small") return pricing.small_all_day;
  return slot === "12:00 am" || slot === "12:00 pm" || slotTimeline.indexOf(slot) > 6 ? pricing.big_later : pricing.big_morning;
}

function priceLabel(turf, slot) {
  return `₹${priceFor(turf, slot)}`;
}

function updatePriceSummary() {
  const summary = document.getElementById("price-summary");
  if (!summary) return;

  const turf = document.getElementById("turf")?.value || "big";
  const slot = document.getElementById("slot")?.value || slotTimeline[0];
  summary.textContent = `${turfLabel(turf)} · ${slot}: ${priceLabel(turf, slot)}`;
}

function getSlotKey(when, slot, turf) {
  return `${when}|${turf}|${slot}`;
}

function getBookingForSlot(when, slot, turf) {
  return bookingState.get(getSlotKey(when, slot, turf));
}

function slotStartTime(when, slot) {
  if (when !== dateKey(0)) return 0;
  const match = slot.match(/^(\d+):00 (am|pm)$/i);
  if (!match) return 0;
  let hour = Number(match[1]) % 12;
  if (match[2].toLowerCase() === "pm") hour += 12;
  const start = new Date();
  start.setHours(hour, 0, 0, 0);
  return start.getTime();
}

function isSlotPast(when, slot) {
  const start = slotStartTime(when, slot);
  return start > 0 && Date.now() >= start;
}

function timePeriod(slot) {
  const index = slotTimeline.indexOf(slot);
  if (index < 6) return "morning";
  if (index < 12) return "afternoon";
  return "evening";
}

function updateAvailabilitySummary() {
  const summary = document.getElementById("availability-summary");
  if (!summary) return;

  const when = document.getElementById("when")?.value || "today";
  const turf = document.getElementById("turf")?.value || "big";
  const openSlots = slotTimeline.filter((slot) => !getBookingForSlot(when, slot, turf)).length;
  summary.textContent = `${openSlots} of ${slotTimeline.length} ${turfLabel(turf)} slots available for ${dayLabel(when).toLowerCase()}. Select an available tile to choose it.`;
}

function selectSlot(when, turf, slot) {
  const whenSelect = document.getElementById("when");
  const slotSelect = document.getElementById("slot");
  const turfSelect = document.getElementById("turf");
  const nameInput = document.querySelector('#book-form input[name="name"]');
  if (!whenSelect || !slotSelect || !turfSelect) return;

  const previousWhen = whenSelect.value;
  const previousTurf = turfSelect.value;
  whenSelect.value = when;
  turfSelect.value = turf;
  if (selectedSlots.size && (previousWhen !== when || previousTurf !== turf)) selectedSlots.clear();
  const selectedIndexes = Array.from(selectedSlots).map((selected) => slotTimeline.indexOf(selected));
  const clickedIndex = slotTimeline.indexOf(slot);
  const selectedPeriod = selectedSlots.size ? timePeriod(Array.from(selectedSlots)[0]) : null;
  if (selectedPeriod && selectedPeriod !== timePeriod(slot)) selectedSlots.clear();
  if (!selectedSlots.size) {
    selectedSlots.add(slot);
  } else if (selectedSlots.has(slot)) {
    selectedSlots.delete(slot);
  } else {
    const firstIndex = Math.min(...selectedIndexes, clickedIndex);
    const lastIndex = Math.max(...selectedIndexes, clickedIndex);
    const start = Math.min(firstIndex, lastIndex);
    const end = Math.max(firstIndex, lastIndex);
    slotTimeline.slice(start, end + 1).forEach((time) => {
      if (!getBookingForSlot(when, time, turf)) selectedSlots.add(time);
    });
  }
  slotSelect.value = Array.from(selectedSlots)[0] || "";
  renderSchedule();
  if (holdNote) {
    holdNote.hidden = false;
    holdNote.textContent = selectedSlots.size
      ? `${selectedSlots.size} ${turfLabel(turf)} slot${selectedSlots.size === 1 ? "" : "s"} selected for ${dayLabel(when)}.`
      : "Select at least one available slot to continue.";
  }
  nameInput?.focus();
}

function renderInteractiveSchedule() {
  const whenInput = document.getElementById("when");
  const turfInput = document.getElementById("turf");
  const activeDate = whenInput?.value || dateKey(0);
  const activeTurf = turfInput?.value || "big";
  restoreCustomerProfile();

  document.querySelectorAll(".date-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.date === activeDate);
    card.onclick = () => {
      if (whenInput?.value !== card.dataset.date) selectedSlots.clear();
      if (whenInput) whenInput.value = card.dataset.date;
      if (document.getElementById("slot")) document.getElementById("slot").value = "";
      renderSchedule();
    };
  });

  document.querySelectorAll(".turf-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.turf === activeTurf);
    button.onclick = () => {
      if (turfInput?.value !== button.dataset.turf) selectedSlots.clear();
      if (turfInput) turfInput.value = button.dataset.turf;
      if (document.getElementById("slot")) document.getElementById("slot").value = "";
      renderSchedule();
    };
  });

  document.querySelectorAll(".slot").forEach((slotButton) => {
    const slot = slotButton.dataset.slot || slotButton.textContent.trim().split(/\s+/).slice(0, 2).join(" ");
    slotButton.dataset.slot = slot;
    const state = getBookingForSlot(activeDate, slot, activeTurf);
    const past = isSlotPast(activeDate, slot);
    slotButton.classList.toggle("booked", past || Boolean(state));
    slotButton.classList.toggle("selected", !state && selectedSlots.has(slot));
    slotButton.disabled = past || Boolean(state);
    slotButton.innerHTML = past ? `${slot}<small>Passed</small>` : state ? `${slot}<small>${state.status === "approved" ? "Blocked" : state.status === "rejected" ? "Rejected" : "Pending"}</small>` : slot;
    slotButton.onclick = past || state ? null : () => selectSlot(activeDate, activeTurf, slot);
  });

  const selectedSlot = document.getElementById("selectedSlot");
  const selectedPrice = document.getElementById("selectedPrice");
  const turfInfo = document.getElementById("turf-info");
  const continueButton = document.getElementById("continueBtn");
  const selectedTime = Array.from(selectedSlots);
  if (turfInfo) {
    turfInfo.textContent = activeTurf === "small" ? "🏏 Cricket ball included on Small Turf" : "";
  }
  if (selectedSlot) selectedSlot.textContent = selectedTime.length
    ? `${selectedTime.length} slot${selectedTime.length === 1 ? "" : "s"} · ${turfLabel(activeTurf)}`
    : "Select a time";
  if (selectedPrice) {
    const total = selectedTime.reduce((sum, slot) => sum + priceFor(activeTurf, slot), 0);
    selectedPrice.textContent = selectedTime.length
      ? `Total: ₹${total} · Admin approval required`
      : "Select slots to see the total";
  }
  if (continueButton) {
    continueButton.disabled = !selectedTime.length;
    continueButton.onclick = () => {
      const form = document.getElementById("book-form");
      if (form) {
        form.hidden = false;
        form.scrollIntoView({ behavior: "smooth", block: "nearest" });
        form.querySelector('input[name="name"]')?.focus();
      }
    };
  }
}

function renderSchedule() {
  const panel = document.getElementById("schedule-panel");
  if (!panel) {
    renderInteractiveSchedule();
    renderAdminPanel();
    return;
  }
  const days = [dateKey(0), dateKey(1)];

  panel.innerHTML = "";

  days.forEach((when) => {
    const group = document.createElement("div");
    group.className = "schedule-date-group";

    const heading = document.createElement("h3");
    heading.textContent = dateLabel(when);
    group.appendChild(heading);

    turfOptions.forEach(([turf, label]) => {
      const turfHeading = document.createElement("h4");
      turfHeading.className = "schedule-turf-heading";
      turfHeading.textContent = label;
      group.appendChild(turfHeading);

      const slots = document.createElement("div");
      slots.className = "schedule-slot-grid";

      slotTimeline.forEach((slot) => {
        const state = getBookingForSlot(when, slot, turf);
        const card = document.createElement(state ? "div" : "button");
        card.className = "slot-card";

        if (state?.status === "approved") {
          card.classList.add("slot-card-approved");
        } else if (state?.status === "pending") {
          card.classList.add("slot-card-pending");
        } else {
          card.classList.add("slot-card-open");
        }

        card.innerHTML = `
          <span class="slot-time">${slot}</span>
          <strong>${state ? (state.status === "approved" ? "Blocked" : "Pending") : "Available"}</strong>
        `;
        if (!state) {
          card.type = "button";
          card.classList.add("slot-card-selectable");
          card.setAttribute("aria-label", `Select ${label} at ${slot} on ${dayLabel(when)}`);
          card.addEventListener("click", () => selectSlot(when, turf, slot));
        } else {
          card.setAttribute("aria-label", `${label} at ${slot} is ${state.status === "approved" ? "blocked" : "pending"}`);
        }
        slots.appendChild(card);
      });

      group.appendChild(slots);
    });
    panel.appendChild(group);
  });
  updateAvailabilitySummary();
  updatePriceSummary();
  renderAdminPanel();
}

function setTicketState({ name, phone, when, slot, turf, paymentState, approvalState, foot }) {
  document.getElementById("ticket-code").textContent = codeFor(name);
  document.getElementById("ticket-when").textContent = `${dateLabel(when)} · ${slot}`;
  document.getElementById("ticket-who").textContent = `${name} · ${phone}`;
  document.getElementById("ticket-turf").textContent = turfLabel(turf);
  document.getElementById("ticket-price").textContent = priceLabel(turf, slot);
  document.getElementById("ticket-payment").textContent =
    paymentState === "Awaiting admin" ? "Pending admin review" : paymentState;
  document.getElementById("ticket-status").textContent = approvalState;
  document.getElementById("ticket-foot").textContent = foot;
}

function isWithinPeriod(timestamp, period) {
  const now = Date.now();
  const age = now - timestamp;
  const day = 24 * 60 * 60 * 1000;

  if (period === "day") return new Date(timestamp).toDateString() === new Date(now).toDateString();
  if (period === "week") return age >= 0 && age < 7 * day;
  return age >= 0 && age < 30 * day;
}

function renderPaymentSummary(approved) {
  const summaryGrid = document.getElementById("payment-summary-grid");
  const paymentList = document.getElementById("payment-list");
  const paidCount = document.getElementById("paid-reservation-count");
  if (!summaryGrid || !paymentList || !paidCount) return;

  const periods = [
    ["day", "Today"],
    ["week", "This week"],
    ["month", "This month"],
  ];

  summaryGrid.innerHTML = periods
    .map(([key, label]) => {
      const count = approved.filter((entry) => isWithinPeriod(entry.approvedAt || entry.createdAt, key)).length;
      return `<article class="payment-summary-card"><span>${label}</span><strong>${count}</strong><small>paid bookings</small></article>`;
    })
    .join("");

  paidCount.textContent = `${approved.length} total`;
  paymentList.innerHTML = approved.length
    ? approved
        .map(
          (entry) => `
            <article class="payment-list-item">
              <div>
                <strong>#${entry.reservationNo} · ${entry.name}</strong>
                <p>${turfLabel(entry.turf)} · ${dateLabel(entry.when)} · ${entry.slot} · ${priceLabel(entry.turf, entry.slot)} · ${entry.phone}</p>
              </div>
              <span class="admin-status admin-status-approved">Paid</span>
            </article>
          `
        )
        .join("")
    : '<p class="empty-state">No paid reservations yet.</p>';
}

function renderAdminStats(reservations) {
  const stats = document.getElementById("admin-stats-grid");
  if (!stats) return;

  const pending = reservations.filter((entry) => entry.status === "pending").length;
  const approved = reservations.filter((entry) => entry.status === "approved").length;
  const today = dateKey(0);
  const todayTotal = reservations.filter((entry) => entry.when === today).length;
  const currentMonth = today.slice(0, 7);
  const monthTotal = reservations.filter((entry) => entry.when.startsWith(currentMonth)).length;
  const bigTotal = reservations.filter((entry) => entry.turf === "big").length;
  const smallTotal = reservations.filter((entry) => entry.turf === "small").length;
  const confirmedSales = reservations
    .filter((entry) => entry.status === "approved")
    .reduce((total, entry) => total + Number(entry.price || priceFor(entry.turf, entry.slot)), 0);
  const cards = [
    ["Requests today", todayTotal, "booked slots"],
    ["This month", monthTotal, "total bookings"],
    ["Needs review", pending, "pending approvals"],
    ["Confirmed", approved, "approved slots"],
    ["Big Turf", bigTotal, "all-time requests"],
    ["Small Turf", smallTotal, "all-time requests"],
    ["Confirmed sales", formatCurrency(confirmedSales), "approved turf value"],
  ];
  stats.innerHTML = cards
    .map(([label, value, detail]) => `<article class="admin-stat-card"><span>${label}</span><strong>${value}</strong><small>${detail}</small></article>`)
    .join("");
}

function bindPricingEditor() {
  const form = document.getElementById("pricing-form");
  if (!form || form.dataset.bound) return;
  form.dataset.bound = "true";
  form.elements.bigMorning.value = pricing.big_morning;
  form.elements.bigLater.value = pricing.big_later;
  form.elements.smallAllDay.value = pricing.small_all_day;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = document.getElementById("pricing-message");
    try {
      const updated = await apiRequest("/api/pricing", {
        method: "PUT",
        body: JSON.stringify({
          bigMorning: form.elements.bigMorning.value,
          bigLater: form.elements.bigLater.value,
          smallAllDay: form.elements.smallAllDay.value,
        }),
      });
      pricing = updated;
      if (message) message.textContent = "Prices saved. New bookings will use these rates.";
      const updatedLabel = document.getElementById("pricing-updated");
      if (updatedLabel) updatedLabel.textContent = "Saved just now";
    } catch (error) {
      if (message) message.textContent = error.message;
    }
  });
}

function renderAdminPanel() {
  const list = document.getElementById("admin-request-list");
  const adminPanel = document.getElementById("admin-panel");
  const isLoggedIn = document.body.dataset.adminLoggedIn === "true";

  if (!list || !adminPanel) return;

  if (!isLoggedIn) {
    adminPanel.hidden = true;
    return;
  }

  const reservations = Array.from(bookingState.values()).sort(
    (first, second) => second.createdAt - first.createdAt
  );
  const approved = reservations.filter((entry) => entry.status === "approved");
  renderAdminStats(reservations);
  renderPaymentSummary(approved);
  bindPricingEditor();
  adminPanel.hidden = false;

  const searchInput = document.getElementById("admin-search");
  const filterInput = document.getElementById("admin-filter");
  const refreshButton = document.getElementById("admin-refresh-btn");
  if (searchInput && !searchInput.dataset.bound) {
    searchInput.dataset.bound = "true";
    searchInput.addEventListener("input", () => {
      adminSearch = searchInput.value.trim().toLowerCase();
      renderAdminPanel();
    });
  }
  if (filterInput && !filterInput.dataset.bound) {
    filterInput.dataset.bound = "true";
    filterInput.addEventListener("change", () => {
      adminFilter = filterInput.value;
      renderAdminPanel();
    });
  }
  if (refreshButton && !refreshButton.dataset.bound) {
    refreshButton.dataset.bound = "true";
    refreshButton.addEventListener("click", () => loadBookings());
  }
  if (searchInput) searchInput.value = adminSearch;
  if (filterInput) filterInput.value = adminFilter;
  const updated = document.getElementById("admin-updated");
  if (updated) updated.textContent = `Updated ${new Intl.DateTimeFormat("en-IN", { timeStyle: "short" }).format(new Date())}`;

  const pending = reservations.filter((entry) => entry.status === "pending");
  const pendingCount = document.getElementById("pending-reservation-count");
  if (pendingCount) pendingCount.textContent = `${pending.length} pending`;

  const visibleReservations = reservations.filter((entry) => {
    const matchesFilter = adminFilter === "all" || entry.status === adminFilter;
    const searchable = `${entry.name} ${entry.phone} ${turfLabel(entry.turf)} ${entry.slot}`.toLowerCase();
    return matchesFilter && (!adminSearch || searchable.includes(adminSearch));
  });

  if (!visibleReservations.length) {
    list.innerHTML = `<p class="empty-state">No reservations match this view.</p>`;
    return;
  }

  list.innerHTML = visibleReservations
    .map(
      (entry) => `
        <article class="admin-request-item">
          <div>
            <strong>#${entry.reservationNo} · ${entry.name}</strong>
            <p>${entry.phone}</p>
            <p>${turfLabel(entry.turf)} · ${dateLabel(entry.when)} · ${entry.slot} · ${priceLabel(entry.turf, entry.slot)}</p>
          </div>
          ${entry.status === "pending"
            ? `<div class="admin-request-actions">
                <button type="button" data-request-action="approve" data-request-key="${entry.key}">Approve</button>
                <button type="button" class="reject-btn" data-request-action="reject" data-request-key="${entry.key}">Reject</button>
              </div>`
            : '<span class="admin-status admin-status-approved">Approved</span>'}
        </article>
      `
    )
    .join("");

  list.querySelectorAll("button[data-request-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const key = button.getAttribute("data-request-key");
      const booking = bookingState.get(key);
      if (!booking) return;

      const action = button.dataset.requestAction;
      try {
        const updatedBooking = await changeBookingStatus(key, action);
        bookingState.set(key, updatedBooking);
      } catch (error) {
        alert(error.message);
        return;
      }
      renderSchedule();

      if (lastSubmittedBookingKey === key && action === "approve") {
        setTicketState({
          name: booking.name,
          phone: booking.phone,
          when: booking.when,
          slot: booking.slot,
          turf: booking.turf,
          paymentState: "Paid",
          approvalState: "Approved by admin",
          foot: "Approved and blocked. This slot is now confirmed for the customer.",
        });
      }

      const note = document.getElementById("hold-note");
      if (note) {
        note.hidden = false;
        note.textContent = action === "approve"
          ? `Approved by admin: ${booking.name} booked ${booking.slot} on ${dayLabel(booking.when)}.`
          : `Request rejected: ${booking.name}'s ${booking.slot} request was removed.`;
      }
    });
  });
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

function renderSalesPage() {
  const monthInput = document.getElementById("sales-month");
  const stats = document.getElementById("sales-stats");
  const list = document.getElementById("sales-list");
  const countLabel = document.getElementById("sales-booking-count");
  if (!monthInput || !stats || !list || !countLabel) return;

  if (!monthInput.value) monthInput.value = dateKey(0).slice(0, 7);
  const month = monthInput.value;
  const bookings = Array.from(bookingState.values())
    .filter((entry) => entry.when.startsWith(month))
    .sort((first, second) => first.when.localeCompare(second.when) || first.slot.localeCompare(second.slot));
  const approved = bookings.filter((entry) => entry.status === "approved");
  const pending = bookings.filter((entry) => entry.status === "pending");
  const revenue = approved.reduce((total, entry) => total + Number(entry.price || priceFor(entry.turf, entry.slot)), 0);

  stats.innerHTML = [
    ["Total bookings", bookings.length, "all requests"],
    ["Approved", approved.length, "confirmed slots"],
    ["Pending", pending.length, "awaiting action"],
    ["Confirmed sales", formatCurrency(revenue), "approved turf value"],
  ].map(([label, value, detail]) => `<article class="sales-stat"><span>${label}</span><strong>${value}</strong><small>${detail}</small></article>`).join("");

  countLabel.textContent = `${bookings.length} slot${bookings.length === 1 ? "" : "s"}`;
  list.innerHTML = bookings.length
    ? bookings.map((entry) => `
            <article class="sales-row">
          <div>
            <strong>#${entry.reservationNo} · ${entry.name}</strong>
            <p>${entry.when} · ${entry.slot} · ${turfLabel(entry.turf)}</p>
          </div>
          <div class="sales-row-value">
            <strong>${formatCurrency(entry.price || priceFor(entry.turf, entry.slot))}</strong>
            <span class="admin-status ${entry.status === "approved" ? "admin-status-approved" : "sales-status-pending"}">${entry.status === "approved" ? "Approved" : "Pending"}</span>
          </div>
        </article>
      `).join("")
    : '<p class="empty-state">No bookings for this month.</p>';

  const updated = document.getElementById("sales-updated");
  if (updated) updated.textContent = `Updated ${new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date())}`;

  if (!monthInput.dataset.bound) {
    monthInput.dataset.bound = "true";
    monthInput.addEventListener("change", renderSalesPage);
    document.getElementById("sales-refresh-btn")?.addEventListener("click", () => loadBookings());
  }
}

function renderSettingsPage() {
  const form = document.getElementById("settings-verify-form");
  const locked = document.getElementById("settings-locked");
  if (!form || !locked) return;
  if (!adminToken) {
    form.hidden = true;
    locked.hidden = false;
    return;
  }

  form.hidden = false;
  locked.hidden = true;
  if (!form.dataset.bound) {
    form.dataset.bound = "true";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const message = document.getElementById("settings-message");
      try {
        const result = await apiRequest("/api/admin/settings/verify", {
          method: "POST",
          body: JSON.stringify({ currentCode: form.elements.currentCode.value, currentUsername: form.elements.currentUsername.value, currentPassword: form.elements.currentPassword.value }),
        });
        sessionStorage.setItem("iturf-settings-challenge", result.challenge);
        window.location.href = "credentials.html";
      } catch (error) {
        if (message) message.textContent = error.message;
      }
    });
  }
}

function renderCredentialsPage() {
  const form = document.getElementById("credentials-form");
  const locked = document.getElementById("credentials-locked");
  const challenge = sessionStorage.getItem("iturf-settings-challenge");
  if (!form || !locked) return;
  if (!adminToken || !challenge) {
    form.hidden = true;
    locked.hidden = false;
    return;
  }
  form.hidden = false;
  locked.hidden = true;
  form.elements.bigMorning.value = pricing.big_morning;
  form.elements.bigLater.value = pricing.big_later;
  form.elements.smallAllDay.value = pricing.small_all_day;
  if (form.dataset.bound) return;
  form.dataset.bound = "true";
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = document.getElementById("credentials-message");
    try {
      await apiRequest("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify({ settingsChallenge: challenge, code: form.elements.code.value, username: form.elements.username.value, password: form.elements.password.value, bigMorning: form.elements.bigMorning.value, bigLater: form.elements.bigLater.value, smallAllDay: form.elements.smallAllDay.value }),
      });
      sessionStorage.removeItem("iturf-settings-challenge");
      if (message) message.textContent = "New encrypted credentials saved. Log out and use them next time.";
      form.reset();
    } catch (error) {
      if (message) message.textContent = error.message;
    }
  });
}

function setAdminState(isLoggedIn) {
  document.body.dataset.adminLoggedIn = String(isLoggedIn);
  const adminSection = document.getElementById("admin-section");
  const codeForm = document.getElementById("admin-code-form");
  const loginForm = document.getElementById("admin-login-form");
  const adminPanel = document.getElementById("admin-panel");
  const secretLogin = document.getElementById("admin-secret-login");
  const credentialsLogin = document.getElementById("admin-credentials-login");
  const logoutBtn = document.getElementById("logout-btn");
  const codeUnlocked = document.body.dataset.adminCodeUnlocked === "true";

  const showAdmin = isAdminPage || window.location.hash === "#admin";
  if (!adminSection) return;

  adminSection.hidden = !(showAdmin || isLoggedIn);
  if (codeForm) codeForm.hidden = isLoggedIn;
  if (loginForm) loginForm.hidden = isLoggedIn || !codeUnlocked;
  if (adminPanel) adminPanel.hidden = !isLoggedIn;
  if (secretLogin) secretLogin.hidden = isLoggedIn;
  if (credentialsLogin) credentialsLogin.hidden = isLoggedIn || !document.body.dataset.adminCodeUnlocked;
  if (logoutBtn) logoutBtn.hidden = !isLoggedIn;

  renderAdminPanel();
}

const adminSecretLogin = document.getElementById("admin-secret-login");
const adminCredentialsLogin = document.getElementById("admin-credentials-login");

if (adminSecretLogin) {
  adminSecretLogin.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = document.getElementById("admin-login-message");
    try {
      const response = await apiRequest("/api/admin/unlock", {
        method: "POST",
        body: JSON.stringify({ code: document.getElementById("admin-secret-code").value.trim() }),
      });
      adminChallenge = response.challenge;
      adminSecretLogin.hidden = true;
      if (adminCredentialsLogin) adminCredentialsLogin.hidden = false;
    } catch (error) {
      if (message) message.textContent = error.message;
    }
  });
}

if (adminCredentialsLogin) {
  adminCredentialsLogin.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = document.getElementById("admin-credentials-message");
    try {
      const response = await apiRequest("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({
          challenge: adminChallenge,
          username: document.getElementById("admin-username").value.trim(),
          password: document.getElementById("admin-password").value,
        }),
      });
      adminToken = response.token;
      sessionStorage.setItem("iturf-admin-token", adminToken);
      adminCredentialsLogin.hidden = true;
      setAdminState(true);
      await loadBookings();
    } catch (error) {
      if (message) message.textContent = error.message;
    }
  });
}

const whenInput = document.getElementById("when");
const bookingForm = document.getElementById("book-form");

if (whenInput) {
  whenInput.addEventListener("change", renderSchedule);
}

const turfInput = document.getElementById("turf");

if (turfInput) {
  turfInput.addEventListener("change", renderSchedule);
}

const slotInput = document.getElementById("slot");

if (slotInput) {
  slotInput.addEventListener("change", updatePriceSummary);
}

if (bookingForm) {
  bookingForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    const name = String(data.get("name")).trim();
    const when = data.get("when");
    const turf = data.get("turf");
    const phone = String(data.get("phone")).trim();
    const slots = Array.from(selectedSlots);

    if (!slots.length) {
      if (holdNote) holdNote.textContent = "Select at least one available slot to continue.";
      return;
    }

    if (slots.some((slot) => getBookingForSlot(when, slot, turf)?.status === "approved")) {
      if (holdNote) {
        holdNote.hidden = false;
        holdNote.textContent = `One of the selected ${turfLabel(turf)} slots is already blocked. Please choose again.`;
      }
      return;
    }

    if (slots.some((slot) => getBookingForSlot(when, slot, turf)?.status === "pending")) {
      if (holdNote) {
        holdNote.hidden = false;
        holdNote.textContent = `One of the selected ${turfLabel(turf)} slots is already awaiting review. Please choose again.`;
      }
      return;
    }

    const approvalState = "Pending admin approval";
    const foot = "Submitted for review. Only the admin can approve this request and block the slot.";

    const bookings = slots.map((slot) => ({
      key: getSlotKey(when, slot, turf),
      name,
      phone,
      when,
      slot,
      turf,
      price: priceFor(turf, slot),
      paymentMethod: "venue",
    }));

    localStorage.setItem(CUSTOMER_PROFILE_KEY, JSON.stringify({ name, phone }));
    const welcome = document.getElementById("welcome-message");
    if (welcome) welcome.textContent = `Welcome back, ${name}`;

    let savedBookings;
    try {
      savedBookings = await createBookings(bookings);
    } catch (error) {
      if (holdNote) {
        holdNote.hidden = false;
        holdNote.textContent = error.message;
      }
      renderSchedule();
      return;
    }
    lastSubmittedBookingKey = savedBookings[0].key;
    localStorage.setItem(CUSTOMER_BOOKING_KEY, JSON.stringify({ name, phone, bookings: savedBookings }));
    renderCustomerBooking(savedBookings, name, phone);

    if (holdNote) {
      holdNote.hidden = false;
      holdNote.textContent = `${savedBookings.length} ${turfLabel(turf)} slot${savedBookings.length === 1 ? "" : "s"} requested for ${dayLabel(when)}. Admin approval is required.`;
    }

    if (ticket) {
      ticket.hidden = false;
      setTicketState({
        name,
        phone,
        when,
        slot: slots[0],
        turf,
        paymentState: "Awaiting admin",
        approvalState,
        foot,
      });
    }

  selectedSlots.clear();
  if (slotInput) slotInput.value = "";
  bookingForm.hidden = true;
    renderSchedule();
    ticket?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
}

if (document.getElementById("logout-btn")) {
  document.getElementById("logout-btn").addEventListener("click", () => {
    adminToken = "";
    sessionStorage.removeItem("iturf-admin-token");
    setAdminState(false);
  });
}

if (isAdminPage) {
  setAdminState(Boolean(adminToken));
} else {
  const adminSection = document.getElementById("admin-section");
  if (adminSection) {
    adminSection.hidden = true;
  }
}

window.addEventListener("hashchange", () => {
  if (isAdminPage || window.location.hash === "#admin") {
    setAdminState(false);
  } else {
    const adminSection = document.getElementById("admin-section");
    if (adminSection) adminSection.hidden = true;
  }
});

loadBookings().catch((error) => {
  const summary = document.getElementById("availability-summary");
  if (summary) summary.textContent = "Database connection unavailable. Start the iTurf server to load reservations.";
  console.error(error);
});
