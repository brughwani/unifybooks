/**
 * mixpanel.js — Shared Mixpanel utility for Cloud Functions
 *
 * Usage:
 *   const { track, identify } = require("../mixpanel");
 *   track("invoice_created", orgId, { amount: 500, to_org: "XYZ" });
 *
 * Set your token via Firebase Functions config or env var:
 *   firebase functions:config:set mixpanel.token="YOUR_TOKEN"
 * Or locally via .env:
 *   MIXPANEL_TOKEN=YOUR_TOKEN
 */

const Mixpanel = require("mixpanel");

let _client = null;

function getClient() {
  if (_client) return _client;

  // Support both Firebase Functions config and plain env var
  const token =
    (process.env.MIXPANEL_TOKEN) ||
    (process.env.FUNCTIONS_EMULATOR ? "dev-token" : null);

  if (!token) {
    console.warn("[Mixpanel] MIXPANEL_TOKEN not set — events will be skipped.");
    return null;
  }

  _client = Mixpanel.init(token, { protocol: "https" });
  return _client;
}

/**
 * Track a server-side event.
 * @param {string} event - Event name, e.g. "invoice_created"
 * @param {string} distinctId - The org's unique ID (PAN / phone:xxx uid)
 * @param {object} [props] - Additional properties to attach
 */
function track(event, distinctId, props = {}) {
  const client = getClient();
  if (!client) return;

  try {
    client.track(event, {
      distinct_id: distinctId || "anonymous",
      platform: "server",
      ...props,
    });
  } catch (err) {
    // Never let tracking break the main flow
    console.warn("[Mixpanel] track error:", err.message);
  }
}

/**
 * Set / update a user profile in Mixpanel People.
 * @param {string} distinctId
 * @param {object} props - Profile properties
 */
function identify(distinctId, props = {}) {
  const client = getClient();
  if (!client) return;

  try {
    client.people.set(distinctId, {
      $distinct_id: distinctId,
      ...props,
    });
  } catch (err) {
    console.warn("[Mixpanel] identify error:", err.message);
  }
}

module.exports = { track, identify };
