#!/usr/bin/env bash
set -euo pipefail

# A disposable Hyprland to develop the plugin against.
#
# The plugin is a binary module loaded into a live compositor: a bad build takes
# the whole desktop down with it, and on a developer's machine that desktop is
# the one their editor is open on. So plugin work never touches the session you
# are sitting in — it goes here instead, to a Hyprland with its own instance
# signature, its own session bus, and no output a human can see.
#
# Hyprland cannot take over a seat that is already in use, so it runs nested
# inside a headless `kwin_wayland --virtual`, which needs no seat at all. That
# parent is the only reason KWin appears in a Hyprland script.
#
# Started through `systemd-run --user` rather than from this shell on purpose:
# a compositor launched as a descendant of a terminal (or of an agent's sandbox)
# dies with it, and a half-killed compositor leaves sockets behind that look
# alive to every liveness check in the tree.
#
#   eval "$(scripts/dev-instance.sh)"                 # start it, export the env
#   scripts/install-and-load.sh --instance "$SYNARA_HYPRLAND_INSTANCE_SIGNATURE"
#   scripts/dev-instance.sh --stop
#
# With those variables exported, Synara's own Hyprland backend drives this
# instance too: `SYNARA_HYPRLAND_INSTANCE_SIGNATURE` is what every `hyprctl`
# call and the liveness probe resolve to.

UNIT="synara-hyprland-dev"
SIZE="1920x1080"
ACTION="start"
SUPERVISE=0
READY_TIMEOUT_SECONDS=60

usage() {
    cat <<EOF
Usage: $0 [--size WxH]
       $0 --stop
       $0 --status

Starts a headless nested Hyprland (inside a headless kwin_wayland --virtual)
under a transient user unit, and prints the environment that addresses it:

  SYNARA_HYPRLAND_INSTANCE_SIGNATURE   the nested instance, for hyprctl -i and
                                       for Synara's Hyprland backend
  DBUS_SESSION_BUS_ADDRESS             its private session bus, where the
                                       plugin registers org.synara.ComputerUse

  --size WxH   virtual output size (default $SIZE)
  --stop       stop the unit and remove its runtime directory
  --status     print the environment of a running instance, if any
EOF
}

log() {
    printf '[synara-hyprland-dev] %s\n' "$*" >&2
}

die() {
    printf '[synara-hyprland-dev] ERROR: %s\n' "$*" >&2
    exit 1
}

need_command() {
    command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --size)
            [[ $# -ge 2 ]] || die "--size needs WxH."
            SIZE="$2"
            shift 2
            ;;
        --size=*)
            SIZE="${1#--size=}"
            shift
            ;;
        --stop)
            ACTION="stop"
            shift
            ;;
        --status)
            ACTION="status"
            shift
            ;;
        --supervise)
            # Internal: this is the process the transient unit runs.
            SUPERVISE=1
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            usage >&2
            die "Unknown argument: $1"
            ;;
    esac
done

[[ "$SIZE" =~ ^[0-9]+x[0-9]+$ ]] || die "--size must look like 1920x1080, got: $SIZE"
WIDTH="${SIZE%x*}"
HEIGHT="${SIZE#*x}"

RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
STATE_DIR="$RUNTIME_DIR/$UNIT"
ENV_FILE="$STATE_DIR/instance.env"

# --- the supervised side ---------------------------------------------------

if (( SUPERVISE )); then
    need_command dbus-daemon
    need_command kwin_wayland
    need_command Hyprland

    rm -rf -- "$STATE_DIR"
    mkdir -p "$STATE_DIR"

    # A private bus, so the nested plugin's org.synara.ComputerUse cannot
    # collide with — or be mistaken for — one running on the human's session.
    dbus-daemon --session --fork \
        --print-address=3 --print-pid=4 \
        3>"$STATE_DIR/bus-address" 4>"$STATE_DIR/bus-pid"
    DBUS_SESSION_BUS_ADDRESS="$(cat "$STATE_DIR/bus-address")"
    export DBUS_SESSION_BUS_ADDRESS
    [[ -n "$DBUS_SESSION_BUS_ADDRESS" ]] || die "dbus-daemon printed no address."

    cat >"$STATE_DIR/hyprland.conf" <<EOF
monitor = , ${WIDTH}x${HEIGHT}@60, 0x0, 1
# Nothing here is for a human to look at, and nothing may pop up on the host.
misc {
    disable_hyprland_logo = true
    disable_splash_rendering = true
    force_default_wallpaper = 0
    disable_autoreload = true
}
animations {
    enabled = false
}
EOF

    # Hyprland is the client kwin_wayland runs, so it inherits the parent's
    # WAYLAND_DISPLAY and never sees the host's.
    exec kwin_wayland \
        --virtual \
        --xwayland \
        --no-global-shortcuts \
        --socket "$UNIT" \
        --width "$WIDTH" \
        --height "$HEIGHT" \
        -- Hyprland -c "$STATE_DIR/hyprland.conf"
