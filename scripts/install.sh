#!/usr/bin/env bash
#
# Joshify installer — P8-04, the native (non-container) path.
#
#   Read this before you run it. It is meant to be readable.
#
#   curl -fsSLO https://raw.githubusercontent.com/JoshHambright/joshify/main/scripts/install.sh
#   less install.sh
#   sudo bash install.sh
#
# What it does, in order:
#   1. checks it is running on something that can host Joshify (root, systemd,
#      arm64/x86-64 Linux) and stops before touching anything if not;
#   2. downloads a release bundle and verifies its SHA-256 against the published
#      SHA256SUMS;
#   3. installs Node 22 from NodeSource if the system's node is older;
#   4. creates the `joshify` system user and its 0700 data directory;
#   5. unpacks the bundle to /opt/joshify/versions/<version> and repoints the
#      /opt/joshify/current symlink at it;
#   6. installs the systemd units shipped in the bundle;
#   7. tells you the one manual step left: `joshify auth`.
#
# What it never does: hold a Spotify secret (there isn't one — Joshify uses
# PKCE), overwrite an existing configuration file, or delete anything outside
# the prefix it created.
#
# Re-running is safe and is the supported way to upgrade: each version lands in
# its own directory and the symlink moves, so a bad version is one symlink away
# from a rollback.

set -euo pipefail

REPO='JoshHambright/joshify'
PREFIX='/opt/joshify'
DATA_DIR='/var/lib/joshify'
CONFIG_DIR='/etc/joshify'
CONFIG_FILE='/etc/joshify/joshify.env'
SERVICE_USER='joshify'
WRAPPER='/usr/local/bin/joshify'
SYSTEMD_DIR='/etc/systemd/system'
NODE_MAJOR='22'
UNITS='joshify-server.service joshify-kiosk.service'

REQUESTED_VERSION='latest'
CLIENT_ID=''
LOCAL_BUNDLE=''
SKIP_SYSTEMD='false'
ENABLE_SERVICES='true'
MODE='install'

# --------------------------------------------------------------------------
# Output. Errors go to stderr and stop the script; there is no path through
# here that leaves a machine half-installed and reports success.
# --------------------------------------------------------------------------

if [ -t 1 ]; then
  C_BOLD=$'\033[1m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'
  C_GREEN=$'\033[32m'; C_OFF=$'\033[0m'
else
  C_BOLD=''; C_RED=''; C_YELLOW=''; C_GREEN=''; C_OFF=''
fi

say() { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "${C_BOLD}" "${C_OFF}" "$*"; }
warn() { printf '%swarning:%s %s\n' "${C_YELLOW}" "${C_OFF}" "$*" >&2; }
ok() { printf '%s  ok%s %s\n' "${C_GREEN}" "${C_OFF}" "$*"; }

fail() {
  printf '%serror:%s %s\n' "${C_RED}" "${C_OFF}" "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: install.sh [options]

  --version <vX.Y.Z>   Install this release. Default: the latest published one
  --bundle <file>      Install from a local bundle tarball instead of downloading
  --client-id <id>     Write SPOTIFY_CLIENT_ID into the config on a first install
  --prefix <dir>       Install root. Default: /opt/joshify
  --skip-systemd       Install the files, register no services
  --no-enable          Install the units but do not enable them at boot
  --uninstall          Remove the program. Leaves your config and tokens alone
  -h, --help           This text

Examples:
  sudo bash install.sh
  sudo bash install.sh --version v1.2.0 --client-id 0123456789abcdef0123456789abcdef
  sudo bash install.sh --uninstall
USAGE
}

# --------------------------------------------------------------------------
# Arguments
# --------------------------------------------------------------------------

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || fail '--version needs a value, e.g. --version v1.2.0'
      REQUESTED_VERSION="$2"; shift 2 ;;
    --bundle)
      [ "$#" -ge 2 ] || fail '--bundle needs a path'
      LOCAL_BUNDLE="$2"; shift 2 ;;
    --client-id)
      [ "$#" -ge 2 ] || fail '--client-id needs a value'
      CLIENT_ID="$2"; shift 2 ;;
    --prefix)
      [ "$#" -ge 2 ] || fail '--prefix needs a path'
      PREFIX="$2"; shift 2 ;;
    --skip-systemd) SKIP_SYSTEMD='true'; shift ;;
    --no-enable) ENABLE_SERVICES='false'; shift ;;
    --uninstall) MODE='uninstall'; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
