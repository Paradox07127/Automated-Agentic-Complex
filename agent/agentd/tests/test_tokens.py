import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from infra.tokens import ensure_state_dir, read_token, write_secret


class SecretPathTests(unittest.TestCase):
    def test_symlink_is_neither_read_nor_truncated(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "other"
            target.write_text("keep me", encoding="utf-8")
            target.chmod(0o600)
            link = Path(tmp) / "hook.token"
            link.symlink_to(target)
            for action in (lambda: read_token(link), lambda: write_secret(link, "replaced")):
                with self.assertRaises((OSError, SystemExit)):
                    action()
                self.assertEqual(target.read_text(encoding="utf-8"), "keep me")

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_foreign_owner_is_rejected_before_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "hook.token"
            write_secret(path, "keep me")
            with patch("infra.tokens.os.getuid", return_value=os.getuid() + 1):
                for action in (lambda: read_token(path), lambda: write_secret(path, "replaced")):
                    with self.assertRaises(SystemExit):
                        action()
            self.assertEqual(path.read_text(encoding="utf-8"), "keep me")

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_non_regular_secret_and_hardlink_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / "folder"
            folder.mkdir()
            fifo = Path(tmp) / "fifo"
            os.mkfifo(fifo)
            target = Path(tmp) / "target"
            write_secret(target, "keep me")
            link = Path(tmp) / "link"
            os.link(target, link)
            for path in (folder, fifo, link):
                for action in (lambda: read_token(path), lambda: write_secret(path, "replaced")):
                    with self.assertRaises((OSError, SystemExit)):
                        action()
            self.assertEqual(target.read_text(encoding="utf-8"), "keep me")

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_state_directory_is_private_owned_and_not_a_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state"
            ensure_state_dir(state)
            self.assertEqual(state.stat().st_mode & 0o777, 0o700)
            state.chmod(0o755)
            ensure_state_dir(state)
            self.assertEqual(state.stat().st_mode & 0o777, 0o700)
            link = Path(tmp) / "state-link"
            link.symlink_to(state, target_is_directory=True)
            with self.assertRaises((OSError, SystemExit)):
                ensure_state_dir(link)
            with patch("infra.tokens.os.getuid", return_value=os.getuid() + 1):
                with self.assertRaises(SystemExit):
                    ensure_state_dir(state)

