#!/usr/bin/env -S python3 -I
"""Headless stand-in for the avatar host that speaks C3 over --agentic-complex-host-socket.

It lists `heartbeat` and `ack`, as both renderers do, and acks every command with a `req`.
Faults: <support>/run/e2e-host-faults.json maps a launch number ("1", "2", ...) or "*" to
{"exit_after_s", "exit_status", "silent_after_s", "fail_switch", "placement"}. "placement" ({"x", "y", "scale",
"display_id"}, its x, y and scale replaced by --agentic-complex-placement when given) lists the capability `placement`,
reports a `window_frame` and that placement after the hello, and applies each `set_placement` and reports it. "looks"
({"appearances", "layers"}, C3's lists) lists `layers` and `mod_settings`, reports the appearance and hidden layers
it was launched or switched with, and answers `set_appearance`, `set_layers` and `set_mod_settings` (every switch taken as
given). Each launch
appends a line with its arguments to <support>/run/e2e-host-launches.jsonl and its C3 traffic, heartbeats left out, to
<support>/run/e2e-host-<pid>.jsonl.
"""
import argparse
import json
import os
from pathlib import Path
import select
import socket
import sys
import threading
import time


def watch_parent(pid):
    if os.getppid() != pid:
        os._exit(0)
    kq = select.kqueue()
    event = select.kevent(pid, filter=select.KQ_FILTER_PROC,
                          flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT, fflags=select.KQ_NOTE_EXIT)
    try:
        kq.control([event], 0, 0)
    except ProcessLookupError:
        os._exit(0)
    # The parent may have exited between the getppid check and registration.
    if os.getppid() != pid:
        os._exit(0)
    threading.Thread(target=lambda: (kq.control(None, 1, None), os._exit(0)), daemon=True).start()


def write_status(path, character, stage):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps({"schema": "endfield-startup/v1", "pid": os.getpid(), "character": character, "stage": stage}))
    os.replace(tmp, path)


def launch_faults(run):
    with open(run / "e2e-host-launches.jsonl", "a+") as f:
        f.seek(0)
        number = len(f.readlines()) + 1
        f.write(json.dumps({"launch": number, "pid": os.getpid(), "argv": sys.argv[1:]}) + "\n")
    try:
        faults = json.loads((run / "e2e-host-faults.json").read_text())
    except FileNotFoundError:
        return {}
    return faults.get(str(number), faults.get("*", {}))


def connect(path):
    # C3: retry every 0.5 s, give up after 10 s.
    deadline = time.monotonic() + 10
    while True:
        s = socket.socket(socket.AF_UNIX)
        try:
            s.connect(path)
            return s
        except OSError:
            s.close()
            if time.monotonic() >= deadline:
                return None
            time.sleep(0.5)


