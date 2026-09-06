# Installing Joshify

From a blank SD card to a working touchscreen, in about half an hour. Most of
that is waiting for downloads.

You do not need to have seen this repository before, and you will not write any
code. If you can flash an SD card and copy a value out of a web page, you can
finish this.

---

## What you are building

A small screen on your desk that shows what you are playing and lets you control
it by touch. It drives your Spotify account over Spotify Connect — your real
speakers, your phone, your desktop. **It is not the audio source**; it is the
remote. (There is an optional module that also makes it a Connect target, but
that is not part of this guide and is not needed for anything below.)

**You need Spotify Premium.** Every playback-control endpoint in Spotify's API
refuses a free account. Joshify will tell you plainly if the account you connect
is not Premium, rather than letting every button fail later with an error you
cannot interpret.

---

## Part 1 — The hardware

### The buy list

| Part | Notes |
|---|---|
| **Raspberry Pi 5**, 4GB or 8GB | 4GB is plenty. 8GB only if the board will do other jobs later |
| **Official 27W USB-C power supply (5V/5A)** | See the warning below. This is not the place to save $8 |
| **Active cooling** | Official Active Cooler, or a case with one built in |
| **Raspberry Pi Touch Display 2** | DSI, so one ribbon cable, and touch needs no extra wiring |
| **microSD card, 32GB+, A2-rated** | Or an NVMe SSD if your case has the HAT for it |
| A case or stand for the Pi + display | Buy them as a matched pair if you can |

Optional, and only if you later add the on-device audio module: a **USB DAC**
(~$10). The Pi 5 has no headphone jack — it was removed. You do not need one to
use Joshify as a remote, which is what this guide sets up.

### ⚠️ The two things people get wrong

Both cost you a second order and several days of waiting. Read these twice.

#### 1. The DSI cable is a different size on the Pi 5

The Pi 5 uses a **22-pin, 0.5mm-pitch** MIPI connector. Every previous full-size
Raspberry Pi used **15-pin, 1mm-pitch**. The cable that came with an older
display, or with an older Pi, **will not fit**.

- **Touch Display 2** ships with the correct **22-way → 15-way display adapter
  cable** in the box. Nothing extra to buy.
- The **original Touch Display** does not. You must buy the adapter cable
  separately.

And the trap inside the trap: **camera adapter cables look identical** and are
sold beside the display ones. They do not work. The word you are looking for on
the listing is **display**.

#### 2. It needs a 5V/5A (27W) supply — not a phone charger

The Pi 5 wants **5V at 5A**. A 5V/3A supply, a laptop USB-C port, or a generic
phone charger will appear to work and then produce faults that look like
software bugs: random reboots, corrupted SD cards, USB devices that vanish, a
display that flickers under load. People lose entire weekends to this.

Use the **official 27W USB-C supply**. If the board is under-powered, Raspberry
Pi OS shows a lightning-bolt icon in the corner — believe it.

### Assembly

Power off and unplugged for all of this.

1. **Fit the cooler first.** Peel the thermal pad backing, seat the cooler over
   the SoC, press the two spring-loaded pins home, and plug its small fan lead
   into the 4-pin `FAN` header next to the USB-C socket. Doing this after the
   display cable is fitted means working around a ribbon you would rather not
   crease.
