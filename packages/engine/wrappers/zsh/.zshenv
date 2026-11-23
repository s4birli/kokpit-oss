# Kokpit: the first file a Kokpit terminal's zsh reads (the engine starts it with ZDOTDIR pointing here; see
# packages/engine/src/terminal-open.ts). It does two things and then gets out of the way:
#
# 1. Puts ZDOTDIR back to the user's own (KOKPIT_USER_ZDOTDIR; empty = unset, i.e. the home directory) and reads the
#    user's own .zshenv. zsh looks ZDOTDIR up again for every later file, so .zprofile, .zshrc, .zlogin and the
#    history file are the user's, exactly as without Kokpit.
# 2. In an interactive shell: puts Kokpit's `open` (KOKPIT_SHIM_DIR) first on PATH — once, at the first prompt, i.e.
#    after every rc file ran. Setting PATH in the environment is not enough: a login zsh runs macOS `path_helper`,
#    which moves /usr/bin to the front.

if [[ -n "${KOKPIT_USER_ZDOTDIR-}" ]]; then
  export ZDOTDIR="$KOKPIT_USER_ZDOTDIR"
else
  unset ZDOTDIR
fi
unset KOKPIT_USER_ZDOTDIR

if [[ -o interactive && -n "${KOKPIT_SHIM_DIR-}" ]]; then
  _kokpit_shim_path() {
    precmd_functions=(${precmd_functions:#_kokpit_shim_path})
    if [[ -d "$KOKPIT_SHIM_DIR" ]]; then
      path=("$KOKPIT_SHIM_DIR" ${path:#$KOKPIT_SHIM_DIR})
    fi
    unfunction _kokpit_shim_path 2>/dev/null
  }
  typeset -ga precmd_functions
  precmd_functions+=(_kokpit_shim_path)
fi

if [[ -r "${ZDOTDIR:-$HOME}/.zshenv" ]]; then
  source "${ZDOTDIR:-$HOME}/.zshenv"
fi