class Host:
    def __init__(self, sock, character, faults, transcript, viewport="window", placement=None, appearance=None, hidden=None):
        self.sock, self.character, self.faults = sock, character, faults
        self.transcript = open(transcript, "a", buffering=1)
        self.lock = threading.Lock()
        self.silent_at = None
        self.viewport, self.placement = viewport, placement
        self.looks = faults.get("looks")
        if self.looks:
            ids = [a["id"] for a in self.looks["appearances"]]
            self.appearance = appearance if appearance in ids else ids[0]
            layers = [l["id"] for l in self.looks["layers"]]
            self.hidden = [h for h in hidden or [] if h in layers]

    def look_fields(self):
        if not self.looks:
            return {}
        return {"appearance": self.appearance, "appearances": self.looks["appearances"], "layers": self.looks["layers"],
                "hidden_layers": self.hidden}

    def record(self, direction, message):
        if message.get("type") != "heartbeat":
            self.transcript.write(json.dumps({"t": time.time(), "dir": direction, "msg": message}) + "\n")

    def send(self, message):
        message = {"v": 1, **message}
        with self.lock:
            if self.silent_at is not None and time.monotonic() >= self.silent_at:
                return
            self.record("a2c", message)
            try:
                self.sock.sendall((json.dumps(message) + "\n").encode())
            except OSError:
                os._exit(0)

    def heartbeats(self):
        seq = 0
        while True:
            self.send({"type": "heartbeat", "seq": seq, "click_through": True})
            seq += 1
            time.sleep(0.1)

    def report_placement(self, reason):
        p = self.placement
        if self.viewport == "fullscreen":
            frame = {"x": 0, "y": 0, "w": 1440, "h": 875}
        else:
            frame = {"x": p["x"] - 270 * p["scale"], "y": p["y"], "w": 540 * p["scale"], "h": 780 * p["scale"]}
        self.send({"type": "window_frame", "frame": frame, "scale": 2, "window_number": 1, "viewport": self.viewport,
                   "display_id": p["display_id"]})
        self.send({"type": "placement", **p, "reason": reason})

    def run(self):
        self.send({"type": "hello", "role": "avatar", "pid": os.getpid(), "protocol": 1, "character": self.character,
                   "capabilities": ["heartbeat", "ack"] + (["placement"] if self.placement else [])
                   + (["layers", "mod_settings"] if self.looks else []), **self.look_fields()})
        if self.placement:
            self.report_placement("start")
        if "silent_after_s" in self.faults:
            self.silent_at = time.monotonic() + self.faults["silent_after_s"]
        threading.Thread(target=self.heartbeats, daemon=True).start()
        handshaken = False
        for line in self.sock.makefile("rb"):
            try:
                m = json.loads(line)
            except ValueError:
                continue
            self.record("c2a", m)
            kind = m.get("type")
            if kind == "hello":
                handshaken = True
            elif not handshaken:
                continue
            elif kind == "quit":
                break
            elif kind == "set_placement" and self.placement:
                self.send({"type": "ack", "req": m["req"], "ok": True})
                if "x" in m:
                    self.placement.update(x=m["x"], y=m["y"])
                if "scale" in m:
                    self.placement["scale"] = m["scale"]
                self.report_placement("set_placement")
            elif kind == "set_character":
                if self.faults.get("fail_switch"):
                    self.send({"type": "character_change_failed", "id": m["id"], "reason": "load_failed"})
                else:
                    ms = 0 if m["id"] == self.character else 100
                    self.character = m["id"]
                    if self.looks:
                        ids = [a["id"] for a in self.looks["appearances"]]
                        self.appearance = m.get("appearance") if m.get("appearance") in ids else ids[0]
                        self.hidden = [h for h in m.get("hidden_layers", []) if h in [l["id"] for l in self.looks["layers"]]]
                    self.send({"type": "character_changed", "id": m["id"], "ms": ms, **self.look_fields()})
            elif kind == "set_appearance" and self.looks:
                if m["id"] in [a["id"] for a in self.looks["appearances"]]:
                    self.appearance = m["id"]
                    self.send({"type": "appearance_changed", "id": m["id"]})
                else:
                    self.send({"type": "appearance_change_failed", "id": m["id"], "reason": "unknown_appearance"})
            elif kind == "set_layers" and self.looks:
                if all(h in [l["id"] for l in self.looks["layers"]] for h in m["hidden"]):
                    self.hidden = m["hidden"]
                    self.send({"type": "layers_changed", "hidden": self.hidden})
                else:
                    self.send({"type": "layers_change_failed", "hidden": m["hidden"], "reason": "unknown_layer"})
            elif kind == "set_mod_settings" and self.looks:
                self.send({"type": "ack", "req": m["req"], "ok": True})
                self.send({"type": "mod_settings", "req": m["req"], "character": m["character"], "appearance": m["appearance"],
                           "values": m["values"]})
            elif "req" in m:
                self.send({"type": "ack", "req": m["req"], "ok": True})
        # C3: EOF counts as quit.
        os._exit(0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--agentic-complex-parent-pid", type=int)
    parser.add_argument("--agentic-complex-character", default="aster")
    parser.add_argument("--agentic-complex-startup-status", required=True)
    parser.add_argument("--agentic-complex-host-socket")
    parser.add_argument("--agentic-complex-viewport", default="window")
    parser.add_argument("--agentic-complex-placement")
    parser.add_argument("--agentic-complex-appearance")
    parser.add_argument("--agentic-complex-hidden-layers", default="")
    args, _ = parser.parse_known_args()
    if args.agentic_complex_parent_pid is not None:
        watch_parent(args.agentic_complex_parent_pid)
    status = Path(args.agentic_complex_startup_status)
    run = status.parent
    faults = launch_faults(run)
    if "exit_after_s" in faults:
        status_code = faults.get("exit_status", 1)
        threading.Timer(faults["exit_after_s"], lambda: os._exit(status_code)).start()
    write_status(status, args.agentic_complex_character, "loading_character")
    write_status(status, args.agentic_complex_character, "ready")
    sock = connect(args.agentic_complex_host_socket) if args.agentic_complex_host_socket else None
    if sock is None:
        threading.Event().wait()
    placement = faults.get("placement")
    if placement is not None and args.agentic_complex_placement:
        x, y, scale = (float(v) for v in args.agentic_complex_placement.split(","))
        placement = {**placement, "x": x, "y": y, "scale": scale}
    Host(sock, args.agentic_complex_character, faults, run / f"e2e-host-{os.getpid()}.jsonl", args.agentic_complex_viewport,
         placement, args.agentic_complex_appearance, [h for h in args.agentic_complex_hidden_layers.split(",") if h]).run()


if __name__ == "__main__":
    main()
