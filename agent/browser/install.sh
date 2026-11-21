#!/bin/sh
# Writes the Chrome Native Messaging host files outside the repo. Run only after the user agreed.
# Usage: install.sh [state-dir]   (default: ~/Library/Application Support/AgenticComplex/agentd)
set -eu
STATE_DIR="${1:-$HOME/Library/Application Support/AgenticComplex/agentd}"
HERE=$(cd "$(dirname "$0")" && pwd)
PY="$HERE/../.venv/bin/python"
read -r EXT_ORIGIN < "$HERE/extension-origin"
HOSTS="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
WRAPPER="$STATE_DIR/native-host.sh"
MANIFEST="$HOSTS/local.agenticcomplex.agentd.json"
mkdir -p "$HOSTS" "$STATE_DIR"
cat > "$WRAPPER" <<SH
#!/bin/sh
exec "$PY" -I "$HERE/native_host.py" --state-dir "$STATE_DIR" "\$@"
SH
chmod 700 "$WRAPPER"
cat > "$MANIFEST" <<JSON
{
  "name": "local.agenticcomplex.agentd",
  "description": "Agentic Complex agentd browser bridge",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": ["$EXT_ORIGIN"]
}
JSON
echo "wrote $WRAPPER"
echo "wrote $MANIFEST"