2. **Connect the display ribbon.** On the Pi 5, use the connector marked
   **`DISPLAY`** — there are two identical-looking 22-pin sockets and the other
   one is the camera. Lift the small dark plastic latch straight up, slide the
   ribbon in with the **contacts facing the correct way for your cable** (the
   Touch Display 2 cable is keyed by its printed side; the metal contacts face
   *away* from the board's edge on the Pi end), then press the latch down. It
   should take almost no force. If it takes force, the latch is not open.
3. **Same again at the display end.** The display's own connector is the 15-way
   one; the adapter cable's wider end goes to the Pi.
4. **Mount the Pi to the display's mounting posts** (or into your case) and route
   the ribbon so it is not folded sharply. These cables tolerate a gentle curve
   and dislike a crease.
5. **Power last.** USB-C into the Pi, not into the display.

A display that stays black after all this is nearly always a ribbon that is in
the camera socket, in backwards, or not fully latched. Re-seat before you debug
anything else.

---

## Part 2 — The operating system

You need **Raspberry Pi OS Bookworm, 64-bit**. Bullseye does not support the
Pi 5 at all, and Joshify is a 64-bit (arm64) program.

1. Install **Raspberry Pi Imager** on your laptop, from raspberrypi.com.
2. Choose **Raspberry Pi 5** as the device, and **Raspberry Pi OS (64-bit)** as
   the OS. The default "with desktop" image is correct — Joshify's first-run
   login needs a browser on the device itself.
3. Click the gear / **Edit Settings** before writing, and set:
   - a hostname (`joshify` is a fine choice),
   - a username and password,
   - your Wi-Fi network and country (or plan to use Ethernet),
   - **enable SSH** — you will want it, and it saves plugging in a keyboard.
4. Write the card, put it in the Pi, and power on.

First boot takes a couple of minutes and resizes the filesystem. When the
desktop appears, the touchscreen should already work.

Then, from a terminal on the Pi (or over SSH):

```bash
sudo apt update && sudo apt full-upgrade -y && sudo reboot
```

---

## Part 3 — Register a Spotify application

This gives you a **Client ID**, which Joshify needs. It takes about five
minutes and costs nothing.

1. Go to the Spotify Developer Dashboard and log in with the **Premium** account
   you want the screen to control.
2. **Create app.** Name it `Joshify`. (If the *Create app* button is greyed out,
   that is Spotify pausing new integrations, not a mistake on your side. Wait and
   retry.)
3. Under **Redirect URIs**, add all three of these, exactly:

   ```
   http://127.0.0.1:8080/callback
   http://[::1]:8080/callback
   http://127.0.0.1:8888/callback
   ```

   The first is the one Joshify uses. The others cost nothing now and save a
   trip back here later.

   Spotify matches redirect URIs **exactly, including the port**, and rejects
   anything that is not HTTPS or a *literal* loopback address. In particular
   `http://localhost:8080/callback` is **refused** — it must be the numeric
   `127.0.0.1`.

4. Save, then copy the **Client ID**.

**Ignore the Client Secret.** Do not copy it, do not paste it anywhere, do not
put it on the Pi. Joshify authenticates with Authorization Code + PKCE, which
completes without a secret at any step. A secret you never use is purely
something to leak. The Client ID is *not* sensitive — it travels in the
authorization URL in plain sight by design.

---

## Part 4 — Install Joshify

### A word about `curl | sh`

The install command below downloads a shell script and runs it as root. That is
a genuinely dangerous pattern in general: you are executing whatever is at the
other end of a URL, sight unseen, with full privileges.

**So look at it first.** It is written to be read:

```bash
curl -fsSLO https://raw.githubusercontent.com/JoshHambright/joshify/main/scripts/install.sh
less install.sh
sudo bash install.sh
```

That is the recommended form, and it is barely slower than the one-liner. If you
want the one-liner anyway, it is:

```bash
curl -fsSL https://raw.githubusercontent.com/JoshHambright/joshify/main/scripts/install.sh | sudo bash
```

Either way, apply the same scepticism to any other project that asks you to do
this.

### What the installer does

Nothing surprising, and it says so as it goes:

1. checks it is on 64-bit Linux with systemd, and stops **before touching
   anything** if not;
2. downloads the latest release bundle and **verifies its SHA-256** against the
   published checksum — a truncated download on an SD card is common enough to be
   worth catching;
3. installs **Node 22** from NodeSource if the system's Node is older (Bookworm
   ships Node 18);
4. creates a `joshify` system user and a `0700` data directory at
   `/var/lib/joshify`, where the encrypted Spotify token lives;
5. unpacks the release to `/opt/joshify/versions/<version>` and points
   `/opt/joshify/current` at it;
6. writes `/etc/joshify/joshify.env` — **and never overwrites it** if it already
   exists;
7. installs the systemd units and enables them for boot;
8. installs a `joshify` command at `/usr/local/bin/joshify`.

No compiler runs on the Pi. The release bundle ships already built, which is most
of why this fits in half an hour.

