#!/usr/bin/env python3
"""Read a bounded AT-SPI tree and return JSON-RPC responses on stdout."""

import json
import sys
import time
import unicodedata

try:
    import gi

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
except Exception as error:  # pragma: no cover - exercised only on live Linux
    Atspi = None
    ATSPI_IMPORT_ERROR = str(error)
else:
    ATSPI_IMPORT_ERROR = None


MAX_NODES = 2048
MAX_DEPTH = 64
# The window search has its own node budget, separate from the per-window tree
# walk above. It only ever visits desktop → application → toplevel candidates
# (it never descends into a window), so this is a cap on the number of
# applications and toplevels, not on widget trees.
SEARCH_MAX_NODES = 4096
# Wall-clock budget for one request. The client times a request out at 10 s;
# answering with what was gathered by then keeps a hung application from
# costing perception of every other window, and keeps the transport alive.
REQUEST_BUDGET_SECONDS = 7.0
# Per-call and startup D-Bus timeouts (milliseconds) handed to libatspi. A
# single unresponsive application otherwise blocks each call for libatspi's
# default 800 ms, which the request budget above cannot interrupt.
ATSPI_CALL_TIMEOUT_MS = 200
ATSPI_STARTUP_TIMEOUT_MS = 2000
WINDOW_ROLE_NAMES = {"frame", "window", "dialog"}
EDITABLE_TEXT_INTERFACE = "editabletext"

# Accessible names are whatever the application put there — dense Chromium or
# Electron trees carry paragraph-sized labels — and this helper's reply is one
# newline-framed line that the client caps (HELPER_MAX_FRAME_BYTES in
# atspiClient.ts, 8 MiB). A line past the cap is a transport error, a process
# reset, and silent perception loss for that application, so the truncation
# happens here, before serialization, rather than after the bytes crossed the
# wire.
MAX_TEXT_CHARS = 1024
MAX_ROLE_CHARS = 64
# Headroom under the client cap for the envelope and framing itself. If even
# the stripped fallback below cannot fit, failing the one request loudly beats
# desyncing the transport for everything behind it.
SAFE_REPLY_BYTES = 6 * 1024 * 1024


class RequestBudget:
    """Wall-clock and search-node budget shared by everything one request does.

    Exhaustion is sticky: once the deadline passes or the search budget is
    spent, every later check answers "stop" so the request winds down and
    replies with what it has instead of racing the client's timeout.
    """

    def __init__(self, seconds=REQUEST_BUDGET_SECONDS, clock=None, max_search_nodes=None):
        self.clock = clock or time.monotonic
        self.deadline = self.clock() + seconds
        self.max_search_nodes = SEARCH_MAX_NODES if max_search_nodes is None else max_search_nodes
        self.search_nodes = 0
        self.exhausted = False

    def expired(self):
        if not self.exhausted and self.clock() >= self.deadline:
            self.exhausted = True
        return self.exhausted

    def take_search_node(self):
        if self.expired() or self.search_nodes >= self.max_search_nodes:
            self.exhausted = True
            return False
        self.search_nodes += 1
        return True


class TreeBudget:
    """Node budget for one window's tree walk, cut short by the request deadline."""

    def __init__(self, request=None, max_nodes=MAX_NODES):
        self.request = request
        self.max_nodes = max_nodes
        self.nodes = 0

    def take(self):
        if self.nodes >= self.max_nodes:
            return False
        if self.request is not None and self.request.expired():
            return False
        self.nodes += 1
        return True


def configure_atspi():
    """Bound every libatspi call so one hung application cannot stall a request.

    Older bindings lack ``set_timeout``; the request budget still bounds the
    damage there, just less tightly.
    """
    if Atspi is None:
        return False
    try:
        Atspi.set_timeout(ATSPI_CALL_TIMEOUT_MS, ATSPI_STARTUP_TIMEOUT_MS)
        return True
    except Exception:
        return False


def clamp_text(value, limit):
    """Cut to `limit` characters without splitting a surrogate pair.

    Python strings are sequences of code points, so plain slicing never lands
    inside a surrogate pair — the hazard the TypeScript side guards against does
    not exist here. `None` passes through untouched.
    """
    if not isinstance(value, str) or len(value) <= limit:
        return value
    return value[:limit]


def emit(message):
    encoded = json.dumps(message, separators=(",", ":"))
    sys.stdout.write(encoded + "\n")
    sys.stdout.flush()


