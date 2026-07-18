# Synara Mobile Companion

> Experimental: Mobile Companion is an opt-in feature. Synara stays local-first: the desktop
> computer runs the only backend and remains the source of truth.

Mobile Companion is an installable PWA for iPhone, iPad, and Android. It can view existing projects
and threads, run tasks in an existing project, respond to approvals and questions, upload files, and
inspect read-only diffs. It deliberately cannot browse the filesystem, create projects or worktrees,
open a terminal, manage providers or secrets, administer automations, or directly mutate Git.

| Available on mobile | Remains desktop-only |
| --- | --- |
| Browse existing projects and threads | Create projects, folders, repositories, or worktrees |
| Create a thread in an existing project | Browse arbitrary files or open a standalone terminal |
| Queue or steer a turn and interrupt a running turn | Configure providers, models, API keys, or secrets |
| Answer approvals and structured questions | Administer automations or pull requests |
| Upload photos/files and inspect read-only diffs | Stage, commit, reset, checkout, merge, rebase, or push Git state |

The restriction applies to direct Companion operations. An agent running in a thread can still use
the tools allowed by that thread's runtime mode. New mobile threads default to approval-required;
choosing full access requires an explicit confirmation.

The supported remote-access path is private HTTPS through Tailscale Serve:

```text
phone -> https://<computer>.<tailnet>.ts.net/mobile/
      -> Tailscale Serve -> http://127.0.0.1:3773
      -> Synara on the desktop computer
```

Synara remains bound to `127.0.0.1`. Do not bind it to `0.0.0.0`, expose port 3773 through a router or
firewall, or use Tailscale Funnel. Funnel is public internet exposure and is not supported for Mobile
Companion.

## Requirements

- The Synara desktop app on the computer that owns the projects.
- Tailscale installed and signed in on both the computer and phone.
- Both devices authorized to reach each other in the same Tailnet. Tailnet ACLs/grants must permit
  the phone to reach the computer's HTTPS Serve endpoint.
- A Tailscale MagicDNS name for the computer, such as `computer.example-tailnet.ts.net`.
- Port `3773` available on loopback, or another unprivileged port selected in Synara.

The host computer must be awake, online, connected to Tailscale, and running Synara. There is no cloud
relay or offline conversation database.

## Set up remote access

### 1. Check Tailscale on both devices

Sign in to Tailscale on the desktop computer and the phone. In Synara, open **Settings > Remote Access
& Devices** and refresh the Tailscale status. Synara reads:

- `tailscale status --json` to discover the computer's exact Tailnet DNS name; and
- `tailscale serve status --json` to check the current private proxy configuration and detect Funnel.

These checks are read-only. Synara never enables, resets, or authorizes Tailscale Serve for you.

### 2. Enable Mobile Companion

Enable **Remote Access / Mobile Companion** in the desktop settings. The default companion port is
`3773`. Enabling the feature also enables **Keep Synara running for mobile access** by default;
**Launch at login** remains off unless you choose it.

Remote mode restarts the backend on the selected fixed port, still bound only to `127.0.0.1`. If the
port is occupied, Synara refuses the change and reports the conflict instead of silently choosing
another port. Choose a free unprivileged port in settings, then use that same port in the Serve command.

Synara stores exactly one discovered HTTPS Tailnet origin. Wildcards and origins with a path, query,
or fragment are rejected. After refreshing diagnostics, use **Use detected** (or enter the exact
origin yourself) and save it. Pairing remains unavailable until remote access is enabled, the saved
origin matches the currently discovered machine name, Serve has an exact root route to Synara, the
route test succeeds, and no Funnel configuration is detected.

### 3. Configure private Tailscale Serve

Copy the command shown by Synara and run it yourself in PowerShell or a terminal. For the default
port, it is:

```powershell
tailscale serve --bg http://127.0.0.1:3773
```

This command publishes the loopback service only inside the Tailnet over HTTPS. Return to Synara,
refresh diagnostics, and use **Test connection**. The expected mobile address is:

```text
https://<computer>.<tailnet>.ts.net/mobile/
```

If Tailscale Serve already has a different configuration, Synara reports it but does not overwrite
it. Review the existing configuration before changing it. Synara expects the root (`/`) Serve
handler for the discovered machine DNS name to proxy the exact loopback target.

### 4. Pair the phone

In **Remote Access & Devices**, choose **Pair a device**. Open the QR link on the phone, or enter the
displayed 12-character code at the mobile address.

- A pairing credential expires after five minutes and can be used once.
- The QR URL keeps the credential after `#token=` so it is not sent in HTTP requests, proxy logs, or
  referrer headers. The PWA exchanges it immediately and clears the fragment.