**Re-running the installer is safe, and is how you upgrade.** Each version gets
its own directory and the symlink moves, so rolling back is one command.

Useful options:

```bash
sudo bash install.sh --version v1.2.0    # pin a specific release
sudo bash install.sh --client-id <id>    # fill the config in as it installs
sudo bash install.sh --skip-systemd      # install the files, register no services
sudo bash install.sh --uninstall         # remove the program, keep config + token
sudo bash install.sh --help
```

### Put your Client ID in

If you did not pass `--client-id`:

```bash
sudo nano /etc/joshify/joshify.env
```

Set `SPOTIFY_CLIENT_ID=` to the value you copied in Part 3. Leave everything
else alone unless you have a reason. There is no secret to add.

---

## Part 5 — Connect your account

This is the one step that has to happen **on the Pi itself**, at the
touchscreen, because the browser that approves the login and the program that
receives the answer must be the same machine — that is what makes
`127.0.0.1` work as a redirect target.

```bash
sudo -u joshify joshify auth
```

It prints a Spotify URL and tries to open it on the Pi's screen. Approve the
request in the browser. The page redirects to `127.0.0.1:8080`, Joshify catches
it, and the terminal says:

```
Connected as <your name>.
Ready.
```

If the browser does not open by itself, copy the printed URL into Chromium on
the Pi by hand. Do **not** open it on your laptop — the callback would land on
your laptop's loopback, where nothing is listening.

The token is stored **encrypted** in `/var/lib/joshify`, survives reboots, and
refreshes itself. You should never need to run this again. If you ever want to
undo it, `sudo -u joshify joshify logout`, and revoke the app at
`spotify.com/account/apps`.

Then start it:

```bash
sudo systemctl start joshify-server
joshify status
systemctl status joshify-server
```

From here, a reboot brings the screen up on its own.

---

## The 30-minute budget

| Step | Time |
|---|---|
| Assembly | 5 min |
| Flashing the SD card | 5 min (mostly unattended) |
| First boot + `apt full-upgrade` | 6 min (unattended) |
| Registering the Spotify app | 5 min |
| Running the installer | 4 min |
| `joshify auth` | 2 min |

---

## The container path (optional)

There is a published image if you would rather run the server in Docker:

```bash
curl -fsSLO https://raw.githubusercontent.com/JoshHambright/joshify/main/docker-compose.yml
docker compose run --rm server auth     # one-time login, same flow as above
docker compose up -d
```

Put your Client ID in a `.env` file beside `docker-compose.yml`:

```
SPOTIFY_CLIENT_ID=<your client id>
```

### What the container actually covers — read this before choosing it

**The container runs the server half only. The kiosk browser does not, and
should not, run in it.**

The server is a Node process that talks to Spotify over the network and serves
loopback — an excellent fit for a container. The kiosk is a Chromium instance
that must reach the Pi's GPU and input devices directly: `/dev/dri` for the
VideoCore VII driver, `/dev/input` for the touchscreen, a seat and a TTY for
DRM/KMS master. You *can* pass all of that into a container, but doing so means
granting nearly everything a container exists to withhold, and pinning the Mesa
version inside the image to the kernel outside it. You would take on all of the
cost of containers and keep none of the isolation.

So the honest division is:

| Part | Container path | Native path |
|---|---|---|
| Spotify I/O, tokens, polling, theme extraction | ✅ in the container | ✅ |
| REST + WebSocket transport | ✅ in the container | ✅ |
| The panel bundle (static files) | ✅ ships in the image — see the note below | ✅ on disk |
| The kiosk browser on DRM/KMS | ❌ **runs natively regardless** | ✅ |
| Boot-to-app, display rotation, screen blanking | ❌ host's job | ✅ |

One more wrinkle worth knowing: **where the kiosk browser gets the panel from.**

With the native install it is on disk at
`/opt/joshify/current/apps/ui/dist-web/index.html`, and the kiosk unit points at
it. Nothing to do.

With the container the bundle is inside the image. If your version's server
serves the panel on its own origin, the kiosk simply opens
`http://127.0.0.1:4770/` and you are done. If it does not — check with
`curl -I http://127.0.0.1:4770/` — lift the bundle out onto the host first:

```bash
docker compose cp server:/app/apps/ui/dist-web ./panel
```

**Recommendation: use the native installer.** It is a single-purpose appliance,
not a multi-tenant server; the container buys you very little here and costs you
the kiosk half of the setup. Use the container if you already run everything on
this Pi in Docker and want Joshify to match, or if you want the server on a
different machine from the screen.

Note that the compose file uses `network_mode: host`, and that this is
load-bearing rather than laziness: under bridge networking, the browser's
`127.0.0.1` during login is the *host* and the listener is in the container, so
the Spotify callback lands nowhere. Host networking makes them the same loopback.

---

## Upgrading, rolling back, removing

**Upgrade** — re-run the installer. It fetches the newest release, unpacks it
beside the old one, and moves the symlink:

```bash
sudo bash install.sh
sudo systemctl restart joshify-server
```

**Roll back** — the previous version is still on disk:

```bash
ls /opt/joshify/versions
sudo ln -sfn /opt/joshify/versions/<older-version> /opt/joshify/current
sudo systemctl restart joshify-server
```

**Remove** — `sudo bash install.sh --uninstall`. It deliberately leaves
`/etc/joshify` and `/var/lib/joshify` alone; delete them yourself if you mean to,
and revoke the app at `spotify.com/account/apps`.

---

## When something is wrong

**Start here.** These two answer most questions:

```bash
joshify status                       # is an account connected, is the token fresh
journalctl -u joshify-server -n 50   # what the service actually said
```

| Symptom | Cause, usually |
|---|---|
| Display stays black, Pi otherwise boots | Ribbon in the `CAMERA` socket instead of `DISPLAY`, in backwards, or not latched. Re-seat it |
| Lightning-bolt icon, random reboots, flaky USB | Under-powered. You need the 5V/5A (27W) supply |
| Fan never stops | Expected under load on a Pi 5; check the cooler is actually seated on the SoC |
| `joshify auth` says `INVALID_CLIENT: Invalid redirect URI` | The URI in the dashboard is not *exactly* `http://127.0.0.1:8080/callback` — check for `localhost`, a trailing slash, or a different port |
| The browser opened but the page never returns | You opened the URL on the wrong machine. It has to be the Pi's own browser |
| Every playback button fails with a 403 | The account is not Premium. Joshify says so at the end of `joshify auth` |
| `joshify-server` starts, then exits | Usually "no Spotify account is connected". It refuses to run tokenless rather than serving errors that look healthy from outside. Run `joshify auth` |
| Port 8080 already in use during auth | Something else on the Pi has it. Register `http://127.0.0.1:8888/callback` (you already did) and set `JOSHIFY_PORT=8888` |
| Search shows tracks that will not play | Set `JOSHIFY_MARKET` to your ISO country code in `/etc/joshify/joshify.env` |

### The ports, since there are two and they are different

| Port | What | Set by |
|---|---|---|
| **4770** | The panel's server. What the kiosk browser talks to | `JOSHIFY_SERVE_PORT` |
| **8080** | The login callback listener, open only during `joshify auth` | `JOSHIFY_PORT` |

`JOSHIFY_PORT` must match a redirect URI registered with Spotify. `4770` is
internal and you can change it freely.

### Where everything lives

| Path | What |
|---|---|
| `/opt/joshify/current` | The running version (a symlink) |
| `/opt/joshify/versions/` | Every installed version, for rollback |
| `/etc/joshify/joshify.env` | Configuration. Yours; never overwritten by an upgrade |
| `/var/lib/joshify` | Encrypted token and the artwork cache. `0700` |
| `/usr/local/bin/joshify` | The CLI |
| `/etc/systemd/system/joshify-*.service` | The services |

---

## See also

- [`HARDWARE.md`](./HARDWARE.md) — why the Pi 5, and the full reasoning behind
  the buy list above
- [`SPOTIFY_SETUP.md`](./SPOTIFY_SETUP.md) — the scopes Joshify asks for, and
  why it asks for no write access to your library
- [`RELEASING.md`](./RELEASING.md) — how the releases you are installing are cut
