"""A fake C3 renderer for character switch tests: hello with its character, then one reply per set_character as
C3 rule 14 says (same id -> changed at once; a request during a switch fails with switching; a failed load keeps
the old character)."""
import json
import socket
import threading
import time


class FakeAvatar:
    def __init__(self, path, character, known=("aster", "birch"), fail=(), switch_s=0.2):
        """known: ids with a pack; fail: known ids whose load fails; switch_s: fade out + load + fade in."""
        self.character, self.known, self.fail, self.switch_s = character, set(known), set(fail), switch_s
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(path)
        self._lock = threading.Lock()
        self._switching = False
        self.send({"v": 1, "type": "hello", "role": "avatar", "pid": 4242, "protocol": 1, "character": character})
        threading.Thread(target=self._read, daemon=True).start()

    def send(self, message):
        with self._lock:
            self.sock.sendall((json.dumps(message) + "\n").encode())

    def close(self):
        self.sock.close()

    def _read(self):
        pending = b""
        while True:
            try:
                chunk = self.sock.recv(65536)
            except OSError:
                return
            if not chunk:
                return
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                message = json.loads(line)
                if message.get("type") == "set_character":
                    self._request(message["id"])

    def _request(self, cid):
        with self._lock:
            if self._switching:
                self._reply_locked({"type": "character_change_failed", "id": cid, "reason": "switching"})
                return
            if cid == self.character:
                self._reply_locked({"type": "character_changed", "id": cid, "ms": 0})
                return
            self._switching = True
        threading.Thread(target=self._switch, args=(cid,), daemon=True).start()

    def _switch(self, cid):
        time.sleep(self.switch_s)
        with self._lock:
            if cid not in self.known:
                self._reply_locked({"type": "character_change_failed", "id": cid, "reason": "unknown_character"})
            elif cid in self.fail:
                self._reply_locked({"type": "character_change_failed", "id": cid, "reason": "load_failed"})
            else:
                self.character = cid
                self._reply_locked({"type": "character_changed", "id": cid, "ms": int(self.switch_s * 1000)})
            self._switching = False

    def _reply_locked(self, message):
        self.sock.sendall((json.dumps({"v": 1, **message}) + "\n").encode())
