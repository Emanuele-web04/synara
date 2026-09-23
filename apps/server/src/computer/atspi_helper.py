#!/usr/bin/env python3
"""Read bounded AT-SPI trees and answer JSON-RPC requests on stdio.

The helper speaks D-Bus to the accessibility bus directly through Gio rather
than through libatspi. libatspi turns an unreachable accessibility bus into a
``g_error`` (``dbind-ERROR``), which aborts the whole process with SIGABRT and a
core dump that Python cannot catch; it also issues every call synchronously,
one round trip at a time. Talking to the bus ourselves makes an unreachable bus
an ordinary error reply and lets every node of a tree level be asked at once.

Wire protocol version 2 (see ``PROTOCOL_VERSION``): tree nodes carry their
child index ``i`` instead of a full path, trees report ``truncated`` and a
per-window ``status``, and every reply names the protocol so a client and a
helper from different builds refuse each other instead of misreading trees.
"""

import collections
import json
import os
import sys
import time
import unicodedata

try:
    import gi

    gi.require_version("Gio", "2.0")
    gi.require_version("GLib", "2.0")
    from gi.repository import Gio, GLib
except Exception as error:  # pragma: no cover - exercised only without PyGObject
    Gio = None
    GLib = None
    GI_IMPORT_ERROR = str(error)
else:
    GI_IMPORT_ERROR = None


PROTOCOL_VERSION = 2
# JSON-RPC error codes the client acts on. A generic failure is one request
# going wrong; an unreachable bus is the machine telling us perception is off.
GENERIC_ERROR = -32000
BUS_UNAVAILABLE_ERROR = -32010
PROTOCOL_MISMATCH_ERROR = -32011

MAX_NODES = 2048
MAX_DEPTH = 64
# Nodes a walk may look at before keeping any. Non-showing nodes are dropped
# after one GetState each, so a browser tab strip full of hidden documents
# costs this budget rather than the node cap, and still has a bound.
MAX_VISITS = 4 * MAX_NODES
# The window search has its own node budget, separate from the per-window tree
# walk above. It only ever visits desktop → application → toplevel candidates
# (it never descends into a window), so this is a cap on the number of
# applications and toplevels, not on widget trees.
SEARCH_MAX_NODES = 4096
# Wall-clock budget for one request. The client times a request out at 10 s;
# answering with what was gathered by then keeps a hung application from
# costing perception of every other window, and keeps the transport alive.
REQUEST_BUDGET_SECONDS = 7.0
# Per-call D-Bus timeout. Calls to one application run concurrently, so this
# covers queueing behind that application's other outstanding calls too. The
# first call that times out writes the application off for the rest of the
# request (see Scheduler.stalled): a hung application costs one timeout, not
# one per node.
CALL_TIMEOUT_MS = 500
# Calls outstanding at once, across every application in the request.
MAX_IN_FLIGHT = 256
# Connecting to the session bus, asking it where the accessibility bus is,
# and connecting there. An unreachable bus is answered within this, not hung.
BUS_TIMEOUT_MS = 2000
# How long a cached tree may be served at most, whatever the client allows.
TREE_CACHE_MAX_SECONDS = 30.0
TREE_CACHE_MAX_ENTRIES = 64
# Events arriving just after registration may predate an application noticing
# the new listener; nothing walked before this settle time is served.
EVENT_SETTLE_SECONDS = 0.25
APPLICATION_CACHE_MAX_ENTRIES = 4096

REGISTRY_NAME = "org.a11y.atspi.Registry"
REGISTRY_PATH = "/org/a11y/atspi/registry"
ROOT_PATH = "/org/a11y/atspi/accessible/root"
NULL_PATH = "/org/a11y/atspi/null"
ACCESSIBLE = "org.a11y.atspi.Accessible"
APPLICATION = "org.a11y.atspi.Application"
COMPONENT = "org.a11y.atspi.Component"
VALUE = "org.a11y.atspi.Value"
EDITABLE_TEXT = "org.a11y.atspi.EditableText"
PROPERTIES = "org.freedesktop.DBus.Properties"
DBUS_NAME = "org.freedesktop.DBus"
DBUS_PATH = "/org/freedesktop/DBus"
COORD_WINDOW = 1
STATE_SHOWING = 25

# Failures that mean "this object does not implement that", as opposed to the
# object or its application being gone or hung.
UNSUPPORTED_ERRORS = frozenset(
    {
        "org.freedesktop.DBus.Error.UnknownMethod",
        "org.freedesktop.DBus.Error.UnknownInterface",
        "org.freedesktop.DBus.Error.UnknownProperty",
        "org.freedesktop.DBus.Error.NotSupported",
        "org.freedesktop.DBus.Error.InvalidArgs",
    }
)
TIMEOUT = "synara.Timeout"
STALLED = "synara.Stalled"
DEADLINE = "synara.Deadline"
CALL_ERROR = "synara.CallError"

# AT-SPI role names by enum value (atspi-constants.h), spelled the way
# libatspi's role_get_name spells them. Asking for the number and naming it
# here keeps every toolkit's roles in one vocabulary; GetRoleName answers in
# whatever the application chose.
ROLE_NAMES = (
    "invalid", "accelerator label", "alert", "animation", "arrow", "calendar", "canvas",
    "check box", "check menu item", "color chooser", "column header", "combo box",
    "date editor", "desktop icon", "desktop frame", "dial", "dialog", "directory pane",
    "drawing area", "file chooser", "filler", "focus traversable", "font chooser", "frame",
    "glass pane", "html container", "icon", "image", "internal frame", "label",
    "layered pane", "list", "list item", "menu", "menu bar", "menu item", "option pane",
    "page tab", "page tab list", "panel", "password text", "popup menu", "progress bar",
    "button", "radio button", "radio menu item", "root pane", "row header", "scroll bar",
    "scroll pane", "separator", "slider", "spin button", "split pane", "status bar", "table",
    "table cell", "table column header", "table row header", "tearoff menu item", "terminal",
    "text", "toggle button", "tool bar", "tool tip", "tree", "tree table", "unknown",
    "viewport", "window", "extended", "header", "footer", "paragraph", "ruler",
    "application", "autocomplete", "editbar", "embedded", "entry", "chart", "caption",
    "document frame", "heading", "page", "section", "redundant object", "form", "link",
    "input method window", "table row", "tree item", "document spreadsheet",
    "document presentation", "document text", "document web", "document email", "comment",
    "list box", "grouping", "image map", "notification", "info bar", "level bar",
    "title bar", "block quote", "audio", "video", "definition", "article", "landmark", "log",
    "marquee", "math", "rating", "timer", "static", "math fraction", "math root",
    "subscript", "superscript", "description list", "description term",
    "description value", "footnote", "content deletion", "content insertion", "mark",
    "suggestion", "push button menu", "switch",
)
WINDOW_ROLE_NAMES = {"frame", "window", "dialog"}
# Roles that hold a page of content. Gecko reports a document that is not on
# screen (a background tab, or every tab of a window that is minimized or on
# another workspace) as not SHOWING, so pruning drops it with its subtree.
DOCUMENT_ROLES = {"document web", "document frame", "internal frame", "embedded"}
CHROMIUM_TOOLKITS = {"chromium", "electron"}
CONTENT_HIDDEN_REASON = (
    "This window's page content is not on screen (the window is hidden, minimized or on "
    "another workspace), so only its frame was read. Bring the window into view and read "
    "it again."
)

