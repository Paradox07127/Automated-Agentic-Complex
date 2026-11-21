"""Plug-in switches resolved once at daemon startup."""
from infra.plugins_generated import PLUGINS

DEFAULTS = {entry["id"]: entry["default"] for entry in PLUGINS}
resolved = DEFAULTS.copy()


def resolve(enabled, disabled):
    resolved.update({key: key not in disabled and (key in enabled or default) for key, default in DEFAULTS.items()})


def on(plugin_id: str) -> bool:
    return resolved[plugin_id]
