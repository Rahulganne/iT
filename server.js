const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 3000;
const ADMIN_CODE_HASH = process.env.ADMIN_CODE_HASH || "";
const ADMIN_USER_HASH = process.env.ADMIN_USER_HASH || "";
const ADMIN_PASS_HASH = process.env.ADMIN_PASS_HASH || "";
const adminSessions = new Map();
const adminChallenges = new Map();
const settingsChallenges = new Map();

function verifySecret(value, storedHash) {
  const [salt, expectedHex] = String(storedHash).split(":");
  if (!salt || !expectedHex) return false;
  const actual = crypto.scryptSync(value, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

function hashSecret(value) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(value, salt, 64).toString("hex")}`;
}
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATABASE_FILE = path.join(DATA_DIR, "iturf.db");

fs.mkdirSync(DATA_DIR, { recursive: true });
const database = new Database(DATABASE_FILE);
database.pragma("journal_mode = WAL");
database.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    when_value TEXT NOT NULL,
    slot TEXT NOT NULL,
    turf TEXT NOT NULL,
    price INTEGER NOT NULL,
    payment_method TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved')),
    created_at INTEGER NOT NULL,
    approved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS bookings_slot_index
    ON bookings (when_value, slot, turf, status);
  CREATE TABLE IF NOT EXISTS pricing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    big_morning INTEGER NOT NULL DEFAULT 500,
    big_later INTEGER NOT NULL DEFAULT 600,
    small_all_day INTEGER NOT NULL DEFAULT 250,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_credentials (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    code_hash TEXT NOT NULL,
    user_hash TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
const bookingColumns = database.prepare("PRAGMA table_info(bookings)").all().map((column) => column.name);
if (!bookingColumns.includes("reservation_no")) {
  database.exec("ALTER TABLE bookings ADD COLUMN reservation_no INTEGER");
  const legacyBookings = database.prepare("SELECT key FROM bookings ORDER BY created_at ASC").all();
  const setLegacyNumber = database.prepare("UPDATE bookings SET reservation_no = ? WHERE key = ?");
  legacyBookings.forEach((booking, index) => setLegacyNumber.run(index + 1, booking.key));
}
database.prepare(`INSERT OR IGNORE INTO pricing (id, big_morning, big_later, small_all_day, updated_at)
  VALUES (1, 500, 600, 250, ?)`).run(Date.now());
database.prepare(`INSERT OR IGNORE INTO admin_credentials (id, code_hash, user_hash, pass_hash, updated_at)
  VALUES (1, ?, ?, ?, ?)`).run(ADMIN_CODE_HASH, ADMIN_USER_HASH, ADMIN_PASS_HASH, Date.now());

const bookingSchema = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bookings'").get()?.sql || "";
if (!bookingSchema.includes("'rejected'")) {
  database.pragma("foreign_keys = OFF");
  database.exec(`
    ALTER TABLE bookings RENAME TO bookings_legacy;
    CREATE TABLE bookings (
      key TEXT PRIMARY KEY,
      reservation_no INTEGER,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      when_value TEXT NOT NULL,
      slot TEXT NOT NULL,
      turf TEXT NOT NULL,
      price INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
      created_at INTEGER NOT NULL,
      approved_at INTEGER
    );
    INSERT INTO bookings (key, reservation_no, name, phone, when_value, slot, turf, price, payment_method, status, created_at, approved_at)
      SELECT key, reservation_no, name, phone, when_value, slot, turf, price, payment_method, status, created_at, approved_at FROM bookings_legacy;
    DROP TABLE bookings_legacy;
    CREATE INDEX IF NOT EXISTS bookings_slot_index ON bookings (when_value, slot, turf, status);
  `);
  database.pragma("foreign_keys = ON");
}

const selectPricing = database.prepare("SELECT big_morning, big_later, small_all_day, updated_at FROM pricing WHERE id = 1");
const updatePricing = database.prepare("UPDATE pricing SET big_morning = ?, big_later = ?, small_all_day = ?, updated_at = ? WHERE id = 1");
const selectAdminCredentials = database.prepare("SELECT code_hash, user_hash, pass_hash FROM admin_credentials WHERE id = 1");
const updateAdminCredentials = database.prepare("UPDATE admin_credentials SET code_hash = ?, user_hash = ?, pass_hash = ?, updated_at = ? WHERE id = 1");

function localDateKey(offset) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

const migrateLegacyDates = database.transaction(() => {
  const legacyRows = database
    .prepare("SELECT key, when_value, turf, slot FROM bookings WHERE when_value IN ('today', 'tomorrow')")
    .all();
  const updateLegacyRow = database.prepare(
    "UPDATE bookings SET key = ?, when_value = ? WHERE key = ?"
  );
  legacyRows.forEach((row) => {
    const date = localDateKey(row.when_value === "tomorrow" ? 1 : 0);
    updateLegacyRow.run(`${date}|${row.turf}|${row.slot}`, date, row.key);
  });
});
migrateLegacyDates();

const selectBooking = database.prepare("SELECT * FROM bookings WHERE key = ?");
const selectBookings = database.prepare("SELECT * FROM bookings ORDER BY created_at DESC");
const nextReservationNumber = database.prepare("SELECT COALESCE(MAX(reservation_no), 0) + 1 AS next_number FROM bookings");
const insertBooking = database.prepare(`
  INSERT INTO bookings (
    key, reservation_no, name, phone, when_value, slot, turf, price, payment_method,
    status, created_at, approved_at
  ) VALUES (@key, @reservationNo, @name, @phone, @whenValue, @slot, @turf, @price, @paymentMethod,
    @status, @createdAt, @approvedAt)
`);
const updateBookingStatus = database.prepare(
  "UPDATE bookings SET status = ?, approved_at = ? WHERE key = ?"
);
const deleteBooking = database.prepare("DELETE FROM bookings WHERE key = ?");
const findActiveSlot = database.prepare(
  "SELECT key FROM bookings WHERE when_value = ? AND slot = ? AND turf = ? AND status IN ('pending', 'approved')"
);
function serverPriceFor(turf, slot) {
  const current = selectPricing.get();
  if (turf === "small") return current.small_all_day;
  return slot === "12:00 am" || slot === "12:00 pm" || ["1:00 pm", "2:00 pm", "3:00 pm", "4:00 pm", "5:00 pm", "6:00 pm", "7:00 pm", "8:00 pm", "9:00 pm", "10:00 pm", "11:00 pm"].includes(slot)
    ? current.big_later
    : current.big_morning;
}
const insertBookings = database.transaction((bookings) => {
  const seenSlots = new Set();
  bookings.forEach((body) => {
    if (seenSlots.has(body.slot) || findActiveSlot.get(body.when, body.slot, body.turf)) {
      throw new Error("One or more selected turf slots are no longer available.");
    }
    seenSlots.add(body.slot);
  });

  const now = Date.now();
  return bookings.map((body) => {
    const booking = {
      key: String(body.key),
      reservationNo: nextReservationNumber.get().next_number,
      name: String(body.name).trim(),
      phone: String(body.phone).trim(),
      whenValue: String(body.when),
      slot: String(body.slot),
      turf: String(body.turf),
      price: serverPriceFor(body.turf, body.slot),
      paymentMethod: "venue",
      status: "pending",
      createdAt: now,
      approvedAt: null,
    };
    insertBooking.run(booking);
    return toBooking(selectBooking.get(booking.key));
  });
});

function toBooking(row) {
  if (!row) return null;
  return {
    key: row.key,
    reservationNo: row.reservation_no,
    name: row.name,
    phone: row.phone,
    when: row.when_value,
    slot: row.slot,
    turf: row.turf,
    price: row.price,
    paymentMethod: row.payment_method,
    status: row.status,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  };
}

function toPublicBooking(row) {
  const booking = toBooking(row);
  return {
    key: booking.key,
    when: booking.when,
    slot: booking.slot,
    turf: booking.turf,
    status: booking.status,
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy();
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function isAdminAuthenticated(request) {
  const header = request.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expiresAt = adminSessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function handleApi(request, response, pathname) {
  if (request.method === "POST" && pathname === "/api/admin/unlock") {
    return readJson(request)
      .then((body) => {
        if (!verifySecret(body.code, selectAdminCredentials.get().code_hash)) return sendJson(response, 401, { error: "Invalid admin secret code." });
        const challenge = crypto.randomBytes(32).toString("hex");
        adminChallenges.set(challenge, Date.now() + 5 * 60 * 1000);
        return sendJson(response, 200, { challenge });
      })
      .catch(() => sendJson(response, 400, { error: "Invalid unlock data." }));
  }

  if (request.method === "POST" && pathname === "/api/admin/login") {
    return readJson(request)
      .then((body) => {
        const expiresAt = adminChallenges.get(body.challenge);
        if (!expiresAt || expiresAt < Date.now()) {
          adminChallenges.delete(body.challenge);
          return sendJson(response, 401, { error: "Complete the secret-code step first." });
        }
        adminChallenges.delete(body.challenge);
        const credentials = selectAdminCredentials.get();
        if (!verifySecret(body.username, credentials.user_hash) || !verifySecret(body.password, credentials.pass_hash)) {
          return sendJson(response, 401, { error: "Invalid admin username or password." });
        }
        const token = crypto.randomBytes(32).toString("hex");
        adminSessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
        return sendJson(response, 200, { token });
      })
      .catch(() => sendJson(response, 400, { error: "Invalid login data." }));
  }

  if (request.method === "GET" && pathname === "/api/pricing") {
    return sendJson(response, 200, selectPricing.get());
  }

  if (request.method === "PUT" && pathname === "/api/pricing") {
    if (!isAdminAuthenticated(request)) {
      return sendJson(response, 401, { error: "Admin login required." });
    }
    return readJson(request)
      .then((body) => {
        const values = [Number(body.bigMorning), Number(body.bigLater), Number(body.smallAllDay)];
        if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 100000)) {
          return sendJson(response, 400, { error: "Prices must be whole numbers between 0 and 100000." });
        }
        updatePricing.run(...values, Date.now());
        return sendJson(response, 200, selectPricing.get());
      })
      .catch(() => sendJson(response, 400, { error: "Invalid pricing data." }));
  }

  if (request.method === "PUT" && pathname === "/api/admin/settings") {
    if (!isAdminAuthenticated(request)) return sendJson(response, 401, { error: "Admin login required." });
    return readJson(request)
      .then((body) => {
        const settingsExpiry = settingsChallenges.get(body.settingsChallenge);
        if (!settingsExpiry || settingsExpiry < Date.now()) {
          settingsChallenges.delete(body.settingsChallenge);
          return sendJson(response, 401, { error: "Verify the current credentials first." });
        }
        settingsChallenges.delete(body.settingsChallenge);
        const currentCredentials = selectAdminCredentials.get();
        const prices = [Number(body.bigMorning), Number(body.bigLater), Number(body.smallAllDay)];
        if (![body.code, body.username, body.password].every((value) => typeof value === "string" && value.trim())) {
          return sendJson(response, 400, { error: "All credential fields are required." });
        }
        if (prices.some((value) => !Number.isInteger(value) || value < 0 || value > 100000)) {
          return sendJson(response, 400, { error: "Prices must be whole numbers between 0 and 100000." });
        }
        updateAdminCredentials.run(hashSecret(body.code.trim()), hashSecret(body.username.trim()), hashSecret(body.password), Date.now());
        updatePricing.run(...prices, Date.now());
        return sendJson(response, 200, { ok: true });
      })
      .catch(() => sendJson(response, 400, { error: "Invalid settings data." }));
  }

  if (request.method === "POST" && pathname === "/api/admin/settings/verify") {
    if (!isAdminAuthenticated(request)) return sendJson(response, 401, { error: "Admin login required." });
    return readJson(request)
      .then((body) => {
        const credentials = selectAdminCredentials.get();
        if (!verifySecret(body.currentCode, credentials.code_hash) || !verifySecret(body.currentUsername, credentials.user_hash) || !verifySecret(body.currentPassword, credentials.pass_hash)) {
          return sendJson(response, 401, { error: "Current admin credentials are incorrect." });
        }
        const challenge = crypto.randomBytes(32).toString("hex");
        settingsChallenges.set(challenge, Date.now() + 10 * 60 * 1000);
        return sendJson(response, 200, { challenge });
      })
      .catch(() => sendJson(response, 400, { error: "Invalid verification data." }));
  }
  if (request.method === "GET" && pathname === "/api/bookings") {
    const mapper = isAdminAuthenticated(request) ? toBooking : toPublicBooking;
    return sendJson(response, 200, selectBookings.all().map(mapper));
  }

  if (request.method === "POST" && pathname === "/api/bookings") {
    return readJson(request)
      .then((body) => {
        const required = ["key", "name", "phone", "when", "slot", "turf", "price", "paymentMethod"];
        if (required.some((field) => body[field] === undefined || body[field] === "")) {
          return sendJson(response, 400, { error: "All booking details are required." });
        }

        if (findActiveSlot.get(body.when, body.slot, body.turf)) {
          return sendJson(response, 409, { error: "This turf slot is no longer available." });
        }

        if (body.paymentMethod === "online") {
          return sendJson(response, 503, { error: "Online payments are not configured yet. Please choose pay at venue." });
        }

        const now = Date.now();
        const booking = {
          key: String(body.key),
          reservationNo: nextReservationNumber.get().next_number,
          name: String(body.name).trim(),
          phone: String(body.phone).trim(),
          whenValue: String(body.when),
          slot: String(body.slot),
          turf: String(body.turf),
          price: serverPriceFor(body.turf, body.slot),
          paymentMethod: "venue",
          status: "pending",
          createdAt: now,
          approvedAt: null,
        };

        insertBooking.run(booking);
        return sendJson(response, 201, toBooking(selectBooking.get(booking.key)));
      })
      .catch(() => sendJson(response, 400, { error: "Invalid booking data." }));
  }

  if (request.method === "POST" && pathname === "/api/bookings/bulk") {
    return readJson(request)
      .then((body) => {
        if (!Array.isArray(body.bookings) || !body.bookings.length) {
          return sendJson(response, 400, { error: "Select at least one slot." });
        }
        const required = ["key", "name", "phone", "when", "slot", "turf", "price"];
        if (body.bookings.some((booking) => required.some((field) => booking[field] === undefined || booking[field] === ""))) {
          return sendJson(response, 400, { error: "All booking details are required." });
        }
        return sendJson(response, 201, insertBookings(body.bookings));
      })
      .catch((error) => sendJson(response, error.message.includes("no longer") ? 409 : 400, { error: error.message }));
  }

  const actionMatch = pathname.match(/^\/api\/bookings\/([^/]+)\/action$/);
  if (request.method === "PATCH" && actionMatch) {
    if (!isAdminAuthenticated(request)) {
      return sendJson(response, 401, { error: "Admin login required." });
    }
    return readJson(request)
      .then((body) => {
        const key = decodeURIComponent(actionMatch[1]);
        const booking = selectBooking.get(key);
        if (!booking) return sendJson(response, 404, { error: "Booking not found." });

        if (body.action === "reject") {
          database.prepare("UPDATE bookings SET status = 'rejected' WHERE key = ?").run(key);
          return sendJson(response, 200, toBooking(selectBooking.get(key)));
        }

        if (body.action === "approve") {
          updateBookingStatus.run("approved", Date.now(), key);
          return sendJson(response, 200, toBooking(selectBooking.get(key)));
        }

        return sendJson(response, 400, { error: "Unknown booking action." });
      })
      .catch(() => sendJson(response, 400, { error: "Invalid action." }));
  }

  sendJson(response, 404, { error: "API route not found." });
}

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

function serveStatic(response, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(ROOT, `.${requestedPath}`);
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    response.writeHead(404);
    return response.end("Not found");
  }

  const extension = path.extname(filePath).toLowerCase();
  response.writeHead(200, { "Content-Type": contentTypes[extension] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (requestUrl.pathname.startsWith("/api/")) {
    if (request.method === "OPTIONS") return sendJson(response, 204, {});
    return handleApi(request, response, requestUrl.pathname);
  }
  serveStatic(response, requestUrl.pathname);
});

server.listen(PORT, () => {
  console.log(`iTurf is running at http://localhost:${PORT}`);
  console.log(`Database: ${DATABASE_FILE}`);
});