done

case "${PREFIX}" in
  /*) ;;
  *) fail "--prefix must be an absolute path, got: ${PREFIX}" ;;
esac
[ "${PREFIX}" != '/' ] || fail '--prefix must not be /'

VERSIONS_DIR="${PREFIX}/versions"
CURRENT_LINK="${PREFIX}/current"

# --------------------------------------------------------------------------
# Guards
# --------------------------------------------------------------------------

require_root() {
  [ "$(id -u)" -eq 0 ] || fail 'this needs root. Re-run it with sudo.'
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

# Deletes only paths this installer created, and only inside its own prefix.
# Anything else is a bug, and a bug here removes somebody's filesystem.
remove_managed_dir() {
  local dir="$1"
  [ -n "${dir}" ] || fail 'internal: remove_managed_dir called with no path'
  case "${dir}" in
    "${VERSIONS_DIR}"/?*) ;;
    *) fail "internal: refusing to remove a path outside ${VERSIONS_DIR}: ${dir}" ;;
  esac
  [ -d "${dir}" ] || return 0
  rm -rf -- "${dir}"
}

preflight() {
  step 'Checking this machine'
  require_root

  [ "$(uname -s)" = 'Linux' ] || fail 'Joshify installs on Linux only.'

  local arch
  arch="$(uname -m)"
  case "${arch}" in
    aarch64|arm64) ok "architecture ${arch}" ;;
    x86_64) warn "architecture ${arch}: fine for testing, but the target is a Raspberry Pi 5 (arm64)." ;;
    *) fail "unsupported architecture: ${arch}. Joshify targets arm64 (Raspberry Pi 5)." ;;
  esac

  if [ "${arch}" = 'aarch64' ] || [ "${arch}" = 'arm64' ]; then
    if [ -r /proc/device-tree/model ]; then
      local model
      model="$(tr -d '\0' < /proc/device-tree/model)"
      say "     board: ${model}"
      case "${model}" in
        *'Raspberry Pi 5'*) ;;
        *'Raspberry Pi'*)
          warn "this is not a Pi 5. Joshify targets the Pi 5 (DECISIONS.md D-008); the visualiser needs its GPU." ;;
        *) ;;
      esac
    fi
  fi

  if [ "${SKIP_SYSTEMD}" = 'false' ]; then
    [ -d /run/systemd/system ] || fail \
      'systemd is not running here. Re-run with --skip-systemd to install the files only.'
    require_cmd systemctl
  fi

  require_cmd tar
  require_cmd install
  require_cmd sha256sum
  require_cmd id
  require_cmd useradd
  if [ -z "${LOCAL_BUNDLE}" ]; then
    require_cmd curl
  fi
  ok 'prerequisites present'
}

# --------------------------------------------------------------------------
# Node
#
# Bookworm's own `nodejs` package is Node 18; Joshify needs 22 (engines in
# package.json, .nvmrc). Rather than piping NodeSource's setup script into a
# shell — the thing this installer's own documentation tells you to be wary of —
# the repository is added by hand, in six readable lines.
# --------------------------------------------------------------------------

node_major() {
  command -v node >/dev/null 2>&1 || return 1
  node --version 2>/dev/null | sed -n 's/^v\([0-9]\{1,\}\)\..*$/\1/p'
}

ensure_node() {
  step "Checking for Node ${NODE_MAJOR}+"
  local have
  have="$(node_major || true)"
  if [ -n "${have}" ] && [ "${have}" -ge "${NODE_MAJOR}" ] 2>/dev/null; then
    ok "node $(node --version) already installed"
    return 0
  fi

  if [ -n "${have}" ]; then
    say "     found node $(node --version); Joshify needs ${NODE_MAJOR} or newer"
  else
    say '     no node found'
  fi

  command -v apt-get >/dev/null 2>&1 || fail \
    "Node ${NODE_MAJOR}+ is required and this system has no apt-get. Install it yourself and re-run."

  step "Installing Node ${NODE_MAJOR} from NodeSource"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg

  local keyring='/usr/share/keyrings/nodesource.gpg'
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --batch --yes --dearmor -o "${keyring}"
  chmod 0644 "${keyring}"
  printf 'deb [signed-by=%s] https://deb.nodesource.com/node_%s.x nodistro main\n' \
    "${keyring}" "${NODE_MAJOR}" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs

  have="$(node_major || true)"
  if [ -z "${have}" ] || [ "${have}" -lt "${NODE_MAJOR}" ]; then
    fail "Node ${NODE_MAJOR}+ still not available after installing. Stopping rather than guessing."
  fi
  ok "node $(node --version)"
}

# --------------------------------------------------------------------------
# The bundle
# --------------------------------------------------------------------------

resolve_version() {
  if [ "${REQUESTED_VERSION}" != 'latest' ]; then
    printf '%s\n' "${REQUESTED_VERSION}"
    return 0
  fi
  local tag
  tag="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1)"
  [ -n "${tag}" ] || fail \
    "could not work out the latest release of ${REPO}. Pass one explicitly: --version v1.0.0"
  printf '%s\n' "${tag}"
}

# Downloads the tarball and its checksum, and refuses to go on if they disagree.
# An interrupted download on a Pi's SD card is common enough that skipping this
# would eventually cost somebody an afternoon.
fetch_bundle() {
  local tag="$1" dest="$2" version="${1#v}"
  local base="https://github.com/${REPO}/releases/download/${tag}"
  local name="joshify-${version}.tar.gz"

  step "Downloading ${name}"
  curl -fsSL --retry 3 --retry-delay 2 -o "${dest}/${name}" "${base}/${name}" \
    || fail "could not download ${base}/${name}"
  curl -fsSL --retry 3 --retry-delay 2 -o "${dest}/SHA256SUMS" "${base}/SHA256SUMS" \
    || fail "could not download ${base}/SHA256SUMS"

  step 'Verifying checksum'
  local line
  line="$(grep -F "${name}" "${dest}/SHA256SUMS" || true)"
  [ -n "${line}" ] || fail "SHA256SUMS has no entry for ${name}"
  printf '%s\n' "${line}" > "${dest}/expected.sums"
  ( cd "${dest}" && sha256sum -c --status expected.sums ) \
    || fail "checksum mismatch for ${name}. The download is corrupt or tampered with; not installing it."
  ok 'checksum matches'
  printf '%s\n' "${dest}/${name}"
}

# --------------------------------------------------------------------------
# Install
# --------------------------------------------------------------------------

ensure_user() {
  step "Ensuring the ${SERVICE_USER} service account exists"
  if id -u "${SERVICE_USER}" >/dev/null 2>&1; then
    ok "user ${SERVICE_USER} already exists"
  else
    useradd --system --home-dir "${DATA_DIR}" --create-home \
      --shell /usr/sbin/nologin \
      --comment 'Joshify service account' "${SERVICE_USER}"
    ok "created ${SERVICE_USER}"
  fi

  # 0700: this directory holds the encrypted refresh token and, beside it, the
  # key that opens it (DECISIONS.md D-021).
  install -d -m 0700 -o "${SERVICE_USER}" -g "${SERVICE_USER}" "${DATA_DIR}"
}

write_config() {
  step 'Configuration'
  install -d -m 0755 "${CONFIG_DIR}"

  if [ -f "${CONFIG_FILE}" ]; then
    ok "${CONFIG_FILE} exists — left exactly as it is"
    if [ -n "${CLIENT_ID}" ]; then
      warn "--client-id ignored: ${CONFIG_FILE} already exists. Edit it by hand if the ID changed."
    fi
    return 0
  fi

  cat > "${CONFIG_FILE}" <<CONF
# Joshify configuration. Read by the systemd units and by the joshify CLI.
#
# There is deliberately no client secret here. Joshify authenticates with
# Authorization Code + PKCE, which completes without one, so there is nothing
# on this device worth stealing beyond the token itself (which is encrypted).

# From the Spotify Developer Dashboard. Not sensitive: it travels in the
# authorize URL in plain sight by design.
SPOTIFY_CLIENT_ID=${CLIENT_ID}

# Must match a redirect URI registered on the Spotify app, exactly, including
# the port. http://127.0.0.1:8080/callback is the one Joshify expects.
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8080/callback

# Loopback only. This process can start music on your account and the LAN it
# sits on has whatever else is on it (DECISIONS.md D-034).
JOSHIFY_HOST=127.0.0.1

# The panel's server. \`joshify serve\` reads this one; the panel and the kiosk
# browser talk to it on 127.0.0.1:4770.
JOSHIFY_SERVE_PORT=4770

# A different listener, and a different port on purpose: the callback that
# \`joshify auth\` opens for the length of the PKCE exchange. It must be the port
# in the redirect URI above, because Spotify matches redirect URIs exactly.
JOSHIFY_PORT=8080

# Your ISO country code, e.g. GB or US. Without it Spotify lists tracks that are
# not licensed where this device is, and tapping one fails at play time rather
# than simply not being offered. Uncomment and set it.
# JOSHIFY_MARKET=

JOSHIFY_DATA_DIR=${DATA_DIR}
CONF

  # Readable by the service, not by every user on the box.
  chown "root:${SERVICE_USER}" "${CONFIG_FILE}"
  chmod 0640 "${CONFIG_FILE}"
  ok "wrote ${CONFIG_FILE}"
}

unpack_bundle() {
  local tarball="$1" version="$2"
  local target="${VERSIONS_DIR}/${version}"

  step "Installing to ${target}"
  install -d -m 0755 "${VERSIONS_DIR}"

  # Unpack beside the target and swap, so an interrupted extraction never
  # becomes a half-populated version directory that looks installed.
  local staging="${VERSIONS_DIR}/.incoming-${version}"
  remove_managed_dir "${staging}"
  install -d -m 0755 "${staging}"
  tar -xzf "${tarball}" -C "${staging}" --strip-components=1

  [ -f "${staging}/apps/server/dist/cli/bin.js" ] || fail \
    'the bundle has no apps/server/dist/cli/bin.js — it is not a Joshify release bundle.'

  remove_managed_dir "${target}"
  mv -- "${staging}" "${target}"
  chown -R root:root "${target}"
  ok "unpacked ${version}"

  ln -sfn "${target}" "${CURRENT_LINK}"
  ok "${CURRENT_LINK} -> ${target}"
}

write_wrapper() {
  step "Installing the ${WRAPPER} command"
  cat > "${WRAPPER}" <<WRAP
#!/bin/sh
# Installed by Joshify's installer. Runs the CLI with the device's own
# configuration loaded, so \`joshify auth\` on the Pi needs no environment setup.
set -eu
if [ -r '${CONFIG_FILE}' ]; then
  set -a
  . '${CONFIG_FILE}'
  set +a
fi
exec node '${CURRENT_LINK}/apps/server/dist/cli/bin.js' "\$@"
WRAP
  chmod 0755 "${WRAPPER}"
  ok "${WRAPPER}"
}

install_units() {
  if [ "${SKIP_SYSTEMD}" = 'true' ]; then
    warn 'skipping systemd registration (--skip-systemd). Nothing will start at boot.'
    return 0
  fi

  step 'Installing systemd units'
  local src="${CURRENT_LINK}/deploy/systemd"
  [ -d "${src}" ] || fail \
    "the bundle has no deploy/systemd directory. Refusing to leave the code installed with no service — re-run with --skip-systemd if that is really what you want."

  local unit installed=''
  for unit in ${UNITS}; do
    if [ -f "${src}/${unit}" ]; then
      install -m 0644 -o root -g root "${src}/${unit}" "${SYSTEMD_DIR}/${unit}"
      installed="${installed} ${unit}"
      ok "${SYSTEMD_DIR}/${unit}"
    elif [ "${unit}" = 'joshify-server.service' ]; then
      fail "${src}/${unit} is missing — that is the service itself, so there is nothing to install."
    else
      # The kiosk unit is genuinely optional: a headless install that only
      # serves the API is a reasonable thing to want.
      warn "${unit} not in this bundle; skipping it."
    fi
  done

  systemctl daemon-reload

  if [ "${ENABLE_SERVICES}" = 'false' ]; then
    warn 'units installed but not enabled (--no-enable).'
    return 0
  fi

  for unit in ${installed}; do
    systemctl enable "${unit}" >/dev/null
    ok "enabled ${unit}"
  done
}

# Started only once an account is connected. `joshify serve` refuses to start
# without a token, by design — a unit that comes up and then dies, restarts, and
# dies again teaches you to ignore `systemctl status`, which is the one signal
# that has to stay trustworthy.
#
# Returns success only if the service is actually running when this returns.
# Every other path is "there is still something for the human to do".
maybe_start() {
  [ "${SKIP_SYSTEMD}" = 'false' ] || return 1
  [ "${ENABLE_SERVICES}" = 'true' ] || return 1

  command -v runuser >/dev/null 2>&1 || return 1
  if ! runuser -u "${SERVICE_USER}" -- \
      env "JOSHIFY_DATA_DIR=${DATA_DIR}" \
      node "${CURRENT_LINK}/apps/server/dist/cli/bin.js" status >/dev/null 2>&1; then
    return 1
  fi

  step 'An account is already connected — restarting the service'
  systemctl restart joshify-server.service
  ok 'joshify-server is running'
  return 0
}

summary() {
  local version="$1" connected="$2"
  say ''
  say "${C_BOLD}Joshify ${version} is installed.${C_OFF}"
  say ''
  if [ "${connected}" = 'true' ]; then
    say '  Nothing left to do. Check it with:'
    say '    systemctl status joshify-server'
    say '    joshify status'
  elif [ "${SKIP_SYSTEMD}" = 'true' ]; then
    say "  No services were registered (--skip-systemd). The files are in ${PREFIX},"
    say '  and you can run it by hand with:'
    say ''
    say '    sudo -u joshify joshify auth'
    say '    sudo -u joshify joshify serve'
  else
    say '  One step left, and it has to happen on the Pi itself:'
    say ''
    if [ -z "${CLIENT_ID}" ] && ! grep -q '^SPOTIFY_CLIENT_ID=.\+' "${CONFIG_FILE}" 2>/dev/null; then
      say "    1. Put your Spotify Client ID in ${CONFIG_FILE}"
      say '       (Spotify Developer Dashboard -> your app. There is no secret to copy.)'
      say '    2. sudo -u joshify joshify auth'
    else
      say '    sudo -u joshify joshify auth'
    fi
    say ''
    say '  That prints a Spotify URL and opens it on the touchscreen. Approve it,'
    say '  and the callback lands back on this device at 127.0.0.1:8080. Then:'
    say ''
    say '    sudo systemctl start joshify-server'
  fi
  say ''
  say '  Full guide: https://github.com/JoshHambright/joshify/blob/main/docs/INSTALL.md'
  say ''
}

do_install() {
  preflight
  ensure_node

  local tag version tarball workdir
  if [ -n "${LOCAL_BUNDLE}" ]; then
    [ -f "${LOCAL_BUNDLE}" ] || fail "no such bundle: ${LOCAL_BUNDLE}"
    tarball="${LOCAL_BUNDLE}"
    version="$(basename "${LOCAL_BUNDLE}" .tar.gz)"
    version="${version#joshify-}"
    step "Installing from local bundle ${LOCAL_BUNDLE}"
  else
    tag="$(resolve_version)"
    version="${tag#v}"
    workdir="$(mktemp -d)"
    # shellcheck disable=SC2064  # expand workdir now, not at trap time
    trap "rm -rf -- '${workdir}'" EXIT
    tarball="$(fetch_bundle "${tag}" "${workdir}")"
  fi

  ensure_user
  unpack_bundle "${tarball}" "${version}"
  write_config
  write_wrapper
  install_units

  local connected='false'
  if maybe_start; then
    connected='true'
  fi
  summary "${version}" "${connected}"
}

do_uninstall() {
  require_root
  step 'Removing Joshify'

  if [ -d /run/systemd/system ]; then
    local unit
    for unit in ${UNITS}; do
      if [ -f "${SYSTEMD_DIR}/${unit}" ]; then
        systemctl disable --now "${unit}" >/dev/null 2>&1 || true
        rm -f -- "${SYSTEMD_DIR}/${unit}"
        ok "removed ${unit}"
      fi
    done
    systemctl daemon-reload
  fi

  rm -f -- "${WRAPPER}"

  if [ -L "${CURRENT_LINK}" ]; then
    rm -f -- "${CURRENT_LINK}"
  fi
  if [ -d "${VERSIONS_DIR}" ]; then
    local dir
    for dir in "${VERSIONS_DIR}"/*; do
      [ -e "${dir}" ] || continue
      remove_managed_dir "${dir}"
    done
    rmdir "${VERSIONS_DIR}" 2>/dev/null || true
    rmdir "${PREFIX}" 2>/dev/null || true
  fi
  ok "removed ${PREFIX}"

  say ''
  say 'Your configuration and your Spotify token were left alone:'
  say "  ${CONFIG_FILE}"
  say "  ${DATA_DIR}"
  say ''
  say 'Remove them yourself if you mean to, and revoke the app at'
  say '  https://www.spotify.com/account/apps/'
  say ''
  say "The ${SERVICE_USER} user was left in place too (userdel -r ${SERVICE_USER} removes it)."
}

case "${MODE}" in
  install) do_install ;;
  uninstall) do_uninstall ;;
  *) fail "internal: unknown mode ${MODE}" ;;
esac
