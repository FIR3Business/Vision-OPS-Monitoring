// Discord notification layer for Vision OPS.
//
// Everything that leaves the machine goes through here: confirmed print
// failures (with the frame that triggered them attached), recoveries, and
// runtime errors such as Groq rejecting a request or the printer refusing to
// pause. Nothing in this file touches the UI — the webhook URL comes from
// DISCORD_WEBHOOK_URL in .env, or from POST /api/notifications at runtime.

const COLORS = {
  failure: 0xe5484d,
  error: 0xf5a524,
  recovery: 0x30a46c,
  info: 0x3b82f6,
};

const WEBHOOK_PATTERN =
  /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/;

// Discord hard-caps attachments at 8MB for unpaid guilds; stay clear of it.
const MAX_ATTACHMENT_BYTES = 7_000_000;
const MAX_SEND_ATTEMPTS = 3;

function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function isValidWebhookUrl(url) {
  return WEBHOOK_PATTERN.test(String(url ?? "").trim());
}

export function getWebhookUrl() {
  const url = String(process.env.DISCORD_WEBHOOK_URL ?? "").trim();
  return isValidWebhookUrl(url) ? url : "";
}

export function isConfigured() {
  return Boolean(getWebhookUrl());
}

// Reports why notifications are (or aren't) live, for /api/notifications and
// the boot log. Never returns the webhook URL itself — it is a secret.
export function describeNotifications() {
  const raw = String(process.env.DISCORD_WEBHOOK_URL ?? "").trim();
  return {
    configured: isConfigured(),
    invalidUrl: raw !== "" && !isValidWebhookUrl(raw),
    notifyFailures: true,
    notifyErrors: envFlag("DISCORD_NOTIFY_ERRORS", true),
    notifyRecovery: envFlag("DISCORD_NOTIFY_RECOVERY", true),
    attachSnapshots: envFlag("DISCORD_ATTACH_SNAPSHOT", true),
    mention: String(process.env.DISCORD_MENTION ?? "").trim(),
    errorCooldownMs: envNumber("DISCORD_ERROR_COOLDOWN_MS", 300_000),
    failureCooldownMs: envNumber("DISCORD_FAILURE_COOLDOWN_MS", 120_000),
  };
}

// --- cooldown ---------------------------------------------------------------
// A camera that keeps failing, or a Groq outage hit once per frame, would
// otherwise post hundreds of identical messages. Suppressed hits are counted
// and reported on the next message that gets through, so nothing is silently
// lost.

const cooldowns = new Map();

function checkCooldown(key, windowMs) {
  if (!key || windowMs <= 0) return { allowed: true, suppressed: 0 };
  const now = Date.now();
  const entry = cooldowns.get(key);
  if (entry && now - entry.lastSentAt < windowMs) {
    entry.suppressed += 1;
    return { allowed: false, suppressed: entry.suppressed };
  }
  const suppressed = entry?.suppressed ?? 0;
  cooldowns.set(key, { lastSentAt: now, suppressed: 0 });
  return { allowed: true, suppressed };
}

export function resetCooldowns() {
  cooldowns.clear();
}

// --- send queue -------------------------------------------------------------
// Posts are serialized so a burst of alerts can't trip Discord's per-webhook
// rate limit, and so a 429 backoff delays the queue instead of racing it.

let queue = Promise.resolve();

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(value, maximumLength) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.length > maximumLength ? `${text.slice(0, maximumLength - 1)}…` : text;
}

function field(name, value, inline = true) {
  const text = truncate(value, 1024);
  if (!text) return null;
  return { name: truncate(name, 256), value: text, inline };
}

function dataUrlToAttachment(dataUrl, filename) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(
    String(dataUrl ?? ""),
  );
  if (!match) return null;
  let buffer;
  try {
    buffer = Buffer.from(match[2], "base64");
  } catch {
    return null;
  }
  if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) return null;
  const extension = match[1].split("/")[1].replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
  return {
    buffer,
    contentType: match[1],
    filename: `${filename}.${extension || "jpg"}`,
  };
}

