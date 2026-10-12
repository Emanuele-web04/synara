"""Verify actual fourth-session native input/output in the completed run's wire log."""
from pathlib import Path
import hashlib
import json
import sqlite3

report_path = Path("docs/verification/parallel-run-native-three-report.json")
report = json.loads(report_path.read_text())
connection = sqlite3.connect(Path(report["home"]) / "userdata/state.sqlite")
sessions = connection.execute("select thread_id,resume_cursor_json from provider_session_runtime").fetchall()
assert len(sessions) == 4
native_ids = [json.loads(cursor)["openCodeSessionId"] for _, cursor in sessions]
assert len(set(native_ids)) == 4
comparison_id = next(turn["thread_id"] for turn in report["turns"] if not turn["thread_id"].startswith("parallel-"))
native_id = next(json.loads(cursor)["openCodeSessionId"] for thread_id, cursor in sessions if thread_id == comparison_id)
wire = Path(report["home"]) / "userdata/logs/provider" / (comparison_id + ".log")
events = []
for line in wire.read_text().splitlines():
    if "NTIVE:" not in line:
        continue
    events.append(json.loads(line[line.index("{"):])["event"])
roles = {}
parts = {}
for event in events:
    assert event["providerThreadId"] == native_id
    raw = event["payload"]
    properties = raw.get("properties", {})
    info = properties.get("info", {})
    if raw["type"] == "message.updated" and "role" in info:
        roles[info["id"]] = info["role"]
    part = properties.get("part", {})
    if raw["type"] == "message.part.updated" and part.get("type") == "text":
        parts[part["id"]] = part
native_user = "".join(part["text"] for part in parts.values() if roles.get(part["messageID"]) == "user")
native_answer = "".join(part["text"] for part in parts.values() if roles.get(part["messageID"]) == "assistant")
canonical_user = connection.execute("select text from projection_thread_messages where thread_id=? and role='user'", (comparison_id,)).fetchone()[0]
canonical_answer = connection.execute("select text from projection_thread_messages where thread_id=? and role='assistant'", (comparison_id,)).fetchone()[0]
assert canonical_user.startswith("Compare these independent attempts at the same task.")
assert canonical_user in native_user
assert native_answer == canonical_answer and len(native_answer) > 0
connection.close()
report["comparisonNativeIntegrity"] = {
    "threadId": comparison_id, "nativeSessionId": native_id,
    "fourDistinctNativeSessions": True,
    "actualNativeComparisonPromptVerified": True,
    "actualNativeUserTextSha256": hashlib.sha256(native_user.encode()).hexdigest(),
    "nativeAnswer": native_answer, "synaraAnswer": canonical_answer,
}
report_path.write_text(json.dumps(report, indent=2) + "\n")
print("PASS_FOURTH_NATIVE_SESSION_INTEGRITY", native_id)