fi

# --- the controlling side --------------------------------------------------

need_command systemctl

print_environment() {
    [[ -f "$ENV_FILE" ]] || return 1
    cat -- "$ENV_FILE"
}

case "$ACTION" in
    stop)
        systemctl --user stop "$UNIT.service" 2>/dev/null || true
        # Sockets outlive a killed compositor and answer nothing; leaving them
        # makes every liveness check in the tree report a desktop that is gone.
        if [[ -f "$ENV_FILE" ]]; then
            signature="$(sed -n 's/^export SYNARA_HYPRLAND_INSTANCE_SIGNATURE=//p' "$ENV_FILE" | tr -d "'\"")"
            [[ -n "$signature" ]] && rm -rf -- "$RUNTIME_DIR/hypr/$signature"
        fi
        rm -rf -- "$STATE_DIR"
        log "stopped"
        exit 0
        ;;
    status)
        print_environment || die "no $UNIT instance is running (no $ENV_FILE)."
        exit 0
        ;;
esac

need_command systemd-run

if systemctl --user is-active --quiet "$UNIT.service"; then
    log "$UNIT is already running; reusing it"
    print_environment && exit 0
    die "$UNIT is running but never published its environment. Run --stop and try again."
fi

# Every signature that exists before this run, so the new one can be told apart
# from the human's own session and from a leftover directory.
mapfile -t BEFORE < <(ls -1 "$RUNTIME_DIR/hypr" 2>/dev/null || true)
was_present() {
    local candidate="$1" existing
    for existing in ${BEFORE[@]+"${BEFORE[@]}"}; do
        [[ "$existing" == "$candidate" ]] && return 0
    done
    return 1
}

SELF="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/$(basename -- "${BASH_SOURCE[0]}")"

# `env -i` and not a longer allowlist: a virtual compositor that inherits
# WAYLAND_DISPLAY or DISPLAY can attach to the very session this exists to stay
# out of, and an inherited HYPRLAND_INSTANCE_SIGNATURE or
# DBUS_SESSION_BUS_ADDRESS would point the nested session's own tools back at
# the human's desktop. Only what a compositor cannot start without is passed.
systemd-run --user \
    --unit="$UNIT" \
    --description="Synara Hyprland plugin development instance" \
    --collect \
    --quiet \
    -- env -i \
    HOME="$HOME" \
    USER="${USER:-$(id -un)}" \
    LOGNAME="${LOGNAME:-${USER:-$(id -un)}}" \
    SHELL="${SHELL:-/bin/sh}" \
    PATH="$PATH" \
    LANG="${LANG:-C.UTF-8}" \
    XDG_RUNTIME_DIR="$RUNTIME_DIR" \
    XDG_SESSION_TYPE=wayland \
    bash "$SELF" --supervise --size "$SIZE" ||
    die "systemd-run could not start $UNIT."

log "waiting up to ${READY_TIMEOUT_SECONDS}s for the nested Hyprland to come up"
SIGNATURE=""
deadline=$(( SECONDS + READY_TIMEOUT_SECONDS ))
while (( SECONDS < deadline )); do
    if ! systemctl --user is-active --quiet "$UNIT.service"; then
        die "$UNIT exited before it was ready. Logs: journalctl --user -u $UNIT -e"
    fi
    for candidate in "$RUNTIME_DIR"/hypr/*; do
        [[ -d "$candidate" ]] || continue
        name="${candidate##*/}"
        was_present "$name" && continue
        # The socket, not the directory: Hyprland creates the directory first
        # and a half-started instance answers nothing.
        [[ -S "$candidate/.socket.sock" ]] || continue
        SIGNATURE="$name"
        break
    done
    [[ -n "$SIGNATURE" ]] && break
    sleep 0.25
done

[[ -n "$SIGNATURE" ]] ||
    die "the nested Hyprland did not publish an instance socket within ${READY_TIMEOUT_SECONDS}s. Logs: journalctl --user -u $UNIT -e"

BUS_ADDRESS="$(cat "$STATE_DIR/bus-address" 2>/dev/null || true)"
[[ -n "$BUS_ADDRESS" ]] || die "the nested session published no bus address."

umask 077
{
    printf 'export SYNARA_HYPRLAND_INSTANCE_SIGNATURE=%q\n' "$SIGNATURE"
    printf 'export DBUS_SESSION_BUS_ADDRESS=%q\n' "$BUS_ADDRESS"
} >"$ENV_FILE"

log "nested Hyprland $SIGNATURE is up"
print_environment
