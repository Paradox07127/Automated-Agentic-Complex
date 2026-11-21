"""Closed interaction presets: background model cadence, speech gate and autonomous motion only.

Direct requests, local reflexes, stop/drag handling, output token limits and model selection do not change.
"""
from dataclasses import asdict, dataclass
from types import MappingProxyType


@dataclass(frozen=True)
class InteractionPreset:
    name: str
    model_every: float
    model_refresh: float
    proactive_speech: bool
    same_cooldown: float
    random_tick_scale: float
    wander_scale: float
    focus_walk_probability: float

    def describe(self):
        return asdict(self)


PRESETS = MappingProxyType({
    "quiet": InteractionPreset("quiet", 600.0, 1800.0, False, 600.0, 2.0, 2.0, .15),
    "balanced": InteractionPreset("balanced", 180.0, 900.0, True, 600.0, 1.0, 1.0, .5),
    "active": InteractionPreset("active", 120.0, 600.0, True, 300.0, .75, .75, .65),
})


def preset(name="balanced"):
    try:
        return PRESETS[name]
    except (KeyError, TypeError):
        raise ValueError(f"unknown interaction preset: {name!r}") from None
