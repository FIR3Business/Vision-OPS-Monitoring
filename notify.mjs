// Alerting for Vision OPS.
//
// Two delivery channels, both optional and independently configurable:
//   - Discord, via an incoming webhook URL
//   - SMS, via the Twilio REST API (plain fetch — no extra dependency)
//
// Every setting is read from process.env at call time rather than captured at
// import, because the landing page can write credentials into .env and
// process.env while the server is already running (see /api/alerts).

const SMS_MAX_CHARACTERS = 320;
const DISCORD_MAX_CHARACTERS = 1900;
const TWILIO_TIMEOUT_MS = 10_000;

// Discord embed stripe colors, by how loud the alert is.
const SEVERITY_COLORS = {
  info: 0x5865f2,
  warning: 0xf0b232,
  critical: 0xed4245,
};

function envValue(name) {
  return String(process.env[name] ?? "").trim();
}

export function normalizePhoneNumber(value) {
  // Twilio wants E.164: a leading +, country code, then digits.
  const digits = String(value ?? "").replace(/[^\d+]/g, "");
  if (!digits) return "";
  if (digits.startsWith("+")) return digits;
  // A bare 10-digit number is almost always North American in this context.
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

export function isValidPhoneNumber(value) {
  return /^\+[1-9]\d{7,14}$/.test(String(value ?? ""));
}

export function isValidDiscordWebhook(value) {
  return /^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(
    String(value ?? "").trim(),
  );
}

function maskPhoneNumber(value) {
  const text = String(value ?? "");
  if (text.length < 5) return "";
  return `${text.slice(0, 2)}••••${text.slice(-4)}`;
}

// "Which channels should actually fire?" — ALERT_CHANNELS can force a subset
// ("discord", "sms", "both"/"all"); the default of "auto" simply uses every
// channel that has complete credentials.
function selectedChannels() {
  const preference = envValue("ALERT_CHANNELS").toLowerCase() || "auto";
  const status = alertStatus();
  if (preference === "discord") return status.discord.configured ? ["discord"] : [];
  if (preference === "sms" || preference === "text") return status.sms.configured ? ["sms"] : [];
  const channels = [];
  if (status.discord.configured) channels.push("discord");
  if (status.sms.configured) channels.push("sms");
  return channels;
}

export function alertStatus() {
  const webhook = envValue("DISCORD_WEBHOOK_URL");
  const accountSid = envValue("TWILIO_ACCOUNT_SID");
  const authToken = envValue("TWILIO_AUTH_TOKEN");
  const fromNumber = envValue("TWILIO_FROM_NUMBER");
  const messagingServiceSid = envValue("TWILIO_MESSAGING_SERVICE_SID");
  const toNumber = envValue("ALERT_PHONE_NUMBER");
  return {
    channels: envValue("ALERT_CHANNELS").toLowerCase() || "auto",
    cooldownMs: cooldownMs(),
    alertOnErrors: alertOnErrors(),
    discord: {
      configured: Boolean(webhook),
      valid: isValidDiscordWebhook(webhook),
    },
    sms: {
      configured: Boolean(
        accountSid && authToken && toNumber && (fromNumber || messagingServiceSid),
      ),
      hasAccount: Boolean(accountSid && authToken),
      hasSender: Boolean(fromNumber || messagingServiceSid),
      // Normalize before masking, so a number typed as "(555) 123-4567" in
      // .env still reads back as "+1••••4567" rather than "(5••••4567".
      toNumber: maskPhoneNumber(normalizePhoneNumber(toNumber)),
      fromNumber: fromNumber || (messagingServiceSid ? "messaging service" : ""),
    },
  };
}

function cooldownMs() {
  const raw = Number(process.env.ALERT_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5 * 60_000;
}

function alertOnErrors() {
  // Errors are noisier than confirmed failures, so this is opt-outable on its
  // own without disabling failure alerts.
  return envValue("ALERT_ON_ERRORS").toLowerCase() !== "false";
}

// A repeating fault (a stuck camera, an expired API key hit once per poll)
// would otherwise send one text per frame. Keyed suppression keeps at most one
// alert per dedupe key per cooldown window.
const lastSentAt = new Map();
function withinCooldown(key) {
  const window = cooldownMs();
  if (!key || window <= 0) return false;
  const previous = lastSentAt.get(key);
  const now = Date.now();
  if (previous !== undefined && now - previous < window) return true;
  lastSentAt.set(key, now);
  return false;
}

export function resetAlertCooldown(key) {
  if (key) lastSentAt.delete(key);
  else lastSentAt.clear();
}

function buildDiscordPayload({ title, body, fields, severity, footer }) {
  return {
    // Content carries the text too, so phone push previews and text-only
    // clients still show something useful if embeds are collapsed.
    content: `**${title}**\n${body}`.slice(0, DISCORD_MAX_CHARACTERS),
    embeds: [
      {
        title: title.slice(0, 250),
        description: body.slice(0, DISCORD_MAX_CHARACTERS),
        color: SEVERITY_COLORS[severity] ?? SEVERITY_COLORS.info,
        fields: (fields || [])
          .filter((field) => field?.name && field?.value)
          .slice(0, 10)
          .map((field) => ({
            name: String(field.name).slice(0, 100),
            value: String(field.value).slice(0, 200),
            inline: field.inline !== false,
          })),
        footer: { text: (footer || "Vision OPS").slice(0, 100) },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

async function sendDiscord(alert) {
  const url = envValue("DISCORD_WEBHOOK_URL");
  if (!url) return { ok: false, skipped: true, reason: "DISCORD_WEBHOOK_URL is not set." };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildDiscordPayload(alert)),
      signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        reason: `Discord responded with ${response.status}. ${detail.slice(0, 200)}`.trim(),
      };
    }
    return { ok: true, status: response.status };
  } catch (error) {
    return { ok: false, reason: `Discord webhook failed: ${error.message}` };
  }
}

function buildSmsText({ title, body, fields }) {
  const detail = (fields || [])
    .filter((field) => field?.name && field?.value && field.sms !== false)
    .map((field) => `${field.name}: ${field.value}`)
    .join(" | ");
  return [title, body, detail]
    .filter(Boolean)
    .join("\n")
    .slice(0, SMS_MAX_CHARACTERS);
}

async function sendSms(alert) {
  const accountSid = envValue("TWILIO_ACCOUNT_SID");
  const authToken = envValue("TWILIO_AUTH_TOKEN");
  const fromNumber = envValue("TWILIO_FROM_NUMBER");
  const messagingServiceSid = envValue("TWILIO_MESSAGING_SERVICE_SID");
  const toNumber = normalizePhoneNumber(envValue("ALERT_PHONE_NUMBER"));
  if (!accountSid || !authToken) {
    return { ok: false, skipped: true, reason: "TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN is not set." };
  }
  if (!toNumber) return { ok: false, skipped: true, reason: "ALERT_PHONE_NUMBER is not set." };
  if (!isValidPhoneNumber(toNumber)) {
    return { ok: false, reason: `ALERT_PHONE_NUMBER is not a valid E.164 number: ${toNumber}` };
  }
  if (!fromNumber && !messagingServiceSid) {
    return {
      ok: false,
      skipped: true,
      reason: "TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID is not set.",
    };
  }
  const form = new URLSearchParams({ To: toNumber, Body: buildSmsText(alert) });
  if (messagingServiceSid) form.set("MessagingServiceSid", messagingServiceSid);
  else form.set("From", normalizePhoneNumber(fromNumber));
  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        // Twilio's own message ("The 'To' number is unverified", "insufficient
        // funds") is far more actionable than the HTTP status alone.
        reason: payload?.message || `Twilio responded with ${response.status}.`,
        code: payload?.code,
      };
    }
    return { ok: true, status: response.status, sid: payload?.sid, to: maskPhoneNumber(toNumber) };
  } catch (error) {
    return { ok: false, reason: `Twilio request failed: ${error.message}` };
  }
}

