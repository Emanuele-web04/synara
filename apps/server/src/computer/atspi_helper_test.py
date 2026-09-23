import collections
import importlib.util
import json
import unittest
from pathlib import Path


HELPER_PATH = Path(__file__).with_name("atspi_helper.py")
SPEC = importlib.util.spec_from_file_location("synara_atspi_helper", HELPER_PATH)
HELPER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(HELPER)

UNKNOWN_METHOD = "org.freedesktop.DBus.Error.UnknownMethod"
UNKNOWN_OBJECT = "org.freedesktop.DBus.Error.UnknownObject"
PROTOCOL = {"protocol": HELPER.PROTOCOL_VERSION}


class FakeClock:
    """A monotonic clock the test moves by hand."""

    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class Node:
    """One accessible object on the fake bus."""

    def __init__(
        self,
        role,
        name="",
        children=None,
        width=0,
        height=0,
        x=0,
        y=0,
        showing=True,
        interfaces=None,
        description="",
        value=None,
        accepts=True,
    ):
        self.role = role
        self.name = name
        self.children = children or []
        self.extents = (x, y, width, height)
        self.showing = showing
        self.interfaces = (
            ["org.a11y.atspi.Accessible", "org.a11y.atspi.Component"]
            if interfaces is None
            else interfaces
        )
        self.description = description
        self.value = value
        self.accepts = accepts
        self.text = None
        self.unsupported = set()
        self.failure = None
        self.dest = None
        self.path = None


def editable_field(name="Name"):
    return Node(
        "entry",
        name,
        interfaces=[
            "org.a11y.atspi.Accessible",
            "org.a11y.atspi.Component",
            "org.a11y.atspi.EditableText",
            "org.a11y.atspi.Text",
        ],
    )


class App:
    def __init__(self, name, pid, windows, toolkit="GTK"):
        self.name = name
        self.pid = pid
        self.root = Node("application", name, windows)
        self.toolkit = toolkit
        self.hung = False
        self.failure = None


class FakeDesktop:
    """A desktop served over a fake transport, one reply per pump."""

    def __init__(self, apps, clock=None):
        self.apps = apps
        self.clock = clock or FakeClock()
        self.objects = {}
        self.app_by_dest = {}
        self.calls = collections.Counter()
        self.registered = []
        self.hooks = {}
        for number, app in enumerate(apps):
            dest = f":1.{number + 10}"
            self.app_by_dest[dest] = app
            self._place(app.root, dest, HELPER.ROOT_PATH)

    def _place(self, node, dest, path):
        if node is None:
            return
        node.dest = dest
        node.path = path
        self.objects[(dest, path)] = node
        for index, child in enumerate(node.children):
            child_path = f"/w{index}" if path == HELPER.ROOT_PATH else f"{path}/{index}"
            self._place(child, dest, child_path)

    @staticmethod
    def reference(node, dest):
        if node is None:
            return (dest, HELPER.NULL_PATH)
        return (node.dest, node.path)

    def dest_of(self, app):
        return next(dest for dest, candidate in self.app_by_dest.items() if candidate is app)

    def answer(self, call):
        self.calls[(call.dest, call.method)] += 1
        self.calls[call.method] += 1
        hook = self.hooks.get((call.dest, call.path, call.method))
        if hook is not None:
            hook()
        if call.dest == HELPER.REGISTRY_NAME:
            if call.method == "GetChildren":
                return ([(dest, HELPER.ROOT_PATH) for dest in self.app_by_dest],)
            if call.method == "RegisterEvent":
                self.registered.append(call.args[0])
                return ()
            raise HELPER.CallFailed(UNKNOWN_METHOD)
        if call.dest == HELPER.DBUS_NAME:
            app = self.app_by_dest.get(call.args[0])
            if app is None or app.pid is None:
                raise HELPER.CallFailed("org.freedesktop.DBus.Error.NameHasNoOwner")
            return (app.pid,)
        app = self.app_by_dest.get(call.dest)
        if app is None:
            raise HELPER.CallFailed("org.freedesktop.DBus.Error.ServiceUnknown")
        if app.failure is not None:
            raise HELPER.CallFailed(app.failure)
        node = self.objects.get((call.dest, call.path))
        if node is None:
            raise HELPER.CallFailed(UNKNOWN_OBJECT)
        if node.failure is not None:
            raise HELPER.CallFailed(node.failure)
        if call.method in node.unsupported:
            raise HELPER.CallFailed(UNKNOWN_METHOD)
        return self.method(app, node, call)

    def method(self, app, node, call):
        method = call.method
        if method == "GetChildren":
            return ([self.reference(child, call.dest) for child in node.children],)
        if method == "GetChildAtIndex":
            (index,) = call.args
            child = node.children[index] if 0 <= index < len(node.children) else None
            return (self.reference(child, call.dest),)
        if method == "GetRole":
            role = node.role if node.role in HELPER.ROLE_NAMES else "unknown"
            return (HELPER.ROLE_NAMES.index(role),)
        if method == "GetRoleName":
            return (node.role,)
        if method == "GetState":
            word = 1 << HELPER.STATE_SHOWING if node.showing else 0
            return ([word, 0],)
        if method == "GetInterfaces":
            return (list(node.interfaces),)
        if method == "GetExtents":
            return (node.extents,)
        if method == "SetTextContents":
            if node.accepts:
                node.text = call.args[0]
            return (node.accepts,)
        if method == "GetAll":
            return (
                {
                    "Name": node.name,
                    "Description": node.description,
                    "ChildCount": len(node.children),
                },
            )
        if method == "Get":
            _iface, prop = call.args
            if prop == "Name":
                return (node.name,)
            if prop == "Description":
                return (node.description,)
            if prop == "ChildCount":
                return (len(node.children),)
            if prop == "ToolkitName":
                return (app.toolkit,)
            if prop == "CurrentValue" and node.value is not None:
                return (node.value,)
            raise HELPER.CallFailed("org.freedesktop.DBus.Error.UnknownProperty")
        raise HELPER.CallFailed(UNKNOWN_METHOD)


