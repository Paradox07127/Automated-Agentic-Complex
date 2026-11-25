"""motion.zip_import unpacks a dropped motion ZIP safely, walks a folder and sorts the files into bodies, faces, cameras and audio."""
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

    def test_256_entries_are_extracted_and_257_refused(self):
        self.assertEqual(len(zip_import.extract(self.archive(["%03d.wav" % i for i in range(256)]), self.dest)), 256)
        self.assertIn("archive_file_limit", self.refused(self.archive(["%03d.wav" % i for i in range(257)])))

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


class WalkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def put(self, *names):
        for name in names:
            path = self.root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b"x")

    def test_files_below_the_folder_without_hidden_entries_and_macosx(self):
        self.put("b.vmd", "Camera/cam/cam.vmd", "a.wav", ".DS_Store", ".git/x.vmd", "__MACOSX/._b.vmd", "set/.hidden.wav")
        self.assertEqual(zip_import.walk(self.root), [self.root / "Camera/cam/cam.vmd", self.root / "a.wav", self.root / "b.vmd"])

    def test_more_than_256_files_is_a_bad_source(self):
        self.put(*("%03d.txt" % i for i in range(257)))
        with self.assertRaises(zip_import.Failure) as caught: zip_import.walk(self.root)
        self.assertEqual(caught.exception.reason, "bad_source")


class ClassifyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def files(self, *names):
        paths = [self.root / name for name in names]
        for path in paths: path.write_bytes(b"x")
        return paths

    # What motion_tool's reader gives for each file name: key counts (morphs: distinct names), header model and last frame.
    INFO = {"Dance_Full_HimeTanaka_v1.1[f-19].vmd": dict(bones=9, cameras=0, morphs=0, model="田中ヒメ", frames=6699),
            "Dance_Full_HinaSuzuki_v1.1[f-19].vmd": dict(bones=9, cameras=0, morphs=3, model="鈴木ヒナ", frames=6700),
            "body.vmd": dict(bones=2, cameras=0, morphs=0, model="m", frames=30),
            "camera.vmd": dict(bones=0, cameras=4, morphs=0, model="カメラ・照明", frames=60),
            "camera2[f4930].vmd": dict(bones=0, cameras=1, morphs=0, model="カメラ・照明", frames=90),
            "lip_HinaSuzuki.vmd": dict(bones=0, cameras=0, morphs=5, model="", frames=6300),
            "lip_other.vmd": dict(bones=0, cameras=0, morphs=2, model="", frames=60),
            "empty.vmd": dict(bones=0, cameras=0, morphs=0, model="", frames=0)}

    def read(self, path):
        if path.name == "broken.vmd": raise ValueError("not a VMD 0002 file")
        return self.INFO[path.name]

    def test_one_body_one_camera_and_one_wav(self):
        body, camera, song, notes = self.files("body.vmd", "camera.vmd", "song.WAV", "notes.txt")
        self.assertEqual(zip_import.classify([notes, song, camera, body], self.read), dict(
            bodies=[dict(path=str(body), name="body.vmd", label="body", model="m", duration_s=1.0, place_frame=None, has_morph=False)],
            faces=[], cameras=[dict(path=str(camera), name="camera.vmd", duration_s=2.0, place_frame=None)],
            audio=[dict(path=str(song), name="song.WAV")], ignored=[dict(name="notes.txt", reason="not_motion")],
            suggested=dict(body=0, face=None, camera=0, audio=0, bgm_start_s=None)))

    def test_two_bodies_are_told_apart_by_the_part_of_their_names_that_differs(self):
        found = zip_import.classify(self.files("Dance_Full_HinaSuzuki_v1.1[f-19].vmd", "Dance_Full_HimeTanaka_v1.1[f-19].vmd"), self.read)
        self.assertEqual([(b["name"], b["label"], b["place_frame"], b["has_morph"]) for b in found["bodies"]],
                         [("Dance_Full_HimeTanaka_v1.1[f-19].vmd", "HimeTanaka", -19, False),
                          ("Dance_Full_HinaSuzuki_v1.1[f-19].vmd", "HinaSuzuki", -19, True)])
        self.assertEqual(found["suggested"], dict(body=1, face=None, camera=None, audio=None, bgm_start_s=-0.633))

    def test_the_face_naming_the_suggested_body_and_the_longest_camera_are_suggested(self):
        found = zip_import.classify(self.files("Dance_Full_HimeTanaka_v1.1[f-19].vmd", "Dance_Full_HinaSuzuki_v1.1[f-19].vmd",
                                               "lip_other.vmd", "lip_HinaSuzuki.vmd", "camera.vmd", "camera2[f4930].vmd",
                                               "b.mp3", "a.flac"), self.read)
        self.assertEqual([(f["name"], f["morphs"], f["duration_s"]) for f in found["faces"]],
                         [("lip_HinaSuzuki.vmd", 5, 210.0), ("lip_other.vmd", 2, 2.0)])
        self.assertEqual([(c["name"], c["place_frame"]) for c in found["cameras"]], [("camera.vmd", None), ("camera2[f4930].vmd", 4930)])
        self.assertEqual([a["name"] for a in found["audio"]], ["a.flac", "b.mp3"])
        self.assertEqual(found["suggested"], dict(body=1, face=0, camera=1, audio=0, bgm_start_s=-0.633))

    def test_the_only_face_is_suggested_whatever_its_name(self):
        self.assertEqual(zip_import.classify(self.files("body.vmd", "lip_other.vmd"), self.read)["suggested"]["face"], 0)

    def test_a_vmd_without_keys_or_that_does_not_parse_is_ignored(self):
        body, empty, broken = self.files("body.vmd", "empty.vmd", "broken.vmd")
        self.assertEqual(zip_import.classify([empty, body, broken], self.read)["ignored"],
                         [dict(name="broken.vmd", reason="bad_vmd"), dict(name="empty.vmd", reason="no_keys")])

    def test_no_body_is_a_bad_vmd(self):
        with self.assertRaises(zip_import.Failure) as caught: zip_import.classify(self.files("camera.vmd", "song.wav"), self.read)
        self.assertEqual((caught.exception.reason, str(caught.exception)), ("bad_vmd", "no body motion"))


if __name__ == "__main__": unittest.main()
