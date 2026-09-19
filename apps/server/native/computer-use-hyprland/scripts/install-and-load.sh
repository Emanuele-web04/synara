#!/usr/bin/env bash
set -euo pipefail

umask 077

PLUGIN_PREFIX="SynaraComputerUsePlugin"

# User-owned everywhere, no sudo anywhere: hyprctl loads a plugin by absolute
# path, live, from any directory this user can read. Keep these defaults in
# sync with hyprlandPluginDirectory()/hyprlandInstallStampPath() in
# apps/server/src/computer/hyprlandPluginProvisioning.ts.
PLUGIN_DIR="${SYNARA_HYPRLAND_PLUGIN_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/synara/hyprland-computer-use/plugins}"
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_ROOT="${SYNARA_HYPRLAND_CACHE_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/synara/hyprland-computer-use-plugin}"
STATE_ROOT="${SYNARA_HYPRLAND_STATE_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/synara/hyprland-computer-use-plugin}"
BUILD_DIR="${SYNARA_HYPRLAND_BUILD_DIR:-$CACHE_ROOT/build}"
STAMP_FILE="$STATE_ROOT/install.stamp"
LOCK_FILE="$PLUGIN_DIR/.synara-provision.lock"
BUILD_LOCK_FILE="$CACHE_ROOT/build.lock"
# Must match s_service in the plugin and COMPUTER_SERVICE in the server's
# kwinDbus.ts: the name whose owner proves the plugin actually came up.
SERVICE_NAME="org.synara.ComputerUse"
# The files hyprlandPluginSourceHash() in the server hashes, in its order. The
# stamp this script writes is read back by the server's "is the install
# current" check, so the two hashes have to be the same hash.
SOURCE_FILES=(Makefile synarahyprlandplugin.cpp capturetransform.h sessionauth.h)

# Bounded rather than indefinite: a stuck holder must eventually be reported as
# one instead of hanging a setup the user is waiting on.
LOCK_WAIT_SECONDS=900

BUILD_ONLY=0
ALLOW_LIVE=0
INSTANCE=""

usage() {
    cat <<EOF
Usage: $0 --instance <signature> [--allow-live]
       $0 --build-only

Builds the Synara Hyprland plugin against the installed Hyprland headers,
installs it under the next unused versioned filename, loads it into the named
Hyprland instance, verifies the instance is serving that exact file, and only
then unloads and deletes the superseded builds — live, with no relogin.

  --instance <sig>  the HYPRLAND_INSTANCE_SIGNATURE of the compositor to load
                    into. Required: hyprctl otherwise addresses whatever
                    instance this shell inherited, which on a developer's
                    machine is the desktop they are sitting at. See
                    scripts/dev-instance.sh for a disposable nested one.
  --allow-live      permit --instance to name the session running this shell.
                    Loading a plugin build into the compositor you are using
                    can take the desktop down with it; this flag is how you say
                    you meant to.
  --build-only      build against the local Hyprland headers, print the built
                    .so path, and stop. Nothing is installed, loaded, or
                    stamped, and no compositor is needed. This is what Synara's
                    own provisioning calls: the build lives here so there is
                    exactly one of it, and the install and load stay on the
                    caller.
EOF
}

log() {
    printf '[synara-hyprland-plugin] %s\n' "$*"
}

die() {
    printf '[synara-hyprland-plugin] ERROR: %s\n' "$*" >&2
    exit 1
}

need_command() {
    command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --build-only)
            BUILD_ONLY=1
            shift
            ;;
        --instance)
            [[ $# -ge 2 ]] || die "--instance needs a Hyprland instance signature."
            INSTANCE="$2"
            shift 2
            ;;
        --instance=*)
            INSTANCE="${1#--instance=}"
            shift
            ;;
        --allow-live)
            ALLOW_LIVE=1
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

need_command make
need_command flock
need_command sha256sum
need_command awk