/**
 * Send one alert to every configured channel.
 *
 * @param {object} alert
 * @param {string} alert.title    Headline, e.g. 'Print failure confirmed'.
 * @param {string} alert.body     One or two sentences of detail.
 * @param {Array}  [alert.fields] [{ name, value, inline?, sms? }] extra detail.
 * @param {'info'|'warning'|'critical'} [alert.severity]
 * @param {string} [alert.dedupeKey] Suppresses repeats within the cooldown.
 * @param {boolean} [alert.force]    Bypass the cooldown (used by the test send).
 */
export async function sendAlert(alert) {
  const normalized = {
    title: String(alert?.title ?? "Vision OPS alert").slice(0, 200),
    body: String(alert?.body ?? "").slice(0, 1000),
    fields: Array.isArray(alert?.fields) ? alert.fields : [],
    severity: alert?.severity || "warning",
    footer: alert?.footer,
  };
  const channels = alert?.channels || selectedChannels();
  if (channels.length === 0) {
    console.log("No alert channel is configured; skipping notification:", normalized.title);
    return { sent: false, reason: "no_channel_configured", results: {} };
  }
  if (!alert?.force && withinCooldown(alert?.dedupeKey)) {
    console.log(`Alert suppressed by cooldown (${alert.dedupeKey}): ${normalized.title}`);
    return { sent: false, reason: "cooldown", results: {} };
  }
  const senders = { discord: sendDiscord, sms: sendSms };
  const settled = await Promise.all(
    channels.map(async (channel) => [channel, await senders[channel](normalized)]),
  );
  const results = Object.fromEntries(settled);
  for (const [channel, result] of settled) {
    if (result.ok) console.log(`Alert sent via ${channel}: ${normalized.title}`);
    else if (!result.skipped) console.error(`Alert via ${channel} failed: ${result.reason}`);
  }
  return { sent: settled.some(([, result]) => result.ok), results };
}
