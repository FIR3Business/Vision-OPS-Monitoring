import "dotenv/config";
import fs from "fs";
import path from "path";
import express from "express";
import Groq from "groq-sdk";
import { WebSocketServer } from "ws";
import {
alertStatus,
isValidDiscordWebhook,
isValidPhoneNumber,
normalizePhoneNumber,
sendAlert,
} from "./notify.mjs";
const app = express();
const port = Number(process.env.PORT || 3001);
const DEFAULT_MODEL = "qwen/qwen3.6-27b";
const ENV_PATH = path.resolve(process.cwd(), ".env");

// GROQ_API_KEY and GROQ_MODEL can arrive via .env at boot, OR be entered later
// from the landing page (see /api/config below), so we keep them mutable
// rather than frozen consts.
let model = process.env.GROQ_MODEL || DEFAULT_MODEL;
let groq = process.env.GROQ_API_KEY
? new Groq({ apiKey: process.env.GROQ_API_KEY })
: null;
const requestTimeoutMs = Number(process.env.GROQ_TIMEOUT_MS || 20_000);
app.use(express.json({ limit: "6mb" }));
// No caching on static assets — this is a locally-run dev tool, and stale
// cached JS after an update is far more confusing than a slightly slower
// reload.
app.use(
express.static("public", {
etag: false,
lastModified: false,
setHeaders: (res) => {
res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
},
}),
);