- Give the phone a recognizable device name. The desktop device list can revoke it later.
- The device name can also be changed later in Mobile Companion settings.
- A paired companion session lasts up to 30 days unless it is signed out or revoked.

If a code expires, generate a new one. Do not share pairing links or codes.

### 5. Install the PWA and optionally enable notifications

On iPhone or iPad, open the mobile address in Safari, use **Share > Add to Home Screen**, then launch
Synara from the new Home Screen icon. iOS/iPadOS only offers Web Push to a Home Screen-installed web
app, and permission must be requested from a user action inside that app.

On Android, use the browser's **Install app** or **Add to Home screen** action, or the install prompt
shown by Synara.

Open **Settings** in the PWA and choose **Enable notifications**. Notification permission is optional.
Task completion, task failure, approval-required, and user-input-required alerts are supported. Message
previews are enabled by default, limited to 160 sanitized characters, and may appear on the lock screen
or pass through the platform push service. Turn **Message previews** off per device if that is not
appropriate, then use **Send test notification** to verify delivery.

Notification text is delivered through the browser vendor's Web Push infrastructure. Synara stores
push destination material encrypted on the host. Disabling
previews omits message text from newly queued notifications for that device; notification titles and
thread routing metadata are still sent.

## Attachments

The mobile composer uploads each attachment over authenticated streaming HTTP before sending the
turn. It does not base64-encode attachment bodies into the WebSocket or save them in service-worker,
IndexedDB, or localStorage caches.

- Up to eight attachment IDs may be consumed by one turn.
- Images are limited to 10 MiB and supported files to 25 MiB.
- Declared image types are checked against their file signature; SVG and unrecognized `image/*`
  formats are rejected.
- Filenames are reduced to a safe basename. Client paths are ignored.
- Unsent uploads expire after 24 hours. A device may have at most 16 outstanding uploads totaling
  200 MiB.
- Uploads belong to one session and thread and can be consumed only once, except for an idempotent
  retry of the same request.

## Keeping Synara available

With **Keep Synara running for mobile access** enabled, closing the last desktop window hides Synara
to the system tray/menu bar instead of stopping it. The first close explains this behavior. The tray
menu provides:

- **Show Synara**
- remote-access status
- **Copy mobile URL**
- **Pair a device**
- **Pause Remote Access**
- **Quit Synara**

Explicitly quitting Synara stops the backend and disconnects phones. System shutdown and application
updates also stop it normally. Sleeping the computer makes it unavailable until the computer wakes and
reconnects.

Disabling or pausing remote access closes companion connections and stops companion delivery, but does
not rewrite Tailscale Serve and does not silently revoke paired devices. Use **Revoke all devices** when
you want to invalidate their sessions. If you also want to remove the Tailscale proxy, review its
impact and run the copied command yourself:

```powershell
tailscale serve reset
```

That command resets the computer's entire Tailscale Serve configuration, not only Synara.

On Linux, if Synara cannot create a usable tray icon, closing the window shows a choice instead of
leaving an invisible background process. Keep the window open or quit Synara in that case.

## Device management and sign-out

The desktop device list shows active Companion sessions, their labels, last connection time, and
expiry. Revoking one device immediately invalidates its session, closes its active sockets, removes
its push subscriptions, and revokes any unconsumed uploads. **Revoke all devices** affects only
Companion sessions; it does not revoke the desktop owner's session.

Using **Sign out** in the PWA revokes that device's current session and clears its cookie. Re-pairing
is required afterwards. Merely disabling remote access preserves device records so access can resume
when the feature is enabled again.

## Offline and privacy behavior

When the host is unreachable, the PWA shows only a connection screen with the hostname and retry
action. It removes project, thread, transcript, and diff state from the active UI. It does not cache
conversations for offline reading and does not queue messages, approvals, interruptions, or uploads.

The service worker caches only the application shell and static assets. Authentication responses,
projects, threads, diffs, attachments, WebSocket data, and notification previews are excluded from its
cache.

## Troubleshooting

### Tailscale CLI is missing or the computer is signed out

Install or start Tailscale, sign in, then refresh diagnostics in **Remote Access & Devices**. Synara
must be able to run the local `tailscale` CLI and obtain a MagicDNS name. Also sign the phone into the
same Tailnet.

### Port 3773 is already in use

Close the program using the port or select another unprivileged port in Synara. Re-run Tailscale Serve
with the new exact loopback target. Synara intentionally does not fall back to a random port while
remote access is enabled.

### Serve reports a different target

Inspect `tailscale serve status --json`. The configured proxy target must exactly match
`http://127.0.0.1:<configured-port>`. Synara will not reset an existing Serve configuration because it
may contain unrelated services.

### Funnel warning

Do not proceed while Funnel is enabled. Disable the public Funnel configuration, confirm
`tailscale serve status --json` reports only a private Serve route, then refresh Synara diagnostics.
Never use `tailscale funnel` for the companion.