# The event classes whose arrival invalidates an application's cached trees.
# Registering is what makes toolkits emit them at all, and every application
# on the bus pays for what is registered, so only the classes that change
# what a tree says are asked for. bounds-changed and visible-data-changed fire
# on every scroll and animation frame; a node that moved is caught when it is
# used (validateNode re-reads its extents before any action), not by a
# generation bump. Toolkits that filter per class (Qt, Chromium) then emit
# nothing for scrolling; GTK 3's bridge emits everything once anything is
# registered (measured 2026-09-23: one scrolling GTK 3 list, ~180
# BoundsChanged/s whichever single class was registered), which is why the
# real-desktop backends leave these events off by default (SYNARA_ATSPI_EVENTS).
CACHE_EVENTS = (
    "object:children-changed",
    "object:state-changed",
    "object:property-change",
    "object:text-changed",
    "window:",
    "document:",
)
EVENT_INTERFACES = (
    "org.a11y.atspi.Event.Object",
    "org.a11y.atspi.Event.Window",
    "org.a11y.atspi.Event.Document",
)

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


class HelperError(Exception):
    """A request failure with the JSON-RPC code the client should see."""

    def __init__(self, message, code=GENERIC_ERROR):
        super().__init__(message)
        self.code = code


class BusUnavailable(HelperError):
    def __init__(self, message):
        super().__init__(message, BUS_UNAVAILABLE_ERROR)


class CallFailed(Exception):
    """One D-Bus call's failure, delivered as a value to its callback."""

    def __init__(self, name, message=""):
        super().__init__(message or name)
        self.name = name

    @property
    def unsupported(self):
        return self.name in UNSUPPORTED_ERRORS


class Call:
    __slots__ = ("dest", "path", "iface", "method", "signature", "args", "reply", "autostart")

    def __init__(
        self, dest, path, iface, method, signature=None, args=None, reply=None, autostart=False
    ):
        self.dest = dest
        self.path = path
        self.iface = iface
        self.method = method
        self.signature = signature
        self.args = args
        self.reply = reply
        self.autostart = autostart


def get_property(dest, path, iface, name):
    return Call(dest, path, PROPERTIES, "Get", "(ss)", (iface, name))


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

    def remaining_ms(self):
        return max(0, int((self.deadline - self.clock()) * 1000))

    def take_search_node(self):
        if self.expired() or self.search_nodes >= self.max_search_nodes:
            self.exhausted = True
            return False
        self.search_nodes += 1
        return True


class Scheduler:
    """Runs D-Bus calls concurrently under one request's budget.

    Callbacks run from ``run`` only, never from inside ``submit``, so a
    callback that submits follow-up calls never recurses. An application whose
    call times out is written off ("stalled") for the rest of the request:
    every later call to it fails at once instead of costing another timeout.
    """

    def __init__(self, transport, budget, call_timeout_ms=CALL_TIMEOUT_MS):
        self.transport = transport
        self.budget = budget
        self.call_timeout_ms = call_timeout_ms
        self.waiting = collections.deque()
        self.ready = collections.deque()
        self.in_flight = 0
        self.stalled = set()
        self.generation = 0

    def submit(self, call, callback):
        self.waiting.append((call, callback))

    def _issue(self):
        while self.waiting and self.in_flight < MAX_IN_FLIGHT:
            call, callback = self.waiting.popleft()
            if call.dest in self.stalled:
                self.ready.append((callback, CallFailed(STALLED)))
                continue
            if self.budget.expired():
                self.ready.append((callback, CallFailed(DEADLINE)))
                continue
            timeout = max(1, min(self.call_timeout_ms, self.budget.remaining_ms()))
            self.in_flight += 1
            self.transport.start(call, timeout, self._completion(call, callback))

    def _completion(self, call, callback):
        generation = self.generation

        def done(value):
            # A call abandoned at the deadline may still answer later; its
            # request is gone, so the answer is too.
            if generation != self.generation:
                return
            self.in_flight -= 1
            if isinstance(value, CallFailed) and value.name == TIMEOUT:
                self.stalled.add(call.dest)
            self.ready.append((callback, value))

        return done

    def run(self):
        """Deliver every outstanding call's result, including follow-ups."""
        while True:
            while self.ready:
                callback, value = self.ready.popleft()
                callback(value)
            self._issue()
            if self.ready:
                continue
            if self.in_flight == 0:
                return
            if self.budget.expired():
                self._abandon()
                continue
            self.transport.pump(self.budget.deadline)

    def _abandon(self):
        """Stop waiting for everything in flight at the deadline.

        The abandoned calls' callbacks never run; their owners see the loss
        through their own pending counts (a walk marks such nodes truncated)
        and the budget's exhausted flag.
        """
        self.transport.cancel()
        self.generation += 1
        self.in_flight = 0


class GioTransport:
    """Asynchronous calls on one Gio connection, pumped by the caller."""

    def __init__(self, connection, context=None):
        self.connection = connection
        self.context = context or GLib.MainContext.default()
        self.cancellable = Gio.Cancellable()

    def start(self, call, timeout_ms, done):
        params = GLib.Variant(call.signature, call.args) if call.signature else None
        reply = GLib.VariantType(call.reply) if call.reply else None
        flags = Gio.DBusCallFlags.NONE if call.autostart else Gio.DBusCallFlags.NO_AUTO_START

        def finish(connection, result):
            try:
                value = connection.call_finish(result).unpack()
            except GLib.Error as error:
                value = call_failure(error)
            except Exception as error:  # pragma: no cover - defensive
                value = CallFailed(CALL_ERROR, str(error))
            done(value)

        try:
            self.connection.call(
                call.dest,
                call.path,
                call.iface,
                call.method,
                params,
                reply,
                flags,
                timeout_ms,
                self.cancellable,
                finish,
            )
        except Exception as error:
            # A malformed name or path is refused before anything is sent;
            # deliver it like any other failure, from the next pump.
            failure = CallFailed(CALL_ERROR, str(error))
            GLib.idle_add(lambda: done(failure) and False)

    def pump(self, deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            self.context.iteration(False)
            return
        wake = GLib.timeout_source_new(int(remaining * 1000) + 1)
        wake.set_callback(lambda *_args: False)
        wake.attach(self.context)
        try:
            self.context.iteration(True)
        finally:
            if not wake.is_destroyed():
                wake.destroy()

    def cancel(self):
        self.cancellable.cancel()
        self.cancellable = Gio.Cancellable()


def call_failure(error):
    if error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.TIMED_OUT):
        return CallFailed(TIMEOUT, error.message)
    if error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED):
        return CallFailed(DEADLINE, error.message)
    name = Gio.DBusError.get_remote_error(error)
    if name == "org.freedesktop.DBus.Error.NoReply":
        return CallFailed(TIMEOUT, error.message)
    return CallFailed(name or CALL_ERROR, error.message)


def clamp_text(value, limit):
    """Cut to `limit` UTF-16 code units, never inside a character.

    The unit is the client's: its schema bounds are JavaScript string lengths,
    where a character outside the Basic Multilingual Plane (most emoji) counts
    two. Clamped here in code points, such a label came back longer than the
    client's bound, the client cut it again (with a marker), and the label it
    later sent to validate_node or set_text no longer matched this side's
    clamp of the live name: the control was refused as changed. `None`
    passes through untouched.
    """
    if not isinstance(value, str) or len(value) * 2 <= limit:
        return value
    units = 0
    for index, char in enumerate(value):
        units += 2 if ord(char) > 0xFFFF else 1
        if units > limit:
            return value[:index]
    return value


def text_or_none(value):
    return value if isinstance(value, str) and value else None


def role_for(index):
    if isinstance(index, int) and 0 <= index < len(ROLE_NAMES):
        return ROLE_NAMES[index]
    return "unknown"


