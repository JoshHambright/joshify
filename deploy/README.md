# deploy/

Everything that turns a Raspberry Pi 5 into the Joshify appliance. Tracker
tasks P7-01 through P7-06.

The reasoning — why each setting exists, what it trades away, and how to
diagnose a black screen — is in **[docs/APPLIANCE.md](../docs/APPLIANCE.md)**.
This file is just what is here and how to put it on a Pi by hand. The
automated installer is P8-04 and does not live here.

## What is in here

| File | What it is |
|---|---|
| `systemd/joshify-server.service` | The Node server. Loopback only, hardened, state in `/var/lib/joshify` |
| `systemd/joshify-kiosk.service` | The browser. Ordered after the server is *ready*, not merely started |
| `kiosk/joshify-kiosk` | The launch script the kiosk unit runs: health poll → splash handoff → browser |
| `kiosk/cmdline-additions.txt` | Tokens to merge into `/boot/firmware/cmdline.txt` |
| `kiosk/config-additions.txt` | Lines to append to `/boot/firmware/config.txt` |

There is no `joshify.target`. Two units with an explicit dependency say
everything a target would; APPLIANCE.md records what would earn one.

## Installing by hand

On Raspberry Pi OS **Lite, 64-bit, Bookworm or later**. Bullseye does not
support the Pi 5.

```bash
# 1. Packages. Node 22 comes from NodeSource, at /usr/bin/node — never nvm.
sudo apt install --no-install-recommends chromium-browser plymouth plymouth-themes curl

# 2. A system user that owns the app and its token
sudo useradd --system --home-dir /opt/joshify --shell /usr/sbin/nologin joshify
sudo usermod -aG video,render,input,tty joshify

# 3. The built app at /opt/joshify (pnpm install && pnpm build first)
sudo mkdir -p /opt/joshify && sudo cp -r . /opt/joshify/
sudo chown -R root:root /opt/joshify        # read-only to the service user

# 4. Config. SPOTIFY_CLIENT_ID lives here; nothing secret does (PKCE, no secret).
sudo install -d -m 0755 /etc/joshify
sudo install -m 0644 .env.example /etc/joshify/joshify.env
sudo nano /etc/joshify/joshify.env
#    Needs SPOTIFY_CLIENT_ID. JOSHIFY_SERVE_PORT (the panel, default 4770) and
#    JOSHIFY_MARKET are optional; JOSHIFY_PORT is the OAuth redirect port only.

# 5. The launch script and the units
sudo install -m 0755 deploy/kiosk/joshify-kiosk /usr/local/bin/joshify-kiosk
sudo install -m 0644 deploy/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload

# 6. Boot config. Read both files first — cmdline.txt is one line, and one
#    token in it has to be REPLACED rather than added.
sudo cp /boot/firmware/cmdline.txt /boot/firmware/cmdline.txt.bak
sudo cp /boot/firmware/config.txt  /boot/firmware/config.txt.bak
sudo nano /boot/firmware/cmdline.txt   # per kiosk/cmdline-additions.txt
sudo nano /boot/firmware/config.txt    # per kiosk/config-additions.txt

# 7. Give the screen to the app: no login prompt, and plymouth stays up until
#    the kiosk takes over rather than quitting at the end of boot.
sudo systemctl disable getty@tty1.service
sudo systemctl mask plymouth-quit.service plymouth-quit-wait.service

# 8. Connect a Spotify account, once, as the service user. `joshify serve`
#    refuses to start without one, so this is not optional and not deferrable.
sudo -u joshify JOSHIFY_DATA_DIR=/var/lib/joshify /usr/bin/node \
  /opt/joshify/apps/server/dist/cli/bin.js auth

# 9. Go
sudo systemctl enable --now joshify-server joshify-kiosk
sudo reboot
```

## Checking it worked

```bash
systemd-analyze verify /etc/systemd/system/joshify-*.service
systemctl status joshify-server joshify-kiosk
curl -fsS http://127.0.0.1:4770/health
ss -lntp | grep 4770                 # must be 127.0.0.1 only
sudo stat -c '%a %n' /var/lib/joshify/*   # must be 600
```

`systemd-analyze verify` also runs on a laptop with no Pi attached — it will
report the missing `/usr/bin/node` and `/usr/local/bin/joshify-kiosk`, which is
expected, and will catch anything actually wrong with the unit files.

The full stage-by-stage checklist and the black-screen decision tree are in
[docs/APPLIANCE.md](../docs/APPLIANCE.md).