async function postToDiscord(payload, attachment) {
  const url = getWebhookUrl();
  if (!url) return { ok: false, skipped: true, reason: "no_webhook" };

  const timeoutMs = envNumber("DISCORD_TIMEOUT_MS", 10_000);
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let body;
      let headers;
      if (attachment) {
        const form = new FormData();
        form.append("payload_json", JSON.stringify(payload));
        form.append(
          "files[0]",
          new Blob([attachment.buffer], { type: attachment.contentType }),
          attachment.filename,
        );
        body = form;
        headers = undefined; // fetch sets the multipart boundary itself.
      } else {
        body = JSON.stringify(payload);
        headers = { "Content-Type": "application/json" };
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      if (response.ok) return { ok: true, status: response.status };

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after")) || 1;
        lastError = `rate limited (retry after ${retryAfter}s)`;
        if (attempt < MAX_SEND_ATTEMPTS) {
          await sleep(Math.min(retryAfter * 1000 + 250, 15_000));
          continue;
        }
      } else if (response.status >= 500) {
        lastError = `Discord responded ${response.status}`;
        if (attempt < MAX_SEND_ATTEMPTS) {
          await sleep(500 * attempt);
          continue;
        }
      } else {
        // 4xx other than 429 will not succeed on retry (bad/deleted webhook,
        // malformed embed) — surface the body so it is actually fixable.
        const detail = truncate(await response.text().catch(() => ""), 300);
        return { ok: false, status: response.status, error: detail || "rejected" };
      }
    } catch (error) {
      lastError = error?.name === "AbortError" ? "timed out" : error?.message || "network error";
      if (attempt < MAX_SEND_ATTEMPTS) await sleep(500 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, error: lastError || "unknown error" };
}

function buildPayload({ embed, mention, suppressed }) {
  const embeds = [embed];
  if (suppressed > 0) {
    embed.footer = {
      text: truncate(
        `${embed.footer?.text ? `${embed.footer.text} • ` : ""}${suppressed} similar alert${
          suppressed === 1 ? "" : "s"
        } suppressed while cooling down`,
        2048,
      ),
    };
  }
  return {
    username: truncate(process.env.DISCORD_USERNAME || "Vision OPS", 80),
    content: mention ? truncate(mention, 200) : undefined,
    embeds,
    allowed_mentions: mention
      ? { parse: ["users", "roles", "everyone"] }
      : { parse: [] },
  };
}

function send({ embed, mention = "", attachment = null, cooldownKey = "", cooldownMs = 0 }) {
  if (!isConfigured()) {
    return Promise.resolve({ ok: false, skipped: true, reason: "no_webhook" });
  }
  const gate = checkCooldown(cooldownKey, cooldownMs);
  if (!gate.allowed) {
    return Promise.resolve({ ok: false, skipped: true, reason: "cooldown" });
  }
  return enqueue(async () => {
    const result = await postToDiscord(
      buildPayload({ embed, mention, suppressed: gate.suppressed }),
      attachment,
    );
    if (!result.ok && !result.skipped) {
      console.error("Discord notification failed:", result.error || result.status);
    }
    return result;
  });
}

// --- formatting -------------------------------------------------------------

