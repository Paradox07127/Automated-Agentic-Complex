"""motion.zip_import unpacks a dropped motion ZIP safely and sorts the files into one body, camera and audio by content."""
from pathlib import Path
import stat
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from motion import zip_import


def patched(path, old, new):
    data = path.read_bytes(); assert len(old) == len(new) and old in data
    path.write_bytes(data.replace(old, new))


class ExtractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.dest = self.root / "inputs"

    def archive(self, entries, compression=zipfile.ZIP_DEFLATED):
        path = self.root / "motion.zip"
        with zipfile.ZipFile(path, "w", compression) as archive:
            for entry in entries:
                info, data = entry if isinstance(entry, tuple) else (entry, b"data")
                archive.writestr(info, data)
        return path

    def refused(self, path):
        with self.assertRaises(zip_import.Failure) as caught: zip_import.extract(path, self.dest)
        self.assertEqual(caught.exception.reason, "bad_zip")
        return str(caught.exception)

    def test_path_traversal_is_refused(self):
        self.assertIn("escaping_path", self.refused(self.archive(["../evil.vmd"])))

    def test_symlink_is_refused(self):
        link = zipfile.ZipInfo("dance.vmd"); link.external_attr = (stat.S_IFLNK | 0o777) << 16
        self.assertIn("archive_executable_or_link", self.refused(self.archive([(link, b"/etc/passwd")])))

    def test_encrypted_entry_is_refused(self):
        path = self.archive(["dance.vmd"])
        data = bytearray(path.read_bytes()); central = data.index(b"PK\x01\x02")
        data[central + 8] |= 1; path.write_bytes(bytes(data))
        self.assertIn("archive_executable_or_link", self.refused(path))

    def test_bzip2_entry_is_refused(self):
        self.assertIn("unsupported_archive_compression", self.refused(self.archive(["dance.vmd"], zipfile.ZIP_BZIP2)))

    def test_names_equal_under_casefold_are_refused(self):
        self.assertIn("duplicate_archive_path", self.refused(self.archive(["Dance.vmd", "dance.VMD"])))

    def test_more_than_64_entries_is_refused(self):
        self.assertIn("archive_file_limit", self.refused(self.archive(["%02d.wav" % i for i in range(65)])))

    def test_cp932_name_without_the_utf8_flag_is_restored(self):
        name = "ダンス.vmd".encode("cp932")
        path = self.archive(["@" * (len(name) - 4) + ".vmd"])
        patched(path, b"@" * (len(name) - 4) + b".vmd", name)
        self.assertEqual(zip_import.extract(path, self.dest), [self.dest / "ダンス.vmd"])
        self.assertEqual((self.dest / "ダンス.vmd").read_bytes(), b"data")

    def test_macosx_folder_and_dot_files_are_skipped(self):
        path = self.archive(["__MACOSX/", "__MACOSX/._dance.vmd", ".DS_Store", "set/.hidden.wav", "set/dance.vmd"])
        self.assertEqual(zip_import.extract(path, self.dest), [self.dest / "set/dance.vmd"])
        self.assertEqual(sorted(p.relative_to(self.dest).as_posix() for p in self.dest.rglob("*")), ["set", "set/dance.vmd"])


class ClassifyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def files(self, *names):
        paths = [self.root / name for name in names]
        for path in paths: path.write_bytes(b"x")
        return paths

    # Bone and camera frame counts by file name, as motion_tool's importer would read them.
    COUNTS = {"body.vmd": (2, 0), "body2.vmd": (5, 3), "camera.vmd": (0, 4), "camera2.vmd": (0, 1), "empty.vmd": (0, 0)}

    def counts(self, path): return self.COUNTS[path.name]

    def failure(self, paths):
        with self.assertRaises(zip_import.Failure) as caught: zip_import.classify(paths, self.counts)
        return caught.exception.reason, str(caught.exception)

    def test_one_body_one_camera_and_one_wav(self):
        body, camera, song, notes = self.files("body.vmd", "camera.vmd", "song.WAV", "notes.txt")
        self.assertEqual(zip_import.classify([notes, song, camera, body], self.counts),
                         dict(body=body, camera=camera, audio=song, warnings=["ignored_file: notes.txt"]))

    def test_vmd_without_frames_is_ignored(self):
        body, empty = self.files("body.vmd", "empty.vmd")
        self.assertEqual(zip_import.classify([body, empty], self.counts),
                         dict(body=body, camera=None, audio=None, warnings=["ignored_file: empty.vmd"]))

    def test_two_bodies_are_ambiguous(self):
        self.assertEqual(self.failure(self.files("body.vmd", "body2.vmd")), ("ambiguous_motion", "body.vmd,body2.vmd"))

    def test_two_cameras_are_ambiguous(self):
        self.assertEqual(self.failure(self.files("body.vmd", "camera.vmd", "camera2.vmd")), ("ambiguous_motion", "camera.vmd,camera2.vmd"))

    def test_two_audio_files_are_ambiguous(self):
        self.assertEqual(self.failure(self.files("body.vmd", "a.mp3", "b.flac")), ("ambiguous_motion", "a.mp3,b.flac"))

    def test_no_body_is_a_bad_vmd(self):
        self.assertEqual(self.failure(self.files("camera.vmd", "song.wav")), ("bad_vmd", "no body motion"))


if __name__ == "__main__": unittest.main()
