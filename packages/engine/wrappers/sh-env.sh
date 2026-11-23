# Kokpit: read by an interactive POSIX sh when it starts (the engine sets ENV to this file in Kokpit terminals whose
# shell is `sh`; see packages/engine/src/terminal-open.ts). A login sh runs macOS `path_helper`, which moves /usr/bin
# to the front of PATH; this puts Kokpit's `open` (KOKPIT_SHIM_DIR) first again.
case ":${PATH:-}" in
  ":${KOKPIT_SHIM_DIR:-}:"*) ;;
  *)
    if [ -n "${KOKPIT_SHIM_DIR:-}" ] && [ -d "$KOKPIT_SHIM_DIR" ]; then
      PATH="$KOKPIT_SHIM_DIR:${PATH:-}"
      export PATH
    fi
    ;;
esac
