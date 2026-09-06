# Joshify — The Appliance

How a Raspberry Pi 5 stops being a computer and becomes a device.

Covers tracker tasks **P7-01** (base image), **P7-02** (kiosk on DRM/KMS),
**P7-03** and **P7-04** (systemd units), **P7-05** (boot handoff) and **P7-06**
(display config).

Companion files: [`deploy/`](../deploy/) holds everything described here.
Installing it by hand is [`deploy/README.md`](../deploy/README.md); the
automated installer is P8-04.

Status: `DRAFT v1` · Last updated: 2026-09-06

---

## Read this first: one gap this document is ahead of

The appliance layer depends on `apps/server`, and one piece of it did not exist
when this was written. The boot will fail at an obvious place until it lands:

**The server does not serve the built UI.** The panel derives its WebSocket URL
from `window.location.host` (`apps/ui/src/main.ts`) and its API base is empty
"for the device, where the UI is same-origin" (`apps/ui/src/lib/commands.ts`).
So the kiosk must load the UI *from the server's own origin*,
`http://127.0.0.1:4770/`, and there is no route serving `apps/ui/dist-web`
there yet — `apps/server/src/http/server.ts` registers `/health`, `/api/*` and
`/ws` and nothing at `/`.

Loading `file:///opt/joshify/apps/ui/dist-web/index.html` instead does **not**
work as a substitute: it breaks the derived socket URL and makes every API call
cross-origin, which the `Host` check (D-034) then refuses.

Symptom: the server is healthy, the kiosk's health poll passes, the browser
starts, and you get a 404 on a dark background.

`joshify serve` itself now exists (`apps/server/src/cli/serve.ts`), so the
server unit's `ExecStart` is real. Note what it does on a fresh image with no
account connected: it refuses to start rather than serving 401s, exits 1, and
`Restart=on-failure` retries it forever. From the front that looks like the
splash never leaving. Run `joshify auth` first; see the diagnosis table.

### Two ports, which are easy to confuse

| Port | Env var | What it is |
|---|---|---|
| **4770** | `JOSHIFY_SERVE_PORT` | The panel. What the kiosk loads, what `/health` is on, what must be loopback-only. |
| 8080 | `JOSHIFY_PORT` | The OAuth loopback redirect, and only while `joshify auth` is running. It is the port registered with Spotify, so it is not free to change. |

## The boot chain, end to end

```
power on
  │
  ├─ GPU firmware            rainbow splash ──► disable_splash=1
  │                          boot_delay      ──► boot_delay=0
  ├─ kernel + KMS            logos           ──► logo.nologo
  │                          boot messages   ──► quiet loglevel=3, console=tty3
  │                          cursor          ──► vt.global_cursor_default=0
  ├─ plymouth                Joshify splash  ──► holds the screen (splash)
  ├─ systemd
  │    ├─ joshify-server.service   Node, loopback :4770, token at 0600
  │    └─ joshify-kiosk.service    waits ───────┐
  │           │                                 │
  │           ├─ poll /health until 200 ◄────────┘   readiness, not "started"
  │           ├─ plymouth quit --retain-splash       splash pixels stay on screen
  │           └─ exec chromium --ozone-platform=drm
  │                    first paint is #101114 ──► --default-background-color
  └─ Now Playing
```

