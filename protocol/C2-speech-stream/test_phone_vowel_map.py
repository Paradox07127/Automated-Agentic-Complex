import json
import os
import unittest

from make_phone_vowel_map import build

HERE = os.path.dirname(os.path.abspath(__file__))


class PhoneVowelMapTest(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(HERE, "phone-vowel-map.json"), encoding="utf-8") as f:
            self.phones = json.load(f)["phones"]

    def test_file_matches_generator(self):
        self.assertEqual(self.phones, build()["phones"])

    def test_all_195_tonal_finals_and_5_japanese_vowels(self):
        self.assertEqual(len(self.phones), 195 + 5)
        self.assertTrue(all(p["vowel"] in "aiueo" and 0 < p["weight"] <= 1 for p in self.phones.values()))

    def test_compound_finals_use_main_vowel(self):
        for phone in ("ai3", "ao4", "iao2", "uai1", "ia5"):
            self.assertEqual(self.phones[phone]["vowel"], "a", phone)

    def test_apical_vowels_half_weight(self):
        self.assertEqual(self.phones["i04"], {"vowel": "i", "weight": 0.5})
        self.assertEqual(self.phones["ir4"], {"vowel": "e", "weight": 0.5})

    def test_u_umlaut_finals_round(self):
        self.assertEqual(self.phones["v3"]["vowel"], "u")
        self.assertEqual(self.phones["vn2"]["vowel"], "u")

    def test_no_cue_phones_absent(self):
        for phone in ("N", "cl", "I", "U", "k", "sh", "SP", "AA", "zh"):
            self.assertNotIn(phone, self.phones)


if __name__ == "__main__":
    unittest.main()