class FakeTransport:
    def __init__(self, desktop):
        self.desktop = desktop
        self.queue = collections.deque()

    def start(self, call, timeout_ms, done):
        self.queue.append((call, self.desktop.clock.now + timeout_ms / 1000.0, done))

    def pump(self, _deadline):
        if not self.queue:
            return
        call, expires, done = self.queue.popleft()
        app = self.desktop.app_by_dest.get(call.dest)
        if app is not None and app.hung:
            # Calls in flight together time out together.
            self.desktop.calls[(call.dest, call.method)] += 1
            self.desktop.clock.now = max(self.desktop.clock.now, expires)
            done(HELPER.CallFailed(HELPER.TIMEOUT))
            return
        try:
            value = self.desktop.answer(call)
        except HELPER.CallFailed as failure:
            value = failure
        done(value)

    def cancel(self):
        self.queue.clear()


def session_for(desktop, **kwargs):
    signals = []

    def connect(on_signal):
        signals.append(on_signal)
        return HELPER.Bus(FakeTransport(desktop), on_signal)

    session = HELPER.Session(connect=connect, clock=desktop.clock, environ={}, **kwargs)
    session.signals = signals
    return session


def request(window_id, title, pid, width=640, height=480):
    return {
        "id": window_id,
        "title": title,
        "pid": pid,
        "bounds": {"width": width, "height": height},
    }


def read(session, *requests, **extra):
    return session.read_tree({**PROTOCOL, "windows": list(requests), **extra})


def resolve(desktop, requested):
    session = session_for(desktop)
    scheduler = session.scheduler(HELPER.RequestBudget(clock=desktop.clock))
    ((_requested, status, window),) = HELPER.resolve_windows(session, scheduler, [requested])
    return status, (desktop.objects[(window.dest, window.path)] if window else None)


def count_nodes(node):
    return 1 + sum(count_nodes(child) for child in node["children"])


class WindowSearchTest(unittest.TestCase):
    def test_descends_through_application_to_find_a_frame(self):
        frame = Node("frame", "Terminal", width=640, height=480)
        desktop = FakeDesktop([App("Terminal", 42, [frame])])

        status, found = resolve(
            desktop, {"title": "Terminal", "pid": 42, "bounds": {"width": 648, "height": 518}}
        )

        self.assertEqual(status, "found")
        self.assertIs(found, frame)

    def test_descends_past_a_container_that_is_not_a_window(self):
        frame = Node("frame", "Terminal", width=640, height=480)
        desktop = FakeDesktop([App("Terminal", 42, [Node("filler", children=[frame])])])

        self.assertIs(resolve(desktop, {"title": "Terminal", "pid": 42})[1], frame)

    def test_takes_a_toplevel_of_any_role(self):
        # Qt exposes a plain QWidget window as a "filler" directly under its
        # application.
        window = Node("filler", "Lab Qt", [Node("push button", "OK")], width=600, height=400)
        desktop = FakeDesktop([App("lab_qt.py", 7, [window])])

        self.assertIs(resolve(desktop, {"title": "Lab Qt", "pid": 7})[1], window)

    def test_refuses_identical_windows_even_in_separate_applications(self):
        desktop = FakeDesktop(
            [
                App("One", 42, [Node("frame", "Terminal", width=640, height=480)]),
                App("Two", 42, [Node("frame", "Terminal", width=640, height=480)]),
            ]
        )

        # Distinguishable from a window that is simply not there.
        self.assertEqual(resolve(desktop, {"title": "Terminal", "pid": 42}), ("ambiguous", None))

    def test_ignores_a_live_name_that_is_only_a_fragment_of_the_requested_title(self):
        # Without a pid, "Terminal" used to match any longer title that
        # contained the word, so an unrelated toplevel took the request.
        fragment = Node("frame", "Terminal", width=640, height=480)
        desktop = FakeDesktop([App("Terminal", None, [fragment])])

        self.assertEqual(
            resolve(desktop, {"title": "Terminal — vim", "pid": None}), ("not-found", None)
        )
        # The requested title as a fragment of the live name is still accepted.
        self.assertIs(resolve(desktop, {"title": "Term", "pid": None})[1], fragment)

    def test_falls_back_to_title_and_bounds_when_the_pid_disagrees(self):
        # A Flatpak app reports the sandbox proxy's pid; the compositor reports
        # the real one. The window is still identifiable by title and size.
        sandboxed = Node("frame", "Firefox", width=640, height=480)
        desktop = FakeDesktop([App("Firefox", 1000, [sandboxed])])

        self.assertIs(
            resolve(
                desktop, {"title": "Firefox", "pid": 42, "bounds": {"width": 640, "height": 480}}
            )[1],
            sandboxed,
        )
        self.assertEqual(resolve(desktop, {"title": "Editor", "pid": 42}), ("not-found", None))

    def test_prefers_the_requested_process_over_a_title_only_match(self):
        owned = Node("frame", "Terminal — vim", width=640, height=480)
        impostor = Node("frame", "Terminal", width=640, height=480)
        desktop = FakeDesktop([App("Other", 7, [impostor]), App("Terminal", 42, [owned])])

        self.assertIs(
            resolve(
                desktop, {"title": "Terminal", "pid": 42, "bounds": {"width": 640, "height": 480}}
            )[1],
            owned,
        )

    def test_chooses_the_frame_with_matching_name_and_extents_for_one_pid(self):
        other = Node("frame", "Other", width=400, height=300)
        target = Node("window", "Terminal", width=640, height=480)
        desktop = FakeDesktop([App("Terminal", 42, [other, target])])

        found = resolve(
            desktop, {"title": "Terminal", "pid": 42, "bounds": {"width": 648, "height": 518}}
        )[1]

        self.assertIs(found, target)

    def test_the_search_budget_is_separate_from_the_tree_walk_budget(self):
        # More toplevels than a tree walk may hold: the search still finds the
        # last one because it counts against its own budget.
        frames = [
            Node("frame", f"Window {i}", width=640, height=480)
            for i in range(HELPER.MAX_NODES + 8)
        ]
        desktop = FakeDesktop([App("Many", 5, frames)])

        status, window = resolve(desktop, request("last", frames[-1].name, 5))

        self.assertEqual(status, "found")
        self.assertIs(window, frames[-1])