### The phone cannot open the mobile URL

Check, in order:

1. Synara remote access is enabled and its connection test succeeds.
2. The desktop computer is awake and Tailscale reports connected.
3. The phone is signed in to the intended Tailnet.
4. The URL uses the exact `https://...ts.net/mobile/` origin shown by Synara.
5. Tailnet ACLs or grants allow the phone/user to reach the desktop device on HTTPS.
6. Tailscale Serve proxies the same port configured in Synara.

Do not work around a Tailnet policy failure by opening a LAN/firewall port or enabling Funnel.

### The PWA says the host is offline

Wake the computer, start Synara if it was explicitly quit, and reconnect Tailscale. If Synara is only
hidden, use its tray/menu-bar icon to inspect status. The PWA retries on browser online/visibility
changes, or use **Try again**.

### The pairing code is invalid or expired

Pairing codes are single-use and valid for five minutes. Generate a fresh code in the desktop app and
enter all 12 characters, or scan the new QR link. A previously consumed link cannot be reused.

### The mobile session expired

Companion sessions expire after 30 days. An expired, signed-out, or revoked client returns to the
pairing flow; generate a new code from the desktop app. Do not copy cookies or bearer credentials
between devices.

### An attachment is rejected

Check the per-file size limit and try a supported type. Images must contain bytes matching their
declared media type. Cancel unused uploads or send the pending turn if the device has reached its
outstanding upload quota. A file selected for one thread cannot be attached to another thread.

### Notifications are unavailable on iPhone or iPad

Open the site in Safari, add it to the Home Screen, then launch the installed app and enable
notifications from its Settings screen. A normal Safari tab cannot receive the intended background
Web Push flow. If permission was denied, change the installed web app's notification permission in iOS
Settings; the web app cannot override a denial.

### Notifications are unavailable or delayed on Android

Confirm browser and OS notification permissions, disable battery restrictions for the installed app if
the device vendor aggressively suspends it, and send a test notification from PWA Settings. The host
must be running and connected when a domain event is produced and delivered.

### A revoked device still shows the app shell

Revocation immediately closes active companion sockets and removes push authority. Static PWA assets
may still load, but protected data and operations require a valid session. Reload the PWA to show the
pairing screen.

## Developer configuration reference

The desktop app owns normal Companion setup. For isolated development and diagnostics, the relevant
server settings are:

| Setting | Environment variable | Production Companion requirement |
| --- | --- | --- |
| Bind address | `SYNARA_HOST` | `127.0.0.1` |
| Fixed HTTP/WebSocket port | `SYNARA_PORT` | `3773` by default |
| Companion endpoint enabled | `SYNARA_COMPANION_ENABLED` | `1` after explicit opt-in |
| Exact public HTTPS origin | `SYNARA_PUBLIC_URL` | One exact `https://...ts.net` origin |
| State directory | `SYNARA_HOME` | Desktop-managed |

Do not put pairing tokens or short-lived WebSocket credentials in command lines or URLs. The PWA uses
an HttpOnly, Secure, SameSite=Strict cookie and sends its WebSocket credential in
`Sec-WebSocket-Protocol`.

The stable public interfaces are:

| Interface | Purpose |
| --- | --- |
| `/mobile/` | PWA shell and client-side routes |
| `/api/auth/bootstrap` | One-time pairing credential to PWA cookie |
| `/api/auth/bootstrap/bearer` | Existing bearer bootstrap reserved for a future native client |
| `/api/auth/ws-token` | Five-minute WebSocket credential |
| `/api/auth/logout` | Revoke the current session and clear its cookie |
| `/api/companion/v1/ws` | Restricted Companion Protocol v1 RPC and streams |
| `/api/companion/v1/attachments` | Authenticated streaming attachment upload |
| `/api/companion/v1/push-subscriptions` | Per-device Web Push registration |

Companion authentication responses, Companion API responses, and mobile HTML are served with
`Cache-Control: no-store`. Hashed PWA assets are immutable; client-side route fallback HTML is not
cached as conversation state. A Companion session is never accepted by the full desktop `/ws`
endpoint. While disabled, the diagnostic `/api/companion/v1/info` route remains readable with
`enabled: false`; restricted Companion WebSocket and authenticated data routes return `404`.

See [the Mobile Companion architecture decision](docs/architecture/mobile-companion.md) for protocol,
authorization, streaming, and compatibility details. Release owners should also use the
[experimental release checklist](docs/mobile-companion-release-checklist.md).

## External references

- [Tailscale Serve documentation](https://tailscale.com/docs/features/tailscale-serve)
- [Tailscale Funnel documentation](https://tailscale.com/kb/1223/funnel)
- [Web Push for Home Screen web apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