Target: everything above inside **60 seconds** (PRODUCT.md §9 #1), with
**nothing** visible on screen except the splash and then the app (§9 #3's
sibling requirement, P7-05).

---

## P7-01 · The base image

**Raspberry Pi OS Lite, 64-bit, Bookworm or later.** Not Bullseye — it does not
support the Pi 5 at all. Not the Desktop image — a desktop environment is
exactly what P7-02 exists to avoid, and it costs RAM the 700MB budget
(PRODUCT.md §9 #6) does not have to give.

Flash with Raspberry Pi Imager and **use its advanced options**, because every
one of them removes a first-boot screen a stranger would otherwise have to
answer with a keyboard this device does not have:

| Imager setting | Why it matters here |
|---|---|
| Hostname | `joshify.local` gives you a name to SSH to before you know the IP |
| Username + password | Skips the `userconf` first-boot wizard entirely |
| Wi-Fi SSID + password + country | The device needs a network before anyone can reach it |
| **Enable SSH** | The only way in once tty1 belongs to the browser. Not optional. |
| Locale + timezone | Wrong timezone shows up later as a wrong clock |

Then, before measuring anything:

```bash
sudo apt update && sudo apt full-upgrade   # firmware included; Touch Display 2
sudo reboot                                # detection depends on it
```

**The first boot is not a valid cold-boot measurement.** Pi OS resizes the root
filesystem and reboots on first power-on. Measure P7-12 on the third boot, not
the first.

### Packages

```bash
sudo apt install --no-install-recommends \
  chromium-browser \
  plymouth plymouth-themes \
  curl
```

- `chromium-browser` is Raspberry Pi's build, with the V3D and Ozone patches.
  Debian's `chromium` also works; the launch script finds either.
- **plymouth is not installed on Lite.** It is what P7-05's splash *is*, so it
  has to be added explicitly.
- `curl` is the kiosk's readiness poll. Present on most images already.
- `--no-install-recommends` matters: without it `chromium-browser` drags in a
  surprising amount of desktop.

Node 22 from NodeSource, at `/usr/bin/node`. **Not nvm** — a version manager
installs the runtime under a home directory, which `ProtectHome=yes` in the
service unit makes invisible, and the failure looks like "node is missing".

### What NOT to install

No desktop environment, no display manager, no `xserver-*`, no `unclutter`
(there is no X server for it to talk to). If `startx`, `lightdm` or `wayfire`
end up on this image, something has gone wrong.

---

## P7-06 · Display

**Raspberry Pi Touch Display 2**, 7", 720×1280, five-point capacitive, over the
**22-way → 15-way DSI adapter cable** the Pi 5's 22-pin/0.5mm connector needs
(D-008). Touch Display 2 ships with the right cable; the original Touch Display
does not, and the camera adapter cable looks identical and does not work.

Config lives in [`deploy/kiosk/config-additions.txt`](../deploy/kiosk/config-additions.txt)
and [`deploy/kiosk/cmdline-additions.txt`](../deploy/kiosk/cmdline-additions.txt).

### Resolution

720×1280 native, and nothing sets it. The panel reports its own mode over DSI
and KMS uses it. Pin `video=DSI-1:720x1280@60` in `cmdline.txt` **only** if
`kmsprint` shows something else — a pinned mode that disagrees with the panel
is a black screen with no error.

### Rotation: none

The panel is natively portrait and the entire interface is designed to
720×1280 (D-039, D-040). **Do not rotate it.** If the image arrives sideways
the cause is the case, not the config, and the answer is to mount the panel the
way it was designed to be mounted.

The one legitimate rotation is a case that holds the panel inverted — 180°,
which keeps the 720×1280 geometry:

```
video=DSI-1:720x1280@60,rotate=180
```

Touch does **not** follow that automatically. Under Ozone/DRM the touch mapping
comes from libinput, and an inverted panel needs a matching
`LIBINPUT_CALIBRATION_MATRIX="-1 0 1 0 -1 1"` udev property on the touch
device. Symptom if you forget: the picture is right and every tap lands at the
point diagonally opposite. Check with `libinput list-devices`.

`display_rotate` and `display_lcd_rotate` in `config.txt` are **legacy non-KMS**
settings. Under `vc4-kms-v3d` they do nothing at all, silently, which is a
uniquely frustrating way to lose an evening.

### Blanking: never, and what that costs

`consoleblank=0` disables the kernel's VT blank timer (default 10 minutes).
There is no desktop screensaver to disable because there is no desktop, and
neither Chromium nor cog blanks a display on its own — so those two facts
together are the whole blanking policy.

**What we are trading away, stated plainly:**

- **Backlight hours.** The panel is lit 24/7. LED backlights dim over
  thousands of hours; this shortens the panel's usable life relative to one
  that sleeps.
- **Image retention.** IPS is far more resistant than OLED, but a static UI
  held for weeks can leave a faint ghost. Joshify's own design is the main
  mitigation and it is not an accident: the backdrop drifts continuously
  (PRODUCT.md §5.1), controls fade out when untouched, and the visualiser's
  idle screensaver mode (Phase 5) moves every pixel.
- **~2–3W, continuously.** Small in absolute terms for a mains-powered object,
  and already accepted as part of D-008.

**We deliberately do not dim on idle in v1.** The product is a thing you glance
at from across the room; a panel that has to be woken is a panel that failed at
its one job. If retention ever shows up in practice, the lever is a *scheduled
brightness reduction* at night via the backlight sysfs, not blanking:

```bash
cat /sys/class/backlight/*/max_brightness
echo 40 | sudo tee /sys/class/backlight/*/brightness    # dim, still readable
```

That same path is also the fastest way to answer "is the panel even powered?"
at 1am.

---

## P7-02 · The kiosk runtime, and a decision that is not ours to make yet

### The recommendation: Chromium, on Ozone/DRM

[`deploy/kiosk/joshify-kiosk`](../deploy/kiosk/joshify-kiosk) is written for
`chromium --ozone-platform=drm`, which draws straight onto KMS with no X
server, no Wayland compositor, no window manager and no desktop environment.
That is P7-02's actual requirement, and this satisfies it.

**Why Chromium is the recommendation:**

1. **Dev/prod parity.** `apps/ui/vite.config.ts` already targets `chrome120`.
   We build, test and prototype in Chrome. A second engine on the device means
   a class of bug that exists only on hardware, found only at 1am.
2. **WebGL2 is the whole of Phase 5.** The visualiser is a multi-pass fragment
   chain with float render targets (VISUALIZER.md). Chromium's ANGLE-on-GLES
   path over Mesa V3D is the well-trodden one; WPE's WebGL2 support is real but
   materially less exercised, and "which extensions do I actually have" is the
   worst question to be asking after committing.
3. **`backdrop-filter` is now load-bearing** for the control plate (D-041).
   Chromium accelerates it on V3D.
4. **It is measurable.** `--remote-debugging-port` on loopback is how P3-01
   reads frame timings and how P7-10 reads RSS. That instrumentation is the
   difference between a performance pass and a guess.
5. **Raspberry Pi maintains the build.** `chromium-browser` on Pi OS carries
   Pi-specific GPU patches. Being on the vendor's supported path is worth real
   money on a device nobody can attach a debugger to.

### What would change the recommendation — and why this is still open

**P3-01 has not been run.** It is the spike that measures Chromium against
`cog`/WPE on real Pi 5 hardware, nobody has the hardware yet, and it is still
tracked as open question **Q3** in TRACKING.md.

> Note for the reader: PRODUCT.md §8.3 and HARDWARE.md both say the Chromium
> choice was "confirmed at the P3-01 spike". That is aspirational — the tracker
> row for P3-01 is ⬜ and Q3 is unresolved. Treat this section as current.

The recommendation above is reasoning from properties, not from numbers. Three
specific measurements would overturn it:

| Measurement | Threshold | Consequence |
|---|---|---|
| **Chromium steady-state RSS**, visualiser running | above ~550MB | Blows §9 #6. `joshify-server` needs 100–150MB; cog/WPE's ~120–180MB total becomes the only way to fit. |
| **Frame budget on the default preset** | Chromium drops frames where cog holds | §9 #4 and the Phase 5 exit criterion. WPE has no browser UI layer at all and a shorter path to the display. |
| **`--ozone-platform=drm` does not work on this build** | GPU falls back to SwiftShader, or Chromium refuses to start | This is the likeliest failure. Chromium's DRM/GBM Ozone backend is not its mainstream configuration and Pi OS's build may not enable it. |

That third row is why the launch script has three modes rather than one:

| `JOSHIFY_KIOSK_RUNTIME` | What it runs | When |
|---|---|---|
| `chromium-drm` | Chromium straight on KMS | **Default.** The recommendation. |
| `chromium-cage` | Chromium inside `cage`, a one-window Wayland compositor on KMS | If DRM Ozone is unusable. Still no desktop; costs one compositor's RSS and a buffer copy. |
| `cog` | WPE WebKit, DRM-native | If RSS or frame budget says so. Untested against this UI. |

Switching is one line in `joshify-kiosk.service`. **That is the point:** the
config commits to a recommendation without pretending a measurement has
happened. When P3-01 runs, it changes an `Environment=` line and closes Q3 with
a DECISIONS.md entry — not a rewrite.

**Verify the GPU is real and not software** (the single most important check
after first paint):

```bash
JOSHIFY_KIOSK_DEBUG_PORT=9222 systemctl restart joshify-kiosk
curl -s http://127.0.0.1:9222/json/list          # from the Pi, or over an SSH tunnel
# then open chrome://gpu in the remote debugger and confirm:
#   "GL Renderer: V3D 7.1" — not "SwiftShader" or "Google Inc. (Google)"
```

---

## P7-03 / P7-04 · The units

Two units, [`joshify-server.service`](../deploy/systemd/joshify-server.service)
and [`joshify-kiosk.service`](../deploy/systemd/joshify-kiosk.service). Every
non-obvious directive carries its reasoning in the file; this section covers
the two things that are structural rather than local.

### Readiness, which is not the same as started

`After=joshify-server.service` only promises systemd *exec'd* the server. Node
then has to load, build the engine, open the socket and be willing to answer.
Starting the browser in that window gives a connection-refused page — a white
screen with console text on it, which is the exact thing P7-05 exists to
prevent.

Three ways to close the gap. We chose the third:

1. **`Type=notify`** — the server calls `sd_notify(READY=1)` when it is
   listening, and systemd holds the kiosk until then. This is the *correct*
   answer and needs no polling. It requires code in `apps/server` that does not
   exist, and declaring `Type=notify` without it makes systemd wait for a
   signal that never comes and then time out. Writing it today would be a lie
   in a config file.
2. **A `joshify-server-ready.service` oneshot** that curls `/health` and exits,
   with the kiosk `After=` it. Honest, and makes readiness visible in
   `systemd-analyze critical-chain`. Rejected for now: it is a third unit and a
   third thing to install, and it duplicates a five-line loop that has to exist
   in the launch script anyway to handle the server restarting later.
3. **A bounded `/health` poll in the launch script.** `GET /health` is already
   built and already cheap (`apps/server/src/http/server.ts` — the UI's
   reconnect loop polls it). Readiness lives in one place, next to the thing
   that depends on it. This is what ships.

The migration is deliberately cheap: when `sd_notify` lands, the server unit
becomes `Type=notify`, systemd's ordering becomes exact, and the loop in the
script demotes to a safety net for later restarts rather than being deleted.

**On timeout the script exits without touching plymouth.** The splash stays on
screen, systemd restarts the kiosk in five seconds, and it tries again. This is
chosen behaviour: a splash reads as "still starting", where a black screen or a
browser error page reads as broken. The cost is that a permanently broken
server looks identical to a slow one from the front, so the diagnosis has to
happen over SSH (see below).

### `joshify.target`: considered, not created

A `joshify.target` grouping both units would give one operator handle —
`systemctl restart joshify.target`. It is not in `deploy/` because with two
units it buys nothing that is not already true:

- `Requires=joshify-server.service` on the kiosk already means stopping the
  server stops the kiosk, in the right order.
- Restarting the server *deliberately* does not restart the kiosk. The UI
  reconnects its own socket and keeps showing last known truth (D-048), so a
  server restart is invisible on screen. A target that coupled them would
  replace an invisible restart with a black flash.
- `systemctl restart joshify-server joshify-kiosk` is the same command with a
  longer name and no extra file to install, enable and get wrong.

**What would earn it:** a third unit joining the set. The optional `librespot`
module (P8-09) is the obvious candidate — at three units, one handle beats
three names, and the target should be added then rather than in anticipation.

### Hardening, and the two places it is deliberately loose

The server holds the token; the kiosk holds nothing. That asymmetry is D-003
paying off, and the units reflect it — the server is locked down hard, the
kiosk is not.

Two directives are omitted on purpose and both would otherwise look like
oversights:

- **`MemoryDenyWriteExecute=yes` on either unit.** V8 needs writable-then-
  executable pages for JIT. Setting it stops Node and Chromium from starting.
- **`RestrictNamespaces=` and `SystemCallFilter=` on the kiosk.** Chromium's
  own multi-process sandbox needs user and PID namespaces and a wide `clone()`
  surface. Restricting them forces `--no-sandbox`, which trades a strong
  in-process sandbox for a weak systemd one. Net loss.

Also considered and rejected: `SocketBindDeny=any` + `SocketBindAllow=` on the
server. It cannot express "loopback only" — only address family and port — so
it does not enforce D-034's actual guarantee, and it silently breaks the moment
someone changes `JOSHIFY_SERVE_PORT` in the env file. A directive that duplicates
config in a second place and fails at 1am is worse than no directive. The
loopback bind and the `Host` check in `apps/server/src/http/server.ts` are the
real defence.

Check the result:

```bash
systemd-analyze security joshify-server.service    # expect a low exposure score
ss -lntp | grep 4770                               # MUST be 127.0.0.1, not 0.0.0.0
sudo stat -c '%a %n' /var/lib/joshify/*            # MUST be 600 (D-021)
sudo stat -c '%a %n' /var/lib/joshify              # MUST be 700
```

### Why the server does not wait for the network

`joshify-server.service` uses `After=network.target` and **not**
`Wants=network-online.target`. Pulling in `network-online.target` makes
`NetworkManager-wait-online.service` a boot dependency, and that can block for
30 seconds or more on a slow DHCP lease — half the entire 60-second cold-boot
budget, spent waiting for something the server does not need to start.

The server is built to come up without a network: it shows last known truth and
recovers silently (D-048, P7-07). Boot fast, paint, and let the network arrive.

`After=time-sync.target` is ordering-only for the same reason. It costs nothing
if timesyncd is not running, and if it is, we start after the clock is right —
which matters because token expiry is judged against the wall clock and a Pi
with no RTC battery boots in 1970.

---

## P7-05 · The boot handoff: everything that could appear, and what stops it

This is the complete list. Each row is a thing a person would see if the
setting were missing.

| # | What appears on screen | Suppressed by | Where |
|---|---|---|---|
| 1 | Rainbow colour-test square at power-on | `disable_splash=1` | `config.txt` |
| 2 | Four raspberry logos, top-left | `logo.nologo` | `cmdline.txt` |
| 3 | Kernel boot log scrolling past | `quiet` + `loglevel=3` | `cmdline.txt` |
| 4 | Late kernel/driver messages printed *over* the splash | `console=tty1` → `console=tty3` (replace, don't add) | `cmdline.txt` |
| 5 | systemd `[ OK ] Started …` lines | `quiet` (implies `systemd.show_status=false`) | `cmdline.txt` |
| 6 | The blinking text cursor on the VT | `vt.global_cursor_default=0` | `cmdline.txt` |
| 7 | `raspberrypi login:` prompt | `systemctl disable getty@tty1.service`, plus `Conflicts=getty@tty1.service` | install + kiosk unit |
| 8 | Screen going black mid-boot, before the splash | `splash` + plymouth installed | `cmdline.txt` + apt |
| 9 | Black gap between plymouth exiting and the browser's first frame | `plymouth quit --retain-splash` | launch script |
| 10 | plymouth quitting at the end of boot, long before the app is ready | `systemctl mask plymouth-quit.service plymouth-quit-wait.service` — the kiosk quits it instead | install |
| 11 | **White browser flash before first paint** | `--default-background-color=ff101114` (cog: `--bg-color`) | launch script |
| 12 | White flash between first paint and CSS applying | `<meta name="color-scheme" content="dark">` and `--joshify-surface: #101114` | already in `apps/ui` |
| 13 | Browser chrome, tab strip, address bar | `--kiosk` | launch script |
| 14 | "Chrome didn't shut down correctly · Restore pages?" after a power cut | `--disable-session-crashed-bubble` | launch script |
| 15 | Infobars, error dialogs, notification prompts, translate bar | `--noerrdialogs --disable-infobars --disable-notifications --disable-features=Translate` | launch script |
| 16 | Scrollbars on a panel that never scrolls (D-039) | `--hide-scrollbars` | launch script |
| 17 | A back-navigation on a horizontal swipe | `--overscroll-history-navigation=0` | launch script |
| 18 | Pinch-zoom breaking the fixed 720×1280 layout | `--disable-pinch`, plus the pinned viewport meta | launch script + `index.html` |
| 19 | A connection-refused error page because the server was not up | the `/health` poll — the splash stays instead | launch script |
| 20 | Chromium blocking on a missing keyring at startup | `--password-store=basic` | launch script |

Two things on this list are **not** suppressed, on purpose:

- **`fsck` repair output** after an unclean shutdown. `quiet` hides the routine
  case; a filesystem actually being repaired should be visible. Hiding that
  would trade a moment of ugliness for an unexplained failure later.
- **A mouse cursor**, if a mouse is plugged in. With touch-only input no
  pointer is drawn at all. A mouse is a debugging condition, and the arrow is
  a useful sign that it worked.

**Colour continuity across the handoff.** The plymouth theme's background
should be `#101114` — the same `--joshify-surface` the browser paints before
first frame and the same value `tokens.css` gives `:root`. Get that wrong and
frames 9→11→12 above each change shade slightly, which reads as flicker even
though nothing is technically flickering. The splash *artwork* itself is
P5-28's job (the original attract sequence); the mechanism is this document's.

---

## Verifying it, stage by stage

Run these in order. The first one that fails is where to look.

```bash
# 1. Firmware and cmdline took effect
cat /proc/cmdline                     # quiet, console=tty3, consoleblank=0, logo.nologo
vcgencmd get_config int | grep splash # disable_splash=1

# 2. The panel is detected at the right mode
ls /sys/class/drm/                    # card?-DSI-1 present
kmsprint                              # 720x1280, DSI-1 connected
libinput list-devices | grep -i -A2 touch

# 3. The units parse (works on any machine, before ever touching a Pi)
systemd-analyze verify deploy/systemd/joshify-server.service
systemd-analyze verify deploy/systemd/joshify-kiosk.service
sh -n deploy/kiosk/joshify-kiosk

# 4. The server is up, listening on loopback only, with a private token
systemctl status joshify-server
curl -fsS http://127.0.0.1:4770/health
ss -lntp | grep 4770                  # 127.0.0.1:4770 ONLY
sudo stat -c '%a %n' /var/lib/joshify /var/lib/joshify/*   # 700, then 600

# 5. The kiosk got to the browser
systemctl status joshify-kiosk
journalctl -u joshify-kiosk -b        # "server healthy after N attempt(s)"
pgrep -a chromium | head -1

# 6. The budgets (PRODUCT.md §9 #1 and #6)
systemd-analyze                       # total boot time
systemd-analyze blame | head -15      # what is slow
systemd-analyze critical-chain joshify-kiosk.service
ps -o rss=,comm= -C node
ps -o rss= -C chromium | awk '{s+=$1} END {print s" KB chromium total"}'
```

On the verify step above: on a non-Pi machine `systemd-analyze verify` will
report `Command /usr/bin/node is not executable` and the same for
`/usr/local/bin/joshify-kiosk`. That is the check working — the files do not
exist here — and it is not a unit error. Anything *else* it prints is.

---

## It is 1am and the screen is black

Work down. Each step assumes the one above passed.

**First, get in.** tty1 belongs to the browser, so:

- **SSH** — enabled at imaging time. `ssh joshify@joshify.local`. This is the
  main way in and the reason "Enable SSH" is marked not-optional above.
- **`Ctrl+Alt+F3`** on a plugged-in keyboard. The kernel console lives on tty3
  (see row 4), and switching VTs makes plymouth hand over the display. An
  on-demand getty starts there.
- **The SD card**, in another machine. `cmdline.txt` and `config.txt` are on
  the FAT partition and editable from any OS. Every mistake in those two files
  is recoverable this way, which is why the backup step is in both.

**Then:**

| Symptom | Likely cause | Check |
|---|---|---|
| Black, no backlight | Power, or the DSI cable. A Pi 5 on an underpowered supply fails in ways that look like anything (D-008). | `vcgencmd get_throttled` (`0x0` is healthy). Use the 27W supply. Reseat both ends of the DSI cable — the ribbon must be the *display* adapter, not the camera one. |
| Backlight on, screen black | The panel is lit but nothing is drawing. | `cat /sys/class/backlight/*/brightness`, then `kmsprint` |
| Splash forever | Server never became healthy. On a fresh image the usual cause is that no account is connected — `serve` refuses to start and systemd retries it forever | `journalctl -u joshify-server -b`. If it says `no Spotify account is connected`, run `joshify auth` (step 8 of deploy/README.md) |
| Splash, then black | The browser took DRM master and died or never painted | `journalctl -u joshify-kiosk -b`. If it mentions DRM or GBM, try `JOSHIFY_KIOSK_RUNTIME=chromium-cage`. |
| Browser error page / 404 | The gap at the top of this doc: the server is healthy but serves no UI at `/` | `curl -sI http://127.0.0.1:4770/` |
| UI paints, then goes black after minutes | Console blanking, or the kiosk restarting | `grep consoleblank /proc/cmdline`, `journalctl -u joshify-kiosk -b \| tail` |
| UI paints but is sluggish, visualiser stutters | Software rendering | `chrome://gpu` via `JOSHIFY_KIOSK_DEBUG_PORT`; look for `SwiftShader` |
| Taps land diagonally opposite | Panel rotated without rotating touch | `libinput list-devices`; see the rotation section |
| Server exits immediately with an `auth` error, but you did run `joshify auth` | The token or its key is unreadable — corruption maps to `auth` by design (D-021) | `sudo -u joshify JOSHIFY_DATA_DIR=/var/lib/joshify joshify status`, then re-run `joshify auth` |
| Everything works, then "log in again" after days | Clock, or the token store | `timedatectl`, `sudo -u joshify JOSHIFY_DATA_DIR=/var/lib/joshify joshify status` |
| A restart loop you cannot outrun | | `systemctl stop joshify-kiosk` first — it will not come back on its own, `Restart=always` notwithstanding, once systemd is told to stop it. Then debug the server. |

**The escape hatch for the whole appliance layer:**

```bash
sudo systemctl stop joshify-kiosk           # give the screen back
sudo systemctl mask joshify-kiosk           # keep it given back across reboots
sudo systemctl unmask plymouth-quit.service plymouth-quit-wait.service
```

That returns a normal, boring Linux box with a console, which is the right
place to stand while fixing anything.