class ReadTreeTest(unittest.TestCase):
    def test_a_large_application_tree_does_not_starve_later_windows(self):
        # One Chromium-sized tree used to exhaust a shared node budget before
        # the search reached the next application. Each window has its own
        # cap, and a tree cut at the cap says so.
        dense = [Node("panel", f"p{i}", width=1, height=1) for i in range(3 * HELPER.MAX_NODES)]
        browser = Node("frame", "Browser", dense, width=640, height=480)
        editor = Node("frame", "Editor", width=640, height=480)
        desktop = FakeDesktop([App("Browser", 41, [browser]), App("Editor", 43, [editor])])

        result = read(
            session_for(desktop),
            request("w-browser", "Browser", 41),
            request("w-editor", "Editor", 43),
        )

        self.assertEqual([tree["windowId"] for tree in result["trees"]], ["w-browser", "w-editor"])
        self.assertNotIn("partial", result)
        browser_tree, editor_tree = result["trees"]
        self.assertEqual(count_nodes(browser_tree["root"]), HELPER.MAX_NODES)
        self.assertIs(browser_tree["truncated"], True)
        self.assertIs(browser_tree["root"]["truncated"], True)
        self.assertEqual(browser_tree["status"], "partial")
        self.assertEqual(editor_tree["status"], "complete")
        self.assertNotIn("truncated", editor_tree)

    def test_resolves_every_window_in_one_desktop_pass_keyed_by_pid(self):
        # The uninvolved application is never enumerated when every request
        # names a pid, and the desktop's children are listed exactly once no
        # matter how many windows were asked for.
        bystander = App("Bystander", 99, [Node("frame", "Bystander")])
        desktop = FakeDesktop(
            [
                App("One", 1, [Node("frame", "One", width=640, height=480)]),
                bystander,
                App("Two", 2, [Node("frame", "Two", width=640, height=480)]),
            ]
        )
        session = session_for(desktop)

        result = read(session, request("w1", "One", 1), request("w2", "Two", 2))

        self.assertEqual([tree["windowId"] for tree in result["trees"]], ["w1", "w2"])
        self.assertEqual(desktop.calls[(HELPER.REGISTRY_NAME, "GetChildren")], 1)
        self.assertEqual(desktop.calls[(desktop.dest_of(bystander), "GetChildren")], 0)

        # A window that resolves to nothing forces the fallback pass over the
        # applications the pid filter skipped.
        result = read(session, request("w1", "One", 1), request("w3", "Three", 3))
        self.assertEqual(desktop.calls[(desktop.dest_of(bystander), "GetChildren")], 1)
        self.assertEqual(result["missing"], [{"windowId": "w3", "reason": "window-not-found"}])

    def test_caches_application_pids_by_bus_name(self):
        desktop = FakeDesktop([App("One", 1, [Node("frame", "One", width=640, height=480)])])
        session = session_for(desktop)

        read(session, request("w1", "One", 1))
        read(session, request("w1", "One", 1))

        self.assertEqual(desktop.calls["GetConnectionUnixProcessID"], 1)

    def test_drops_an_application_that_fails_and_keeps_the_rest(self):
        broken = App("Broken", 7, [Node("frame", "Broken")])
        broken.failure = UNKNOWN_OBJECT
        desktop = FakeDesktop(
            [broken, App("Editor", 43, [Node("frame", "Editor", width=640, height=480)])]
        )

        result = read(
            session_for(desktop),
            request("w-broken", "Broken", 7),
            request("w-editor", "Editor", 43),
        )

        self.assertEqual([tree["windowId"] for tree in result["trees"]], ["w-editor"])
        # One attempt, not one per window.
        self.assertEqual(desktop.calls[(desktop.dest_of(broken), "GetChildren")], 1)

    def test_a_hung_application_costs_one_timeout_and_is_written_off(self):
        clock = FakeClock()
        panels = [Node("panel", f"p{i}", width=1, height=1) for i in range(20)]
        hung = App("Hung", 7, [Node("frame", "Hung", panels, width=640, height=480)])
        desktop = FakeDesktop(
            [hung, App("Editor", 43, [Node("frame", "Editor", width=640, height=480)])], clock
        )
        session = session_for(desktop)
        hung.hung = True

        result = read(session, request("w-hung", "Hung", 7), request("w-editor", "Editor", 43))

        self.assertEqual([tree["windowId"] for tree in result["trees"]], ["w-editor"])
        self.assertEqual(result["missing"], [{"windowId": "w-hung", "reason": "window-not-found"}])
        self.assertNotIn("partial", result)
        # One timeout's worth of waiting, not one per call.
        self.assertLessEqual(clock.now, HELPER.CALL_TIMEOUT_MS / 1000.0)

    def test_a_hung_window_mid_walk_is_reported_truncated(self):
        clock = FakeClock()
        panels = [Node("panel", f"p{i}", [Node("button", "b")], width=1, height=1) for i in range(20)]
        frame = Node("frame", "Hung", panels, width=640, height=480)
        hung = App("Hung", 7, [frame])
        desktop = FakeDesktop([hung], clock)
        desktop.hooks[(frame.dest, frame.path, "GetChildren")] = lambda: setattr(hung, "hung", True)

        result = read(session_for(desktop), request("w-hung", "Hung", 7))

        tree = result["trees"][0]
        self.assertIs(tree["truncated"], True)
        self.assertEqual(tree["status"], "partial")
        self.assertLessEqual(clock.now, HELPER.CALL_TIMEOUT_MS / 1000.0)

    def test_replies_with_what_it_has_when_the_deadline_passes(self):
        clock = FakeClock()
        leaves = [Node("panel", f"p{i}", width=1, height=1) for i in range(8)]
        first = Node("frame", "First", leaves, width=640, height=480)
        second = Node("frame", "Second", width=640, height=480)
        desktop = FakeDesktop([App("First", 1, [first]), App("Second", 2, [second])], clock)
        desktop.hooks[(leaves[2].dest, leaves[2].path, "GetState")] = lambda: setattr(
            clock, "now", clock.now + HELPER.REQUEST_BUDGET_SECONDS + 1
        )
        requests = [request("w1", "First", 1), request("w2", "Second", 2)]

        result = read(session_for(desktop), *requests)

        self.assertIs(result["partial"], True)
        trees = {tree["windowId"]: tree for tree in result["trees"]}
        self.assertIs(trees["w1"]["truncated"], True)
        self.assertLess(len(trees["w1"]["root"]["children"]), len(leaves))

        desktop.hooks.clear()
        clock.now = 0.0
        complete = read(session_for(desktop), *requests)
        self.assertNotIn("partial", complete)
        self.assertEqual([tree["status"] for tree in complete["trees"]], ["complete", "complete"])

    def test_read_tree_without_windows_never_touches_the_bus(self):
        session = HELPER.Session(connect=lambda _on_signal: self.fail("connected"), environ={})
        empty = {"protocol": HELPER.PROTOCOL_VERSION, "trees": []}
        self.assertEqual(session.read_tree({**PROTOCOL, "windows": []}), empty)
        self.assertEqual(session.read_tree(dict(PROTOCOL)), empty)

    def test_refuses_a_client_speaking_another_protocol(self):
        session = HELPER.Session(connect=lambda _on_signal: self.fail("connected"), environ={})
        for params in ({"windows": []}, {"protocol": 1, "windows": []}):
            with self.assertRaises(HELPER.HelperError) as caught:
                session.read_tree(params)
            self.assertEqual(caught.exception.code, HELPER.PROTOCOL_MISMATCH_ERROR)

    def test_an_unreachable_bus_is_an_answer_not_a_crash(self):
        def unreachable(_on_signal):
            raise HELPER.BusUnavailable("The accessibility bus launcher (org.a11y.Bus) failed: gone")

        session = HELPER.Session(connect=unreachable, environ={})

        self.assertEqual(
            session.probe(),
            {
                "ok": True,
                "protocol": HELPER.PROTOCOL_VERSION,
                "atspi": False,
                "reason": "The accessibility bus launcher (org.a11y.Bus) failed: gone",
            },
        )
        with self.assertRaises(HELPER.BusUnavailable) as caught:
            read(session, request("w1", "One", 1))
        self.assertEqual(caught.exception.code, HELPER.BUS_UNAVAILABLE_ERROR)

    def test_probe_reports_a_reachable_bus(self):
        self.assertEqual(
            session_for(FakeDesktop([])).probe(),
            {"ok": True, "protocol": HELPER.PROTOCOL_VERSION, "atspi": True, "reason": None},
        )

    def test_reconnects_after_the_bus_closes(self):
        desktop = FakeDesktop([App("One", 1, [Node("frame", "One", width=640, height=480)])])
        session = session_for(desktop)
        read(session, request("w1", "One", 1))
        session.bus.closed = True

        self.assertEqual(len(read(session, request("w1", "One", 1))["trees"]), 1)
        self.assertEqual(len(session.signals), 2)

    def test_the_session_bus_address_never_autolaunches(self):
        self.assertEqual(
            HELPER.session_bus_address({"DBUS_SESSION_BUS_ADDRESS": "unix:path=/x"}), "unix:path=/x"
        )
        self.assertIsNone(HELPER.session_bus_address({"XDG_RUNTIME_DIR": "/nonexistent-synara"}))
        self.assertIsNone(HELPER.session_bus_address({}))


