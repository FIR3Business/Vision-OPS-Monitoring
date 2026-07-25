<img width="1201" height="328" alt="image" src="https://github.com/user-attachments/assets/92d3aff5-f772-4975-9388-fea676629c1e" />

Vision OPS Stands for: Vision Operation Systems

Vision OPS is an AI-powered fabrication monitoring camera designed for 3D printers, CNC machines, laser cutters, and maker spaces. Instead of simply recording video, Vision OPS watches a machine while it runs, detects early signs of failure or safety risk, and helps the operator understand what is going wrong.

The device uses a clean orb-style webcam enclosure with RGB status lighting. Inside the enclosure, the only core component is a webcam, making the hardware simple, reliable, and easy to build. A USB-A cable provides both power and data, so it can plug directly into a laptop or demo computer.

Vision OPS can detect problems such as 3D print spaghetti failures, poor bed adhesion, layer shifts, laser smoke or flame risk, CNC workpiece movement, tool chatter, and other visible machine issues. When a problem appears, the system can change its RGB status light, alert the user, capture snapshots, and generate an AI incident report with the likely cause and recommended next action.

The goal of Vision OPS is to turn ordinary machine footage into useful operational intelligence. Most cameras only let you watch a machine fail. Vision OPS helps you catch the failure early, understand why it happened, and prevent it from happening again.

Additionally, Vision OPS is designed so it is able to monitor loaded filament, print status whether a machine is idle, needs attention, or printing ongoing. It is designed around the peace of mind of a user.

----------------------------------------------------------------
How to use Vision OPS?
1. In your terminal type git clone https://github.com/FIR3Business/Vision-OPS-Monitoring (It will save in the folder you are cd in the terminal!)
2. PLEASE ENTER YOUR API KEY
To get your api key: 
a) Go to this website: https://console.groq.com/keys
b) Sign into the website, and make your API key
c) Copy your API key, and paste it into the .env file in the code
d) Ctrl/CMD+S to save the .env file

3. After entering API key, go into the folder containing the files
   
   <img width="860" height="189" alt="image" src="https://github.com/user-attachments/assets/42031c57-2f85-497b-b9fe-3a5b4d4791ef" />

4. Type "cmd" to enter the terminal
   
   <img width="592" height="148" alt="image" src="https://github.com/user-attachments/assets/a63fcaad-026a-4deb-839f-7df78c66c8a3" />
   
   This should pop up:
   <img width="862" height="468" alt="image" src="https://github.com/user-attachments/assets/6b90d429-9c52-4650-bb14-fd2b4c8e6ea7" />

5. Type "npm install"
   
   <img width="500" height="252" alt="image" src="https://github.com/user-attachments/assets/3e11d30d-4c53-45b4-9d17-620cca3736ca" />

6. Type "cd VisionOPS_4"
   
   <img width="628" height="158" alt="image" src="https://github.com/user-attachments/assets/0383243a-4e8d-45d1-951c-76f7e44be302" />
   
7. Type "npm start" as seen above

8. Enter in: "http://localhost:3001/" in your browser

   <img width="803" height="56" alt="image" src="https://github.com/user-attachments/assets/585e7262-8ec1-4169-ad27-5afb8e9f3bf3" />


----------------------------------------------------------------
## Alerts

Vision OPS can message you on Discord when something goes wrong, so you do not
have to watch the camera feed. Nothing is sent until you configure a channel.

### What triggers a message

| Trigger | When it fires |
| --- | --- |
| Confirmed print failure | A camera reports `needs_attention` for `CONFIRMATION_STREAK` frames in a row (default 3). One bad frame never alerts. |
| Analysis failure | Groq rejects the API key, rate-limits, times out, or is down, so monitoring has effectively stopped. |
| Unreadable model output | The model returned text that was not valid JSON after retrying. |
| Auto-pause failure | A confirmed failure happened, but the configured printer driver could not pause the machine. |
| Server crash | An uncaught exception or unhandled rejection. |

A confirmed failure also attaches the camera frame that triggered it, so you can
see the problem without walking over to the machine. When a camera that was in a
confirmed failure returns to normal, a short recovery message follows.

Everything except confirmed failures can be turned off with
`DISCORD_NOTIFY_ERRORS=false`, and recovery messages with
`DISCORD_NOTIFY_RECOVERY=false`.

Repeats of the same alert are suppressed for `DISCORD_ERROR_COOLDOWN_MS`
(default 5 minutes) and `DISCORD_FAILURE_COOLDOWN_MS` (default 2 minutes), keyed
by camera and failure type, so a stuck camera cannot send one message per frame.
The next message that does go out reports how many were suppressed, so nothing
is silently dropped.

### Setting up Discord

1. In your Discord server, open **Server Settings > Integrations > Webhooks > New Webhook**.
2. Pick the channel you want alerts in, then click **Copy Webhook URL**.
3. Paste it into the `.env` file:

```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

4. Save the file and restart the server.

### Getting it on your phone

Discord push-notifies on mentions, so add your own user ID to `.env` and a
confirmed failure or a crash will buzz your phone:

```
DISCORD_MENTION=<@your_user_id>
```

To find your ID, turn on **Settings > Advanced > Developer Mode** in Discord,
then right-click your name and choose **Copy User ID**. A role (`<@&role_id>`),
`@here`, or `@everyone` works too. Leave it blank for no ping.

### Checking it works

With the server running, send a real test message:

```
curl -X POST http://localhost:3001/api/notifications/test
```

A rejected webhook comes back with the reason Discord gave.

### Alert API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/notifications` | Current alert configuration. The webhook URL is never returned. |
| `POST /api/notifications` | Set or clear the webhook at runtime and save it to `.env`. Send `{"webhookUrl": "..."}`, or an empty string to disable. |
| `POST /api/notifications/test` | Send a test alert. |

See `.env.example` for every setting, including snapshot attachments, cooldowns,
and the bot's display name.

----------------------------------------------------------------
## Troubleshooting

### "The image request is too large" after the first analysis

Vision OPS normally sends two images per analysis: the current frame and the
previous one, so the model can tell what changed. On Groq's free tier that pair
costs roughly 8300 tokens against a limit of 8000 tokens per minute, so the
first analysis succeeds and every one after it fails.

The server now handles this on its own — it drops the reference frame, retries,
and stays in single-frame mode for the rest of the run, posting one Discord
notice when it switches. Monitoring keeps working; only frame-to-frame change
detection is lost.

To avoid the one failed request entirely, set `SEND_REFERENCE_IMAGE=false` in
`.env`. To get the reference frame back, lower the camera resolution or upgrade
the Groq tier at [console.groq.com/settings/billing](https://console.groq.com/settings/billing).

### "Port 3001 is already in use"

Vision OPS is already running in another terminal window or browser tab session.
Open <http://localhost:3001> instead of starting it again, or close the other
window first. To run a second copy alongside it, give it another port:

```
PORT=3002 npm start
```

### A note on .env

`.env` is no longer tracked by git, because it holds your Groq API key and your
Discord webhook URL and this repository is public. Anyone cloning the project
should copy `.env.example` to `.env` and fill in their own values.