def rect_from(extents):
    try:
        x, y, width, height = extents
        return {
            "x": float(x),
            "y": float(y),
            "width": max(0.0, float(width)),
            "height": max(0.0, float(height)),
        }
    except Exception:
        return {"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0}


def has_state(states, bit):
    try:
        word = states[bit // 32]
    except (IndexError, TypeError):
        return False
    return bool(int(word) & (1 << (bit % 32)))


def supports_editable_text(interfaces):
    if not isinstance(interfaces, (list, tuple)):
        return False
    return any(
        isinstance(name, str) and name.rsplit(".", 1)[-1].casefold() == "editabletext"
        for name in interfaces
    )


def real_reference(reference):
    """A (bus, path) child reference, or None for AT-SPI's null object."""
    try:
        dest, path = reference
    except (TypeError, ValueError):
        return None
    if not isinstance(dest, str) or not dest or not isinstance(path, str):
        return None
    if not path or path == NULL_PATH:
        return None
    return dest, path


# ── Window search ────────────────────────────────────────────────────


class Candidate:
    """One toplevel the search considered, with what identity rests on."""

    __slots__ = ("dest", "path", "role", "name", "extents", "pid", "toplevel")

    def __init__(
        self, dest, path, role="unknown", name="", extents=None, pid=None, toplevel=False
    ):
        self.dest = dest
        self.path = path
        self.role = role
        self.name = name or ""
        self.extents = extents or rect_from(None)
        self.pid = pid
        # A direct child of its application: a toplevel whatever its role. Qt
        # exposes a plain QWidget window as a "filler".
        self.toplevel = toplevel


def is_window_candidate(candidate):
    if candidate.toplevel and candidate.role not in ("unknown", "invalid"):
        return True
    return (candidate.role or "").strip().casefold() in WINDOW_ROLE_NAMES


# Points for the strongest evidence of each kind. A pid match alone outranks
# the best a pid-mismatched candidate can earn, so a Flatpak fallback never
# displaces a window the requested process actually owns.
PID_MATCH_SCORE = 100
TITLE_EXACT_SCORE = 100
TITLE_SUBSTRING_SCORE = 30
BOUNDS_SCORES = ((2, 40), (8, 20), (64, 5))


def title_score(candidate, requested):
    """Title evidence, or None when the title rules the candidate out.

    Only the requested title may be a substring of the live name (a browser
    appends its own suffix). The reverse — a live name that is a fragment of
    the requested title — matched every "Untitled" or "Terminal" toplevel to
    any longer title containing the word, and is not accepted.
    """
    requested_title = (requested.get("title") or "").strip().casefold()
    if not requested_title:
        return 0
    name = candidate.name.strip().casefold()
    if name == requested_title:
        return TITLE_EXACT_SCORE
    if requested_title in name:
        return TITLE_SUBSTRING_SCORE
    return None


def bounds_score(candidate, requested):
    requested_bounds = requested.get("bounds")
    if not isinstance(requested_bounds, dict):
        return 0
    requested_width = requested_bounds.get("width")
    requested_height = requested_bounds.get("height")
    if not isinstance(requested_width, (int, float)) or not isinstance(
        requested_height, (int, float)
    ):
        return 0
    actual = candidate.extents
    if actual["width"] <= 0 or actual["height"] <= 0:
        return 0
    width_delta = abs(actual["width"] - float(requested_width))
    height_delta = abs(actual["height"] - float(requested_height))
    for tolerance, points in BOUNDS_SCORES:
        if width_delta <= tolerance and height_delta <= tolerance:
            return points
    return 0


def same_window_score(candidate, requested):
    """How strongly `candidate` looks like the requested window, or None.

    The candidate's pid is its application's. Identity rests on the pid when
    both sides know it. When they disagree the window may still be the one
    asked for — a Flatpak app reports the sandbox proxy's pid, not the one
    the compositor sees — so a title match with plausible bounds is accepted
    at a reduced score rather than rejected.
    """
    if not is_window_candidate(candidate):
        return None
    requested_pid = requested.get("pid")
    pid = candidate.pid
    title = title_score(candidate, requested)
    bounds = bounds_score(candidate, requested)

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

    Built once per request from one concurrent pass over desktop →
    application → toplevel. The search never descends into a window: a
    Chromium tree with thousands of nodes costs the same as a terminal with
    one. Applications are loaded in two stages so the common case — every
    requested window carries a pid — touches only the applications that were
    asked about; everything else is enumerated only when a request stayed
    unresolved (a Flatpak app reports the sandbox proxy's pid, not the one the
    compositor sees). An application whose enumeration fails is dropped for
    the rest of the request rather than retried for every window.
    """

    def __init__(self, session, scheduler):
        self.session = session
        self.scheduler = scheduler
        self.budget = scheduler.budget
        # pid -> [Candidate]; None collects windows with no known pid.
        self.by_pid = {}
        self.pending = self._applications()
        self.loaded_everything = False

    def _applications(self):
        found = []

        def listed(value):
            if isinstance(value, CallFailed):
                return
            for reference in (value[0] if value else [])[:SEARCH_MAX_NODES]:
                application = real_reference(reference)
                if application is None or not self.budget.take_search_node():
                    continue
                found.append(application)

        self.scheduler.submit(
            Call(REGISTRY_NAME, ROOT_PATH, ACCESSIBLE, "GetChildren", reply="(a(so))", autostart=True),
            listed,
        )
        self.scheduler.run()
        self.session.pids.load(self.scheduler, [dest for dest, _ in found])
        return found

    def load(self, pids=None):
        """Enumerate pending applications; only those owning `pids` when given."""
        remaining = []
        chosen = []
        for application in self.pending:
            pid = self.session.pids.get(application[0])
            if self.budget.exhausted or (pids is not None and pid is not None and pid not in pids):
                remaining.append(application)
                continue
            chosen.append((application, pid))
        for (dest, path), pid in chosen:
            self._collect(dest, path, pid, 0)
        self.scheduler.run()
        self.pending = remaining
        if pids is None:
            self.loaded_everything = True

    def _collect(self, dest, path, pid, depth):
        """List one node's children as candidates, descending past non-windows."""
        if depth > MAX_DEPTH:
            return

        def listed(value):
            if isinstance(value, CallFailed):
                return
            for reference in (value[0] if value else [])[:SEARCH_MAX_NODES]:
                child = real_reference(reference)
                if child is None or self.budget.exhausted:
                    continue
                if not self.budget.take_search_node():
                    return
                self._inspect(Candidate(child[0], child[1], pid=pid, toplevel=depth == 0), depth + 1)

        self.scheduler.submit(Call(dest, path, ACCESSIBLE, "GetChildren", reply="(a(so))"), listed)

    def _inspect(self, candidate, depth):
        remaining = [3]

        def settle():
            remaining[0] -= 1
            if remaining[0] > 0:
                return
            if is_window_candidate(candidate):
                self.by_pid.setdefault(candidate.pid, []).append(candidate)
            if not (candidate.role or "").strip().casefold() in WINDOW_ROLE_NAMES and (
                candidate.role != "unknown"
            ):
                # Windows can sit below a container toplevel.
                self._collect(candidate.dest, candidate.path, candidate.pid, depth)

        def role(value):
            if isinstance(value, CallFailed):
                if value.unsupported:
                    remaining[0] += 1
                    self.scheduler.submit(
                        Call(candidate.dest, candidate.path, ACCESSIBLE, "GetRoleName"), role_name
                    )
            else:
                candidate.role = role_for(value[0])
            settle()

        def role_name(value):
            if not isinstance(value, CallFailed) and value and isinstance(value[0], str):
                candidate.role = value[0].strip().casefold() or "unknown"
            settle()

        def name(value):
            if not isinstance(value, CallFailed):
                candidate.name = value[0] if isinstance(value[0], str) else ""
            settle()

        def extents(value):
            if not isinstance(value, CallFailed):
                candidate.extents = rect_from(value[0])
            settle()

        self.scheduler.submit(Call(candidate.dest, candidate.path, ACCESSIBLE, "GetRole"), role)
        self.scheduler.submit(get_property(candidate.dest, candidate.path, ACCESSIBLE, "Name"), name)
        self.scheduler.submit(
            Call(candidate.dest, candidate.path, COMPONENT, "GetExtents", "(u)", (COORD_WINDOW,)),
            extents,
        )

    def candidates(self, requested_pid):
        if requested_pid is not None and requested_pid in self.by_pid:
            # A pid-owned window is a strong identity; only fall back to the
            # rest of the desktop when the pid owns nothing.
            return self.by_pid[requested_pid]
        return [entry for entries in self.by_pid.values() for entry in entries]

    def resolve(self, requested):
        """Return ("found", candidate), ("ambiguous", None) or ("not-found", None)."""
        best_score = None
        best = None
        tied = False
        for candidate in self.candidates(requested.get("pid")):
            score = same_window_score(candidate, requested)
            if score is None:
                continue
            if best_score is None or score > best_score:
                best_score, best, tied = score, candidate, False
            elif score == best_score and candidate is not best:
                # Refuse a tied identity; a later strictly better match may
                # still disambiguate.
                tied = True
        if best is None:
            return "not-found", None
        if tied:
            return "ambiguous", None
        return "found", best


def resolve_windows(session, scheduler, requests):
    """Resolve every request against one desktop pass, as (request, status, candidate) triples."""
    index = WindowIndex(session, scheduler)
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


# ── Tree walk ────────────────────────────────────────────────────────


class WalkNode:
    __slots__ = (
        "walk", "dest", "path", "depth", "index", "parent", "kids", "pending", "fields",
        "truncated", "child_count", "showing", "answers", "decided",
    )

    def __init__(self, walk, dest, path, depth, index, parent):
        self.walk = walk
        self.dest = dest
        self.path = path
        self.depth = depth
        self.index = index
        self.parent = parent
        self.kids = []
        self.pending = 0
        self.fields = {
            "role": "unknown",
            "label": None,
            "value": None,
            "description": None,
            "frame": rect_from(None),
            "editable": False,
        }
        self.truncated = False
        self.child_count = None
        self.showing = None
        self.answers = None
        # Whether the walk ever learned enough to keep or prune this node.
        self.decided = False


class TreeWalk:
    """One window's walk: SHOWING subtrees only, each node's calls at once.

    Every node is asked for its state and role first. A node that is not
    SHOWING is dropped with its whole subtree — a browser keeps every background tab's
    document in the tree, and 70–90% of its nodes are never on screen — unless
    the window root itself does not report SHOWING, which some toolkits never
    set; that window is walked in full. A kept node's properties, role,
    interfaces, extents and children are then requested together, and each
    child starts the moment its parent's list arrives, so a tree costs about
    two round trips per level rather than six per node.
    """

    def __init__(self, scheduler, dest, path, max_nodes=MAX_NODES):
        self.scheduler = scheduler
        self.max_nodes = max_nodes
        self.nodes = 0
        self.visits = 1
        self.prune = True
        self.null_children = False
        # Why the window root itself could not be read, when it could not.
        self.failed = None
        # Documents (and the root's own children) kept and pruned; see
        # content_hidden.
        self.shown_documents = 0
        self.hidden_documents = 0
        self.hidden_root_children = 0
        self.root = WalkNode(self, dest, path, 0, None, None)
        self._visit(self.root)

    # A node's calls are counted so the walk knows when it has everything; a
    # call lost at the deadline leaves its node marked incomplete instead.
    def _submit(self, node, call, callback):
        node.pending += 1

        def done(value):
            node.pending -= 1
            callback(value)

        self.scheduler.submit(call, done)

    def _visit(self, node):
        # State and role together: the role is what tells a hidden document
        # (a background tab, a window on another workspace) from a hidden
        # widget, and a kept node needs it anyway.
        node.answers = {}
        self._submit(node, Call(node.dest, node.path, ACCESSIBLE, "GetState", reply="(au)"),
                     lambda value: self._answered(node, "state", value))
        self._submit(node, Call(node.dest, node.path, ACCESSIBLE, "GetRole", reply="(u)"),
                     lambda value: self._answered(node, "role", value))

    def _answered(self, node, key, value):
        node.answers[key] = value
        if len(node.answers) == 2:
            answers, node.answers = node.answers, None
            node.decided = True
            self._decide(node, answers["state"], answers["role"])

    def _decide(self, node, state, role):
        if isinstance(state, CallFailed):
            if not state.unsupported:
                if node.parent is None:
                    self.failed = state.name
                # Gone, hung, or cut off by the deadline: the parent's child
                # list is now missing a member.
                self._drop(node)
                return
            showing = None
        else:
            showing = has_state(state[0] if state else [], STATE_SHOWING)
        node.showing = showing
        if not isinstance(role, CallFailed):
            node.fields["role"] = role_for(role[0] if role else None)
        document = node.fields["role"] in DOCUMENT_ROLES
        if node.parent is None:
            self.prune = showing is True
        elif self.prune and showing is False:
            # Not on screen: neither it nor anything below it can be acted on.
            node.parent.kids.remove(node)
            if document:
                self.hidden_documents += 1
            if node.parent is self.root:
                self.hidden_root_children += 1
            return
        if node.parent is not None and self.nodes >= self.max_nodes:
            self._drop(node)
            return
        self.nodes += 1
        if document:
            self.shown_documents += 1
        dest, path = node.dest, node.path
        if isinstance(role, CallFailed) and role.unsupported:
            self._submit(node, Call(dest, path, ACCESSIBLE, "GetRoleName"),
                         lambda value: self._on_role_name(node, value))
        self._submit(node, Call(dest, path, PROPERTIES, "GetAll", "(s)", (ACCESSIBLE,)),
                     lambda value: self._on_properties(node, value))
        self._submit(node, Call(dest, path, ACCESSIBLE, "GetInterfaces", reply="(as)"),
                     lambda value: self._on_interfaces(node, value))
        self._submit(node, Call(dest, path, COMPONENT, "GetExtents", "(u)", (COORD_WINDOW,)),
                     lambda value: self._on_extents(node, value))
        if node.depth >= MAX_DEPTH:
            self._submit(node, get_property(dest, path, ACCESSIBLE, "ChildCount"),
                         lambda value: self._on_depth_limit(node, value))
        else:
            self._submit(node, Call(dest, path, ACCESSIBLE, "GetChildren", reply="(a(so))"),
                         lambda value: self._on_children(node, value))

    def _drop(self, node):
        if node.parent is not None:
            node.parent.kids.remove(node)
            node.parent.truncated = True

    def _on_properties(self, node, value):
        if isinstance(value, CallFailed):
            if value.unsupported:
                self._submit(node, get_property(node.dest, node.path, ACCESSIBLE, "Name"),
                             lambda reply: self._on_property(node, "label", reply))
                self._submit(node, get_property(node.dest, node.path, ACCESSIBLE, "Description"),
                             lambda reply: self._on_property(node, "description", reply))
            return
        properties = value[0] if value and isinstance(value[0], dict) else {}
        node.fields["label"] = text_or_none(properties.get("Name"))
        node.fields["description"] = text_or_none(properties.get("Description"))
        count = properties.get("ChildCount")
        if isinstance(count, int):
            node.child_count = count

    def _on_property(self, node, field, value):
        if not isinstance(value, CallFailed):
            node.fields[field] = text_or_none(value[0] if value else None)

    def _on_role_name(self, node, value):
        if not isinstance(value, CallFailed) and value and isinstance(value[0], str) and value[0]:
            node.fields["role"] = value[0].strip().casefold()

    def _on_interfaces(self, node, value):
        if isinstance(value, CallFailed):
            return
        interfaces = value[0] if value else []
        node.fields["editable"] = supports_editable_text(interfaces)
        if VALUE in interfaces:
            self._submit(node, get_property(node.dest, node.path, VALUE, "CurrentValue"),
                         lambda reply: self._on_value(node, reply))

    def _on_value(self, node, value):
        if not isinstance(value, CallFailed) and value:
            node.fields["value"] = text_or_none(str(value[0]))

    def _on_extents(self, node, value):
        if not isinstance(value, CallFailed):
            node.fields["frame"] = rect_from(value[0] if value else None)

    def _on_depth_limit(self, node, value):
        count = value[0] if not isinstance(value, CallFailed) and value else None
        if not isinstance(count, int) or count > 0:
            node.truncated = True

    def _on_children(self, node, value):
        if isinstance(value, CallFailed):
            if value.unsupported:
                self._children_by_index(node)
            else:
                node.truncated = True
            return
        self._adopt(node, list(enumerate(value[0] if value else [])))

    def _children_by_index(self, node):
        """GetChildAtIndex for toolkits without GetChildren."""

        def counted(count):
            if not isinstance(count, int) or count < 0:
                node.truncated = True
                return
            answers = {}
            remaining = [min(count, MAX_NODES)]
            if remaining[0] < count:
                node.truncated = True
            if remaining[0] == 0:
                return

            def one(index):
                def done(value):
                    if isinstance(value, CallFailed):
                        node.truncated = True
                    else:
                        answers[index] = value[0] if value else None
                    remaining[0] -= 1
                    if remaining[0] == 0:
                        self._adopt(node, sorted(answers.items()))

                return done

            for index in range(min(count, MAX_NODES)):
                self._submit(node, Call(node.dest, node.path, ACCESSIBLE, "GetChildAtIndex", "(i)",
                                        (index,), reply="((so))"), one(index))

        if node.child_count is not None:
            counted(node.child_count)
            return
        self._submit(node, get_property(node.dest, node.path, ACCESSIBLE, "ChildCount"),
                     lambda value: counted(value[0] if not isinstance(value, CallFailed) and value
                                           else None))

    def _adopt(self, node, indexed):
        for index, reference in indexed:
            child = real_reference(reference)
            if child is None:
                self.null_children = True
                continue
            if self.visits >= MAX_VISITS or self.nodes >= self.max_nodes:
                node.truncated = True
                return
            self.visits += 1
            kid = WalkNode(self, child[0], child[1], node.depth + 1, int(index), node)
            node.kids.append(kid)
            self._visit(kid)

    def content_hidden(self):
        """Whether pruning, not the application, emptied this window.

        A root that stays SHOWING while everything under it is not (Gecko's
        root accessible does this for a window on another workspace), or
        pages of which none is showing, is a window whose content exists but
        is not on screen — not a window without content.
        """
        if not self.prune:
            return False
        if self.hidden_documents > 0 and self.shown_documents == 0:
            return True
        return self.hidden_root_children > 0 and not self.root.kids

    def finish(self):
        """The walked tree as the wire shape, and whether anything is missing."""
        incomplete = [False]

        def emit(node):
            if node.pending > 0:
                # Calls for this node were still out when the request ended.
                node.truncated = True
            kids = [kid for kid in node.kids if kid.decided]
            if len(kids) < len(node.kids):
                # Children the request ended before it could even look at.
                node.truncated = True
            out = {
                "role": clamp_text(node.fields["role"], MAX_ROLE_CHARS),
                "label": clamp_text(node.fields["label"], MAX_TEXT_CHARS),
                "value": clamp_text(node.fields["value"], MAX_TEXT_CHARS),
                "description": clamp_text(node.fields["description"], MAX_TEXT_CHARS),
                "frame": node.fields["frame"],
                "editable": node.fields["editable"],
                "children": [emit(kid) for kid in sorted(kids, key=lambda kid: kid.index)],
            }
            if node.index is not None:
                out["i"] = node.index
            if node.truncated:
                out["truncated"] = True
                incomplete[0] = True
            return out

        root = emit(self.root)
        return root, incomplete[0]


# ── Caches and events ───────────────────────────────────────────────


class ApplicationFacts:
    """Per-application facts that never change for a bus name.

    A unique bus name is never reused, so a pid or toolkit looked up once
    stays right until the name goes away; the event monitor drops it then,
    and the size cap bounds a helper that never sees the exits.
    """

    def __init__(self):
        self.values = {}

    def get(self, dest):
        return self.values.get(dest)

    def put(self, dest, value):
        if len(self.values) >= APPLICATION_CACHE_MAX_ENTRIES:
            self.values.clear()
        self.values[dest] = value

    def drop(self, dest):
        self.values.pop(dest, None)


class PidCache(ApplicationFacts):
    def load(self, scheduler, dests):
        for dest in dests:
            if dest in self.values:
                continue

            def found(value, dest=dest):
                pid = value[0] if not isinstance(value, CallFailed) and value else None
                self.put(dest, int(pid) if isinstance(pid, int) and pid > 0 else None)

            scheduler.submit(
                Call(DBUS_NAME, DBUS_PATH, DBUS_NAME, "GetConnectionUnixProcessID", "(s)", (dest,),
                     reply="(u)", autostart=True),
                found,
            )
        scheduler.run()


class EventMonitor:
    """Which applications changed since a tree was walked.

    Every event an application emits bumps its generation. A cached tree is
    served only while its application's generation is the one it was walked
    at, and only for applications that have been heard from at all: a toolkit
    that never emits cannot prove that nothing changed.
    """

    def __init__(self, clock=None):
        self.clock = clock or time.monotonic
        self.generations = collections.Counter()
        self.heard = set()
        self.active_since = None

    def note(self, dest):
        self.generations[dest] += 1
        self.heard.add(dest)

    def forget(self, dest):
        self.generations[dest] += 1
        self.heard.discard(dest)

    def generation(self, dest):
        return self.generations[dest]

    def vouches_for(self, dest, walked_at):
        return (
            self.active_since is not None
            and walked_at >= self.active_since
            and dest in self.heard
        )


class CachedTree:
    __slots__ = ("tree", "dest", "path", "walked_at", "generation")

    def __init__(self, tree, dest, path, walked_at, generation):
        self.tree = tree
        self.dest = dest
        self.path = path
        self.walked_at = walked_at
        self.generation = generation


class TreeCache:
    """Walked trees by window, bounded in count and in age.

    An entry older than TREE_CACHE_MAX_SECONDS can never be served, so it is
    not kept either: a dense Chromium tree is megabytes, and a helper that
    lives as long as the desktop connection would otherwise hold its last 64
    walks for hours.
    """

    def __init__(self, clock=None):
        self.clock = clock or time.monotonic
        self.entries = collections.OrderedDict()

    @staticmethod
    def key(requested):
        return json.dumps(
            {
                "id": requested.get("id"),
                "title": requested.get("title"),
                "pid": requested.get("pid"),
                "bounds": requested.get("bounds"),
            },
            sort_keys=True,
        )

    def get(self, requested):
        self.expire()
        return self.entries.get(self.key(requested))

    def put(self, requested, entry):
        key = self.key(requested)
        self.entries.pop(key, None)
        self.entries[key] = entry
        self.expire()
        while len(self.entries) > TREE_CACHE_MAX_ENTRIES:
            self.entries.popitem(last=False)

    def expire(self):
        oldest = self.clock() - TREE_CACHE_MAX_SECONDS
        for key in [key for key, entry in self.entries.items() if entry.walked_at < oldest]:
            del self.entries[key]

    def drop(self, requested):
        self.entries.pop(self.key(requested), None)

    def clear(self):
        self.entries.clear()


# ── The accessibility bus ───────────────────────────────────────────


class Bus:
    """One live connection to the accessibility bus."""

    def __init__(self, transport, on_signal=None):
        self.transport = transport
        self.closed = False
        self.on_signal = on_signal


def session_bus_address(environ):
    address = environ.get("DBUS_SESSION_BUS_ADDRESS")
    if address:
        return address
    # No autolaunch: GLib would spawn a bus of its own through dbus-launch
    # when X11 is around, and a bus nobody else is on has no applications.
    runtime = environ.get("XDG_RUNTIME_DIR")
    if runtime and os.path.exists(os.path.join(runtime, "bus")):
        return "unix:path=" + os.path.join(runtime, "bus")
    return None


def wait_for(operation, timeout_ms, what):
    """Run one async Gio operation to completion or a timeout, on the default context."""
    context = GLib.MainContext.default()
    cancellable = Gio.Cancellable()
    outcome = {}

    def finished(result=None, error=None):
        outcome["result"] = result
        outcome["error"] = error

    operation(cancellable, finished)
    deadline = time.monotonic() + timeout_ms / 1000.0
    while "result" not in outcome and time.monotonic() < deadline:
        wake = GLib.timeout_source_new(max(1, int((deadline - time.monotonic()) * 1000) + 1))
        wake.set_callback(lambda *_args: False)
        wake.attach(context)
        try:
            context.iteration(True)
        finally:
            if not wake.is_destroyed():
                wake.destroy()
    if "result" not in outcome:
        cancellable.cancel()
        raise BusUnavailable(f"{what} did not answer within {timeout_ms} ms")
    if outcome["error"] is not None:
        raise BusUnavailable(f"{what} failed: {outcome['error']}")
    return outcome["result"]


def connect_address(address, what):
    flags = (
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT
        | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
    )

    def operation(cancellable, finished):
        def done(_source, result):
            try:
                finished(Gio.DBusConnection.new_for_address_finish(result))
            except GLib.Error as error:
                finished(error=error.message)

        Gio.DBusConnection.new_for_address(address, flags, None, cancellable, done)

    return wait_for(operation, BUS_TIMEOUT_MS, what)


def call_once(connection, dest, path, iface, method, reply, what):
    def operation(cancellable, finished):
        def done(source, result):
            try:
                finished(source.call_finish(result).unpack())
            except GLib.Error as error:
                finished(error=error.message)

        connection.call(dest, path, iface, method, None, GLib.VariantType(reply),
                        Gio.DBusCallFlags.NONE, BUS_TIMEOUT_MS, cancellable, done)

    return wait_for(operation, BUS_TIMEOUT_MS + 100, what)


def accessibility_bus_address(environ):
    """Where the accessibility bus is, the way libatspi looks for it."""
    explicit = environ.get("AT_SPI_BUS_ADDRESS")
    if explicit:
        return explicit
    session_address = session_bus_address(environ)
    if session_address is None:
        raise BusUnavailable("There is no session bus to ask for the accessibility bus")
    session = connect_address(session_address, "The session bus")
    try:
        (address,) = call_once(
            session, "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus", "GetAddress", "(s)",
            "The accessibility bus launcher (org.a11y.Bus)",
        )
    finally:
        session.close(None, None, None)
    if not isinstance(address, str) or not address:
        raise BusUnavailable("org.a11y.Bus returned no accessibility bus address")
    return address


def connect_accessibility_bus(environ, on_signal):
    """Connect to the accessibility bus with a timeout, or raise BusUnavailable."""
    if Gio is None:
        raise BusUnavailable("PyGObject is unavailable: " + str(GI_IMPORT_ERROR))
    address = accessibility_bus_address(environ)
    connection = connect_address(address, "The accessibility bus")
    # A registry that answers is the difference between a bus and a bus with
    # an accessibility desktop on it.
    call_once(
        connection, REGISTRY_NAME, ROOT_PATH, ACCESSIBLE, "GetChildren", "(a(so))",
        "The accessibility registry",
    )
    bus = Bus(GioTransport(connection), on_signal)
    bus.connection = connection
    connection.connect("closed", lambda *_args: setattr(bus, "closed", True))

    def signal(_connection, sender, _path, _iface, _member, _params):
        if bus.on_signal is not None:
            bus.on_signal(sender)

    def owner_changed(_connection, _sender, _path, _iface, _member, params):
        try:
            name, _old, new = params.unpack()
        except Exception:
            return
        if not new and bus.on_signal is not None:
            bus.on_signal(name, gone=True)

    bus.subscriptions = [
        connection.signal_subscribe(None, iface, None, None, None, Gio.DBusSignalFlags.NONE, signal)
        for iface in EVENT_INTERFACES
    ]
    bus.subscriptions.append(
        connection.signal_subscribe(DBUS_NAME, DBUS_NAME, "NameOwnerChanged", DBUS_PATH, None,
                                    Gio.DBusSignalFlags.NONE, owner_changed)
    )
    return bus


# ── Requests ─────────────────────────────────────────────────────────


def requested_windows(params):
    return [
        requested
        for requested in params.get("windows") or []
        if isinstance(requested, dict) and isinstance(requested.get("id"), str)
    ]


def check_protocol(params):
    protocol = params.get("protocol")
    if protocol != PROTOCOL_VERSION:
        raise HelperError(
            f"AT-SPI helper speaks protocol {PROTOCOL_VERSION}; the client sent {protocol!r}",
            PROTOCOL_MISMATCH_ERROR,
        )


# The space-like code points the client's label matching folds to a plain
# space (normalizeLabelSpaces in uiTreeTargeting.ts). Positions and counts of
# whitespace are otherwise significant on both sides.
SPACE_LIKE = str.maketrans({" ": " ", " ": " ", " ": " "})


def comparable_label(value):
    """A label as the client compares it: NFC, space-like folded, nothing trimmed."""
    return unicodedata.normalize("NFC", value).translate(SPACE_LIKE)


def matches_expected(role, name, expected_role, expected_label):
    """Guard against tree drift writing into, or clicking, an unrelated widget.

    The expected label is what the tree carried, which was clamped to
    MAX_TEXT_CHARS before it left this process, so the live name gets the
    same clamp before the comparison or a long-named control could never be
    matched.
    """
    if isinstance(expected_role, str) and expected_role:
        if (role or "").strip().casefold() != expected_role.strip().casefold():
            return False
    if isinstance(expected_label, str):
        if comparable_label(clamp_text(name or "", MAX_TEXT_CHARS)) != comparable_label(
            expected_label
        ):
            return False
    return True


class Session:
    """Everything that outlives one request: the bus, caches and events.

    `connect` returns a Bus; tests hand in one over a fake transport.
    """

    def __init__(self, connect=None, clock=None, environ=None, events=None):
        self.environ = os.environ if environ is None else environ
        self.connect_bus = connect or (
            lambda on_signal: connect_accessibility_bus(self.environ, on_signal)
        )
        self.clock = clock or time.monotonic
        self.bus = None
        self.pids = PidCache()
        self.toolkits = ApplicationFacts()
        self.monitor = EventMonitor(self.clock)
        self.trees = TreeCache(self.clock)
        self.events_enabled = (
            events if events is not None else self.environ.get("SYNARA_ATSPI_EVENTS") != "0"
        )
        self.events_requested = False

    # The bus is connected lazily and again after it closes: a restarted
    # accessibility bus costs one failed request, never the process.
    def ensure_bus(self):
        if self.bus is not None and not self.bus.closed:
            return self.bus
        self.bus = None
        self.pids = PidCache()
        self.toolkits = ApplicationFacts()
        self.monitor = EventMonitor(self.clock)
        self.trees.clear()
        self.events_requested = False
        self.bus = self.connect_bus(self._on_signal)
        return self.bus

    def _on_signal(self, dest, gone=False):
        if gone:
            self.monitor.forget(dest)
            self.pids.drop(dest)
            self.toolkits.drop(dest)
        else:
            self.monitor.note(dest)

    def scheduler(self, budget):
        return Scheduler(self.ensure_bus().transport, budget)

    def _request_events(self, scheduler):
        """Ask applications to emit the events the tree cache relies on.

        Toolkits only emit what some client registered for, so without this
        nothing arrives. Done once per bus, and only when a caller actually
        accepts cached trees.
        """
        if self.events_requested or not self.events_enabled:
            return
        self.events_requested = True
        outcomes = []

        def registered(value, event):
            if isinstance(value, CallFailed) and value.unsupported:
                # Registries before the (sass) signature take the event alone.
                scheduler.submit(
                    Call(REGISTRY_NAME, REGISTRY_PATH, REGISTRY_NAME, "RegisterEvent", "(s)",
                         (event,), autostart=True),
                    lambda reply: outcomes.append(not isinstance(reply, CallFailed)),
                )
                return
            outcomes.append(not isinstance(value, CallFailed))

        for event in CACHE_EVENTS:
            scheduler.submit(
                Call(REGISTRY_NAME, REGISTRY_PATH, REGISTRY_NAME, "RegisterEvent", "(sass)",
                     (event, [], ""), autostart=True),
                lambda value, event=event: registered(value, event),
            )
        scheduler.run()
        if outcomes and all(outcomes):
            self.monitor.active_since = self.clock() + EVENT_SETTLE_SECONDS

    def probe(self, _params=None):
        """Whether this helper can read trees: PyGObject present and the bus reachable.

        Answering never needs more than the bus connection, and every step is
        bounded, so an unreachable bus is a reason rather than a crash.
        """
        try:
            self.ensure_bus()
        except BusUnavailable as error:
            return {"ok": True, "protocol": PROTOCOL_VERSION, "atspi": False, "reason": str(error)}
        return {"ok": True, "protocol": PROTOCOL_VERSION, "atspi": True, "reason": None}

    def read_tree(self, params):
        check_protocol(params)
        requests = requested_windows(params)
        if not requests:
            return {"protocol": PROTOCOL_VERSION, "trees": []}
        budget = RequestBudget(clock=self.clock)
        scheduler = self.scheduler(budget)
        max_age = params.get("maxAgeMs")
        max_age = (
            min(float(max_age) / 1000.0, TREE_CACHE_MAX_SECONDS)
            if isinstance(max_age, (int, float)) and not isinstance(max_age, bool) and max_age > 0
            else 0.0
        )
        if max_age > 0:
            self._request_events(scheduler)

        trees = {}
        missing = []
        uncached = []
        for requested in requests:
            cached = self._fresh_cached(requested, max_age)
            if cached is None:
                uncached.append(requested)
            else:
                trees[requested["id"]] = cached
        # Every cached answer is confirmed against its application in one
        # batch: the reply cannot arrive before any event the application
        # sent ahead of it, and a window that stopped showing is walked again.
        confirmed = self._confirm(scheduler, [(requested, trees[requested["id"]])
                                              for requested in requests
                                              if requested["id"] in trees])
        for requested in requests:
            if requested["id"] in trees and requested["id"] not in confirmed:
                del trees[requested["id"]]
                uncached.append(requested)
        for requested in requests:
            if requested["id"] in confirmed:
                tree = dict(confirmed[requested["id"]].tree)
                tree["cached"] = True
                trees[requested["id"]] = tree

        walks = []
        if uncached:
            for requested, status, window in resolve_windows(self, scheduler, uncached):
                if status != "found":
                    missing.append({"windowId": requested["id"], "reason": "window-" + status})
                    continue
                if budget.expired():
                    missing.append({"windowId": requested["id"], "reason": "deadline"})
                    continue
                walks.append((requested, window, TreeWalk(scheduler, window.dest, window.path),
                              self.monitor.generation(window.dest), self.clock()))
            scheduler.run()
            self._load_toolkits(scheduler, walks)

        for requested, window, walk, generation, started in walks:
            if walk.failed is not None:
                missing.append({
                    "windowId": requested["id"],
                    "reason": "deadline" if walk.failed == DEADLINE else "window-unreadable",
                })
                continue
            root, incomplete = walk.finish()
            # Pages exist but none is showing: pruning left the chrome and
            # dropped the content, which is not the same as "no content".
            content_hidden = walk.content_hidden()
            if content_hidden:
                root["truncated"] = True
                incomplete = True
            client = root["frame"]
            tree = {
                "windowId": requested["id"],
                "clientSize": {"width": client["width"], "height": client["height"]},
                "root": root,
                "status": "partial" if incomplete else "complete",
            }
            if incomplete:
                tree["truncated"] = True
            if content_hidden:
                tree["reason"] = CONTENT_HIDDEN_REASON
            reason = self._unavailable_reason(walk, window, root)
            if reason is not None:
                tree["status"] = "unavailable"
                tree["reason"] = reason
            trees[requested["id"]] = tree
            # Without events nothing can vouch for a cached tree, so none is kept.
            if not incomplete and reason is None and self.events_enabled:
                self.trees.put(requested, CachedTree(tree, window.dest, window.path, started,
                                                     generation))
            else:
                self.trees.drop(requested)

        result = {
            "protocol": PROTOCOL_VERSION,
            "trees": [trees[requested["id"]] for requested in requests if requested["id"] in trees],
        }
        if missing:
            result["missing"] = missing
        if budget.exhausted:
            # Whatever was gathered before the budget ran out is still a valid
            # perception of those windows; the flag tells the client the rest is
            # missing rather than absent.
            result["partial"] = True
        return fit_reply(result)

    def _fresh_cached(self, requested, max_age):
        if max_age <= 0:
            return None
        entry = self.trees.get(requested)
        if entry is None:
            return None
        if self.clock() - entry.walked_at > max_age:
            return None
        if not self.monitor.vouches_for(entry.dest, entry.walked_at):
            return None
        if self.monitor.generation(entry.dest) != entry.generation:
            return None
        return entry

    def _confirm(self, scheduler, candidates):
        confirmed = {}
        for requested, entry in candidates:

            def answered(value, requested=requested, entry=entry):
                if isinstance(value, CallFailed):
                    return
                if not has_state(value[0] if value else [], STATE_SHOWING):
                    return
                confirmed[requested["id"]] = entry

            scheduler.submit(Call(entry.dest, entry.path, ACCESSIBLE, "GetState", reply="(au)"),
                             answered)
        scheduler.run()
        # Events that arrived with those replies count against the entries.
        return {
            window_id: entry
            for window_id, entry in confirmed.items()
            if self.monitor.generation(entry.dest) == entry.generation
        }

    def _load_toolkits(self, scheduler, walks):
        wanted = {
            window.dest
            for _requested, window, walk, _generation, _started in walks
            if walk.null_children and not walk.root.kids and self.toolkits.get(window.dest) is None
        }
        for dest in wanted:

            def found(value, dest=dest):
                name = value[0] if not isinstance(value, CallFailed) and value else ""
                self.toolkits.put(dest, name if isinstance(name, str) else "")

            scheduler.submit(get_property(dest, ROOT_PATH, APPLICATION, "ToolkitName"), found)
        if wanted:
            scheduler.run()

    def _unavailable_reason(self, walk, window, root):
        """Why a window that answered still has no usable tree, or None."""
        if root["children"] or not walk.null_children:
            return None
        toolkit = (self.toolkits.get(window.dest) or "").strip().casefold()
        if toolkit in CHROMIUM_TOOLKITS:
            return (
                "This Chromium/Electron window exposes no accessibility tree: renderer "
                "accessibility is off. Launch the app with --force-renderer-accessibility "
                "(apps Synara launches get it), or target it by coordinates."
            )
        return (
            "This window exposes no accessibility tree (its only child is the AT-SPI null "
            "object). Target it by coordinates."
        )

    def _resolve_node(self, params, scheduler):
        """The live node a path addresses, or a refusal reason."""
        requested = params.get("window")
        if not isinstance(requested, dict):
            raise ValueError("this request needs a window descriptor")
        path = params.get("path")
        if not isinstance(path, list):
            raise ValueError("this request needs a node path")
        ((_requested, status, window),) = resolve_windows(self, scheduler, [requested])
        if status != "found":
            return None, None, "window-" + status
        node = node_at_path(scheduler, (window.dest, window.path), path)
        if node is None:
            return window, None, "node-not-found"
        facts = node_facts(scheduler, node)
        if facts is None:
            return window, None, "node-not-found"
        if not matches_expected(facts["role"], facts["name"], params.get("role"),
                                params.get("label")):
            return window, None, "node-changed"
        return window, (node, facts), None

    def validate_node(self, params):
        """Fresh extents for the node a tree address names, if it still is that node."""
        check_protocol(params)
        scheduler = self.scheduler(RequestBudget(clock=self.clock))
        window, found, reason = self._resolve_node(params, scheduler)
        if reason is not None:
            return {"ok": False, "reason": reason}
        _node, facts = found
        root = {}

        def client(value):
            if not isinstance(value, CallFailed):
                root["frame"] = rect_from(value[0] if value else None)

        scheduler.submit(Call(window.dest, window.path, COMPONENT, "GetExtents", "(u)",
                              (COORD_WINDOW,)), client)
        scheduler.run()
        frame = root.get("frame", window.extents)
        return {
            "ok": True,
            "frame": facts["frame"],
            "showing": facts["showing"],
            "clientSize": {"width": frame["width"], "height": frame["height"]},
        }

    def set_text(self, params):
        check_protocol(params)
        text = params.get("text")
        if not isinstance(text, str):
            raise ValueError("set-text requires a text string")
        if not isinstance(params.get("window"), dict):
            raise ValueError("set-text requires a window descriptor")
        if not isinstance(params.get("path"), list):
            raise ValueError("set-text requires a node path")
        scheduler = self.scheduler(RequestBudget(clock=self.clock))
        _window, found, reason = self._resolve_node(params, scheduler)
        if reason is not None:
            return {"ok": False, "reason": reason}
        (dest, path), facts = found
        if not facts["editable"]:
            return {"ok": False, "reason": "not-editable"}
        outcome = {}
        scheduler.submit(
            Call(dest, path, EDITABLE_TEXT, "SetTextContents", "(s)", (text,)),
            lambda value: outcome.setdefault("value", value),
        )
        scheduler.run()
        value = outcome.get("value")
        if isinstance(value, CallFailed) or value is None:
            return {"ok": False, "reason": str(value) if value is not None else "no-reply"}
        # A binding that answers nothing has already applied the write; only
        # an explicit false is a refusal the caller must fall back from.
        return {"ok": not value or bool(value[0])}


def node_at_path(scheduler, root, path):
    """Re-resolve a node from a child-index path, or None when it moved."""
    node = root
    for index in path:
        if isinstance(index, bool) or not isinstance(index, int) or index < 0:
            return None
        answer = {}
        dest, object_path = node
        scheduler.submit(get_property(dest, object_path, ACCESSIBLE, "ChildCount"),
                         lambda value: answer.setdefault("count", value))
        scheduler.submit(Call(dest, object_path, ACCESSIBLE, "GetChildAtIndex", "(i)", (index,),
                              reply="((so))"), lambda value: answer.setdefault("child", value))
        scheduler.run()
        count, child = answer.get("count"), answer.get("child")
        # Some bindings answer the nearest child for an index past the end
        # instead of the null object; the count check refuses the address
        # first.
        if isinstance(count, CallFailed) or not count or not isinstance(count[0], int):
            return None
        if index >= count[0] or isinstance(child, CallFailed) or not child:
            return None
        node = real_reference(child[0])
        if node is None:
            return None
    return node


def node_facts(scheduler, node):
    dest, path = node
    answers = {}
    for key, call in (
        ("role", Call(dest, path, ACCESSIBLE, "GetRole", reply="(u)")),
        ("name", get_property(dest, path, ACCESSIBLE, "Name")),
        ("interfaces", Call(dest, path, ACCESSIBLE, "GetInterfaces", reply="(as)")),
        ("extents", Call(dest, path, COMPONENT, "GetExtents", "(u)", (COORD_WINDOW,))),
        ("state", Call(dest, path, ACCESSIBLE, "GetState", reply="(au)")),
    ):
        scheduler.submit(call, lambda value, key=key: answers.setdefault(key, value))
    scheduler.run()
    role = answers.get("role")
    if isinstance(role, CallFailed) or not role:
        return None
    name = answers.get("name")
    interfaces = answers.get("interfaces")
    extents = answers.get("extents")
    state = answers.get("state")
    return {
        "role": role_for(role[0]),
        "name": name[0] if not isinstance(name, CallFailed) and name else "",
        "editable": supports_editable_text(
            interfaces[0] if not isinstance(interfaces, CallFailed) and interfaces else None
        ),
        "frame": rect_from(extents[0] if not isinstance(extents, CallFailed) and extents else None),
        "showing": (
            has_state(state[0], STATE_SHOWING)
            if not isinstance(state, CallFailed) and state
            else None
        ),
    }


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


# ── Process loop ─────────────────────────────────────────────────────


def emit(message):
    encoded = json.dumps(message, separators=(",", ":"))
    sys.stdout.write(encoded + "\n")
    sys.stdout.flush()


def handle_line(session, line):
    # Reset per line. Carrying the previous request's id into this one's
    # failure reply attributes the error to a request that already succeeded,
    # and leaves the request that actually failed with no reply at all — the
    # caller waits for it until its timeout.
    request_id = None
    try:
        message = json.loads(line)
        request_id = message.get("id")
        method = message.get("method")
        params = message.get("params") or {}
        if method == "read-tree":
            result = session.read_tree(params)
        elif method == "set-text":
            result = session.set_text(params)
        elif method == "validate-node":
            result = session.validate_node(params)
        elif method == "probe":
            result = session.probe(params)
        else:
            raise ValueError("Unknown AT-SPI helper method")
        emit({"jsonrpc": "2.0", "id": request_id, "result": result})
    except Exception as error:
        emit(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": error.code if isinstance(error, HelperError) else GENERIC_ERROR,
                    "message": str(error),
                },
            }
        )


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