class WalkTest(unittest.TestCase):
    @staticmethod
    def window(children, **kwargs):
        frame = Node("frame", "Window", children, width=640, height=480, **kwargs)
        return FakeDesktop([App("App", 5, [frame])]), frame

    @staticmethod
    def tree(desktop, **extra):
        return read(session_for(desktop), request("w", "Window", 5), **extra)["trees"][0]

    def test_emits_child_indices_and_skips_the_null_object(self):
        desktop, _frame = self.window([None, Node("label", "Name:"), editable_field()])

        root = self.tree(desktop)["root"]

        self.assertNotIn("i", root)
        self.assertFalse(root["editable"])
        # Two children were emitted, at their real AT-SPI indices 1 and 2.
        self.assertEqual([child["i"] for child in root["children"]], [1, 2])
        self.assertEqual([child["editable"] for child in root["children"]], [False, True])
        self.assertNotIn("path", root["children"][0])

    def test_reads_properties_extents_and_values(self):
        slider = Node(
            "slider",
            "Volume",
            x=10,
            y=20,
            width=100,
            height=8,
            description="Output level",
            value=0.5,
            interfaces=["org.a11y.atspi.Accessible", "org.a11y.atspi.Value"],
        )
        desktop, _frame = self.window([slider])

        node = self.tree(desktop)["root"]["children"][0]

        self.assertEqual(node["role"], "slider")
        self.assertEqual(node["label"], "Volume")
        self.assertEqual(node["description"], "Output level")
        self.assertEqual(node["value"], "0.5")
        # Extents are asked for in window coordinates and passed through.
        self.assertEqual(node["frame"], {"x": 10.0, "y": 20.0, "width": 100.0, "height": 8.0})

    def test_prunes_subtrees_that_are_not_showing(self):
        hidden = Node(
            "panel", "Hidden tab", [Node("button", f"b{i}") for i in range(50)], showing=False
        )
        shown = Node("panel", "Shown tab", [Node("button", "OK")])
        desktop, _frame = self.window([hidden, shown])

        tree = self.tree(desktop)

        self.assertEqual([child["label"] for child in tree["root"]["children"]], ["Shown tab"])
        self.assertEqual(tree["status"], "complete")
        # The hidden subtree cost one visit, not fifty.
        self.assertLess(desktop.calls["GetState"], 10)

    def test_walks_everything_when_the_root_does_not_report_showing(self):
        desktop, _frame = self.window(
            [Node("panel", "A", showing=False), Node("panel", "B", showing=False)], showing=False
        )

        tree = self.tree(desktop)

        self.assertEqual([child["label"] for child in tree["root"]["children"]], ["A", "B"])

    def test_says_when_pruning_left_only_the_frame(self):
        # Gecko's root stays SHOWING while everything below it on another
        # workspace is not; an empty tree there is not "no controls".
        page = Node("document web", "Page", [Node("button", "Buy")])
        desktop, _frame = self.window([Node("tool bar", "Navigation", [page], showing=False)])

        tree = self.tree(desktop)

        self.assertEqual(tree["status"], "partial")
        self.assertIs(tree["truncated"], True)
        self.assertIs(tree["root"]["truncated"], True)
        self.assertEqual(tree["reason"], HELPER.CONTENT_HIDDEN_REASON)

    def test_says_when_no_page_is_showing(self):
        page = Node("internal frame", "", [Node("document web", "Page")], showing=False)
        desktop, _frame = self.window([Node("tool bar", "Navigation"), page])

        tree = self.tree(desktop)

        self.assertEqual(tree["status"], "partial")
        self.assertEqual(tree["reason"], HELPER.CONTENT_HIDDEN_REASON)

    def test_a_background_tab_next_to_a_shown_one_is_not_incomplete(self):
        shown = Node("internal frame", "", [Node("document web", "Shown", [Node("button", "Go")])])
        hidden = Node("internal frame", "", [Node("document web", "Hidden")], showing=False)
        desktop, _frame = self.window([shown, hidden])

        tree = self.tree(desktop)

        self.assertEqual(tree["status"], "complete")
        self.assertNotIn("reason", tree)

    def test_a_hidden_popover_in_an_ordinary_window_is_not_incomplete(self):
        desktop, _frame = self.window(
            [Node("popup menu", "Menu", showing=False), Node("button", "OK")]
        )
        self.assertEqual(self.tree(desktop)["status"], "complete")

    def test_falls_back_when_getall_and_getchildren_are_missing(self):
        leaf = Node("button", "OK", description="Confirm")
        panel = Node("panel", "Panel", [leaf])
        desktop, frame = self.window([panel])
        for node in (frame, panel, leaf):
            node.unsupported |= {"GetAll", "GetChildren", "GetRole"}

        root = self.tree(desktop)["root"]

        self.assertEqual(root["label"], "Window")
        button = root["children"][0]["children"][0]
        self.assertEqual(
            (button["role"], button["label"], button["description"], button["i"]),
            ("button", "OK", "Confirm", 0),
        )

    def test_marks_the_parent_of_a_child_that_failed(self):
        broken = Node("button", "Broken")
        broken.failure = UNKNOWN_OBJECT
        desktop, _frame = self.window([Node("button", "OK"), broken])

        tree = self.tree(desktop)

        self.assertEqual([child["label"] for child in tree["root"]["children"]], ["OK"])
        self.assertIs(tree["root"]["truncated"], True)
        self.assertEqual(tree["status"], "partial")

    def test_marks_a_node_whose_children_could_not_be_listed(self):
        panel = Node("panel", "Panel", [Node("button", "OK")])
        desktop, _frame = self.window([panel])

        def refuse():
            raise HELPER.CallFailed("org.freedesktop.DBus.Error.Failed")

        desktop.hooks[(panel.dest, panel.path, "GetChildren")] = refuse

        tree = self.tree(desktop)

        self.assertIs(tree["root"]["children"][0]["truncated"], True)
        self.assertEqual(tree["status"], "partial")

    def test_reports_a_chromium_frame_without_renderer_accessibility(self):
        frame = Node("frame", "Claude", [None], width=800, height=600)
        desktop = FakeDesktop([App("claude-desktop", 5, [frame], toolkit="Chromium")])

        tree = read(session_for(desktop), request("w", "Claude", 5))["trees"][0]

        self.assertEqual(tree["status"], "unavailable")
        self.assertIn("--force-renderer-accessibility", tree["reason"])
        self.assertEqual(tree["root"]["children"], [])

    def test_a_childless_window_is_simply_empty(self):
        desktop, _frame = self.window([])
        self.assertEqual(self.tree(desktop)["status"], "complete")


class TreeCacheTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.button = Node("button", "OK")
        self.frame = Node("frame", "Window", [self.button], width=640, height=480)
        self.desktop = FakeDesktop([App("App", 5, [self.frame])], self.clock)
        self.session = session_for(self.desktop)
        self.dest = self.frame.dest

    def read(self, max_age_ms=5000):
        return read(self.session, request("w", "Window", 5), maxAgeMs=max_age_ms)["trees"][0]

    def warm(self):
        """Register, hear from the application, and cache one walk."""
        self.read()
        self.clock.now += HELPER.EVENT_SETTLE_SECONDS + 0.01
        self.session._on_signal(self.dest)
        self.read()

    def test_serves_a_tree_the_application_has_not_changed_since(self):
        self.warm()
        self.assertEqual(self.desktop.registered, list(HELPER.CACHE_EVENTS))
        # Per-frame classes are never asked for: every application on the bus
        # would emit them on each scroll and animation frame.
        self.assertNotIn("object:bounds-changed", self.desktop.registered)
        self.assertNotIn("object:visible-data-changed", self.desktop.registered)
        walked = self.desktop.calls["GetChildren"]
        confirmed = self.desktop.calls[(self.dest, "GetState")]

        cached = self.read()

        self.assertIs(cached["cached"], True)
        self.assertEqual(self.desktop.calls["GetChildren"], walked)
        # The cached answer was still confirmed against the application.
        self.assertEqual(self.desktop.calls[(self.dest, "GetState")], confirmed + 1)

    def test_an_event_from_the_application_invalidates_its_trees(self):
        self.warm()
        self.button.name = "Cancel"
        self.session._on_signal(self.dest)

        tree = self.read()

        self.assertNotIn("cached", tree)
        self.assertEqual(tree["root"]["children"][0]["label"], "Cancel")

    def test_an_event_that_arrives_with_the_confirmation_invalidates_too(self):
        self.warm()
        self.desktop.hooks[(self.dest, self.frame.path, "GetState")] = lambda: (
            self.session._on_signal(self.dest)
        )

        self.assertNotIn("cached", self.read())

    def test_never_serves_an_application_it_has_not_heard_from(self):
        self.read()
        self.clock.now += HELPER.EVENT_SETTLE_SECONDS + 0.01
        self.read()
        self.assertNotIn("cached", self.read())

    def test_honours_the_callers_maximum_age(self):
        self.warm()
        self.assertNotIn("cached", self.read(max_age_ms=0))
        self.warm()
        self.clock.now += 6
        self.assertNotIn("cached", self.read(max_age_ms=5000))

    def test_a_window_that_stopped_showing_is_walked_again(self):
        self.warm()
        self.frame.showing = False
        self.assertNotIn("cached", self.read())

    def test_an_application_that_exits_is_forgotten(self):
        self.warm()
        self.session._on_signal(self.dest, gone=True)
        self.assertNotIn("cached", self.read())

    def test_drops_walks_too_old_to_serve(self):
        self.warm()
        self.assertEqual(len(self.session.trees.entries), 1)
        self.clock.now += HELPER.TREE_CACHE_MAX_SECONDS + 1
        self.session.trees.expire()
        self.assertEqual(len(self.session.trees.entries), 0)

    def test_keeps_no_walks_when_events_are_off(self):
        session = session_for(self.desktop, events=False)
        read(session, request("w", "Window", 5), maxAgeMs=5000)
        self.assertEqual(len(session.trees.entries), 0)

    def test_registers_for_events_only_when_a_caller_accepts_cached_trees(self):
        self.read(max_age_ms=0)
        self.assertEqual(self.desktop.registered, [])
        read(session_for(self.desktop, events=False), request("w", "Window", 5), maxAgeMs=5000)
        self.assertEqual(self.desktop.registered, [])