# Which compositor this run is allowed to touch, settled before anything is
# built. Getting it wrong costs a developer their desktop, so it is never
# inferred from the environment.
if (( BUILD_ONLY == 0 )); then
    need_command hyprctl
    need_command busctl
    need_command mktemp
    [[ -n "$INSTANCE" ]] ||
        die "--instance <signature> is required. Pass the signature of the Hyprland instance to load into (\$HYPRLAND_INSTANCE_SIGNATURE names the one this shell is in), or --build-only to just compile. scripts/dev-instance.sh starts a disposable nested instance and prints its signature."
    [[ "$INSTANCE" != */* && "$INSTANCE" != "." && "$INSTANCE" != ".." ]] ||
        die "Not an instance signature: $INSTANCE"
    if [[ "$INSTANCE" == "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]] && (( ALLOW_LIVE == 0 )); then
        die "Refusing to load into $INSTANCE: that is the Hyprland session this shell is running in. A plugin build that crashes takes this desktop and everything open on it with it. Use scripts/dev-instance.sh for a nested instance, or pass --allow-live if you meant this one."
    fi
    INSTANCE_SOCKET="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/hypr/$INSTANCE/.socket.sock"
    [[ -S "$INSTANCE_SOCKET" ]] ||
        die "No live Hyprland instance at $INSTANCE_SOCKET. Check \`hyprctl instances\`."
fi

hypr() {
    # hyprctl always exits 0, so every caller reads the reply text instead.
    hyprctl -i "$INSTANCE" "$@"
}

take_lock() {
    local fd="$1" path="$2" what="$3"
    eval "exec $fd>\"\$path\""
    if flock -n "$fd"; then
        return 0
    fi
    log "another $what is already running; waiting up to ${LOCK_WAIT_SECONDS}s for it"
    flock -w "$LOCK_WAIT_SECONDS" "$fd" ||
        die "timed out after ${LOCK_WAIT_SECONDS}s waiting for the $what lock: $path"
}

if (( BUILD_ONLY == 0 )); then
    mkdir -p "$PLUGIN_DIR" "$STATE_ROOT"
    take_lock 9 "$LOCK_FILE" "install"
fi
mkdir -p "$CACHE_ROOT"
take_lock 8 "$BUILD_LOCK_FILE" "build"

need_command g++
need_command pkg-config
pkg-config --exists hyprland \
    || die "Hyprland development headers are not installed (pkg-config cannot find hyprland). On Arch they ship with the hyprland package itself; check that /usr/share/pkgconfig/hyprland.pc exists."
for pkg in pixman-1 libdrm sdbus-c++ cairo xkbcommon; do
    pkg-config --exists "$pkg" || die "Missing development package: $pkg (pkg-config cannot find it)."
done

HYPR_VERSION="$(pkg-config --modversion hyprland)"

source_hash() {
    local file
    {
        for file in "${SOURCE_FILES[@]}"; do
            printf '%s' "$file"
            cat -- "$SOURCE_DIR/$file"
        done
    } | sha256sum | awk '{ print $1 }'
}

# Build out of tree so a source checkout stays clean: the Makefile writes its
# .so next to the sources it compiles, so give it a copy of them.
mkdir -p "$BUILD_DIR"
for file in "${SOURCE_FILES[@]}"; do
    cp -f "$SOURCE_DIR/$file" "$BUILD_DIR/"
done
log "Building against Hyprland $HYPR_VERSION ..."
make -C "$BUILD_DIR" >/dev/null
BUILT_SO="$BUILD_DIR/SynaraComputerUseHyprland.so"
[[ -f "$BUILT_SO" ]] || die "Build finished but $BUILT_SO does not exist."

if (( BUILD_ONLY )); then
    # The path is the contract: provisioning reads the last stdout line.
    printf '%s\n' "$BUILT_SO"
    exit 0
fi

# Next unused generation. A live-dlopened .so must never be overwritten, so
# every install is a new file; superseded ones are retired below.
next=1
for existing in "$PLUGIN_DIR/${PLUGIN_PREFIX}V"*.so; do
    [[ -e "$existing" ]] || continue
    n="${existing##*"${PLUGIN_PREFIX}V"}"
    n="${n%.so}"
    [[ "$n" =~ ^[0-9]+$ ]] && (( n >= next )) && next=$(( n + 1 ))
done
PLUGIN_ID="${PLUGIN_PREFIX}V${next}"
PLUGIN_PATH="$PLUGIN_DIR/$PLUGIN_ID.so"
install -m 0755 "$BUILT_SO" "$PLUGIN_PATH"
log "Installed $PLUGIN_PATH"

# Load first, prove it works second, retire the old builds third, and never in
# any other order. Hyprland unloads a plugin by the path string it loaded it
# from, matched against the file on disk, so a build deleted while it is still
# loaded can never be unloaded again: it keeps the service name away from its
# replacement until the compositor restarts. Unloading before loading is just as
# bad in the other direction — a refused load would leave the desktop with no
# plugin at all, having thrown away the one that was working.
REPLY="$(hypr plugin load "$PLUGIN_PATH")"
if [[ "$REPLY" != "ok" ]]; then
    rm -f "$PLUGIN_PATH"
    die "Hyprland refused to load $PLUGIN_PATH: $REPLY"
fi
log "Loaded $PLUGIN_ID into Hyprland instance $INSTANCE."

owner=""
for _ in 1 2 3 4 5; do
    if busctl --user call org.freedesktop.DBus /org/freedesktop/DBus \
        org.freedesktop.DBus GetNameOwner s "$SERVICE_NAME" >/dev/null 2>&1; then
        owner="yes"
        break
    fi
    sleep 0.2
done
[[ -n "$owner" ]] ||
    die "$PLUGIN_ID loaded, but nothing owns $SERVICE_NAME on this session bus, so the plugin did not register its service. Nothing was unloaded or removed."

health="$(busctl --user call "$SERVICE_NAME" /org/synara/ComputerUse \
    org.synara.ComputerUse1 healthJson 2>&1)" ||
    die "$PLUGIN_ID loaded, but healthJson failed: $health. Nothing was unloaded or removed."
printf '%s\n' "$health"

# busctl prints the JSON as an escaped string, so quotes arrive as \".
serving="$(printf '%s' "$health" | sed -n 's/.*\\"modulePath\\":\\"\([^\\]*\)\\".*/\1/p')"
if [[ -z "$serving" ]]; then
    log "healthJson reports no modulePath (older plugin interface); skipping the identity check"
elif [[ "$serving" != "$PLUGIN_PATH" ]]; then
    die "the compositor is serving $serving, not the $PLUGIN_PATH this run just installed — an older generation still owns $SERVICE_NAME. Nothing was unloaded or removed."
else
    log "Hyprland is serving the build this run installed."
fi

# Only now, with a proven-good replacement running, are the old ones retired:
# unloaded first, deleted only once that succeeded. A refusal here is fatal —
# a superseded build that is still loaded is exactly what the ordering above
# exists to prevent, and deleting its file would make it permanent.
retired=0
for existing in "$PLUGIN_DIR/${PLUGIN_PREFIX}V"*.so; do
    [[ -e "$existing" && "$existing" != "$PLUGIN_PATH" ]] || continue
    reply="$(hypr plugin unload "$existing")"
    if [[ "$reply" != "ok" && "$reply" != *"not loaded"* ]]; then
        die "Hyprland would not unload the superseded build $existing: $reply. It was left on disk so it stays addressable; retry once the compositor answers, or restart Hyprland."
    fi
    rm -f "$existing"
    retired=$(( retired + 1 ))
    log "Retired superseded $(basename "$existing")"
done
if (( retired > 0 )); then
    log "Retired $retired superseded build(s)."
fi

stamp_tmp="$(mktemp "$STATE_ROOT/install.stamp.XXXXXX")"
{
    printf 'plugin_id=%s\n' "$PLUGIN_ID"
    printf 'installed_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'plugin_path=%s\n' "$PLUGIN_PATH"
    printf 'hyprland_version=%s\n' "$HYPR_VERSION"
    # Read back by the server to decide whether a rebuild is needed at all.
    printf 'source_hash=%s\n' "$(source_hash)"
} >"$stamp_tmp"
# Renamed into place rather than written in place: a crash mid-write would
# leave a half-read stamp answering "is this install current" wrongly forever.
mv -f "$stamp_tmp" "$STAMP_FILE"
log "Done."