class LineServer:
    """Stdin requests served from a GLib main loop, so events flow between them.

    The stdin watch only queues lines; requests run one at a time from an
    idle callback. A request pumps the main context itself while it waits for
    replies, which may dispatch the stdin watch again — that just queues more
    — and events, which only bump generations.
    """

    def __init__(self, session, loop, fd):
        self.session = session
        self.loop = loop
        self.fd = fd
        self.buffer = b""
        self.lines = collections.deque()
        self.busy = False
        self.eof = False
        self.scheduled = False

    def on_input(self, _fd, condition):
        try:
            chunk = os.read(self.fd, 65536)
        except BlockingIOError:
            return True
        except OSError:
            chunk = b""
        if chunk:
            self.buffer += chunk
            *complete, self.buffer = self.buffer.split(b"\n")
            self.lines.extend(line.decode("utf-8", errors="replace") for line in complete)
        else:
            self.eof = True
            if self.buffer:
                self.lines.append(self.buffer.decode("utf-8", errors="replace"))
                self.buffer = b""
        self.schedule()
        return not self.eof

    def schedule(self):
        if not self.scheduled:
            self.scheduled = True
            GLib.idle_add(self.drain)

    def drain(self):
        self.scheduled = False
        if self.busy:
            return False
        self.busy = True
        try:
            while self.lines:
                line = self.lines.popleft()
                if line.strip():
                    handle_line(self.session, line)
        finally:
            self.busy = False
        if self.eof:
            self.loop.quit()
        return False


def main():
    if GLib is None:
        # No PyGObject: answer every request, so the client learns why.
        session = Session(connect=lambda _on_signal: (_ for _ in ()).throw(
            BusUnavailable("PyGObject is unavailable: " + str(GI_IMPORT_ERROR))))
        for line in read_request_lines():
            if line.strip():
                handle_line(session, line)
        return
    session = Session()
    loop = GLib.MainLoop()
    fd = sys.stdin.fileno()
    os.set_blocking(fd, False)
    server = LineServer(session, loop, fd)
    GLib.io_add_watch(fd, GLib.PRIORITY_DEFAULT, GLib.IOCondition.IN | GLib.IOCondition.HUP
                      | GLib.IOCondition.ERR, server.on_input)
    loop.run()


if __name__ == "__main__":
    main()
