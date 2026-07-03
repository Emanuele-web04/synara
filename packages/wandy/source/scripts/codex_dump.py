#!/usr/bin/env python3

from __future__ import annotations

import json
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from mitmproxy import ctx, http


DEFAULT_HOST_PATTERNS = (
    r"(^|\.)chatgpt\.com$",
    r"(^|\.)chat.openai\.com$",
    r"(^|\.)openai\.com$",
)
DEFAULT_PATH_PATTERNS = (
    r"^/backend-api/codex/",
    r"^/backend-api/wham/",
    r"^/backend-api/plugins/",
    r"^/backend-api//connectors/",
)
SENSITIVE_HEADERS = {
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-api-key",
}
SENSITIVE_JSON_KEYS = {
    "authorization",
    "access_token",
    "refresh_token",
    "api_key",
    "bearer_token",
    "cookie",
}
TRUNCATE_PREVIEW_BYTES = 240
SESSION_TEXT_PREVIEW_BYTES = 4000
SESSION_MATCH_WINDOW_SECONDS = 6 * 60 * 60
DEFAULT_SESSION_ROOT = Path.home() / ".codex" / "sessions"
IGNORED_SESSION_TEXT_PREFIXES = (
    "<environment_context>",
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_stem(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-") or "flow"


def _redact_header_value(name: str, value: str) -> str:
    if name.lower() in SENSITIVE_HEADERS:
        return "<redacted>"
    return value


def _redact_json(value: Any) -> Any:
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            if key.lower() in SENSITIVE_JSON_KEYS:
                redacted[key] = "<redacted>"
            else:
                redacted[key] = _redact_json(item)
        return redacted
    if isinstance(value, list):
        return [_redact_json(item) for item in value]
    return value


def _json_preview(value: Any) -> str:
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if len(text) <= TRUNCATE_PREVIEW_BYTES:
        return text
    return text[:TRUNCATE_PREVIEW_BYTES] + "...<truncated>"


def _truncate_text(value: str, limit: int = SESSION_TEXT_PREVIEW_BYTES) -> str:
    if len(value) <= limit:
        return value
    return value[:limit] + "...<truncated>"


def _truncate_nested(value: Any, limit: int = SESSION_TEXT_PREVIEW_BYTES) -> Any:
    if isinstance(value, dict):
        return {key: _truncate_nested(item, limit=limit) for key, item in value.items()}
    if isinstance(value, list):
        return [_truncate_nested(item, limit=limit) for item in value]
    if isinstance(value, str):
        return _truncate_text(value, limit=limit)
    return value


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _extract_text_blocks(content: Any) -> list[str]:
    if isinstance(content, str):
        return [content]
    if not isinstance(content, list):
        return []

    texts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        for key in ("text", "input_text", "output_text"):
            value = item.get(key)
            if isinstance(value, str) and value:
                texts.append(value)
    return texts


class CodexDump:
    def __init__(self) -> None:
        self.output_dir: Path | None = None
        self.host_patterns: list[re.Pattern[str]] = []
        self.path_patterns: list[re.Pattern[str]] = []
        self.include_http = True
        self.include_ws = True
        self.include_local_sessions = True
        self.local_session_root = DEFAULT_SESSION_ROOT
        self.capture_started_at = datetime.now(timezone.utc)
        self._http_counter = 0
        self._ws_counter = 0
        self._ws_files: dict[str, Path] = {}
        self._observed_session_ids: set[str] = set()
        self._observed_prompts: set[str] = set()
        self._local_session_exports: dict[Path, tuple[str, Path]] = {}
        self._local_session_counter = 0

    def load(self, loader) -> None:
        loader.add_option(
            name="codex_dump_dir",
            typespec=str,
            default="",
            help="Directory used to persist captured Codex HTTP and WebSocket traffic.",
        )
        loader.add_option(
            name="codex_dump_hosts",
            typespec=str,
            default=",".join(DEFAULT_HOST_PATTERNS),
            help="Comma-separated regex patterns for host allowlist.",
        )
        loader.add_option(
            name="codex_dump_paths",
            typespec=str,
            default=",".join(DEFAULT_PATH_PATTERNS),
            help="Comma-separated regex patterns for request path allowlist.",
        )
        loader.add_option(
            name="codex_dump_include_http",
            typespec=bool,
            default=True,
            help="Whether to persist matching HTTP request/response flows.",
        )
        loader.add_option(
            name="codex_dump_include_ws",
            typespec=bool,
            default=True,
            help="Whether to persist matching WebSocket messages.",
        )
        loader.add_option(
            name="codex_dump_include_local_sessions",
            typespec=bool,
            default=True,
            help="Whether to export recent ~/.codex/sessions JSONL summaries into the dump directory.",
        )
        loader.add_option(
            name="codex_dump_local_session_root",
            typespec=str,
            default=str(DEFAULT_SESSION_ROOT),
            help="Directory that contains Codex local rollout session JSONL files.",
        )
        loader.add_option(
            name="codex_dump_local_session_window_seconds",
            typespec=int,
            default=SESSION_MATCH_WINDOW_SECONDS,
            help="How far back to scan local session files when exporting summaries.",
        )

    def configure(self, updated) -> None:
        hosts = [item.strip() for item in ctx.options.codex_dump_hosts.split(",") if item.strip()]
        paths = [item.strip() for item in ctx.options.codex_dump_paths.split(",") if item.strip()]
        self.host_patterns = [re.compile(pattern) for pattern in hosts]
        self.path_patterns = [re.compile(pattern) for pattern in paths]
        self.include_http = bool(ctx.options.codex_dump_include_http)
        self.include_ws = bool(ctx.options.codex_dump_include_ws)
        self.include_local_sessions = bool(ctx.options.codex_dump_include_local_sessions)
        self.capture_started_at = datetime.now(timezone.utc)
        self._observed_session_ids.clear()
        self._observed_prompts.clear()
        self._local_session_exports.clear()
        self._local_session_counter = 0
        self._http_counter = 0
        self._ws_counter = 0
        self._ws_files.clear()
        self.local_session_root = Path(ctx.options.codex_dump_local_session_root).expanduser()
        self.local_session_window_seconds = int(ctx.options.codex_dump_local_session_window_seconds)

        if ctx.options.codex_dump_dir:
            base_dir = Path(ctx.options.codex_dump_dir).expanduser()
        else:
            timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            base_dir = Path(tempfile.gettempdir()) / "codex-dumps" / timestamp

        self.output_dir = base_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)
        (self.output_dir / "http").mkdir(exist_ok=True)
        (self.output_dir / "websocket").mkdir(exist_ok=True)
        if self.include_local_sessions:
            (self.output_dir / "local-sessions").mkdir(exist_ok=True)

    def request(self, flow: http.HTTPFlow) -> None:
        if self.include_http and self._matches(flow) and not self._is_ws_upgrade(flow):
            self._persist_http_flow(flow)

    def websocket_start(self, flow: http.HTTPFlow) -> None:
        if not self.include_ws or not self._matches(flow):
            return

        self._ws_counter += 1
        request = flow.request
        self._observe_request_session(request)
        path_stem = _safe_stem(request.path.split("?", 1)[0].strip("/"))
        file_path = self.output_dir / "websocket" / f"{self._ws_counter:03d}-{path_stem}.jsonl"
        self._ws_files[flow.id] = file_path

        metadata = {
            "event": "websocket_start",
            "captured_at": _utc_now(),
            "id": flow.id,
            "request": self._serialize_request(request),
        }
        self._append_jsonl(file_path, metadata)
        ctx.log.info(f"codex_dump websocket -> {file_path}")

    def websocket_message(self, flow: http.HTTPFlow) -> None:
        if not self.include_ws or not self._matches(flow):
            return

        file_path = self._ws_files.get(flow.id)
        if file_path is None:
            self.websocket_start(flow)
            file_path = self._ws_files.get(flow.id)
            if file_path is None:
                return

        message = flow.websocket.messages[-1]
        decoded = self._decode_message(message.content)
        payload = {
            "event": "websocket_message",
            "captured_at": _utc_now(),
            "id": flow.id,
            "from_client": bool(message.from_client),
            "is_text": isinstance(decoded, str),
            "size_bytes": len(message.content),
        }

        if isinstance(decoded, str):
            parsed = self._try_parse_json(decoded)
            if parsed is not None:
                redacted = _redact_json(parsed)
                payload["json"] = redacted
                payload["preview"] = _json_preview(redacted)
                self._observe_ws_payload(redacted)
            else:
                payload["text"] = decoded
                payload["preview"] = decoded[:TRUNCATE_PREVIEW_BYTES]
        else:
            payload["binary_preview_hex"] = decoded[:64].hex()

        self._append_jsonl(file_path, payload)

    def websocket_end(self, flow: http.HTTPFlow) -> None:
        file_path = self._ws_files.pop(flow.id, None)
        if file_path is None:
            return

        payload = {
            "event": "websocket_end",
            "captured_at": _utc_now(),
            "id": flow.id,
            "closed_by_client": getattr(flow.websocket, "closed_by_client", None),
            "close_code": getattr(flow.websocket, "close_code", None),
            "close_reason": getattr(flow.websocket, "close_reason", None),
        }
        self._append_jsonl(file_path, payload)
        self._sync_local_sessions()

    def done(self) -> None:
        self._sync_local_sessions()

    def _matches(self, flow: http.HTTPFlow) -> bool:
        request = flow.request
        host = request.pretty_host or request.host or ""
        path = request.path or ""
        return (
            any(pattern.search(host) for pattern in self.host_patterns)
            and any(pattern.search(path) for pattern in self.path_patterns)
        )

    def _is_ws_upgrade(self, flow: http.HTTPFlow) -> bool:
        upgrade = flow.request.headers.get("upgrade", "")
        connection = flow.request.headers.get("connection", "")
        return "websocket" in upgrade.lower() or "upgrade" in connection.lower()

    def _persist_http_flow(self, flow: http.HTTPFlow) -> None:
        self._http_counter += 1
        request = flow.request
        path_stem = _safe_stem(request.path.split("?", 1)[0].strip("/"))
        file_path = self.output_dir / "http" / f"{self._http_counter:03d}-{request.method.lower()}-{path_stem}.json"

        payload = {
            "captured_at": _utc_now(),
            "id": flow.id,
            "request": self._serialize_request(request),
            "response": self._serialize_response(flow.response),
        }
        file_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        ctx.log.info(f"codex_dump http -> {file_path}")

    def _serialize_request(self, request: http.Request) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "method": request.method,
            "scheme": request.scheme,
            "host": request.pretty_host,
            "port": request.port,
            "path": request.path,
            "pretty_url": request.pretty_url,
            "headers": {
                name: _redact_header_value(name, value) for name, value in request.headers.items(multi=True)
            },
        }
        body = self._decode_message(request.raw_content or b"")
        if isinstance(body, str) and body:
            parsed = self._try_parse_json(body)
            payload["body"] = _redact_json(parsed) if parsed is not None else body
        elif isinstance(body, bytes) and body:
            payload["body_binary_preview_hex"] = body[:64].hex()
        return payload

    def _serialize_response(self, response: http.Response | None) -> dict[str, Any] | None:
        if response is None:
            return None

        payload: dict[str, Any] = {
            "status_code": response.status_code,
            "reason": response.reason,
            "headers": {
                name: _redact_header_value(name, value) for name, value in response.headers.items(multi=True)
            },
        }
        body = self._decode_message(response.raw_content or b"")
        if isinstance(body, str) and body:
            parsed = self._try_parse_json(body)
            payload["body"] = _redact_json(parsed) if parsed is not None else body
        elif isinstance(body, bytes) and body:
            payload["body_binary_preview_hex"] = body[:64].hex()
        return payload

    def _try_parse_json(self, value: str) -> Any | None:
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return None

    def _decode_message(self, content: bytes) -> str | bytes:
        if not content:
            return ""
        try:
            return content.decode("utf-8")
        except UnicodeDecodeError:
            return content

    def _append_jsonl(self, file_path: Path, payload: dict[str, Any]) -> None:
        with file_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")

    def _observe_ws_payload(self, payload: Any) -> None:
        if not isinstance(payload, dict):
            return

        if payload.get("type") == "response.create":
            for prompt in self._extract_observed_prompts(payload):
                normalized = _normalize_text(prompt)
                if normalized:
                    self._observed_prompts.add(normalized)

        if payload.get("type") == "response.completed":
            self._sync_local_sessions()

    def _extract_observed_prompts(self, payload: dict[str, Any]) -> list[str]:
        prompts: list[str] = []
        for item in payload.get("input", []):
            if not isinstance(item, dict):
                continue
            if item.get("type") != "message" or item.get("role") != "user":
                continue
            prompts.extend(_extract_text_blocks(item.get("content")))
        return prompts

    def _sync_local_sessions(self) -> None:
        if not self.include_local_sessions or self.output_dir is None:
            return
        if self.local_session_root is None or not self.local_session_root.exists():
            return

        for session_path in sorted(self.local_session_root.rglob("rollout-*.jsonl")):
            if self._observed_session_ids and not any(session_id in session_path.name for session_id in self._observed_session_ids):
                continue
            try:
                stat = session_path.stat()
            except OSError:
                continue

            age_seconds = (self.capture_started_at.timestamp() - stat.st_mtime)
            if age_seconds > self.local_session_window_seconds:
                continue

            signature = f"{stat.st_mtime_ns}:{stat.st_size}"
            existing = self._local_session_exports.get(session_path)
            if existing is not None and existing[0] == signature:
                continue

            summary = self._summarize_local_session(session_path)
            if summary is None or not self._session_matches_capture(summary):
                continue

            if existing is None:
                self._local_session_counter += 1
                session_id = summary.get("session", {}).get("id") or session_path.stem
                export_path = self.output_dir / "local-sessions" / f"{self._local_session_counter:03d}-{_safe_stem(session_id)}.json"
            else:
                export_path = existing[1]

            export_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            self._local_session_exports[session_path] = (signature, export_path)
            ctx.log.info(f"codex_dump local_session -> {export_path}")

    def _summarize_local_session(self, session_path: Path) -> dict[str, Any] | None:
        try:
            raw_lines = session_path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return None

        session_meta: dict[str, Any] = {}
        user_prompts: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        tool_call_index: dict[str, dict[str, Any]] = {}
        final_answers: list[str] = []

        for raw_line in raw_lines:
            try:
                entry = json.loads(raw_line)
            except json.JSONDecodeError:
                continue

            entry_type = entry.get("type")
            payload = entry.get("payload")

            if entry_type == "session_meta" and isinstance(payload, dict):
                session_meta = {
                    "id": payload.get("id"),
                    "timestamp": payload.get("timestamp"),
                    "cwd": payload.get("cwd"),
                    "originator": payload.get("originator"),
                    "cli_version": payload.get("cli_version"),
                    "source": payload.get("source"),
                    "model_provider": payload.get("model_provider"),
                }
                continue

            if entry_type != "response_item" or not isinstance(payload, dict):
                continue

            payload_type = payload.get("type")

            if payload_type == "message":
                role = payload.get("role")
                texts = _extract_text_blocks(payload.get("content"))
                if role == "user":
                    for text in texts:
                        if not any(text.startswith(prefix) for prefix in IGNORED_SESSION_TEXT_PREFIXES):
                            user_prompts.append(text)
                if role == "assistant" and payload.get("phase") == "final_answer":
                    final_answers.extend(texts)
                continue

            if payload_type == "function_call":
                call = {
                    "timestamp": entry.get("timestamp"),
                    "call_id": payload.get("call_id"),
                    "namespace": payload.get("namespace"),
                    "name": payload.get("name"),
                    "arguments": self._parse_function_arguments(payload.get("arguments")),
                }
                tool_calls.append(call)
                call_id = payload.get("call_id")
                if isinstance(call_id, str) and call_id:
                    tool_call_index[call_id] = call
                continue

            if payload_type == "function_call_output":
                output_summary = {
                    "timestamp": entry.get("timestamp"),
                    "result": self._parse_function_output(payload.get("output")),
                }
                call_id = payload.get("call_id")
                existing_call = tool_call_index.get(call_id) if isinstance(call_id, str) else None
                if existing_call is not None:
                    existing_call["output"] = output_summary
                else:
                    tool_calls.append(
                        {
                            "timestamp": entry.get("timestamp"),
                            "call_id": call_id,
                            "output": output_summary,
                        }
                    )

        unique_prompts = []
        seen_prompts: set[str] = set()
        for prompt in user_prompts:
            normalized = _normalize_text(prompt)
            if not normalized or normalized in seen_prompts:
                continue
            seen_prompts.add(normalized)
            unique_prompts.append(prompt)

        final_answer = "\n".join(text for text in final_answers if text).strip()

        return {
            "captured_at": _utc_now(),
            "source_path": str(session_path),
            "session": session_meta,
            "user_prompts": [_truncate_text(text) for text in unique_prompts],
            "tool_calls": tool_calls,
            "final_answer": _truncate_text(final_answer) if final_answer else None,
        }

    def _session_matches_capture(self, summary: dict[str, Any]) -> bool:
        if self._observed_prompts:
            session_prompts = [_normalize_text(item) for item in summary.get("user_prompts", []) if isinstance(item, str)]
            for session_prompt in session_prompts:
                if not session_prompt:
                    continue
                for observed_prompt in self._observed_prompts:
                    if session_prompt in observed_prompt or observed_prompt in session_prompt:
                        summary["matched_prompt"] = _truncate_text(session_prompt)
                        return True
            return False

        session_meta = summary.get("session")
        if not isinstance(session_meta, dict):
            return False

        session_id = session_meta.get("id")
        if self._observed_session_ids:
            return isinstance(session_id, str) and session_id in self._observed_session_ids

        timestamp = session_meta.get("timestamp")
        if not isinstance(timestamp, str):
            return False

        try:
            session_time = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        except ValueError:
            return False

        delta = abs((session_time - self.capture_started_at).total_seconds())
        return delta <= self.local_session_window_seconds

    def _observe_request_session(self, request: http.Request) -> None:
        for header_name in ("session_id", "x-client-request-id"):
            value = request.headers.get(header_name)
            if isinstance(value, str) and value:
                self._observed_session_ids.add(value)

        metadata = request.headers.get("x-codex-turn-metadata")
        if not isinstance(metadata, str) or not metadata:
            return

        parsed = self._try_parse_json(metadata)
        if not isinstance(parsed, dict):
            return

        session_id = parsed.get("session_id")
        if isinstance(session_id, str) and session_id:
            self._observed_session_ids.add(session_id)

    def _parse_function_arguments(self, arguments: Any) -> Any:
        if not isinstance(arguments, str):
            return _truncate_nested(_redact_json(arguments))
        parsed = self._try_parse_json(arguments)
        if parsed is not None:
            return _truncate_nested(_redact_json(parsed))
        return _truncate_text(arguments)

    def _parse_function_output(self, output: Any) -> Any:
        if not isinstance(output, str):
            return _truncate_nested(_redact_json(output))

        match = re.match(r"^Wall time:\s*([0-9.]+)\s+seconds\nOutput:\n(.*)$", output, flags=re.DOTALL)
        if match is None:
            return {"text": _truncate_text(output)}

        result: dict[str, Any] = {
            "wall_time_seconds": float(match.group(1)),
        }
        body = match.group(2)
        parsed = self._try_parse_json(body)
        if parsed is not None:
            result["output"] = _truncate_nested(_redact_json(parsed))
        else:
            result["text"] = _truncate_text(body)
        return result


addons = [CodexDump()]
