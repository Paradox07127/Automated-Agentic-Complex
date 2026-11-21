"""A host's motion request {kind, seconds, geometry} as the Kimodo prompt and constraints of POST /v1/generate.

Geometry is in the rig root frame (Unity left-handed, metres, +z her forward, +x her right hand, yaw degrees toward
+x). to_kimodo maps a point [x, y, z] to Kimodo metres and a yaw in degrees to Kimodo degrees (positive toward her
left); the service takes radians.

sit_loop and sit_exit are asked with the seat as origin: Kimodo moves frame 0's root to x=z=0, so their t=0 Hips sit at
[0, seat height, 0] and sit_exit's root ends at the actor root, minus the seat in Kimodo. The retarget puts them back
on the seat."""
import math
import re

REQUEST_ID = re.compile(r"mr-[0-9a-f]{16}")
KEYS = {"request_id", "behavior_id", "kind", "seconds", "geometry"}
SECONDS = (1, 10)
BEHAVIOR_ID_MAX = 64  # bytes
GEOMETRY = {"turn": {"yaw"}, "walk": {"to", "end_yaw"}, "window_loop": {"hips"}, "sit_enter": {"seat"},
            "sit_loop": {"seat"}, "sit_exit": {"seat"}, "lean": {"hand", "grip"}}
SIDESTEP_MAX = 1.5  # m: longer walks turn, walk and turn back
SLIGHT_TURN = 45  # degrees
WINDOW_HIPS_Y = 1.10  # m in Kimodo: the feet hang 8-13 cm off its ground
SEAT_AT = 2.5  # s: sit_enter has the hips on the seat by then


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _point(value, size):
    return isinstance(value, list) and len(value) == size and all(_number(v) for v in value)


def _geometry(kind, geometry):
    if not isinstance(geometry, dict) or set(geometry) != GEOMETRY[kind]:
        return False
    if kind == "turn":
        return _number(geometry["yaw"]) and abs(geometry["yaw"]) <= 180
    if kind == "walk":
        return _point(geometry["to"], 2) and _number(geometry["end_yaw"]) and abs(geometry["end_yaw"]) <= 180
    if kind == "lean":
        return geometry["hand"] in ("left", "right") and _point(geometry["grip"], 3)
    return _point(next(iter(geometry.values())), 3)


def check(body):
    """Problems with a POST /motions/generate body, [] when it follows the contract."""
    if not isinstance(body, dict) or set(body) != KEYS:
        return [f"the body is exactly {sorted(KEYS)}"]
    problems = []
    if not isinstance(body["request_id"], str) or not REQUEST_ID.fullmatch(body["request_id"]):
        problems.append("request_id is mr- and 16 lowercase hex characters")
    behavior_id = body["behavior_id"]
    if not isinstance(behavior_id, str) or not behavior_id or len(behavior_id.encode()) > BEHAVIOR_ID_MAX:
        problems.append(f"behavior_id is a string of 1-{BEHAVIOR_ID_MAX} bytes")
    if not _number(body["seconds"]) or not SECONDS[0] <= body["seconds"] <= SECONDS[1]:
        problems.append(f"seconds is a number in {SECONDS[0]}-{SECONDS[1]}")
    if body["kind"] not in GEOMETRY:
        problems.append(f"kind is one of {tuple(GEOMETRY)}")
    elif not _geometry(body["kind"], body["geometry"]):
        problems.append(f"{body['kind']} geometry is {sorted(GEOMETRY[body['kind']])} within its limits")
    return problems


def _root(t, x=0, z=0, yaw=0):
    return {"t": t, "x": x, "z": z, "yaw": yaw}


def _side(value):
    """Her side of a Kimodo x or yaw: positive is her left."""
    return "left" if value > 0 else "right"


def _hips(times, pos):
    return [{"joint": "Hips", "t": t, "pos": pos} for t in times]


