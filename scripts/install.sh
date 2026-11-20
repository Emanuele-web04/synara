#!/bin/sh
# Installs Synara for the current Linux user. No root is needed.
#
#   curl -fsSL https://raw.githubusercontent.com/Emanuele-web04/synara/main/scripts/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/Emanuele-web04/synara/main/scripts/install.sh | sh -s -- --beta
#   curl -fsSL https://raw.githubusercontent.com/Emanuele-web04/synara/main/scripts/install.sh | sh -s -- --uninstall
#
# Synara keeps its AppImage in a fixed place, so the update button in the app can replace it.

set -eu

RELEASES_URL=${SYNARA_INSTALL_RELEASES_URL:-https://github.com/Emanuele-web04/synara/releases}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "Install curl or wget, then run this command again."
  fi
}

manifest_value() {
  sed -n "s/^$1: *//p" "$2" | head -n 1
}

# The launcher runs an unpacked copy of the AppImage, because many distributions no longer ship
# the FUSE 2 library that an AppImage needs to mount itself. APPIMAGE still names the AppImage
# file: the in-app updater replaces that file and the launcher unpacks it again.
write_launcher() {
  cat >"$1" <<'LAUNCHER'
#!/bin/sh
set -u

dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
appimage=$dir/Synara.AppImage
app=$dir/app

stamp() {
  stat -c '%i-%s-%Y' "$appimage" 2>/dev/null
}

running() {
  for exe in /proc/[0-9]*/exe; do
    case $(readlink "$exe" 2>/dev/null) in
      "$app"/*) return 0 ;;
    esac
  done
  return 1
}

# Unpacking under a running app would delete files it still loads, so that waits for the next start.
unpack() {
  [ "$(cat "$app.stamp" 2>/dev/null)" = "$1" ] && return 0
  running && return 0
  tmp=$(mktemp -d "$dir/unpack.XXXXXX") || return 1
  if (cd "$tmp" && "$appimage" --appimage-extract >/dev/null 2>&1); then
    rm -rf "$app" && mv "$tmp/squashfs-root" "$app" && printf '%s\n' "$1" >"$app.stamp"
  fi
  rm -rf "$tmp"
  [ "$(cat "$app.stamp" 2>/dev/null)" = "$1" ]
}

while :; do
  current=$(stamp) || {
    echo "Synara is not installed correctly. Run the installer again." >&2
    exit 1
  }
  unpacked=0
  (flock 9 2>/dev/null; unpack "$current") 9>"$dir/unpack.lock" || unpacked=1
  [ "${SYNARA_INSTALL_PREPARE:-}" = 1 ] && exit "$unpacked"
  if [ ! -x "$app/AppRun" ]; then
    echo "Synara could not unpack $appimage. Run the installer again." >&2
    exit 1
  fi

  # An APPDIR inherited from another AppImage would send AppRun to that app's files.
  status=0
  APPDIR=$app APPIMAGE=$appimage "$app/AppRun" "$@" || status=$?

  # A changed AppImage means the app installed an update and quit, so start the new version.
  [ "$(stamp)" != "$current" ] || exit "$status"
  tries=0
  while running && [ "$tries" -lt 15 ]; do
    sleep 1
    tries=$((tries + 1))
  done
  set --
done
LAUNCHER
  chmod 755 "$1"
}

uninstall() {
  rm -rf "$dir"
  rm -f "$data/applications/$name.desktop" "$data"/icons/hicolor/*/apps/"$name.png"
  echo "$title is removed. Your projects and settings in ~/.$name are kept."
}

install() {
  case $(uname -m) in
    x86_64 | amd64) arch= ;;
    aarch64 | arm64) arch=-arm64 ;;
    *) fail "Synara has no Linux build for $(uname -m)." ;;
  esac
  for tool in sha512sum base64 od awk stat mktemp; do
    command -v "$tool" >/dev/null 2>&1 || fail "This installer needs the '$tool' command."
  done

  mkdir -p "$dir"
  work=$(mktemp -d "$dir/install.XXXXXX")
  trap 'rm -rf "$work"' EXIT

  if [ "$name" = synara-beta ]; then
    fetch "$RELEASES_URL.atom" "$work/releases" || fail "Could not read the Synara release list."
    tag=$(grep -o 'releases/tag/v[0-9][0-9.]*-beta\.[0-9][0-9]*' "$work/releases" | head -n 1 | sed 's|.*/||')
    [ -n "$tag" ] || fail "No Synara Beta release was found."
    manifest_url=$RELEASES_URL/download/$tag/beta-linux$arch.yml
  else
    manifest_url=$RELEASES_URL/latest/download/latest-linux$arch.yml
  fi
  fetch "$manifest_url" "$work/manifest" || fail "$title has no Linux build for $(uname -m) yet."

  version=$(manifest_value version "$work/manifest")
  payload=$(manifest_value path "$work/manifest")
  sha512=$(manifest_value sha512 "$work/manifest")
  printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$' || fail "The release manifest has no valid version."
  printf '%s\n' "$payload" | grep -Eq '^[A-Za-z0-9._-]+\.AppImage$' || fail "The release manifest has no valid AppImage name."
  printf '%s\n' "$sha512" | grep -Eq '^[A-Za-z0-9+/]+=*$' || fail "The release manifest has no valid checksum."

  echo "Downloading $title $version..."
  fetch "$RELEASES_URL/download/v$version/$payload" "$work/Synara.AppImage" || fail "The download failed. Run this command again."
  expected=$(printf '%s' "$sha512" | base64 -d | od -An -vtx1 | tr -d ' \n')
  actual=$(sha512sum "$work/Synara.AppImage" | cut -d ' ' -f 1)
  [ "$actual" = "$expected" ] || fail "The download does not match the published checksum. Run this command again."
  chmod 755 "$work/Synara.AppImage"

  # Check the package before it replaces a working install: it must unpack and be this flavor.
  (cd "$work" && ./Synara.AppImage --appimage-extract "$name.desktop" >/dev/null 2>&1) || true
  [ -f "$work/squashfs-root/$name.desktop" ] || fail "The download is not a $title package for this computer."

  mv -f "$work/Synara.AppImage" "$dir/Synara.AppImage"
  write_launcher "$dir/launch"
  SYNARA_INSTALL_PREPARE=1 "$dir/launch" || fail "Could not unpack $title."

  mkdir -p "$data/applications" "$data/icons/hicolor/512x512/apps"
  cp "$dir/app/.DirIcon" "$data/icons/hicolor/512x512/apps/$name.png"
  # Quote only when needed: released builds read this line to find Beta and expect a bare path.
  case $dir in
    *[!A-Za-z0-9/._-]*) launcher="\"$dir/launch\"" ;;
    *) launcher=$dir/launch ;;
  esac
  awk -v exec="Exec=$launcher %U" '
    /^X-AppImage-Version=/ { next }
    /^Exec=/ { print exec; next }
    { print }
  ' "$dir/app/$name.desktop" >"$data/applications/$name.desktop"
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$data/applications" >/dev/null 2>&1 || true
  fi

  echo "$title $version is installed. Open it from your app menu, or run:"
  echo "  $dir/launch"
  echo "Updates install from inside the app."
}

main() {
  name=synara
  title=Synara
  action=install
  for option in "$@"; do
    case $option in
      --beta)
        name=synara-beta
        title="Synara Beta"
        ;;
      --uninstall) action=uninstall ;;
      *) fail "Unknown option: $option. Use --beta or --uninstall." ;;
    esac
  done

  [ "$(uname -s)" = Linux ] || fail "This installer is for Linux. Get Synara for other systems at https://www.trysynara.com/install"
  [ -n "${HOME:-}" ] || fail "HOME is not set."
  data=${XDG_DATA_HOME:-$HOME/.local/share}
  dir=$data/$name

  "$action"
}

# Run only after the whole script has arrived, so a cut-off download does nothing.
main "$@"
