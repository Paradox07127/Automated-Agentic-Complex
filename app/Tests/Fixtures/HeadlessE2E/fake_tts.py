#!/usr/bin/env -S python3 -I
"""Fake TTS service: POST /speech_stream replays the C2 ok-basic example with the request's speech_id.

usage: fake_tts.py --port-file F --log L   (listens on 127.0.0.1:0; F gets the port, L one JSON line per request)
"""
import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

EXAMPLE = Path(__file__).resolve().parents[4] / "protocol/C2-speech-stream/examples/ok-basic.ndjson"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        with self.server.lock, open(self.server.log, "a") as f:
            f.write(json.dumps({"path": self.path, "authorization": self.headers.get("Authorization"), "body": body}) + "\n")
        if self.path != "/speech_stream":
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.end_headers()
        for line in EXAMPLE.read_text().splitlines():
            event = json.loads(line)
            if "speech_id" in body:
                event["speech_id"] = body["speech_id"]
            self.wfile.write((json.dumps(event, ensure_ascii=False) + "\n").encode())
            self.wfile.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port-file", required=True)
    parser.add_argument("--log", required=True)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.lock, server.log = threading.Lock(), args.log
    port_file = Path(args.port_file)
    tmp = port_file.with_name(port_file.name + ".tmp")
    tmp.write_text(str(server.server_address[1]))
    os.replace(tmp, port_file)
    server.serve_forever()


if __name__ == "__main__":
    main()
