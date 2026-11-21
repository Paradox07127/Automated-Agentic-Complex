"""GET/PUT /motion/settings, POST /motions/generate and GET /motions/<id>/meta|keys|tracks; server.motion is the
Performer."""
from character.binding import effective
from motion import requests
from route_registry import MOTION_FILE_PATH, MOTION_TRACKS_PATH


def _bytes(h, data, content_type):
    h.send_response(200)
    h.send_header("Content-Type", content_type)
    h.send_header("Cache-Control", "no-store")
    h.send_header("Content-Length", str(len(data)))
    h.end_headers()
    h.wfile.write(data)


def _generate(h, motion):
    try:
        body = h.body()
    except ValueError:
        body = None
    if requests.check(body):
        h.json(400, {"error": "invalid_motion_request"})
    elif effective(h.server)["motion"]["driver"] != "generated":
        motion.refuse(body, "game_backend")
        h.json(409, {"error": "motion_backend_game"})
    elif motion.settings.service_url is None:
        motion.refuse(body, "no_service")
        h.json(409, {"error": "no_service"})
    else:
        motion.request(body)
        h.json(202, {"request_id": body["request_id"]})


def route(h, method, path):
    motion = getattr(h.server, "motion", None)
    file = MOTION_FILE_PATH.fullmatch(path)
    tracks = MOTION_TRACKS_PATH.fullmatch(path)
    if path not in ("/motion/settings", "/motions/generate") and file is None and tracks is None:
        return False
    if motion is None:
        h.json(503, {"error": "no_motion"})
    elif path == "/motions/generate":
        _generate(h, motion)
    elif tracks is not None:
        found = motion.store.get(tracks[1])
        if found is None or found[2] is None:
            h.json(404, {"error": "unknown_tracks"})
        else:
            _bytes(h, found[2], "application/json")
    elif file is not None:
        found = motion.store.get(file[1])
        if found is None:
            h.json(404, {"error": "unknown_motion"})
        elif file[2] == "meta":
            _bytes(h, found[0], "application/json")
        else:
            _bytes(h, found[1], "application/octet-stream")
    elif method == "GET":
        h.json(200, motion.settings.public())
    else:
        try:
            body = h.body()
        except ValueError:
            body = None
        was = motion.settings.backend
        status, reply = motion.settings.update(body)
        if status == 200 and motion.settings.backend != was and h.server.mouth is not None:
            # the motion marker rule is in or out of the prompt from the next turn
            h.server.mouth.refresh_system(effective(h.server))
        if status == 200:
            motion.prewarm(effective(h.server)["motion"]["driver"])
        h.json(status, reply)
    return True