function titleCase(value) {
  return String(value ?? "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}

function percent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return `${Math.round(number * 100)}%`;
}

// --- public API -------------------------------------------------------------

export function notifyFailure({ cameraLabel, cameraId, result, snapshotDataUrl }) {
  const settings = describeNotifications();
  const failureLabel = titleCase(result?.failure_type || "unknown");
  const attachment =
    settings.attachSnapshots && snapshotDataUrl
      ? dataUrlToAttachment(snapshotDataUrl, "failure-frame")
      : null;

  const embed = {
    title: `🚨 ${failureLabel} confirmed — ${truncate(cameraLabel, 100)}`,
    description: truncate(result?.reason, 2000),
    color: COLORS.failure,
    timestamp: new Date().toISOString(),
    fields: [
      field("Failure", failureLabel),
      field("Severity", `${result?.severity ?? 0}/10`),
      field("Confidence", percent(result?.confidence)),
      field("Recommended action", titleCase(result?.recommended_action), false),
      field("Evidence", result?.evidence, false),
      field("Probable cause", result?.probable_cause, false),
      field("Next step", result?.next_step, false),
      field(
        "Confirmed after",
        `${result?.confirmation_target ?? "?"} consecutive frames`,
        true,
      ),
      field("Camera", cameraId && cameraId !== cameraLabel ? cameraId : "", true),
    ].filter(Boolean),
    footer: { text: "Vision OPS" },
  };
  if (attachment) embed.image = { url: `attachment://${attachment.filename}` };

  return send({
    embed,
    mention: settings.mention,
    attachment,
    cooldownKey: `failure:${cameraId}:${result?.failure_type}`,
    cooldownMs: settings.failureCooldownMs,
  });
}

export function notifyRecovery({ cameraLabel, cameraId, result }) {
  const settings = describeNotifications();
  if (!settings.notifyRecovery) return Promise.resolve({ ok: false, skipped: true });

  return send({
    embed: {
      title: `✅ Recovered — ${truncate(cameraLabel, 100)}`,
      description: truncate(
        result?.machine_status_reason || "The camera no longer reports a problem.",
        2000,
      ),
      color: COLORS.recovery,
      timestamp: new Date().toISOString(),
      fields: [
        field("Machine status", titleCase(result?.machine_status)),
        field("Confidence", percent(result?.status_confidence)),
      ].filter(Boolean),
      footer: { text: "Vision OPS" },
    },
    cooldownKey: `recovery:${cameraId}`,
    cooldownMs: settings.failureCooldownMs,
  });
}

// `key` groups repeats for cooldown purposes: the same Groq outage hit once per
// frame should post once, not once a second.
export function notifyError({ scope, message, details = "", key = "", cameraLabel = "", fatal = false }) {
  const settings = describeNotifications();
  if (!settings.notifyErrors) return Promise.resolve({ ok: false, skipped: true });

  return send({
    embed: {
      title: `${fatal ? "🛑" : "⚠️"} Vision OPS ${fatal ? "crashed" : "error"} — ${truncate(scope, 80)}`,
      description: truncate(message, 2000),
      color: fatal ? COLORS.failure : COLORS.error,
      timestamp: new Date().toISOString(),
      fields: [
        field("Camera", cameraLabel, true),
        field("Details", details ? `\`\`\`${truncate(details, 900)}\`\`\`` : "", false),
      ].filter(Boolean),
      footer: { text: "Vision OPS" },
    },
    mention: fatal ? settings.mention : "",
    cooldownKey: key || `error:${scope}`,
    cooldownMs: fatal ? 0 : settings.errorCooldownMs,
  });
}

export function notifyInfo({ title, message }) {
  return send({
    embed: {
      title: truncate(title, 256),
      description: truncate(message, 2000),
      color: COLORS.info,
      timestamp: new Date().toISOString(),
      footer: { text: "Vision OPS" },
    },
  });
}

export function notifyTest() {
  return send({
    embed: {
      title: "🔔 Vision OPS test alert",
      description:
        "Notifications are wired up correctly. Real alerts fire on confirmed failures, recoveries, and runtime errors.",
      color: COLORS.info,
      timestamp: new Date().toISOString(),
      footer: { text: "Vision OPS" },
    },
    mention: describeNotifications().mention,
  });
}

// Lets the queue drain before the process exits on a fatal error, so the crash
// alert actually leaves the machine.
export async function flush(timeoutMs = 5_000) {
  await Promise.race([queue, sleep(timeoutMs)]);
}
