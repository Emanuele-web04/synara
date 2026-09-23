#!/usr/bin/env bash
set -euo pipefail

# Removes the Synara Hyprland plugin: unloaded from the running compositor
# first, then deleted, then the install stamp with it.
#
# Order matters here for the same reason it does in install-and-load.sh:
# Hyprland unloads a plugin by the path it loaded it from, matched against the
# file on disk. Deleting first leaves a plugin running that nothing can name
# any more — the uninstall reports success and the agent's cursor is still
# there until the session restarts.
#
# Unloading is safe on the session you are sitting in, so unlike installing,
# this defaults to it.

PLUGIN_PREFIX="SynaraComputerUsePlugin"
PLUGIN_DIR="${SYNARA_HYPRLAND_PLUGIN_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/synara/hyprland-computer-use/plugins}"
STATE_ROOT="${SYNARA_HYPRLAND_STATE_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/synara/hyprland-computer-use-plugin}"
STAMP_FILE="$STATE_ROOT/install.stamp"
CACHE_ROOT="${SYNARA_HYPRLAND_CACHE_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/synara/hyprland-computer-use-plugin}"

INSTANCE="${HYPRLAND_INSTANCE_SIGNATURE:-}"
KEEP_BUILD_CACHE=0

usage() {
    cat <<EOF
Usage: $0 [--instance <signature>] [--keep-cache]

Unloads every installed Synara plugin generation from the named Hyprland
instance and deletes it, along with the install stamp.

  --instance <sig>  the instance to unload from (default: this shell's
                    \$HYPRLAND_INSTANCE_SIGNATURE). With no instance anywhere,
                    files are removed but nothing is unloaded, and that is
                    reported rather than assumed harmless.
  --keep-cache      leave the out-of-tree build directory in place
EOF
}

log() {
    printf '[synara-hyprland-plugin] %s\n' "$*"
}

warn() {
    printf '[synara-hyprland-plugin] WARNING: %s\n' "$*" >&2
}

die() {
    printf '[synara-hyprland-plugin] ERROR: %s\n' "$*" >&2
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --instance)
            [[ $# -ge 2 ]] || die "--instance needs a Hyprland instance signature."
            INSTANCE="$2"
            shift 2
            ;;
        --instance=*)
            INSTANCE="${1#--instance=}"
            shift
            ;;
        --keep-cache)
            KEEP_BUILD_CACHE=1
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

plugin_files=()
shopt -s nullglob
plugin_files=("$PLUGIN_DIR/${PLUGIN_PREFIX}V"*.so)
shopt -u nullglob

# The stamp can name a generation whose file an earlier install already
# deleted; it is still loaded, and this is the only record of its path.
stamped_path=""
if [[ -f "$STAMP_FILE" ]]; then
    stamped_path="$(sed -n 's/^plugin_path=//p' "$STAMP_FILE" | head -n 1)"
fi
if [[ -n "$stamped_path" ]]; then
    already=0
    for existing in ${plugin_files[@]+"${plugin_files[@]}"}; do
        [[ "$existing" == "$stamped_path" ]] && already=1
    done
    (( already )) || plugin_files+=("$stamped_path")
fi

if (( ${#plugin_files[@]} == 0 )); then
    log "no installed Synara Hyprland plugin files found in $PLUGIN_DIR"
else
    can_unload=0
    if [[ -n "$INSTANCE" ]] && command -v hyprctl >/dev/null 2>&1; then
        can_unload=1
    elif [[ -z "$INSTANCE" ]]; then
        warn "no Hyprland instance to unload from (\$HYPRLAND_INSTANCE_SIGNATURE is unset and --instance was not given). Files will be removed, but a loaded plugin stays loaded until the compositor restarts."
    else
        warn "hyprctl is not installed, so nothing can be unloaded. Files will be removed, but a loaded plugin stays loaded until the compositor restarts."
    fi

    removed=0
    for plugin_file in "${plugin_files[@]}"; do
        if (( can_unload )); then
            # hyprctl always exits 0; the reply text is the whole answer.
            reply="$(hyprctl -i "$INSTANCE" plugin unload "$plugin_file")"
            if [[ "$reply" != "ok" && "$reply" != *"not loaded"* ]]; then
                die "Hyprland would not unload $plugin_file: $reply. It was left on disk so it stays addressable; retry once the compositor answers, or restart Hyprland."
            fi
            [[ "$reply" == "ok" ]] && log "unloaded $(basename "$plugin_file")"
        fi
        rm -f -- "$plugin_file"
        removed=$(( removed + 1 ))
    done
    log "removed $removed installed plugin file(s)"
fi

rm -f -- "$STAMP_FILE"
rmdir -- "$PLUGIN_DIR" 2>/dev/null || true
if (( KEEP_BUILD_CACHE == 0 )); then
    rm -rf -- "$CACHE_ROOT"
fi
log "Done."
