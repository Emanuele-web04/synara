#!/usr/bin/env python3
"""Independent GTK target/guard oracle for an isolated Linux desktop session.

This process observes only its own windows. It does not inject input, inspect
other applications, or certify compositor-wide focus/pointer isolation.
"""

import argparse
import json
import os
from pathlib import Path
import signal
import time

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--role", choices=("target", "human"), required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--windows", type=int, choices=(1, 2), default=2)
    args = parser.parse_args()
    args.state.parent.mkdir(parents=True, exist_ok=True)
    snapshots = {}
    windows = []
    preview_updates = []
    sequence = 0

    def emit(event, label, details=None):
        nonlocal sequence
        sequence += 1
        payload = {
            "schemaVersion": 1,
            "sequence": sequence,
            "monotonicNs": time.monotonic_ns(),
            "pid": os.getpid(),
            "role": args.role,
            "event": event,
            "label": label,
            "windows": snapshots,
        }
        if details is not None:
            payload["details"] = details
        encoded = json.dumps(payload, sort_keys=True)
        temporary = args.state.with_name(args.state.name + ".tmp")
        temporary.write_text(encoded + "\n", encoding="utf-8")
        temporary.replace(args.state)
        print(encoded, flush=True)

    def create_window(index):
        label = chr(ord("A") + index)
        window = Gtk.Window(title=f"Synara Linux Fixture {args.role} {label} {os.getpid()}")
        window.set_default_size(480, 300)
        window.move(30 + index * 540, 30 if args.role == "target" else 400)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18)
        box.set_border_width(24)
        window.add(box)
        heading = Gtk.Label(label=f"{args.role.title()} fixture {label}")
        box.pack_start(heading, False, False, 0)
        entry = Gtk.Entry()
        entry.set_text(f"{args.role}-{label}-original")
        entry.get_accessible().set_name(f"Fixture text {label}")
        box.pack_start(entry, False, False, 0)
        button = Gtk.Button(label="Counter: 0")
        button.get_accessible().set_name(f"Fixture counter {label}")
        box.pack_start(button, False, False, 0)
        snapshots[label] = {
            "title": window.get_title(),
            "text": entry.get_text(),
            "clicks": 0,
            "edits": 0,
            "active": False,
            "visible": False,
            "inputEvents": [],
        }
        state = snapshots[label]

        def changed(_entry):
            state["text"] = entry.get_text()
            state["edits"] += 1
            emit("text-changed", label)

        def clicked(_button):
            state["clicks"] += 1
            button.set_label(f"Counter: {state['clicks']}")
            emit("counter-changed", label)

        def active_changed(_window, _property):
            state["active"] = window.is_active()
            emit("activation-changed", label)

        def input_event(_widget, event):
            record = {"type": int(event.type)}
            if event.type in (Gdk.EventType.KEY_PRESS, Gdk.EventType.KEY_RELEASE):
                record["keyval"] = int(event.keyval)
            else:
                record["x"] = float(event.x)
                record["y"] = float(event.y)
                if event.type != Gdk.EventType.MOTION_NOTIFY:
                    record["button"] = int(event.button)
            state["inputEvents"] = (state["inputEvents"] + [record])[-64:]
            emit("input-observed", label, record)
            return False

        def mapped(_window, _event):
            state["visible"] = True
            emit("mapped", label)
            return False

        def closed(_window, _event):
            Gtk.main_quit()
            return False

        def update_preview():
            # A runner-owned visual change tests capture publication without
            # pretending that native input produced an application effect.
            state["previewRevision"] = state.get("previewRevision", 0) + 1
            heading.set_text(f"{args.role.title()} fixture {label} - preview {state['previewRevision']}")
            emit("fixture-self-update", label)

        preview_updates.append(update_preview)

        entry.connect("changed", changed)
        button.connect("clicked", clicked)
        window.connect("notify::is-active", active_changed)
        window.connect("map-event", mapped)
        window.connect("delete-event", closed)
        window.add_events(
            Gdk.EventMask.BUTTON_PRESS_MASK
            | Gdk.EventMask.BUTTON_RELEASE_MASK
            | Gdk.EventMask.KEY_PRESS_MASK
            | Gdk.EventMask.KEY_RELEASE_MASK
            | Gdk.EventMask.POINTER_MOTION_MASK
        )
        for event_name in (
            "button-press-event", "button-release-event", "key-press-event",
            "key-release-event", "motion-notify-event",
        ):
            window.connect(event_name, input_event)
        window.show_all()
        windows.append(window)

    for index in range(args.windows):
        create_window(index)
    emit("ready", None)
    for signum in (signal.SIGINT, signal.SIGTERM):
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signum, Gtk.main_quit)
    if args.role == "target":
        def update_previews():
            for update in preview_updates:
                update()
            return True
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGUSR1, update_previews)
    Gtk.main()


if __name__ == "__main__":
    main()
