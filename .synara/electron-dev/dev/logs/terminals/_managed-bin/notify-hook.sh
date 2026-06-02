#!/bin/sh
set -eu
if [ "$#" -gt 0 ]; then
  _t3code_hook_input="$1"
else
  _t3code_hook_input="$(cat)"
fi

_t3code_extract_event() {
  printf '%s' "$_t3code_hook_input" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1
}

_t3code_event="$(_t3code_extract_event hook_event_name)"
if [ -z "$_t3code_event" ]; then
  _t3code_type="$(_t3code_extract_event type)"
  case "$_t3code_type" in
    task_started|userPromptSubmitted|user_prompt_submit)
      _t3code_event="Start"
      ;;
    task_complete|agent-turn-complete|stop|session_end|sessionEnd)
      _t3code_event="Stop"
      ;;
    exec_approval_request|apply_patch_approval_request|request_user_input)
      _t3code_event="PermissionRequest"
      ;;
  esac
fi

_t3code_emit_osc() {
  _t3code_sequence="$1"
  if [ -w /dev/tty ]; then
    printf '%b' "$_t3code_sequence" > /dev/tty 2>/dev/null || printf '%b' "$_t3code_sequence"
    return
  fi
  printf '%b' "$_t3code_sequence"
}

case "$_t3code_event" in
  UserPromptSubmit|PostToolUse|PostToolUseFailure|Start)
    _t3code_emit_osc '\033]633;T3CODE_AGENT_EVENT=Start\007'
    ;;
  Stop)
    _t3code_emit_osc '\033]633;T3CODE_AGENT_EVENT=Stop\007'
    ;;
  PermissionRequest|PreToolUse|Notification)
    _t3code_emit_osc '\033]633;T3CODE_AGENT_EVENT=PermissionRequest\007'
    ;;
esac
