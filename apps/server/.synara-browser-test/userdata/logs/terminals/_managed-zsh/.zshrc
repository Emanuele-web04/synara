# Synara zsh rc wrapper
_synara_home="${SYNARA_ORIGINAL_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_synara_home"
[[ -f "$_synara_home/.zshrc" ]] && source "$_synara_home/.zshrc"
export ZDOTDIR='/Users/emanueledipietro/.codex/worktrees/c73c/synara/apps/server/.synara-browser-test/userdata/logs/terminals/_managed-zsh'
if [ -n "${SYNARA_MANAGED_BIN_DIR:-}" ] && [ -d "${SYNARA_MANAGED_BIN_DIR}" ]; then
  case ":$PATH:" in
    *:${SYNARA_MANAGED_BIN_DIR}:*) ;;
    *) export PATH="${SYNARA_MANAGED_BIN_DIR}:$PATH" ;;
  esac
  unalias claude 2>/dev/null || true
  claude() {
    if [ -x "${SYNARA_MANAGED_BIN_DIR}/claude" ] && [ ! -d "${SYNARA_MANAGED_BIN_DIR}/claude" ]; then
      "${SYNARA_MANAGED_BIN_DIR}/claude" "$@"
    else
      command claude "$@"
    fi
  }
  unalias codex 2>/dev/null || true
  codex() {
    if [ -x "${SYNARA_MANAGED_BIN_DIR}/codex" ] && [ ! -d "${SYNARA_MANAGED_BIN_DIR}/codex" ]; then
      "${SYNARA_MANAGED_BIN_DIR}/codex" "$@"
    else
      command codex "$@"
    fi
  }
  typeset -ga precmd_functions 2>/dev/null || true
  _synara_ensure_managed_bin() {
    case ":$PATH:" in
      *:${SYNARA_MANAGED_BIN_DIR}:*) ;;
      *) PATH="${SYNARA_MANAGED_BIN_DIR}:$PATH" ;;
    esac
  }
  {
    precmd_functions=(${precmd_functions:#_synara_ensure_managed_bin} _synara_ensure_managed_bin)
  } 2>/dev/null || true
fi
