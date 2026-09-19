# Synara computer-use plugin for Hyprland

The Hyprland twin of `../computer-use-kwin`: the agent drives the human's real
desktop with its own drawn ghost cursor and its own input path, never the seat
the human is sitting at. It exposes the identical D-Bus surface —
`org.synara.ComputerUse` at `/org/synara/ComputerUse`, interface
`org.synara.ComputerUse1`, the same sixteen methods and `sessionStopped`
signal — so the server's whole KWin driving path is reused; only loading
differs (`hyprctl plugin load`, which takes effect live with no relogin).

Build with `make` against the installed Hyprland's headers (`pkg-config
hyprland`). Hyprland validates a plugin against the exact commit it was
compiled from, so every build is for one Hyprland and no other — which is why,
unlike the KWin plugin, nothing here is shipped prebuilt: a binary built
elsewhere would match almost nobody, and Hyprland ships its development headers
in the compositor package itself, so a machine running Hyprland can nearly
always compile one of its own.

Status: the plugin itself is feature-complete — window enumeration, session
lifecycle (idle timeout, Meta+Shift+Esc release/resume chord), the ghost cursor
(arrow + name badge, scale-aware, hold-then-fade), direct per-client input
injection (raw wire events on the target client's own
`wl_pointer`/`wl_keyboard` resources, seat-manager serials, xkb modifier
mirror — the compositor's seat state is never touched; the seat's pointer focus
is only observed, so an enter the human's seat sends to a sibling surface of the
agent's target invalidates the agent's own enter and the next motion re-enters,
and every agent action ends by handing the shared pointer/keyboard object back
to the seat so the human's own scroll, motion, and typing stay in their window),
and the capture
pipeline (offscreen GPU render of a window snapshot or each monitor's full
scene, read back and composited in cairo with the ghost cursor overlaid, so
captures show the agent's pointer exactly where the human sees it; the human's
cursor is never in the offscreen scene). The server side is wired too: a live
Hyprland session (instance signature with a live socket) auto-selects the
`hyprland` backend tier, which reuses the whole KWin backend engine through a
`hyprctl`-backed plugin host (`apps/server/src/computer/hyprlandPluginHost.ts`)
and provisions with `scripts/install-and-load.sh` — built from source against
the running Hyprland, loaded live by absolute path with no relogin ever, and
skipped entirely when the install stamp already names this Hyprland and these
sources.

## Developing against it

Development testing runs in a disposable nested Hyprland, never against the
live desktop: a bad plugin build takes the compositor down with it, and on a
developer's machine that is the session their editor is open in. Hyprland
cannot take a seat that is already in use, so the nested instance runs inside a
headless `kwin_wayland --virtual` parent, which needs no seat at all.

```sh
eval "$(scripts/dev-instance.sh)"     # starts it, exports the signature and bus
scripts/install-and-load.sh --instance "$SYNARA_HYPRLAND_INSTANCE_SIGNATURE"
scripts/dev-instance.sh --stop
```

`--instance` is mandatory, and naming the session you are sitting in needs
`--allow-live` on top of it. With the two variables above exported, Synara's own
backend drives the nested instance as well, so no code change is needed to
point the server at it. `scripts/uninstall.sh` unloads every installed
generation and removes it.

Run `make test` for the compositor-free input regression fixture: it compiles
the production input functions against stub protocol resources and checks
clicks, dragging, scrolling, focus restoration, and refusal cleanup. `make
authprobe` builds the standalone session-auth probe, which exposes the plugin's
token gate over a real bus with no compositor anywhere. Both run in CI
(`.github/workflows/hyprland-plugin.yml`), along with a plugin build against
Arch's Hyprland.
