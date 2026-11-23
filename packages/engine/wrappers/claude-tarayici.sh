#!/bin/sh
# Kokpit "Claude + browser": starts Claude Code with the project's Chrome attached through Playwright MCP.
# Typed into the project's terminal by the tool command in tools.defaults.json, which sets:
#   KOKPIT_MCP_PACKAGE     exact npm spec of the Playwright MCP server, e.g. @playwright/mcp@0.0.84
#   KOKPIT_BROWSER_WAIT_S  seconds to wait for the project's browser (the engine starts it with the terminal)
# KOKPIT_CDP_URL comes from the engine (only in local terminals of projects whose browser runs on the Mac mini).
# Arguments are passed on to claude. The MCP config is built here, not left to claude to expand, so the
# endpoint is the terminal's real value; --mcp-config is variadic, so it goes last.
set -eu

fail() {
  printf 'kokpit: %s\n' "$1" >&2
  exit 2
}

case "${KOKPIT_MCP_PACKAGE:-}" in
  "" | -* | *[!A-Za-z0-9@._/-]*) fail "KOKPIT_MCP_PACKAGE geçersiz: '${KOKPIT_MCP_PACKAGE:-}'" ;;
esac
case "${KOKPIT_BROWSER_WAIT_S:-}" in
  "" | *[!0-9]*) fail "KOKPIT_BROWSER_WAIT_S geçersiz: '${KOKPIT_BROWSER_WAIT_S:-}'" ;;
esac

url=${KOKPIT_CDP_URL:-}
if [ -z "$url" ]; then
  fail "Bu terminalde KOKPIT_CDP_URL yok: tarayıcı yalnız Mac mini'de çalışan projelerde ajana bağlanır (SSH projesi ya da tarayıcısı uygulamanın bilgisayarında açılan proje değil)."
fi
# Loopback DevTools only, as the engine hands it out: http://127.0.0.1:<port>.
port=${url#http://127.0.0.1:}
case "$port" in
  "$url" | "" | *[!0-9]* | ??????*) fail "KOKPIT_CDP_URL beklenmeyen biçimde: '$url'" ;;
esac
[ "$port" -ge 1 ] && [ "$port" -le 65535 ] || fail "KOKPIT_CDP_URL portu geçersiz: '$url'"

up() {
  curl -fsS -o /dev/null --max-time 1 "$url/json/version" 2>/dev/null
}
waited=0
until up; do
  if [ "$waited" -ge "$KOKPIT_BROWSER_WAIT_S" ]; then
    printf '%s\n' "Önce Tarayıcı panelinden tarayıcıyı aç. Claude yine de açılıyor; tarayıcı açılınca ilk tarayıcı komutunda bağlanır." >&2
    break
  fi
  sleep 1
  waited=$((waited + 1))
done

# Playwright MCP writes snapshots into its working directory (the project / card worktree) unless told otherwise;
# untracked files there would make the card "dirty" and block deleting it. Use the project's own output folder the
# engine put in this terminal (PLAYWRIGHT_MCP_OUTPUT_DIR; the engine deletes old files there), else the per-user
# temp dir.
out=${PLAYWRIGHT_MCP_OUTPUT_DIR:-}
case "$out" in
  /*) ;;
  *) out="" ;;
esac
case "$out" in
  *[!A-Za-z0-9._/-]* | */../* | */..) out="" ;;
esac
if [ -z "$out" ]; then
  tmp=${TMPDIR:-}
  case "$tmp" in
    /*) ;;
    *) fail "TMPDIR yok ya da mutlak değil; Playwright çıktısı proje klasörüne yazılmasın diye durduruldu." ;;
  esac
  case "$tmp" in
    *[!A-Za-z0-9._/-]*) fail "TMPDIR beklenmeyen karakter içeriyor: '$tmp'" ;;
  esac
  out="${tmp%/}/kokpit-playwright-mcp"
fi

config=$(printf '{"mcpServers":{"kokpit-tarayici":{"type":"stdio","command":"npx","args":["-y","%s","--cdp-endpoint","%s","--output-dir","%s"]}}}' "$KOKPIT_MCP_PACKAGE" "$url" "$out")
exec claude "$@" --mcp-config "$config"
