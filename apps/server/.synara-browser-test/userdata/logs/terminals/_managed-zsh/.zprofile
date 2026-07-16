# Synara zsh profile wrapper
_synara_home="${SYNARA_ORIGINAL_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_synara_home"
[[ -f "$_synara_home/.zprofile" ]] && source "$_synara_home/.zprofile"
export ZDOTDIR='/Users/emanueledipietro/.codex/worktrees/c73c/synara/apps/server/.synara-browser-test/userdata/logs/terminals/_managed-zsh'
