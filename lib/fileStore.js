// Holds converted PDFs in memory for a few minutes so the app can download them by an unguessable link.
const crypto = require("crypto");

const TTL_MS = 15 * 60 * 1000;
const MAX_ITEMS = 40;
const MAX_BYTES = 150 * 1024 * 1024;
const store = new Map();

function cleanup() {
  const now = Date.now();
  let bytes = 0;
  for (const [id, e] of store) { if (e.exp < now) store.delete(id); else bytes += e.buffer.length; }
  while (store.size > MAX_ITEMS || bytes > MAX_BYTES) {         // drop the oldest first
    const [id, e] = store.entries().next().value;
    bytes -= e.buffer.length; store.delete(id);
  }
}

function put(buffer, name) {
  cleanup();
  const id = crypto.randomBytes(24).toString("hex");            // 48 hex chars
  store.set(id, { buffer, name, exp: Date.now() + TTL_MS });
  cleanup();
  return id;
}

function get(id) {
  const e = store.get(id);
  if (!e) return null;
  if (e.exp < Date.now()) { store.delete(id); return null; }
  return e;
}

setInterval(cleanup, 60 * 1000).unref();
module.exports = { put, get };