def rect_for(accessible):
    try:
        component = accessible.get_component_iface()
        rect = component.get_extents(Atspi.CoordType.SCREEN)
        return {
            "x": float(rect.x),
            "y": float(rect.y),
            "width": max(0.0, float(rect.width)),
            "height": max(0.0, float(rect.height)),
        }
    except Exception:
        return {"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0}


def text_or_none(value):
    return value if isinstance(value, str) and value else None


def supports_editable_text(accessible):
    """Whether a node accepts EditableText.set_text_contents.

    The interface list is the cheap answer and is what most toolkits expose;
    probing the interface itself is the fallback for bindings that do not
    report the list.
    """
    try:
        interfaces = accessible.get_interfaces()
    except Exception:
        interfaces = None
    if isinstance(interfaces, (list, tuple)):
        for name in interfaces:
            if isinstance(name, str) and name.rsplit(".", 1)[-1].casefold() == (
                EDITABLE_TEXT_INTERFACE
            ):
                return True
        return False
    try:
        return accessible.get_editable_text_iface() is not None
    except Exception:
        return False


def node_for(accessible, depth, budget, path=()):
    if depth > MAX_DEPTH or not budget.take():
        return None
    try:
        role = accessible.get_role_name() or "unknown"
    except Exception:
        role = "unknown"
    try:
        label = text_or_none(accessible.get_name())
    except Exception:
        label = None
    try:
        description = text_or_none(accessible.get_description())
    except Exception:
        description = None
    value = None
    try:
        value_iface = accessible.get_value_iface()
        value = text_or_none(str(value_iface.get_current_value()))
    except Exception:
        pass

    children = []
    try:
        count = accessible.get_child_count()
        for index in range(min(count, MAX_NODES)):
            child = accessible.get_child_at_index(index)
            if child is None:
                continue
            child_node = node_for(child, depth + 1, budget, tuple(path) + (index,))
            if child_node is not None:
                children.append(child_node)
    except Exception:
        pass

    return {
        "role": clamp_text(role, MAX_ROLE_CHARS),
        "label": clamp_text(label, MAX_TEXT_CHARS),
        "value": clamp_text(value, MAX_TEXT_CHARS),
        "description": clamp_text(description, MAX_TEXT_CHARS),
        "frame": rect_for(accessible),
        "activationPoint": None,
        # The real child indices, not the emitted ones: a skipped or budgeted-out
        # child would otherwise shift every later sibling's address.
        "path": [int(index) for index in path],
        "editable": supports_editable_text(accessible),
        "children": children,
    }


def process_id(accessible):
    try:
        value = accessible.get_process_id()
        return int(value) if value and int(value) > 0 else None
    except Exception:
        return None


def role_name(accessible):
    try:
        value = accessible.get_role_name()
        return value.strip().casefold() if isinstance(value, str) else ""
    except Exception:
        return ""


def is_window_candidate(accessible):
    try:
        role = accessible.get_role()
        if role in (Atspi.Role.FRAME, Atspi.Role.WINDOW, Atspi.Role.DIALOG):
            return True
    except Exception:
        pass
    return role_name(accessible) in WINDOW_ROLE_NAMES


# Points for the strongest evidence of each kind. A pid match alone outranks
# the best a pid-mismatched candidate can earn, so a Flatpak fallback never
# displaces a window the requested process actually owns.
PID_MATCH_SCORE = 100
TITLE_EXACT_SCORE = 100
TITLE_SUBSTRING_SCORE = 30
BOUNDS_SCORES = ((2, 40), (8, 20), (64, 5))


def title_score(accessible, requested):
    """Title evidence, or None when the title rules the candidate out.

    Only the requested title may be a substring of the live name (a browser
    appends its own suffix). The reverse — a live name that is a fragment of
    the requested title — matched every "Untitled" or "Terminal" toplevel to
    any longer title containing the word, and is not accepted.
    """
    requested_title = (requested.get("title") or "").strip().casefold()
    if not requested_title:
        return 0
    try:
        name = (accessible.get_name() or "").strip().casefold()
    except Exception:
        name = ""
    if name == requested_title:
        return TITLE_EXACT_SCORE
    if requested_title in name:
        return TITLE_SUBSTRING_SCORE
    return None


def bounds_score(accessible, requested):
    requested_bounds = requested.get("bounds")
    if not isinstance(requested_bounds, dict):
        return 0
    requested_width = requested_bounds.get("width")
    requested_height = requested_bounds.get("height")
    if not isinstance(requested_width, (int, float)) or not isinstance(
        requested_height, (int, float)
    ):
        return 0
    actual = rect_for(accessible)
    if actual["width"] <= 0 or actual["height"] <= 0:
        return 0
    width_delta = abs(actual["width"] - float(requested_width))
    height_delta = abs(actual["height"] - float(requested_height))
    for tolerance, points in BOUNDS_SCORES:
        if width_delta <= tolerance and height_delta <= tolerance:
            return points
    return 0


def same_window_score(accessible, requested, pid=None):
    """How strongly `accessible` looks like the requested window, or None.

    `pid` is the process the index resolved the window to (its own, or its
    application's); None when neither reports one. Identity rests on the pid
    when both sides know it. When they disagree the window may still be the
    one asked for — a Flatpak app reports the sandbox proxy's pid, not the
    one the compositor sees — so a title match with plausible bounds is
    accepted at a reduced score rather than rejected.
    """
    if not is_window_candidate(accessible):
        return None
    requested_pid = requested.get("pid")
    if pid is None:
        pid = process_id(accessible)
    title = title_score(accessible, requested)
    bounds = bounds_score(accessible, requested)

    if requested_pid is None or pid is None:
        # Nothing to pin the process down: the title has to carry identity.
        if title is None or title == 0:
            return None
        return title + bounds
    if pid == requested_pid:
        # Titles change under a live process (a terminal's title tracks the
        # running command), so a pid match survives a title miss.
        return PID_MATCH_SCORE + (title or 0) + bounds
    if title is None or title == 0:
        return None
    return (title + bounds) // 2


class WindowIndex:
    """Every toplevel window on the desktop, keyed by the process it belongs to.

    Built once per request from a single pass over desktop → application →
    toplevel. The search never descends into a window: a Chromium tree with
    thousands of nodes costs the same as a terminal with one. Applications are
    loaded in two stages so the common case — every requested window carries
    a pid — touches only the applications that were asked about; everything
    else is enumerated only when a request stayed unresolved (a Flatpak app
    reports the sandbox proxy's pid, not the one the compositor sees).
    An application whose enumeration raises is dropped for the rest of the
    request rather than retried for every window.
    """

    def __init__(self, desktop, budget):
        self.desktop = desktop
        self.budget = budget
        # pid -> [(window, pid)]; None collects windows with no known pid.
        self.by_pid = {}
        self.pending = list(self._desktop_children())
        self.loaded_everything = False

    def _desktop_children(self):
        try:
            count = self.desktop.get_child_count()
        except Exception:
            return
        for index in range(min(count, SEARCH_MAX_NODES)):
            if not self.budget.take_search_node():
                return
            try:
                child = self.desktop.get_child_at_index(index)
            except Exception:
                continue
            if child is not None:
                yield child

    def load(self, pids=None):
        """Enumerate pending applications; only those owning `pids` when given."""
        remaining = []
        for application in self.pending:
            if self.budget.exhausted:
                remaining.append(application)
                continue
            pid = process_id(application)
            if pids is not None and pid is not None and pid not in pids:
                remaining.append(application)
                continue
            try:
                self._collect(application, pid, 0)
            except Exception:
                pass
        self.pending = remaining
        if pids is None:
            self.loaded_everything = True

    def _collect(self, accessible, inherited_pid, depth):
        if depth > MAX_DEPTH or not self.budget.take_search_node():
            return
        if is_window_candidate(accessible):
            pid = process_id(accessible) or inherited_pid
            self.by_pid.setdefault(pid, []).append((accessible, pid))
            return
        count = accessible.get_child_count()
        for index in range(min(count, SEARCH_MAX_NODES)):
            if self.budget.exhausted:
                return
            child = accessible.get_child_at_index(index)
            if child is None:
                continue
            self._collect(child, inherited_pid, depth + 1)

    def candidates(self, requested_pid):
        if requested_pid is not None and requested_pid in self.by_pid:
            # A pid-owned window is a strong identity; only fall back to the
            # rest of the desktop when the pid owns nothing.
            return self.by_pid[requested_pid]
        return [entry for entries in self.by_pid.values() for entry in entries]

    def resolve(self, requested):
        """Return ("found", window), ("ambiguous", None) or ("not-found", None)."""
        best_score = None
        best = None
        tied = False
        for window, pid in self.candidates(requested.get("pid")):
            score = same_window_score(window, requested, pid)
            if score is None:
                continue
            if best_score is None or score > best_score:
                best_score, best, tied = score, window, False
            elif score == best_score and window is not best:
                # Refuse a tied identity; a later strictly better match may
                # still disambiguate.
                tied = True
        if best is None:
            return "not-found", None
        if tied:
            return "ambiguous", None
        return "found", best


def resolve_windows(desktop, requests, budget):
    """Resolve every request against one desktop pass, as (request, status, window) triples."""
    index = WindowIndex(desktop, budget)
    pids = {requested.get("pid") for requested in requests}
    index.load(pids if None not in pids else None)
    results = [(requested,) + index.resolve(requested) for requested in requests]
    if not index.loaded_everything and any(status != "found" for _, status, _ in results):
        index.load()
        results = [
            (requested, status, window)
            if status == "found"
            else (requested,) + index.resolve(requested)
            for requested, status, window in results
        ]
    return results


def resolve_window(desktop, requested, budget=None):
    """Resolve one window descriptor; see `WindowIndex.resolve` for the statuses."""
    return resolve_windows(desktop, [requested], budget or RequestBudget())[0][1:]


def find_window(accessible, requested):
    return resolve_window(accessible, requested)[1]


def client_size_for(window):
    rect = rect_for(window)
    return {"width": rect["width"], "height": rect["height"]}


def requested_windows(params):
    return [
        requested
        for requested in params.get("windows") or []
        if isinstance(requested, dict) and isinstance(requested.get("id"), str)
    ]


def read_tree(params, clock=None):
    requests = requested_windows(params)
    if not requests:
        return {"trees": []}
    if Atspi is None:
        raise RuntimeError("PyGObject Atspi is unavailable: " + ATSPI_IMPORT_ERROR)
    budget = RequestBudget(clock=clock)
    desktop = Atspi.get_desktop(0)
    trees = []
    for requested, status, window in resolve_windows(desktop, requests, budget):
        if status != "found" or budget.expired():
            continue
        try:
            root = node_for(window, 0, TreeBudget(budget))
            if root is None:
                continue
            trees.append(
                {
                    "windowId": requested["id"],
                    "clientSize": client_size_for(window),
                    "root": root,
                }
            )
        except Exception:
            continue
    result = {"trees": trees}
    if budget.exhausted:
        # Whatever was gathered before the budget ran out is still a valid
        # perception of those windows; the flag tells the client the rest is
        # missing rather than absent.
        result["partial"] = True
    return fit_reply(result)


def serialized_bytes(result):
    return len(json.dumps(result, separators=(",", ":")).encode("utf-8", errors="replace"))


def strip_node_text(node, keep_label=False):
    """Drop a node's free text in place, keeping role, geometry, and shape.

    A stripped tree still says which windows exist and where they are; only
    per-widget text is gone. The window root keeps even its label, because a
    tree that no longer names its own window is half useless.
    """
    node["label"] = None if not keep_label else node["label"]
    node["value"] = None
    node["description"] = None
    for child in node["children"]:
        strip_node_text(child)


def fit_reply(result):
    """Keep a read-tree reply inside what the transport can carry.

    Per-field clamps make an oversized line implausible; this is the guard that
    turns the implausible into one structured error instead of a frame that the
    client must drop and a helper it must reset.
    """
    if serialized_bytes(result) <= SAFE_REPLY_BYTES:
        return result
    stripped = dict(result)
    stripped["trees"] = [dict(tree) for tree in result["trees"]]
    for tree in stripped["trees"]:
        tree["root"] = json.loads(json.dumps(tree["root"]))
        strip_node_text(tree["root"], keep_label=True)
    if serialized_bytes(stripped) > SAFE_REPLY_BYTES:
        raise RuntimeError(
            "The accessibility tree stayed over the transport limit even with all text dropped"
        )
    return stripped


def node_at_path(window, path):
    """Re-resolve a node from a child-index path, or None when it moved."""
    node = window
    for index in path:
        if isinstance(index, bool) or not isinstance(index, int) or index < 0:
            return None
        try:
            if index >= node.get_child_count():
                return None
            child = node.get_child_at_index(index)
        except Exception:
            return None
        if child is None:
            return None
        node = child
    return node


# The space-like code points the client's label matching folds to a plain
# space (normalizeLabelSpaces in uiTreeTargeting.ts). Positions and counts of
# whitespace are otherwise significant on both sides.
SPACE_LIKE = str.maketrans({"\u00a0": " ", "\u2007": " ", "\u202f": " "})


def comparable_label(value):
    """A label as the client compares it: NFC, space-like folded, nothing trimmed."""
    return unicodedata.normalize("NFC", value).translate(SPACE_LIKE)


def matches_expected_node(accessible, expected_role, expected_label):
    """Guard against tree drift writing text into an unrelated widget.

    The expected label is what the tree carried, which was clamped to
    MAX_TEXT_CHARS before it left this process, so the live name gets the
    same clamp before the comparison or a long-named control could never be
    written.
    """
    if isinstance(expected_role, str) and expected_role:
        if role_name(accessible) != expected_role.strip().casefold():
            return False
    if isinstance(expected_label, str):
        try:
            name = accessible.get_name() or ""
        except Exception:
            name = ""
        if comparable_label(clamp_text(name, MAX_TEXT_CHARS)) != comparable_label(expected_label):
            return False
    return True


def set_text(params):
    if Atspi is None:
        raise RuntimeError("PyGObject Atspi is unavailable: " + ATSPI_IMPORT_ERROR)
    text = params.get("text")
    if not isinstance(text, str):
        raise ValueError("set-text requires a text string")
    requested = params.get("window")
    if not isinstance(requested, dict):
        raise ValueError("set-text requires a window descriptor")
    path = params.get("path")
    if not isinstance(path, list):
        raise ValueError("set-text requires a node path")

    status, window = resolve_window(Atspi.get_desktop(0), requested)
    if status != "found":
        return {"ok": False, "reason": "window-" + status}
    node = node_at_path(window, path)
    if node is None:
        return {"ok": False, "reason": "node-not-found"}
    if not matches_expected_node(node, params.get("role"), params.get("label")):
        return {"ok": False, "reason": "node-changed"}
    if not supports_editable_text(node):
        return {"ok": False, "reason": "not-editable"}
    try:
        iface = node.get_editable_text_iface()
        if iface is None:
            return {"ok": False, "reason": "not-editable"}
        result = iface.set_text_contents(text)
    except Exception as error:
        return {"ok": False, "reason": str(error)}
    # Bindings that return nothing have already applied the write; only an
    # explicit false is a refusal the caller must fall back from.
    return {"ok": result is None or bool(result)}


def probe(_params=None):
    """Whether this helper can read trees at all, without touching the desktop.

    Answering never needs the accessibility bus, so a machine with python3 but
    no PyGObject still answers — with the import error the client can show.
    """
    return {"ok": True, "atspi": Atspi is not None, "reason": ATSPI_IMPORT_ERROR}


def read_request_lines():
    """Requests, one per line, decoded so that a bad byte costs one request.

    ``for line in sys.stdin`` decodes strictly, so a single non-UTF-8 byte
    anywhere in the stream raises ``UnicodeDecodeError`` out of the ``for``
    itself — outside any handler — and the helper dies mid-conversation, taking
    every outstanding request with it. Reading the underlying binary buffer and
    decoding each line with ``errors="replace"`` turns that into one request
    that fails to parse and one error reply, which is what the caller can act
    on.
    """
    for raw in sys.stdin.buffer:
        yield raw.decode("utf-8", errors="replace")


def main():
    configure_atspi()
    for line in read_request_lines():
        # Reset per iteration. Carrying the previous request's id into this
        # one's failure reply attributes the error to a request that already
        # succeeded, and leaves the request that actually failed with no reply
        # at all — the caller waits for it until its timeout.
        request_id = None
        try:
            message = json.loads(line)
            request_id = message.get("id")
            method = message.get("method")
            params = message.get("params") or {}
            if method == "read-tree":
                result = read_tree(params)
            elif method == "set-text":
                result = set_text(params)
            elif method == "probe":
                result = probe(params)
            else:
                raise ValueError("Unknown AT-SPI helper method")
            emit({"jsonrpc": "2.0", "id": request_id, "result": result})
        except Exception as error:
            emit(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32000, "message": str(error)},
                }
            )


if __name__ == "__main__":
    main()