def build(kind, seconds, geometry, to_kimodo):
    """(prompt, constraints) for one checked request."""
    T = seconds
    if kind == "turn":
        yaw = math.radians(to_kimodo(geometry["yaw"]))
        how = "turns slightly" if abs(geometry["yaw"]) <= SLIGHT_TURN else "turns around"
        return (f"a person {how} to their {_side(yaw)}",
                {"root": [_root(0), _root(0.8 * T, yaw=yaw), _root(T, yaw=yaw)]})
    if kind == "walk":
        x, z = geometry["to"]
        _, _, end_z = end = to_kimodo([x, 0, z])
        end_yaw = math.radians(to_kimodo(geometry["end_yaw"]))
        side = _side(end[0])
        if math.hypot(x, z) <= SIDESTEP_MAX:
            return (f"a person side-steps to the {side} and stops", {"root": [_root(0), _root(T, end[0], end_z, end_yaw)]})
        back = "right" if side == "left" else "left"
        mid_yaw = math.pi / 2 if side == "left" else -math.pi / 2

        def u(f):
            """The share of the line walked by f of T: none during the first turn, all after the last."""
            return min(max((f - 0.1) / 0.8, 0), 1)
        return (f"a person turns to the {side}, walks four steps, then turns {back} to face the front again "
                "and stands still",
                {"root": [_root(0),
                          _root(0.25 * T, end[0] * u(0.25), end_z * u(0.25), mid_yaw),
                          _root(T / 2, end[0] / 2, end_z / 2, mid_yaw),
                          _root(0.75 * T, end[0] * u(0.75), end_z * u(0.75), mid_yaw),
                          _root(T, end[0], end_z, end_yaw)]})
    if kind == "window_loop":
        x, _, z = to_kimodo(geometry["hips"])
        return ("a person sits on the edge of a high table, swinging their legs",
                {"effectors": _hips((0, T / 3, 2 * T / 3, T), [x, WINDOW_HIPS_Y, z])})
    if kind == "lean":
        hand = "RightHand" if geometry["hand"] == "right" else "LeftHand"
        grip = to_kimodo(geometry["grip"])
        times = [float(t) for t in range(1, math.ceil(T))] + [T]
        return (f"a person leans against a wall with their {geometry['hand']} hand",
                {"root": [_root(0)], "effectors": [{"joint": hand, "t": t, "pos": grip} for t in times]})
    seat = to_kimodo(geometry["seat"])
    if kind == "sit_enter":
        return "a person sits down on a stool", {"root": [_root(0)], "effectors": _hips((min(SEAT_AT, T),), seat)}
    on_seat = [0, seat[1], 0]
    if kind == "sit_loop":
        return "a person sits on a stool, shifting slightly", {"effectors": _hips((0, T / 3, 2 * T / 3, T), on_seat)}
    return ("a person stands up from a stool",
            {"root": [_root(T, -seat[0], -seat[2])], "effectors": _hips((0,), on_seat)})


HEADED = ("walk", "turn")  # the kinds heading_problems checks


def heading_problems(kind, seconds, constraints, heading, fps=30):
    """What is wrong with a generated walk's or turn's heading (degrees per frame from frame 0, positive to her left)
    against the yaw of its constraints' root keys; [] when it passes or kind is not in HEADED."""
    if kind not in HEADED:
        return []
    keys = sorted(constraints["root"], key=lambda k: k["t"])
    plan = [(k["t"], math.degrees(k["yaw"])) for k in keys]
    end_yaw, peak, problems = plan[-1][1], max(abs(h) for h in heading), []
    if kind == "walk":
        for t, yaw in plan:
            at = heading[min(round(t * fps), len(heading) - 1)]
            # Only the key at T/2: the thresholds were measured with that inner key alone.
            if abs(t - seconds / 2) <= 1e-6 and abs(at - yaw) > 60:
                problems.append(f"heading {at:.0f}° at {t:g} s is over 60° from {yaw:.0f}°")
        end_limit, peak_limit = 90, max(abs(yaw) for _, yaw in plan) + 110
    else:
        end_limit, peak_limit = 15, abs(end_yaw) + 45
    if abs(heading[-1] - end_yaw) > end_limit:
        problems.append(f"the last heading {heading[-1]:.0f}° is over {end_limit}° from {end_yaw:.0f}°")
    if peak > peak_limit:
        problems.append(f"the heading reaches {peak:.0f}°, over {peak_limit:.0f}°")
    return problems
