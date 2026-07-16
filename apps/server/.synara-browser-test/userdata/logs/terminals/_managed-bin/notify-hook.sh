#!/bin/sh
set -eu
if [ "$#" -gt 0 ]; then
  _synara_hook_input="$1"
else
  _synara_hook_input="$(cat)"
fi

_synara_extract_event() {
  printf '%s' "$_synara_hook_input" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1
}

_synara_event="$(_synara_extract_event hook_event_name)"
if [ -z "$_synara_event" ]; then
  _synara_type="$(_synara_extract_event type)"
  case "$_synara_type" in
    task_started|userPromptSubmitted|user_prompt_submit)
      _synara_event="Start"
      ;;
    task_complete|agent-turn-complete|stop|session_end|sessionEnd)
      _synara_event="Stop"
      ;;
    exec_approval_request|apply_patch_approval_request|request_user_input)
      _synara_event="PermissionRequest"
      ;;
  esac
fi

_synara_emit_osc() {
  _synara_sequence="$1"
  if [ -w /dev/tty ]; then
    printf '%b' "$_synara_sequence" > /dev/tty 2>/dev/null || printf '%b' "$_synara_sequence"
    return
  fi
  printf '%b' "$_synara_sequence"
}

case "$_synara_event" in
  UserPromptSubmit|PostToolUse|PostToolUseFailure|Start)
    _synara_emit_osc '\033]633;SYNARA_AGENT_EVENT=Start\007'
    ;;
  Stop)
    _synara_emit_osc '\033]633;SYNARA_AGENT_EVENT=Stop\007'
    ;;
  PermissionRequest|PreToolUse|Notification)
    _synara_emit_osc '\033]633;SYNARA_AGENT_EVENT=PermissionRequest\007'
    ;;
esac