class SemanticAddressTest(unittest.TestCase):
    def setUp(self):
        self.field = editable_field()
        # The null child keeps the emitted list and the real indices apart.
        self.frame = Node(
            "frame", "Terminal", [None, Node("label", "Name:"), self.field], width=640, height=480
        )
        self.app = App("Terminal", 42, [self.frame])
        self.desktop = FakeDesktop([self.app])
        self.session = session_for(self.desktop)
        self.requested = {
            "id": "window-1",
            "title": "Terminal",
            "pid": 42,
            "bounds": {"width": 648, "height": 518},
        }

    def set_text(self, **params):
        return self.session.set_text({**PROTOCOL, "window": self.requested, **params})

    def validate(self, **params):
        return self.session.validate_node({**PROTOCOL, "window": self.requested, **params})

    def node_at(self, path):
        scheduler = self.session.scheduler(HELPER.RequestBudget(clock=self.desktop.clock))
        found = HELPER.node_at_path(scheduler, (self.frame.dest, self.frame.path), path)
        return self.desktop.objects[found] if found else None

    def test_resolves_a_path_and_rejects_one_that_no_longer_exists(self):
        self.assertIs(self.node_at([2]), self.field)
        self.assertIs(self.node_at([]), self.frame)
        self.assertIsNone(self.node_at([9]))
        self.assertIsNone(self.node_at([0]))
        self.assertIsNone(self.node_at([2, 0]))
        self.assertIsNone(self.node_at(["2"]))
        self.assertIsNone(self.node_at([True]))

    def test_writes_the_whole_value_through_editable_text(self):
        result = self.set_text(path=[2], text="naïve", role="entry", label="Name")

        self.assertEqual(result, {"ok": True})
        self.assertEqual(self.field.text, "naïve")

    def test_refuses_a_node_that_drifted_or_cannot_take_text(self):
        drifted = self.set_text(path=[2], text="x", label="Other")
        not_editable = self.set_text(path=[1], text="x")
        missing_node = self.set_text(path=[7], text="x")
        missing_window = self.session.set_text(
            {
                **PROTOCOL,
                "window": {"id": "gone", "title": "Gone", "pid": 7},
                "path": [],
                "text": "x",
            }
        )

        self.assertEqual(drifted, {"ok": False, "reason": "node-changed"})
        self.assertEqual(not_editable, {"ok": False, "reason": "not-editable"})
        self.assertEqual(missing_node, {"ok": False, "reason": "node-not-found"})
        self.assertEqual(missing_window, {"ok": False, "reason": "window-not-found"})
        self.assertIsNone(self.field.text)

    def test_refuses_to_write_into_an_ambiguous_window(self):
        twin = Node(
            "frame",
            "Terminal",
            [None, Node("label", "Name:"), editable_field()],
            width=640,
            height=480,
        )
        self.session = session_for(FakeDesktop([self.app, App("Terminal", 42, [twin])]))

        self.assertEqual(
            self.set_text(path=[2], text="x"), {"ok": False, "reason": "window-ambiguous"}
        )
        self.assertIsNone(self.field.text)

    def test_writes_a_control_whose_name_outgrew_the_tree_clamp(self):
        # The tree carried the first MAX_TEXT_CHARS of the name; comparing
        # that against the unclamped live name refused every such control.
        self.field.name = "n" * (HELPER.MAX_TEXT_CHARS + 500)
        tree = read(self.session, self.requested)["trees"][0]
        label = tree["root"]["children"][1]["label"]

        self.assertEqual(self.set_text(path=[2], text="x", label=label), {"ok": True})
        self.assertEqual(self.field.text, "x")

    def test_clamps_in_the_client_unit_so_a_long_emoji_name_still_matches(self):
        # 🙂 is two UTF-16 units: the tree must carry no more units than the
        # client's bound, or the client cuts it again and the label it sends
        # back never matches this side's clamp of the live name.
        self.field.name = "🙂" * HELPER.MAX_TEXT_CHARS
        tree = read(self.session, self.requested)["trees"][0]
        label = tree["root"]["children"][1]["label"]

        self.assertEqual(len(label.encode("utf-16-le")) // 2, HELPER.MAX_TEXT_CHARS)
        self.assertEqual(self.set_text(path=[2], text="x", label=label), {"ok": True})
        self.assertEqual(HELPER.clamp_text("a🙂b", 2), "a")
        self.assertEqual(HELPER.clamp_text("a🙂b", 3), "a🙂")

    def test_compares_labels_the_way_the_client_matches_them(self):
        # Non-breaking spaces fold to plain spaces and composed/decomposed
        # forms are equal, but whitespace is never trimmed: a trailing space
        # is a different label, as it is for the client's exact matching.
        self.field.name = "Nom *"
        self.assertEqual(self.set_text(path=[2], text="a", label="Nom *"), {"ok": True})
        self.field.name = "Café"
        self.assertEqual(self.set_text(path=[2], text="b", label="Café"), {"ok": True})
        self.field.name = "Name "
        self.assertEqual(
            self.set_text(path=[2], text="c", label="Name"),
            {"ok": False, "reason": "node-changed"},
        )
        self.assertEqual(self.field.text, "b")

    def test_refuses_a_labeled_node_at_an_unlabeled_address(self):
        self.assertEqual(
            self.set_text(path=[2], text="wrong", label=""),
            {"ok": False, "reason": "node-changed"},
        )
        self.assertIsNone(self.field.text)

    def test_reports_a_toolkit_that_refuses_the_write(self):
        self.field.accepts = False
        self.assertEqual(self.set_text(path=[2], text="x"), {"ok": False})

    def test_validates_a_node_with_fresh_extents(self):
        self.field.extents = (30, 40, 200, 24)

        self.assertEqual(
            self.validate(path=[2], role="entry", label="Name"),
            {
                "ok": True,
                "frame": {"x": 30.0, "y": 40.0, "width": 200.0, "height": 24.0},
                "showing": True,
                "clientSize": {"width": 640.0, "height": 480.0},
            },
        )

    def test_validation_refuses_a_node_that_changed(self):
        self.assertEqual(
            self.validate(path=[2], role="entry", label="Email"),
            {"ok": False, "reason": "node-changed"},
        )
        self.assertEqual(
            self.validate(path=[1], role="entry", label="Name:"),
            {"ok": False, "reason": "node-changed"},
        )
        self.assertEqual(
            self.validate(path=[5], role="entry", label="Name"),
            {"ok": False, "reason": "node-not-found"},
        )


class ReplySizeTest(unittest.TestCase):
    def setUp(self):
        self.safe_reply_bytes = HELPER.SAFE_REPLY_BYTES
        self.frame = Node("frame", "Terminal", width=640, height=480)
        self.requested = {
            "id": "window-1",
            "title": "Terminal",
            "pid": 42,
            "bounds": {"width": 648, "height": 518},
        }

    def tearDown(self):
        HELPER.SAFE_REPLY_BYTES = self.safe_reply_bytes

    def session(self):
        return session_for(FakeDesktop([App("Terminal", 42, [self.frame])]))

    def test_clamps_oversized_accessible_names_before_serialization(self):
        # A megabyte-scale name: a dense Chromium tree can produce these, and
        # before the clamp one of them failed the client's frame cap and took
        # perception for the whole application down with it.
        self.frame.name = "x" * (2 * 1024 * 1024)
        self.requested["title"] = self.frame.name

        trees = read(self.session(), self.requested)["trees"]

        self.assertEqual(len(trees[0]["root"]["label"]), HELPER.MAX_TEXT_CHARS)
        # The reply stays well inside what the newline-framed transport accepts.
        self.assertLess(
            len(json.dumps(trees, separators=(",", ":")).encode()), HELPER.SAFE_REPLY_BYTES
        )

    def test_drops_node_text_when_the_whole_reply_would_still_exceed_the_cap(self):
        # Enough nodes that even clamped text sums past the safety threshold:
        # the fallback keeps role, geometry, and shape, dropping free text.
        self.frame.children = [
            Node("panel", "y" * HELPER.MAX_TEXT_CHARS, width=10, height=10) for _ in range(2000)
        ]
        # A threshold the bare node shapes fit under but one clamped label per
        # node blows straight through.
        limit = 512 * 1024
        HELPER.SAFE_REPLY_BYTES = limit

        result = read(self.session(), self.requested)

        root = result["trees"][0]["root"]
        self.assertLessEqual(len(json.dumps(result, separators=(",", ":")).encode()), limit)
        # The window node kept its identity; leaf nodes lost their text.
        self.assertEqual(root["label"], "Terminal")
        self.assertIsNone(root["children"][0]["label"])

    def test_raises_when_even_the_strip_cannot_fit(self):
        HELPER.SAFE_REPLY_BYTES = 16
        with self.assertRaises(RuntimeError) as caught:
            read(self.session(), self.requested)
        self.assertIn("transport limit", str(caught.exception))

    def test_keeps_the_partial_flag_when_stripping_text(self):
        self.frame.children = [
            Node("panel", "y" * HELPER.MAX_TEXT_CHARS, width=10, height=10) for _ in range(2000)
        ]
        trees = read(self.session(), self.requested)["trees"]
        HELPER.SAFE_REPLY_BYTES = 512 * 1024

        result = HELPER.fit_reply({"trees": trees, "partial": True})

        self.assertIs(result["partial"], True)
        self.assertIsNone(result["trees"][0]["root"]["children"][0]["label"])


class RequestLineTest(unittest.TestCase):
    def test_answers_each_line_with_its_own_id_and_error_code(self):
        emitted = []
        original = HELPER.emit
        HELPER.emit = emitted.append
        try:
            session = session_for(FakeDesktop([]))
            HELPER.handle_line(session, '{"jsonrpc":"2.0","id":1,"method":"probe"}')
            HELPER.handle_line(session, "{not json")
            HELPER.handle_line(session, '{"jsonrpc":"2.0","id":3,"method":"read-tree","params":{}}')
        finally:
            HELPER.emit = original

        self.assertEqual(emitted[0]["id"], 1)
        self.assertIs(emitted[0]["result"]["atspi"], True)
        self.assertIsNone(emitted[1]["id"])
        self.assertEqual(emitted[1]["error"]["code"], HELPER.GENERIC_ERROR)
        self.assertEqual(emitted[2]["id"], 3)
        self.assertEqual(emitted[2]["error"]["code"], HELPER.PROTOCOL_MISMATCH_ERROR)


if __name__ == "__main__":
    unittest.main()
