import importlib.util
import json
import unittest
from pathlib import Path


HELPER_PATH = Path(__file__).with_name("atspi_helper.py")
SPEC = importlib.util.spec_from_file_location("synara_atspi_helper", HELPER_PATH)
HELPER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(HELPER)


class FakeRole:
    FRAME = "frame"
    WINDOW = "window"
    DIALOG = "dialog"


class FakeCoordType:
    SCREEN = "screen"


class FakeAtspi:
    Role = FakeRole
    CoordType = FakeCoordType
    desktop = None

    @staticmethod
    def get_desktop(_index):
        return FakeAtspi.desktop


class FakeClock:
    """A monotonic clock the test moves by hand."""

    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class FakeRect:
    def __init__(self, width, height):
        self.x = 0
        self.y = 0
        self.width = width
        self.height = height


class FakeEditableText:
    def __init__(self, owner, accepts=True):
        self.owner = owner
        self.accepts = accepts

    def set_text_contents(self, text):
        if not self.accepts:
            return False
        self.owner.text = text
        return True


class FakeAccessible:
    def __init__(
        self,
        role,
        name="",
        pid=None,
        width=0,
        height=0,
        children=None,
        interfaces=None,
        editable=None,
    ):
        self.role = role
        self.name = name
        self.pid = pid
        self.rect = FakeRect(width, height)
        self.children = children or []
        self.interfaces = ["Accessible", "Component"] if interfaces is None else interfaces
        self.editable = editable
        self.text = None

    def get_interfaces(self):
        return self.interfaces

    def get_editable_text_iface(self):
        return self.editable

    def get_role(self):
        return self.role

    def get_role_name(self):
        return self.role

    def get_name(self):
        return self.name

    def get_process_id(self):
        return self.pid

    def get_component_iface(self):
        return self

    def get_extents(self, _coord_type):
        return self.rect

    def get_child_count(self):
        return len(self.children)

    def get_child_at_index(self, index):
        # Real bindings answer None for a missing child rather than raising.
        return self.children[index] if 0 <= index < len(self.children) else None

    def get_description(self):
        return ""

    def get_value_iface(self):
        raise RuntimeError("no value")


def editable_field(name="Name"):
    field = FakeAccessible(
        "entry",
        name,
        interfaces=["Accessible", "Component", "org.a11y.atspi.EditableText", "Text"],
    )
    field.editable = FakeEditableText(field)
    return field


