# Synara zsh rc wrapper
_t3code_home="${T3CODE_ORIGINAL_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_t3code_home"
[[ -f "$_t3code_home/.zshrc" ]] && source "$_t3code_home/.zshrc"
export ZDOTDIR='/Users/emanueledipietro/Developer/Testing/t3code/.synara/electron-dev/dev/logs/terminals/_managed-zsh'
if [ -n "${T3CODE_MANAGED_BIN_DIR:-}" ] && [ -d "${T3CODE_MANAGED_BIN_DIR}" ]; then
  case ":$PATH:" in
    *:${T3CODE_MANAGED_BIN_DIR}:*) ;;
    *) export PATH="${T3CODE_MANAGED_BIN_DIR}:$PATH" ;;
  esac
  unalias claude 2>/dev/null || true
  claude() {
    if [ -x "${T3CODE_MANAGED_BIN_DIR}/claude" ] && [ ! -d "${T3CODE_MANAGED_BIN_DIR}/claude" ]; then
      "${T3CODE_MANAGED_BIN_DIR}/claude" "$@"
    else
      command claude "$@"
    fi
  }
  unalias codex 2>/dev/null || true
  codex() {
    if [ -x "${T3CODE_MANAGED_BIN_DIR}/codex" ] && [ ! -d "${T3CODE_MANAGED_BIN_DIR}/codex" ]; then
      "${T3CODE_MANAGED_BIN_DIR}/codex" "$@"
    else
      command codex "$@"
    fi
  }
  typeset -ga precmd_functions 2>/dev/null || true
  _t3code_ensure_managed_bin() {
    case ":$PATH:" in
      *:${T3CODE_MANAGED_BIN_DIR}:*) ;;
      *) PATH="${T3CODE_MANAGED_BIN_DIR}:$PATH" ;;
    esac
  }
  {
    precmd_functions=(${precmd_functions:#_t3code_ensure_managed_bin} _t3code_ensure_managed_bin)
  } 2>/dev/null || true
fi
