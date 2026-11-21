"""The local time as prompts read it."""

WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def local_time(now):
    """An aware datetime as the prompts read it: date, time, weekday and UTC offset."""
    offset = now.strftime("%z")
    return f"{now:%Y-%m-%d %H:%M} {WEEKDAYS[now.weekday()]} (UTC{offset[:3]}:{offset[3:]})"