class RaisingAccessible(FakeAccessible):
    """An application whose enumeration fails, the way a hung app times out."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.enumerations = 0

    def get_child_count(self):
        self.enumerations += 1
        raise RuntimeError("timeout")


class AtspiHelperTest(unittest.TestCase):
    def setUp(self):
        HELPER.Atspi = FakeAtspi
        FakeAtspi.desktop = None

    def test_descends_through_application_to_find_a_frame(self):
        frame = FakeAccessible("frame", "Terminal", None, 640, 480)
        application = FakeAccessible("application", "Terminal", 42, 0, 0, [frame])
        desktop = FakeAccessible("desktop", children=[application])

        found = HELPER.find_window(
            desktop,
            {
                "title": "Terminal",
                "pid": 42,
                "bounds": {"width": 648, "height": 518},
            },
        )

        self.assertIs(found, frame)
        self.assertEqual(HELPER.client_size_for(found), {"width": 640.0, "height": 480.0})

    def test_refuses_identical_windows_even_in_separate_subtrees(self):
        first = FakeAccessible("frame", "Terminal", 42, 640, 480)
        second = FakeAccessible("frame", "Terminal", 42, 640, 480)
        desktop = FakeAccessible("desktop", children=[
            FakeAccessible("application", children=[first]),
            FakeAccessible("application", children=[second]),
        ])
        requested = {"title": "Terminal", "pid": 42}
        self.assertIsNone(HELPER.find_window(desktop, requested))
        # Distinguishable from a window that is simply not there.
        self.assertEqual(HELPER.resolve_window(desktop, requested), ("ambiguous", None))

    def test_ignores_a_live_name_that_is_only_a_fragment_of_the_requested_title(self):
        # Without a pid, "Terminal" used to match any longer title that
        # contained the word, so an unrelated toplevel took the request.
        fragment = FakeAccessible("frame", "Terminal", None, 640, 480)
        desktop = FakeAccessible("desktop", children=[
            FakeAccessible("application", "Terminal", None, children=[fragment])
        ])

        self.assertEqual(
            HELPER.resolve_window(desktop, {"title": "Terminal — vim", "pid": None}),
            ("not-found", None),
        )
        # The requested title as a fragment of the live name is still accepted.
        self.assertIs(HELPER.find_window(desktop, {"title": "Term", "pid": None}), fragment)

    def test_falls_back_to_title_and_bounds_when_the_pid_disagrees(self):
        # A Flatpak app reports the sandbox proxy's pid; the compositor reports
        # the real one. The window is still identifiable by title and size.
        sandboxed = FakeAccessible("frame", "Firefox", 1000, 640, 480)
        desktop = FakeAccessible("desktop", children=[
            FakeAccessible("application", "Firefox", 1000, children=[sandboxed])
        ])

        self.assertIs(
            HELPER.find_window(
                desktop, {"title": "Firefox", "pid": 42, "bounds": {"width": 640, "height": 480}}
            ),
            sandboxed,
        )
        self.assertEqual(
            HELPER.resolve_window(desktop, {"title": "Editor", "pid": 42}), ("not-found", None)
        )

    def test_prefers_the_requested_process_over_a_title_only_match(self):
        owned = FakeAccessible("frame", "Terminal — vim", 42, 640, 480)
        impostor = FakeAccessible("frame", "Terminal", 7, 640, 480)
        desktop = FakeAccessible("desktop", children=[
            FakeAccessible("application", "Other", 7, children=[impostor]),
            FakeAccessible("application", "Terminal", 42, children=[owned]),
        ])

        self.assertIs(
            HELPER.find_window(
                desktop, {"title": "Terminal", "pid": 42, "bounds": {"width": 640, "height": 480}}
            ),
            owned,
        )

    def test_chooses_the_frame_with_matching_name_and_extents_for_one_pid(self):
        other = FakeAccessible("frame", "Other", 42, 400, 300)
        target = FakeAccessible("window", "Terminal", 42, 640, 480)
        desktop = FakeAccessible("desktop", children=[other, target])

        found = HELPER.find_window(
            desktop,
            {
                "title": "Terminal",
                "pid": 42,
                "bounds": {"width": 648, "height": 518},
            },
        )

        self.assertIs(found, target)


class AtspiWindowSearchTest(unittest.TestCase):
    def setUp(self):
        HELPER.Atspi = FakeAtspi

    def tearDown(self):
        FakeAtspi.desktop = None

    @staticmethod
    def request(window_id, title, pid, width=640, height=480):
        return {
            "id": window_id,
            "title": title,
            "pid": pid,
            "bounds": {"width": width, "height": height},
        }

    def test_a_large_application_tree_does_not_starve_later_windows(self):
        # One Chromium-sized tree used to exhaust the shared node budget before
        # the search reached the next application, so every later window was
        # reported missing.
        dense = [
            FakeAccessible("panel", f"p{i}", width=1, height=1)
            for i in range(3 * HELPER.MAX_NODES)
        ]
        browser = FakeAccessible("frame", "Browser", 41, 640, 480, dense)
        editor = FakeAccessible("frame", "Editor", 43, 640, 480)
        FakeAtspi.desktop = FakeAccessible("desktop", children=[
            FakeAccessible("application", "Browser", 41, children=[browser]),
            FakeAccessible("application", "Editor", 43, children=[editor]),
        ])

        result = HELPER.read_tree(
            {
                "windows": [
                    self.request("w-browser", "Browser", 41),
                    self.request("w-editor", "Editor", 43),
                ]
            }
        )

        self.assertEqual([tree["windowId"] for tree in result["trees"]], ["w-browser", "w-editor"])
        self.assertNotIn("partial", result)

    def test_resolves_every_window_in_one_desktop_pass_keyed_by_pid(self):
        # The uninvolved application is never enumerated when every request
        # names a pid, and the desktop's children are listed exactly once no
        # matter how many windows were asked for.
        first = FakeAccessible("frame", "One", 1, 640, 480)
        second = FakeAccessible("frame", "Two", 2, 640, 480)
        bystander = RaisingAccessible("application", "Bystander", 99)
        desktop = FakeAccessible("desktop", children=[
            FakeAccessible("application", "One", 1, children=[first]),
            bystander,
            FakeAccessible("application", "Two", 2, children=[second]),
        ])
        listings = []
        original = desktop.get_child_at_index
        desktop.get_child_at_index = lambda index: listings.append(index) or original(index)
        FakeAtspi.desktop = desktop

        result = HELPER.read_tree(
            {
                "windows": [
                    self.request("w1", "One", 1),
                    self.request("w2", "Two", 2),
                    self.request("w3", "Three", 3),
                ]
            }
        )

        self.assertEqual([tree["windowId"] for tree in result["trees"]], ["w1", "w2"])
        self.assertEqual(listings, [0, 1, 2])
        # The window that resolved to nothing forced the fallback pass over the
        # applications the pid filter skipped, which is where the failure lives.
        self.assertEqual(bystander.enumerations, 1)

    def test_drops_an_application_that_raises_and_keeps_the_rest(self):
        broken = RaisingAccessible("application", "Broken", 7)
        editor = FakeAccessible("frame", "Editor", 43, 640, 480)
        FakeAtspi.desktop = FakeAccessible("desktop", children=[
            broken,
            FakeAccessible("application", "Editor", 43, children=[editor]),
        ])

        result = HELPER.read_tree(
            {
                "windows": [
                    self.request("w-broken", "Broken", 7),
                    self.request("w-editor", "Editor", 43),
                ]
            }
        )

        self.assertEqual([tree["windowId"] for tree in result["trees"]], ["w-editor"])
        # Blacklisted for the request: one attempt, not one per window.
        self.assertEqual(broken.enumerations, 1)

    def test_replies_with_what_it_has_when_the_deadline_passes(self):
        clock = FakeClock()
        leaves = [FakeAccessible("panel", f"p{i}", width=1, height=1) for i in range(8)]

        def stall():
            clock.now += HELPER.REQUEST_BUDGET_SECONDS + 1
            return "panel"

        leaves[2].get_role_name = stall
        first = FakeAccessible("frame", "First", 1, 640, 480, leaves)
        second = FakeAccessible("frame", "Second", 2, 640, 480)
        FakeAtspi.desktop = FakeAccessible("desktop", children=[
            FakeAccessible("application", "First", 1, children=[first]),
            FakeAccessible("application", "Second", 2, children=[second]),
        ])
        requests = [self.request("w1", "First", 1), self.request("w2", "Second", 2)]

        result = HELPER.read_tree({"windows": requests}, clock=clock)

        self.assertIs(result["partial"], True)
        self.assertEqual([tree["windowId"] for tree in result["trees"]], ["w1"])
        self.assertLess(len(result["trees"][0]["root"]["children"]), len(leaves))

        clock.now = 0.0
        leaves[2].get_role_name = lambda: "panel"
        complete = HELPER.read_tree({"windows": requests}, clock=clock)
        self.assertNotIn("partial", complete)
        self.assertEqual(len(complete["trees"]), 2)

    def test_the_search_budget_is_separate_from_the_tree_walk_budget(self):
        # More toplevels than a tree walk may hold: the search still finds the
        # last one because it counts against its own budget.
        frames = [
            FakeAccessible("frame", f"Window {i}", 5, 640, 480)
            for i in range(HELPER.MAX_NODES + 8)
        ]
        FakeAtspi.desktop = FakeAccessible("desktop", children=[
            FakeAccessible("application", "Many", 5, children=frames)
        ])

        status, window = HELPER.resolve_window(
            FakeAtspi.desktop, self.request("last", frames[-1].name, 5)
        )

        self.assertEqual(status, "found")
        self.assertIs(window, frames[-1])

    def test_read_tree_without_windows_never_touches_atspi(self):
        HELPER.Atspi = None
        self.assertEqual(HELPER.read_tree({"windows": []}), {"trees": []})
        self.assertEqual(HELPER.read_tree({}), {"trees": []})

    def test_configure_atspi_bounds_calls_and_tolerates_old_bindings(self):
        calls = []
        FakeAtspi.set_timeout = staticmethod(lambda *args: calls.append(args))
        try:
            self.assertTrue(HELPER.configure_atspi())
        finally:
            del FakeAtspi.set_timeout
        self.assertEqual(calls, [(HELPER.ATSPI_CALL_TIMEOUT_MS, HELPER.ATSPI_STARTUP_TIMEOUT_MS)])
        self.assertFalse(HELPER.configure_atspi())
        HELPER.Atspi = None
        self.assertFalse(HELPER.configure_atspi())

    def test_probe_reports_whether_atspi_imported(self):
        self.assertEqual(HELPER.probe(), {"ok": True, "atspi": True, "reason": None})
        HELPER.Atspi = None
        original = HELPER.ATSPI_IMPORT_ERROR
        HELPER.ATSPI_IMPORT_ERROR = "No module named 'gi'"
        try:
            self.assertEqual(
                HELPER.probe(), {"ok": True, "atspi": False, "reason": "No module named 'gi'"}
            )
        finally:
            HELPER.ATSPI_IMPORT_ERROR = original


class AtspiSemanticWriteTest(unittest.TestCase):
    def setUp(self):
        HELPER.Atspi = FakeAtspi
        self.field = editable_field()
        self.label = FakeAccessible("label", "Name:")
        # The dropped child keeps the emitted list and the real indices apart.
        self.frame = FakeAccessible(
            "frame",
            "Terminal",
            42,
            640,
            480,
            [None, self.label, self.field],
        )
        self.application = FakeAccessible("application", "Terminal", 42, 0, 0, [self.frame])
        FakeAtspi.desktop = FakeAccessible("desktop", children=[self.application])
        self.requested = {
            "id": "window-1",
            "title": "Terminal",
            "pid": 42,
            "bounds": {"width": 648, "height": 518},
        }

    def tearDown(self):
        FakeAtspi.desktop = None

    def test_emits_real_child_indices_and_the_editable_flag(self):
        trees = HELPER.read_tree({"windows": [self.requested]})["trees"]

        root = trees[0]["root"]
        self.assertEqual(root["path"], [])
        self.assertFalse(root["editable"])
        # Two children were emitted, at their real AT-SPI indices 1 and 2.
        self.assertEqual([child["path"] for child in root["children"]], [[1], [2]])
        self.assertEqual([child["editable"] for child in root["children"]], [False, True])

    def test_resolves_a_path_and_rejects_one_that_no_longer_exists(self):
        self.assertIs(HELPER.node_at_path(self.frame, [2]), self.field)
        self.assertIs(HELPER.node_at_path(self.frame, []), self.frame)
        self.assertIsNone(HELPER.node_at_path(self.frame, [9]))
        self.assertIsNone(HELPER.node_at_path(self.frame, [0]))
        self.assertIsNone(HELPER.node_at_path(self.frame, [2, 0]))
        self.assertIsNone(HELPER.node_at_path(self.frame, ["2"]))
        self.assertIsNone(HELPER.node_at_path(self.frame, [True]))

    def test_the_bounds_check_protects_the_write_not_the_binding(self):
        # Some bindings answer the nearest child for an index past the end
        # instead of None; the count check has to refuse the address first.
        self.frame.get_child_at_index = lambda index: self.frame.children[
            min(index, len(self.frame.children) - 1)
        ]

        self.assertIsNone(HELPER.node_at_path(self.frame, [9]))
        self.assertEqual(
            HELPER.set_text({"window": self.requested, "path": [9], "text": "x"}),
            {"ok": False, "reason": "node-not-found"},
        )
        self.assertIsNone(self.field.text)

    def test_writes_the_whole_value_through_editable_text(self):
        result = HELPER.set_text(
            {
                "window": self.requested,
                "path": [2],
                "text": "naïve",
                "role": "entry",
                "label": "Name",
            }
        )

        self.assertEqual(result, {"ok": True})
        self.assertEqual(self.field.text, "naïve")

    def test_refuses_a_node_that_drifted_or_cannot_take_text(self):
        drifted = HELPER.set_text(
            {"window": self.requested, "path": [2], "text": "x", "label": "Other"}
        )
        not_editable = HELPER.set_text({"window": self.requested, "path": [1], "text": "x"})
        missing_node = HELPER.set_text({"window": self.requested, "path": [7], "text": "x"})
        missing_window = HELPER.set_text(
            {"window": {"id": "gone", "title": "Gone", "pid": 7}, "path": [], "text": "x"}
        )

        self.assertEqual(drifted, {"ok": False, "reason": "node-changed"})
        self.assertEqual(not_editable, {"ok": False, "reason": "not-editable"})
        self.assertEqual(missing_node, {"ok": False, "reason": "node-not-found"})
        self.assertEqual(missing_window, {"ok": False, "reason": "window-not-found"})
        self.assertIsNone(self.field.text)

    def test_refuses_to_write_into_an_ambiguous_window(self):
        twin = FakeAccessible(
            "frame", "Terminal", 42, 640, 480, [None, self.label, editable_field()]
        )
        self.application.children.append(twin)

        result = HELPER.set_text({"window": self.requested, "path": [2], "text": "x"})

        self.assertEqual(result, {"ok": False, "reason": "window-ambiguous"})
        self.assertIsNone(self.field.text)

    def test_writes_a_control_whose_name_outgrew_the_tree_clamp(self):
        # The tree carried the first MAX_TEXT_CHARS of the name; comparing
        # that against the unclamped live name refused every such control.
        self.field.name = "n" * (HELPER.MAX_TEXT_CHARS + 500)
        tree = HELPER.read_tree({"windows": [self.requested]})["trees"][0]
        label = tree["root"]["children"][1]["label"]

        result = HELPER.set_text(
            {"window": self.requested, "path": [2], "text": "x", "label": label}
        )

        self.assertEqual(result, {"ok": True})
        self.assertEqual(self.field.text, "x")

    def test_compares_labels_the_way_the_client_matches_them(self):
        # Non-breaking spaces fold to plain spaces and composed/decomposed
        # forms are equal, but whitespace is never trimmed: a trailing space
        # is a different label, as it is for the client's exact matching.
        self.field.name = "Nom\u00a0*"
        self.assertEqual(
            HELPER.set_text({"window": self.requested, "path": [2], "text": "a", "label": "Nom *"}),
            {"ok": True},
        )
        self.field.name = "Cafe\u0301"
        self.assertEqual(
            HELPER.set_text({"window": self.requested, "path": [2], "text": "b", "label": "Caf\u00e9"}),
            {"ok": True},
        )
        self.field.name = "Name "
        self.assertEqual(
            HELPER.set_text({"window": self.requested, "path": [2], "text": "c", "label": "Name"}),
            {"ok": False, "reason": "node-changed"},
        )
        self.assertEqual(self.field.text, "b")

    def test_refuses_a_labeled_node_at_an_unlabeled_address(self):
        result = HELPER.set_text({"window": self.requested, "path": [2], "text": "wrong", "label": ""})
        self.assertEqual(result, {"ok": False, "reason": "node-changed"})
        self.assertIsNone(self.field.text)

    def test_reports_a_toolkit_that_refuses_the_write(self):
        self.field.editable = FakeEditableText(self.field, accepts=False)

        self.assertEqual(
            HELPER.set_text({"window": self.requested, "path": [2], "text": "x"}),
            {"ok": False},
        )

    def test_falls_back_to_the_interface_probe_when_no_list_is_reported(self):
        probed = editable_field()
        probed.get_interfaces = lambda: None

        self.assertTrue(HELPER.supports_editable_text(probed))
        self.assertFalse(HELPER.supports_editable_text(self.label))


class AtspiReplySizeTest(unittest.TestCase):
    def setUp(self):
        HELPER.Atspi = FakeAtspi
        self.safe_reply_bytes = HELPER.SAFE_REPLY_BYTES
        self.frame = FakeAccessible("frame", "Terminal", 42, 640, 480)
        self.application = FakeAccessible("application", "Terminal", 42, 0, 0, [self.frame])
        FakeAtspi.desktop = FakeAccessible("desktop", children=[self.application])
        self.requested = {
            "id": "window-1",
            "title": "Terminal",
            "pid": 42,
            "bounds": {"width": 648, "height": 518},
        }

    def tearDown(self):
        FakeAtspi.desktop = None
        HELPER.SAFE_REPLY_BYTES = self.safe_reply_bytes

    def test_clamps_oversized_accessible_names_before_serialization(self):
        # A megabyte-scale name: a dense Chromium tree can produce these, and
        # before the clamp one of them failed the client's frame cap and took
        # perception for the whole application down with it.
        self.frame.name = "x" * (2 * 1024 * 1024)

        trees = HELPER.read_tree({"windows": [self.requested]})["trees"]

        label = trees[0]["root"]["label"]
        self.assertEqual(len(label), HELPER.MAX_TEXT_CHARS)
        # The reply stays well inside what the newline-framed transport accepts.
        self.assertLess(
            len(json.dumps(trees, separators=(",", ":")).encode()), HELPER.SAFE_REPLY_BYTES
        )

    def test_drops_node_text_when_the_whole_reply_would_still_exceed_the_cap(self):
        # Enough nodes that even clamped text sums past the safety threshold:
        # the fallback keeps role, geometry, and shape, dropping free text.
        many = [
            FakeAccessible(f"n{i}", "y" * HELPER.MAX_TEXT_CHARS, width=10, height=10)
            for i in range(2048)
        ]
        self.frame.children = many
        # A threshold the bare node shapes fit under but one clamped label per
        # node blows straight through.
        limit = 512 * 1024
        HELPER.SAFE_REPLY_BYTES = limit
        result = HELPER.read_tree({"windows": [self.requested]})

        root = result["trees"][0]["root"]
        encoded = json.dumps(result, separators=(",", ":")).encode()
        self.assertLessEqual(len(encoded), limit)
        # The window node kept its identity; leaf nodes lost their text.
        self.assertEqual(root["label"], "Terminal")
        self.assertIsNone(root["children"][0]["label"])

    def test_raises_when_even_the_strip_cannot_fit(self):
        HELPER.SAFE_REPLY_BYTES = 16
        with self.assertRaises(RuntimeError) as caught:
            HELPER.read_tree({"windows": [self.requested]})
        self.assertIn("transport limit", str(caught.exception))

    def test_keeps_the_partial_flag_when_stripping_text(self):
        HELPER.SAFE_REPLY_BYTES = 512 * 1024
        self.frame.children = [
            FakeAccessible("n", "y" * HELPER.MAX_TEXT_CHARS, width=10, height=10)
            for _ in range(2048)
        ]
        trees = HELPER.read_tree({"windows": [self.requested]})["trees"]

        result = HELPER.fit_reply({"trees": trees, "partial": True})

        self.assertIs(result["partial"], True)
        self.assertIsNone(result["trees"][0]["root"]["children"][0]["label"])


if __name__ == "__main__":
    unittest.main()
