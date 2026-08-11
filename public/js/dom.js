// Small DOM utilities shared by every rendering module.

export const $ = (id) => document.getElementById(id);

export function escapeHTML(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// Push a short message to the visually-hidden polite live region so screen-reader
// users hear the same updates sighted users see (fields filling, validation,
// address options, mic state, save status). Clearing first forces re-announcement
// even when the same text repeats.
let announceTimer = null;
export function announce(msg) {
  const el = $("srAnnounce");
  if (!el || !msg) return;
  el.textContent = "";
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { el.textContent = msg; }, 40);
}

// Spoken form of a field value for the live region.
export function spokenValue(f, v) {
  return v || "cleared";
}
