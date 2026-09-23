#!/usr/bin/env bash
# Enables the auto-rebuild units for the Synara KWin computer-use plugin.
#
# The .path and .service units are GENERATED here rather than linked from this
# directory, because the path unit depends on a fact about this machine: which
# ABI directory actually carries KWin's development files (lib64 vs lib vs
# Debian multiarch — the same candidates the server's KWIN_CMAKE_CONFIG_PATHS
# probes). A checked-in unit could only hardcode one machine's answer.
#
# Where this checkout lives is deliberately NOT baked into the service. It runs
# a stable wrapper in ~/.local/bin that reads the source directory from a state
# file this script writes; moving or updating the app rewrites the state file
# and the units keep working, and a checkout that is gone fails loudly in the
# journal instead of silently never rebuilding.
set -euo pipefail

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$SOURCE_DIR/scripts/install-and-load.sh"
README_PATH="$SOURCE_DIR/README.md"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
# Keep in sync with STATE_ROOT in scripts/install-and-load.sh and
# scripts/uninstall.sh.
STATE_ROOT="${SYNARA_KWIN_STATE_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/synara/kwin-computer-use-plugin}"
SOURCE_DIR_FILE="$STATE_ROOT/source-dir"
WRAPPER_DIR="$HOME/.local/bin"
WRAPPER_PATH="$WRAPPER_DIR/synara-kwin-computer-use-rebuild"
UNIT_NAME="synara-kwin-computer-use-rebuild"

command -v systemctl >/dev/null 2>&1 || {
    printf 'Missing required command: systemctl\n' >&2
    exit 1
}

[[ -f "$SCRIPT_PATH" ]] || {
    printf 'install-and-load.sh is missing next to this script; the checkout looks wrong\n' >&2
    exit 1
}

# The ABI directory is whichever one really holds KWin's cmake config, in the
# same order KWIN_CMAKE_CONFIG_PATHS probes it server-side.
abi_dir=""
for candidate in /usr/lib64 /usr/lib/x86_64-linux-gnu /usr/lib/aarch64-linux-gnu /usr/lib; do
    if [[ -f "$candidate/cmake/KWin/KWinConfig.cmake" ]]; then
        abi_dir="$candidate"
        break
    fi
done
if [[ -z "$abi_dir" ]]; then
    printf 'No KWin cmake config found under /usr/lib64, /usr/lib/<multiarch>, or /usr/lib;\n' >&2
    printf 'install kwin-devel (or your distribution equivalent) first.\n' >&2
    exit 1
fi

mkdir -p "$SYSTEMD_USER_DIR" "$STATE_ROOT" "$WRAPPER_DIR"

# Written temp-plus-rename: the wrapper reads this on every run, and a
# half-written path would send it to a directory that does not exist.
source_dir_tmp="$(mktemp "$STATE_ROOT/source-dir.XXXXXX")"
printf '%s\n' "$SOURCE_DIR" >"$source_dir_tmp"
mv -f "$source_dir_tmp" "$SOURCE_DIR_FILE"

# The wrapper is the only thing the units reference. It carries no path of its
# own beyond the state file, so it is the same on every machine and never goes
# stale when the app moves.
wrapper_tmp="$(mktemp "$WRAPPER_DIR/.synara-kwin-computer-use-rebuild.XXXXXX")"
cat >"$wrapper_tmp" <<'EOF'
#!/usr/bin/env bash
# Runs the Synara KWin computer-use plugin installer from wherever the app
# currently lives. Written by systemd/enable.sh; the source directory comes
# from the state file so relocating the app does not strand these units.
set -euo pipefail
STATE_ROOT="${SYNARA_KWIN_STATE_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/synara/kwin-computer-use-plugin}"
SOURCE_DIR_FILE="$STATE_ROOT/source-dir"
if [[ ! -f "$SOURCE_DIR_FILE" ]]; then
    printf '[synara-kwin-plugin] ERROR: %s is missing; run systemd/enable.sh from the Synara checkout again, or scripts/uninstall.sh to remove these units.\n' "$SOURCE_DIR_FILE" >&2
    exit 1
fi
source_dir="$(<"$SOURCE_DIR_FILE")"
script="$source_dir/scripts/install-and-load.sh"
if [[ ! -f "$script" ]]; then
    printf '[synara-kwin-plugin] ERROR: the installer recorded in %s is gone (%s); run systemd/enable.sh from the current Synara checkout, or scripts/uninstall.sh to remove these units.\n' "$SOURCE_DIR_FILE" "$script" >&2
    exit 1
fi
exec bash "$script" "$@"
EOF
chmod 755 "$wrapper_tmp"
mv -f "$wrapper_tmp" "$WRAPPER_PATH"

# One watched file, not five: a package upgrade rewrites every KWin ABI file in
# quick succession and each write fired the service once. KWinConfigVersion.cmake
# is written last by the package, and the service's ExecStartPre delay below
# absorbs the rest of the transaction.
path_unit="$SYSTEMD_USER_DIR/$UNIT_NAME.path"
{
    echo "[Unit]"
    echo "Description=Watch the KWin package version for Synara KWin computer-use rebuilds"
    echo ""
    echo "[Path]"
    echo "PathChanged=$abi_dir/cmake/KWin/KWinConfigVersion.cmake"
    echo "Unit=$UNIT_NAME.service"
    echo ""
    echo "[Install]"
    echo "WantedBy=paths.target"
} >"$path_unit"

# The service only makes sense inside a running Wayland session: the installer
# talks to the compositor over the session bus to load the plugin, and outside
# a session there is nothing to load into. ConditionEnvironment skips it
# quietly when the user manager has no WAYLAND_DISPLAY (a headless login, a
# timer firing after logout); Requisite fails it when graphical-session.target
# is not active.
service_unit="$SYSTEMD_USER_DIR/$UNIT_NAME.service"
{
    echo "[Unit]"
    echo "Description=Rebuild and install the Synara KWin computer-use plugin"
    echo "Documentation=file:$README_PATH"
    echo "Requisite=graphical-session.target"
    echo "After=graphical-session.target"
    echo "ConditionEnvironment=WAYLAND_DISPLAY"
    echo ""
    echo "[Service]"
    echo "Type=oneshot"
    echo "ExecStartPre=/bin/sleep 20"
    echo "ExecStart=$WRAPPER_PATH"
} >"$service_unit"

# The timer is machine-independent and ships checked in; systemctl enable is
# all-or-nothing, so it must exist in the unit directory alongside the
# generated units before either can be enabled.
cp -- "$SOURCE_DIR/systemd/$UNIT_NAME.timer" "$SYSTEMD_USER_DIR/"

systemctl --user daemon-reload
systemctl --user enable \
    "$UNIT_NAME.path" \
    "$UNIT_NAME.timer"

printf 'Synara KWin rebuild units are enabled for the user manager (watching %s/cmake/KWin/KWinConfigVersion.cmake, running %s). They were not started.\n' "$abi_dir" "$WRAPPER_PATH"