function maskKey(key) {
if (!key || key.length < 8) return "";
return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

// Persists a KEY=value pair into the .env file, creating the file or
// replacing an existing line for that key as needed, so a key entered from
// the browser survives a server restart.
function upsertEnvFile(updates) {
let lines = [];
if (fs.existsSync(ENV_PATH)) {
lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
}
for (const [key, value] of Object.entries(updates)) {
const index = lines.findIndex((line) => line.startsWith(`${key}=`));
const entry = `${key}=${value}`;
if (index >= 0) {
lines[index] = entry;
} else {
lines.push(entry);
}
}
const cleaned = lines.filter((line, index) => line.trim() !== "" || index === lines.length - 1);
fs.writeFileSync(ENV_PATH, cleaned.join("\n").replace(/\n*$/, "\n"), "utf8");
}

app.get("/api/health", (_request, response) => {
response.json({
ok: true,
message: "Vision OPS backend is running.",
model,
});
});

app.get("/api/config", (_request, response) => {
response.json({
hasApiKey: Boolean(groq),
model,
maskedApiKey: maskKey(process.env.GROQ_API_KEY),
});
});

app.post("/api/config", (request, response) => {
const apiKey = clean(request.body?.apiKey, 200);
const requestedModel = clean(request.body?.model, 120);
if (!apiKey || !/^gsk_[A-Za-z0-9]+$/.test(apiKey)) {
return response.status(400).json({
error: "That doesn't look like a valid Groq API key (should start with 'gsk_').",
});
}
try {
groq = new Groq({ apiKey });
process.env.GROQ_API_KEY = apiKey;
if (requestedModel) {
model = requestedModel;
process.env.GROQ_MODEL = requestedModel;
}
upsertEnvFile({
GROQ_API_KEY: apiKey,
...(requestedModel ? { GROQ_MODEL: requestedModel } : {}),
});
console.log(`Groq API key configured from the browser (${maskKey(apiKey)}). Model: ${model}`);
response.json({ ok: true, model, maskedApiKey: maskKey(apiKey) });
} catch (error) {
console.error("Failed to save API key:", error);
response.status(500).json({ error: "The key could not be saved on the server." });
}
});
app.get("/api/alerts", (_request, response) => {
response.json(alertStatus());
});

// Saves alert settings the same way /api/config saves the Groq key: into
// process.env for the running server and into .env so they survive a restart.
// Any field may be omitted to leave it alone, or sent as "" to clear it.
app.post("/api/alerts", (request, response) => {
const body = request.body ?? {};
const updates = {};
const errors = [];
const setIfPresent = (field, envKey, transform = (value) => value) => {
if (body[field] === undefined) return;
const value = transform(clean(body[field], 300));
updates[envKey] = value;
};
if (body.discordWebhookUrl !== undefined) {
const webhook = clean(body.discordWebhookUrl, 300);
if (webhook && !isValidDiscordWebhook(webhook)) {
errors.push(
"That doesn't look like a Discord webhook URL (expected https://discord.com/api/webhooks/...).",
);
}
updates.DISCORD_WEBHOOK_URL = webhook;
}
if (body.phoneNumber !== undefined) {
const phone = clean(body.phoneNumber, 40);
const normalized = phone ? normalizePhoneNumber(phone) : "";
if (normalized && !isValidPhoneNumber(normalized)) {
errors.push("That phone number isn't valid. Use a full number with country code, e.g. +15551234567.");
}
updates.ALERT_PHONE_NUMBER = normalized;
}
setIfPresent("twilioAccountSid", "TWILIO_ACCOUNT_SID");
setIfPresent("twilioAuthToken", "TWILIO_AUTH_TOKEN");
setIfPresent("twilioFromNumber", "TWILIO_FROM_NUMBER", (value) =>
value ? normalizePhoneNumber(value) : "",
);
setIfPresent("twilioMessagingServiceSid", "TWILIO_MESSAGING_SERVICE_SID");
if (body.channels !== undefined) {
const channels = clean(body.channels, 20).toLowerCase();
if (!["auto", "discord", "sms", "text", "both", "all", ""].includes(channels)) {
errors.push('channels must be one of: auto, discord, sms, both.');
} else {
updates.ALERT_CHANNELS = channels || "auto";
}
}
if (body.cooldownMinutes !== undefined) {
const minutes = clamp(body.cooldownMinutes, 0, 240, 5);
updates.ALERT_COOLDOWN_MS = String(Math.round(minutes * 60_000));
}
if (body.alertOnErrors !== undefined) {
updates.ALERT_ON_ERRORS = body.alertOnErrors === false ? "false" : "true";
}
if (errors.length > 0) return response.status(400).json({ error: errors.join(" ") });
if (Object.keys(updates).length === 0) {
return response.status(400).json({ error: "No alert settings were provided." });
}
try {
Object.assign(process.env, updates);
upsertEnvFile(updates);
console.log(`Alert settings updated: ${Object.keys(updates).join(", ")}`);
response.json({ ok: true, ...alertStatus() });
} catch (error) {
console.error("Failed to save alert settings:", error);
response.status(500).json({ error: "The alert settings could not be saved on the server." });
}
});

// Sends a real message through every configured channel so you can confirm the
// wiring works before trusting it with an overnight print.
app.post("/api/alerts/test", async (_request, response) => {
const status = alertStatus();
if (!status.discord.configured && !status.sms.configured) {
return response.status(400).json({
error: "No alert channel is configured yet. Add a Discord webhook URL or Twilio SMS credentials first.",
});
}
const outcome = await sendAlert({
title: "✅ Vision OPS test alert",
body: "Alerts are wired up correctly. Real notifications will look like this.",
severity: "info",
fields: [{ name: "Model", value: model }],
force: true,
});
response.status(outcome.sent ? 200 : 502).json({
ok: outcome.sent,
results: outcome.results,
...(outcome.sent ? {} : { error: "No channel accepted the test message. See the details below." }),
});
});

function isImage(value) {
return typeof value === "string" && value.startsWith("data:image/");
}
function clean(value, maximumLength = 280) {
return String(value ?? "").trim().slice(0, maximumLength);
}
function clamp(value, minimum, maximum, fallback = 0) {
const number = Number(value);
return Number.isFinite(number)
? Math.max(minimum, Math.min(maximum, number))
: fallback;
}
function normalizeHex(value) {
const text = String(value ?? "").trim().toUpperCase();
if (/^#[0-9A-F]{6}$/.test(text)) return text;
if (/^[0-9A-F]{6}$/.test(text)) return `#${text}`;
return "#808080";
}
function normalizeColors(rawColors) {
if (!Array.isArray(rawColors)) return [];
const seen = new Set();
return rawColors
.map((color) => ({
name: clean(color?.name || "Unknown", 30),
hex: normalizeHex(color?.hex),
confidence: clamp(color?.confidence, 0, 1, 0),
coverage: clamp(color?.coverage, 0, 1, 0),
}))
.filter((color) => {
const key = `${color.name.toLowerCase()}-${color.hex}`;
if (seen.has(key)) return false;
seen.add(key);
return true;
})
.sort((a, b) => b.coverage - a.coverage || b.confidence - a.confidence)
.slice(0, 4);
}
function normalizeBox(rawBox) {
const empty = { x: 0, y: 0, width: 0, height: 0 };
if (!rawBox || typeof rawBox !== "object") return empty;
const x = clamp(rawBox.x, 0, 1, 0);
const y = clamp(rawBox.y, 0, 1, 0);
const width = clamp(rawBox.width, 0, Math.max(0, 1 - x), 0);
const height = clamp(rawBox.height, 0, Math.max(0, 1 - y), 0);
const minimumFraction = 0.015;
if (width < minimumFraction || height < minimumFraction) return empty;
return { x, y, width, height };
}
function chooseReference({
previousImageDataUrl,
expectedPartReferenceDataUrl,
emptyPlateReferenceDataUrl,
}) {
const candidates = [
{
type: "previous",
label: "PREVIOUS CAMERA FRAME — compare this with the current frame",
image: previousImageDataUrl,
},
{
type: "expected",
label: "EXPECTED OR KNOWN-GOOD PART REFERENCE",
image: expectedPartReferenceDataUrl,
},
{
type: "empty",
label: "EMPTY BUILD-PLATE REFERENCE",
image: emptyPlateReferenceDataUrl,
},
];
return candidates.find((item) => isImage(item.image)) || null;
}
function machineInstructions(machineType) {
if (machineType === "laser_cutter") {
return `
Inspect a laser cutter camera frame.
Normal may include a workpiece, fixtures, ordinary cutting glow, brief sparks,
light smoke, reflections, residue, and the machine frame.
A machine needs attention when there is sustained flame, excessive smoke,
serious scorching, abnormal material reaction, exhaust failure, or an unusable view.
Automatic machine_status rules:
- printing: a workpiece or active cutting job is visibly present and no problem is visible
- idle: the work area is visibly empty
- needs_attention: a warning, failure, unsafe condition, or unreliable camera view is visible
Allowed failure_type values:
none, excess_smoke, flame, scorching, exhaust_problem,
material_problem, camera_problem, unknown
`;
}
if (machineType === "cnc") {
return `
Inspect a CNC or router camera frame.
Normal may include a workpiece, clamps, fixtures, ordinary chips, dust,
coolant, and normal cutting marks.
A machine needs attention when the workpiece shifted, fixturing failed,
chip buildup is extreme, a tool appears damaged, the toolpath appears wrong,
or the camera view is unreliable.
Automatic machine_status rules:
- printing: a workpiece or machining job is visibly present and no problem is visible
- idle: the work area is visibly empty
- needs_attention: a warning, failure, abnormal condition, or unreliable view is visible
Allowed failure_type values:
none, workpiece_shift, bad_fixturing, chip_buildup,
tool_damage, chatter, path_problem, zero_problem,
camera_problem, unknown
`;
}
return `
Inspect an FDM 3D-printer build plate.
First classify material_pattern:
- empty: no meaningful printed object and no failed plastic
- intentional_solid_geometry: organized layers, walls, surfaces, curves, edges,
holes, or deliberate manufactured geometry
- chaotic_loose_filament: many random overlapping loops, coils, bird-nest strands,
or tangled plastic without a dominant coherent object
- plastic_blob: a dense irregular mass of melted plastic
- unclear
Then classify attachment_state:
- not_applicable
- attached_flat
- edge_lifted
- partially_detached
- fully_detached
- tipped_or_displaced
- unclear
Failure priority:
1. A coherent solid part lifting from the plate is bed_adhesion, not spaghetti.
2. A fully separated coherent part is detachment.
3. A moved or tipped coherent part is tipped_object.
4. Spaghetti requires many random loops or a tangled mass.
5. One isolated strand does not make a coherent part spaghetti.
6. Build plate, rails, nozzle, clips, markings, screws, frame, and cables are not obstructions.
7. Examine the entire visible perimeter of the printed object, especially corners and edges
   closest to the camera, before concluding it is fully and flatly attached. A small raised
   corner or curled edge is still bed_adhesion evidence even if the rest of the part looks fine.
Automatic machine_status must be exactly one of:
- printing: ANY meaningful printed object or printed material is visible on the build plate,
and no warning or failure is visible. For this prototype, an object remaining on the plate
is treated as Printing even if actual motor motion cannot be proven from one still image.
- idle: the build plate is visible and no meaningful object or failed plastic is present.
- needs_attention: a warning, failure, lifted part, detachment, spaghetti, blob, smoke,
camera problem, or uncertain/unreliable view is present.
Filament color rules:
- Detect only colors belonging to visible printed filament or the printed part.
- Ignore the build plate, printer frame, nozzle, cables, background, glare, reflections, and shadows.
- Return no more than four dominant filament colors.
- Give each color a common name and approximate six-digit HEX value.
- If no printed material is visible, return an empty array.
Allowed failure_type values:
none, spaghetti, first_layer, detachment, bed_adhesion,
layer_shift, tipped_object, nozzle_blob, nozzle_drag,
smoke, camera_problem, unknown
`;
}
function normalizeResult(raw, context) {
const allowedStatuses = new Set(["normal", "warning", "failure", "unclear"]);
const allowedScenes = new Set([
"idle_empty_build_plate",
"object_on_build_plate",
"printing_normally",
"printing_suspicious",
"printing_failure",
"failed_material_on_plate",
"camera_unusable",
"unknown",
]);
const allowedPatterns = new Set([
"empty",
"intentional_solid_geometry",
"chaotic_loose_filament",
"plastic_blob",
"unclear",
]);
const allowedAttachment = new Set([
"not_applicable",
"attached_flat",
"edge_lifted",
"partially_detached",
"fully_detached",
"tipped_or_displaced",
"unclear",
]);
const allowedLooseFilament = new Set([
"none",
"isolated_strand",
"multiple_loops",
"tangled_mass",
"unclear",
]);
const allowedActions = new Set([
"continue",
"inspect_machine",
"strongly_consider_pause",
"stop_and_inspect",
]);
const result = {
scene_state: allowedScenes.has(raw?.scene_state)
? raw.scene_state
: "unknown",
material_pattern: allowedPatterns.has(raw?.material_pattern)
? raw.material_pattern
: "unclear",
attachment_state: allowedAttachment.has(raw?.attachment_state)
? raw.attachment_state
: "unclear",
loose_filament_extent: allowedLooseFilament.has(raw?.loose_filament_extent)
? raw.loose_filament_extent
: "unclear",
build_plate_visible: Boolean(raw?.build_plate_visible),
printed_part_visible: Boolean(raw?.printed_part_visible),
failed_material_visible: Boolean(raw?.failed_material_visible),
temporal_change_detected: Boolean(raw?.temporal_change_detected),
machine_status: "needs_attention",
status_confidence: clamp(raw?.status_confidence, 0, 1, 0),
detected_colors: normalizeColors(raw?.detected_colors),
status: allowedStatuses.has(raw?.status) ? raw.status : "unclear",
failure_type: clean(raw?.failure_type || "unknown", 60).toLowerCase(),
failure_box: normalizeBox(raw?.failure_box),
confidence: clamp(raw?.confidence, 0, 1, 0),
severity: Math.round(clamp(raw?.severity, 0, 10, 0)),
should_notify_user: Boolean(raw?.should_notify_user),
recommended_action: allowedActions.has(raw?.recommended_action)
? raw.recommended_action
: "inspect_machine",
reason: clean(raw?.reason || "No explanation was returned."),
evidence: clean(raw?.evidence || "No specific evidence was returned."),
probable_cause: clean(raw?.probable_cause || "unknown", 220),
next_step: clean(raw?.next_step || "Inspect the machine.", 220),
machine_status_reason: clean(
raw?.machine_status_reason || "The camera result requires review.",
220,
),
};
if (context.machineType === "3d_printer") {
const coherentPart = result.material_pattern === "intentional_solid_geometry";
const partialLift = ["edge_lifted", "partially_detached"].includes(
result.attachment_state,
);
const strongSpaghetti =
result.material_pattern === "chaotic_loose_filament" &&
["multiple_loops", "tangled_mass"].includes(result.loose_filament_extent);
if (coherentPart && partialLift) {
Object.assign(result, {
scene_state: "failed_material_on_plate",
printed_part_visible: true,
failed_material_visible: true,
status: "failure",
failure_type: "bed_adhesion",
confidence: Math.max(result.confidence, 0.82),
severity: Math.max(result.severity, 7),
should_notify_user: true,
recommended_action: "stop_and_inspect",
reason:
"A coherent printed part is visibly lifting or warping away from the build plate.",
evidence:
"An edge or section appears raised, curled, bowed, or separated while the part retains intentional geometry.",
probable_cause:
"Possible adhesion loss, warping, contamination, or insufficient first-layer bonding.",
next_step:
"Pause the print and inspect bed cleanliness, leveling, temperature, and first-layer adhesion.",
});
} else if (coherentPart && result.attachment_state === "fully_detached") {
Object.assign(result, {
scene_state: "failed_material_on_plate",
printed_part_visible: true,
failed_material_visible: true,
status: "failure",
failure_type: "detachment",
confidence: Math.max(result.confidence, 0.82),
severity: Math.max(result.severity, 8),
should_notify_user: true,
recommended_action: "stop_and_inspect",
reason:
"A coherent printed part appears fully separated from its build-plate footprint.",
evidence:
"The object has intentional geometry but no longer appears seated normally on the plate.",
probable_cause:
"Possible adhesion loss, warping, plate contamination, or first-layer failure.",
next_step:
"Stop the print and inspect the build surface and first-layer settings.",
});
} else if (coherentPart && result.attachment_state === "tipped_or_displaced") {
Object.assign(result, {
scene_state: "failed_material_on_plate",
printed_part_visible: true,
failed_material_visible: true,
status: "failure",
failure_type: "tipped_object",
confidence: Math.max(result.confidence, 0.82),
severity: Math.max(result.severity, 8),
should_notify_user: true,
recommended_action: "stop_and_inspect",
reason: "The printed part appears tipped, displaced, or moved from its normal position.",
evidence:
"The solid object appears rotated, leaned, raised, or shifted relative to the plate.",
probable_cause:
"Possible adhesion loss, nozzle collision, warping, or insufficient support.",
next_step:
"Stop the print and inspect adhesion, supports, and possible nozzle contact.",
});
} else if (strongSpaghetti) {
Object.assign(result, {
scene_state: "failed_material_on_plate",
failed_material_visible: true,
status: "failure",
failure_type: "spaghetti",
confidence: Math.max(result.confidence, 0.82),
severity: Math.max(result.severity, 8),
should_notify_user: true,
recommended_action: "stop_and_inspect",
reason: "Multiple uncontrolled filament loops or a tangled filament mass are visible.",
evidence:
"Random loose strands and overlapping coils dominate instead of a coherent printed shape.",
probable_cause:
"The print may have lost adhesion or continued extruding after the intended geometry failed.",
next_step:
"Stop the print, remove failed filament, and inspect bed adhesion and the first layer.",
});
} else if (result.failure_type === "spaghetti" && !strongSpaghetti) {
result.status = partialLift ? "failure" : "warning";
result.failure_type = partialLift ? "bed_adhesion" : "unknown";
result.severity = partialLift
? Math.max(result.severity, 7)
: Math.min(Math.max(result.severity, 3), 5);
result.recommended_action = partialLift
? "stop_and_inspect"
: "inspect_machine";
result.reason = partialLift
? "The image is more consistent with a solid part lifting from the plate than with spaghetti."
: "There is not enough loose-loop evidence to confirm spaghetti.";
}
}
const visibleProblem =
result.status === "failure" ||
result.status === "warning" ||
result.status === "unclear" ||
result.failed_material_visible ||
result.failure_type === "camera_problem" ||
result.failure_type === "smoke" ||
(result.failure_type !== "none" && result.failure_type !== "unknown");
const visiblyEmpty =
result.build_plate_visible &&
result.material_pattern === "empty" &&
!result.printed_part_visible &&
!result.failed_material_visible;
const visibleObject =
result.printed_part_visible ||
[
"intentional_solid_geometry",
"chaotic_loose_filament",
"plastic_blob",
].includes(result.material_pattern);
if (visibleProblem) {
result.machine_status = "needs_attention";
result.status_confidence = Math.max(result.status_confidence, 0.82);
result.machine_status_reason =
"The camera detected a warning, failure, or condition that requires inspection.";
} else if (visiblyEmpty) {
result.machine_status = "idle";
result.status_confidence = Math.max(result.status_confidence, 0.84);
result.machine_status_reason =
"The build plate is visible and no meaningful printed object or failed material is present.";
result.detected_colors = [];
result.status = "normal";
result.failure_type = "none";
result.failure_box = { x: 0, y: 0, width: 0, height: 0 };
result.severity = 0;
result.should_notify_user = false;
result.recommended_action = "continue";
} else if (visibleObject) {
result.machine_status = "printing";
result.status_confidence = Math.max(result.status_confidence, 0.76);
result.machine_status_reason =
"Meaningful printed material or a printed object is visible on the build plate.";
result.failure_box = { x: 0, y: 0, width: 0, height: 0 };
} else {
result.machine_status = "needs_attention";
result.status_confidence = Math.max(result.status_confidence, 0.55);
result.machine_status_reason =
"The camera could not confidently determine whether the build plate is empty or contains a print.";
}
if (!visibleObject && result.material_pattern === "empty") {
result.detected_colors = [];
}
return result;
}
function extractJson(text) {
const trimmed = String(text ?? "").trim();
const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
const body = fenced ? fenced[1].trim() : trimmed;
const start = body.indexOf("{");
const end = body.lastIndexOf("}");
if (start === -1 || end === -1 || end < start) return body;
return body.slice(start, end + 1);
}
async function requestAnalysis(content) {
const maxAttempts = 2;
let lastRawText = "";
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
const isReasoningModel = /qwen|deepseek/i.test(model);
const completion = await groq.chat.completions.create(
{
model,
messages: [{ role: "user", content }],
response_format: { type: "json_object" },
// Reasoning models (e.g. qwen3) can spend their entire completion budget
// thinking and never emit the JSON answer at all (Groq then rejects the
// request with json_validate_failed / empty failed_generation), and leak
// <think> tokens into `content` unless reasoning_format is set, which also
// breaks JSON.parse. Disable reasoning and hide/parse leaked tokens
// defensively. Non-reasoning models reject these fields outright, so only
// send them when the configured model actually supports reasoning.
...(isReasoningModel ? { reasoning_effort: "none", reasoning_format: "hidden" } : {}),
temperature: 0,
max_completion_tokens: 2048,
stream: false,
},
{ timeout: requestTimeoutMs, maxRetries: 2 },
);
const rawText = completion.choices[0]?.message?.content;
if (!rawText) {
lastRawText = "";
continue;
}
try {
return { rawResult: JSON.parse(extractJson(rawText)), attempts: attempt };
} catch {
lastRawText = rawText;
console.error(
`Attempt ${attempt}/${maxAttempts} returned unparseable JSON:`,
rawText.slice(0, 300),
);
}
}
const error = new Error("Groq returned text that was not valid JSON after retrying.");
error.invalidJson = true;
error.rawText = lastRawText;
throw error;
}
const CONFIRMATION_STREAK = Number(process.env.CONFIRMATION_STREAK || 3);
const cameraConfirmations = new Map();
function getCameraConfirmation(cameraId) {
if (!cameraConfirmations.has(cameraId)) {
cameraConfirmations.set(cameraId, { streak: 0, confirmed: false });
}
return cameraConfirmations.get(cameraId);
}
function updateConfirmation(cameraId, result) {
const state = getCameraConfirmation(cameraId);
const problem = result.machine_status === "needs_attention";
state.streak = problem ? state.streak + 1 : 0;
const wasConfirmed = state.confirmed;
state.confirmed = problem && state.streak >= CONFIRMATION_STREAK;
return {
confirmation_streak: Math.min(state.streak, CONFIRMATION_STREAK),
confirmation_target: CONFIRMATION_STREAK,
confirmed_failure: state.confirmed,
newly_confirmed: state.confirmed && !wasConfirmed,
};
}
let wss = null;
function broadcast(message) {
if (!wss) return;
const payload = JSON.stringify(message);
for (const client of wss.clients) {
if (client.readyState === client.OPEN) client.send(payload);
}
}
// Fired when a failure has survived CONFIRMATION_STREAK consecutive frames, so
// this is a real problem rather than one bad guess from a single image.
function notifyFailureConfirmed({ cameraLabel, cameraId, result }) {
return sendAlert({
title: `🚨 ${cameraLabel}: ${result.failure_type.replace(/_/g, " ")}`,
body: `${result.reason} ${result.next_step}`.trim(),
severity: result.severity >= 7 ? "critical" : "warning",
fields: [
{ name: "Severity", value: `${result.severity}/10` },
{ name: "Confidence", value: `${Math.round(result.confidence * 100)}%` },
{ name: "Action", value: result.recommended_action.replace(/_/g, " ") },
{ name: "Evidence", value: result.evidence, inline: false, sms: false },
{ name: "Probable cause", value: result.probable_cause, inline: false, sms: false },
],
// One text per camera per failure type, not one per confirming frame.
dedupeKey: `failure:${cameraId}:${result.failure_type}`,
}).catch((alertError) => {
console.error("Failure alert threw:", alertError);
});
}

// Fired when the monitoring pipeline itself breaks — a rejected API key, a
// Groq outage, unparseable model output, a failed auto-pause. Without this the
// app can silently stop watching a running print.
function notifyError({ title, body, dedupeKey, fields = [] }) {
if (String(process.env.ALERT_ON_ERRORS ?? "").toLowerCase() === "false") return;
return sendAlert({
title: `⚠️ Vision OPS error: ${title}`,
body,
severity: "critical",
fields,
dedupeKey,
}).catch((alertError) => {
console.error("Error alert threw:", alertError);
});
}
const printerDrivers = {
none: {
async pause() {
return { ok: false, skipped: true, reason: "No PRINTER_DRIVER configured." };
},
},
octoprint: {
async pause() {
const baseUrl = process.env.OCTOPRINT_URL;
const apiKey = process.env.OCTOPRINT_API_KEY;
if (!baseUrl || !apiKey) {
return { ok: false, skipped: true, reason: "OCTOPRINT_URL or OCTOPRINT_API_KEY is missing." };
}
try {
const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/job`, {
method: "POST",
headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
body: JSON.stringify({ command: "pause", action: "pause" }),
});
return { ok: response.ok, status: response.status };
} catch (driverError) {
return { ok: false, error: driverError.message };
}
},
},
moonraker: {
async pause() {
const baseUrl = process.env.MOONRAKER_URL;
if (!baseUrl) {
return { ok: false, skipped: true, reason: "MOONRAKER_URL is missing." };
}
try {
const response = await fetch(`${baseUrl.replace(/\/$/, "")}/printer/print/pause`, {
method: "POST",
});
return { ok: response.ok, status: response.status };
} catch (driverError) {
return { ok: false, error: driverError.message };
}
},
},
};
async function pausePrinter() {
const driverName = process.env.PRINTER_DRIVER || "none";
const driver = printerDrivers[driverName] || printerDrivers.none;
return driver.pause();
}
app.post("/api/analyze-machine", async (request, response) => {
try {
if (!groq) {
return response.status(401).json({
error: "No Groq API key is configured yet. Add one from the setup screen.",
code: "missing_api_key",
});
}
const {
currentImageDataUrl,
emptyPlateReferenceDataUrl,
expectedPartReferenceDataUrl,
previousImageDataUrl,
machineType = "3d_printer",
jobContext = {},
cameraId: rawCameraId,
cameraLabel: rawCameraLabel,
} = request.body;
const cameraId = clean(rawCameraId, 200) || "default";
const cameraLabel = clean(rawCameraLabel, 100) || cameraId;
if (!isImage(currentImageDataUrl)) {
return response.status(400).json({
error: "A valid current camera image was not received.",
});
}
const reference = chooseReference({
previousImageDataUrl,
expectedPartReferenceDataUrl,
emptyPlateReferenceDataUrl,
});
const images = [];
if (reference) images.push(reference);
images.push({
type: "current",
label: "CURRENT CAMERA FRAME — classify this image now",
image: currentImageDataUrl,
});
const totalCharacters = images.reduce(
(total, item) => total + item.image.length,
0,
);
// Groq's free/on-demand tier caps requests at a few thousand tokens per
// minute. Vision token cost scales mainly with pixel dimensions, not file
// size, so this is a loose backstop against something unexpectedly large
// (e.g. a full-resolution upload) slipping through — normal 384px frames
// land far below this.
if (totalCharacters > 350_000) {
return response.status(413).json({
error:
"The combined images are too large for the current Groq rate limit. Reduce camera resolution/quality or clear an unnecessary reference image.",
});
}
const safeJobContext = {
cameraName: clean(jobContext.cameraName, 100),
material: clean(jobContext.material, 80),
operator: clean(jobContext.operator, 80),
};
const prompt = `
You are Vision OPS, a conservative fabrication-machine visual inspector.
Use only visible evidence. Never invent motion, sound, heat, smoke, or events.
When the evidence sits between two classifications, prefer the one that flags a possible
problem over the one that assumes the machine is fine — a small, easy-to-miss issue (one
lifted corner, one stray strand, a faint smoke haze) still counts as visible evidence and
must not be reported as "none" or "normal". Only act on what is actually visible; do not
invent a problem in a genuinely clean frame.
Machine type: ${machineType}
Context: ${JSON.stringify(safeJobContext)}
Reference image type: ${reference?.type || "none"}
${machineInstructions(machineType)}
If a PREVIOUS CAMERA FRAME is included, compare it with the CURRENT CAMERA FRAME
and set temporal_change_detected only when a meaningful visible change exists.
The machine_status must be exactly one of:
printing, needs_attention, idle
Failure location:
- If failure_type is not "none", set failure_box to the tightest rectangle around the single
  clearest piece of visible evidence for that failure_type (the lifted corner, the tangled
  strands, the detached section, the smoke plume, the shifted workpiece, the damaged tool).
- failure_box coordinates are fractions of the CURRENT CAMERA FRAME from 0.0 to 1.0, where
  x,y is the top-left corner of the box and width,height is its size. (0,0) is the top-left
  corner of the image and (1,1) is the bottom-right corner.
- If failure_type is "none" or no single region explains the finding, set x, y, width, and
  height all to 0.
Output rules:
- Respond with ONLY the JSON object below as raw text — no markdown code fences, no
  <think> or reasoning text, and no words before or after the JSON object.
- Keep reason, evidence, probable_cause, next_step, and machine_status_reason each to 12
  words or fewer.
Return JSON only:
{
"scene_state": "idle_empty_build_plate | object_on_build_plate | printing_normally | printing_suspicious | printing_failure | failed_material_on_plate | camera_unusable | unknown",
"material_pattern": "empty | intentional_solid_geometry | chaotic_loose_filament | plastic_blob | unclear",
"attachment_state": "not_applicable | attached_flat | edge_lifted | partially_detached | fully_detached | tipped_or_displaced | unclear",
"loose_filament_extent": "none | isolated_strand | multiple_loops | tangled_mass | unclear",
"build_plate_visible": true,
"printed_part_visible": false,
"failed_material_visible": false,
"temporal_change_detected": false,
"machine_status": "printing | needs_attention | idle",
"status_confidence": 0.0,
"machine_status_reason": "short visible reason",
"detected_colors": [
{
"name": "Blue",
"hex": "#1E6BFF",
"confidence": 0.0,
"coverage": 0.0
}
],
"status": "normal | warning | failure | unclear",
"failure_type": "allowed failure type",
"failure_box": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0 },
"confidence": 0.0,
"severity": 0,
"should_notify_user": false,
"recommended_action": "continue | inspect_machine | strongly_consider_pause | stop_and_inspect",
"reason": "short conclusion",
"evidence": "short visible evidence",
"probable_cause": "short cautious cause",
"next_step": "short action"
}
`;
const content = [{ type: "text", text: prompt }];
for (const item of images) {
content.push({ type: "text", text: item.label });
content.push({
type: "image_url",
image_url: { url: item.image },
});
}
console.log(
`Analyzing with ${model}; images=${images.length}; machine=${machineType}`,
);
const startedAt = Date.now();
const { rawResult, attempts } = await requestAnalysis(content);
const latencyMs = Date.now() - startedAt;
console.log(`Groq responded in ${latencyMs}ms (attempts=${attempts}).`);
const normalized = normalizeResult(rawResult, { machineType });
const confirmation = updateConfirmation(cameraId, normalized);
const payload = {
...normalized,
...confirmation,
latency_ms: latencyMs,
camera_id: cameraId,
};
response.json(payload);
broadcast({ type: "status_update", cameraId, cameraLabel, result: payload });
if (confirmation.newly_confirmed) {
console.log(`Confirmed failure on "${cameraLabel}": ${normalized.failure_type}`);
notifyFailureConfirmed({ cameraLabel, cameraId, result: normalized });
pausePrinter().then((outcome) => {
console.log(`Printer pause attempt for "${cameraLabel}":`, outcome);
broadcast({ type: "printer_pause_result", cameraId, cameraLabel, outcome });
// A configured driver that fails to pause is worth a second message: the
// print is still running and nobody stopped it.
if (!outcome.ok && !outcome.skipped) {
notifyError({
title: "auto-pause failed",
body: `Could not pause "${cameraLabel}" after a confirmed ${normalized.failure_type}. Stop the machine by hand.`,
dedupeKey: `pause-failed:${cameraId}`,
fields: [
{ name: "Driver", value: process.env.PRINTER_DRIVER || "none" },
{ name: "Detail", value: outcome.reason || outcome.error || `status ${outcome.status}` },
],
});
}
});
broadcast({ type: "failure_confirmed", cameraId, cameraLabel, result: payload });
}
} catch (error) {
// `cameraLabel` is scoped inside the try block, so re-derive a label here.
const failedCamera = clean(request.body?.cameraLabel, 100) || clean(request.body?.cameraId, 200) || "default";
if (error?.invalidJson) {
notifyError({
title: "unreadable model output",
body: `${model} returned text that was not valid JSON while analyzing "${failedCamera}". Monitoring for that camera is not producing results.`,
dedupeKey: `error:invalid_json:${failedCamera}`,
fields: [{ name: "Model", value: model }],
});
return response.status(502).json({
error: "Groq returned text that was not valid JSON.",
code: "invalid_json",
details: (error.rawText || "").slice(0, 500),
});
}
console.error("FULL GROQ ERROR:", error);
const status = Number(error?.status) || 500;
const details =
error?.error?.error?.message ||
error?.error?.message ||
error?.message ||
"Unknown Groq API error.";
const messages = {
400: "Groq rejected the request format.",
401: "Groq rejected the API key.",
403: "This account cannot use the selected model.",
404: `Groq could not find the model: ${model}`,
413: "The image request is too large.",
422: "Groq could not produce valid JSON. Try again.",
429:
"Groq token or request limit reached. Stop auto monitoring and wait about one minute.",
500: "Groq experienced an internal error.",
502: "Groq returned an invalid response.",
503: "Groq is temporarily unavailable.",
};
const summary = messages[status] || `Groq request failed with status ${status}.`;
notifyError({
title: `analysis failed (${status})`,
body: `${summary} Camera "${failedCamera}" is not being monitored until this is fixed.`,
// One alert per status code per camera per cooldown — a 429 storm during
// auto-monitoring must not turn into a text per frame.
dedupeKey: `error:${status}:${failedCamera}`,
fields: [
{ name: "Status", value: String(status) },
{ name: "Model", value: model },
{ name: "Detail", value: String(details).slice(0, 200), inline: false, sms: false },
],
});
response.status(status).json({
error: summary,
details,
});
}
});
const server = app.listen(port, () => {
console.log(`Vision OPS is running at http://localhost:${port}`);
console.log(`Groq vision model: ${model}`);
console.log(
groq
? "Groq API key loaded from .env."
: "No Groq API key yet — open the app and use the setup screen to add one.",
);
});
wss = new WebSocketServer({ server });
wss.on("connection", (socket) => {
socket.send(JSON.stringify({ type: "hello", message: "Connected to Vision OPS live updates." }));
});

const alerts = alertStatus();
console.log(
[
`Alerts — Discord: ${alerts.discord.configured ? "on" : "off"}`,
`SMS: ${alerts.sms.configured ? `on (${alerts.sms.toNumber})` : "off"}`,
`errors: ${alerts.alertOnErrors ? "on" : "off"}`,
].join(", ") +
(alerts.discord.configured || alerts.sms.configured
? ""
: " — set DISCORD_WEBHOOK_URL or the TWILIO_* keys to get notified of failures."),
);

// Last line of defence: if the process is about to die, get one message out
// before it does — the send is awaited so the HTTP request finishes before the
// exit call tears the process down.
process.on("uncaughtException", async (error) => {
console.error("UNCAUGHT EXCEPTION:", error);
await notifyError({
title: "server crashed",
body: `Vision OPS stopped with an uncaught exception: ${error?.message || error}. Monitoring has stopped.`,
dedupeKey: "error:uncaught",
});
process.exit(1);
});
process.on("unhandledRejection", (reason) => {
console.error("UNHANDLED REJECTION:", reason);
notifyError({
title: "unhandled rejection",
body: `Vision OPS hit an unhandled rejection: ${reason?.message || reason}.`,
dedupeKey: "error:unhandled-rejection",
});
});
