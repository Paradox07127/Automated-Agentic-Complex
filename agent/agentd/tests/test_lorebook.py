import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from brain.lorebook import Lorebook  # noqa: E402


def book(entries, budget=100):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "lore.json"
        path.write_text(json.dumps({"budget_tokens": budget, "entries": entries}, ensure_ascii=False), encoding="utf-8")
        return Lorebook(path)


def entry(id, keys, text="设定。", **extra):
    return {"id": id, "kind": "world", "keys": keys, "text": text,
            "tier": "official", "source_ref": "voice", "game_version": None, **extra}


def hit(id, text, reason, tier="official"):
    return {"id": id, "tier": tier, "text": text, "reason": reason}


class LorebookTest(unittest.TestCase):
    def test_keys_trigger_entries(self):
        lore = book([entry("ship", ["示例舰号", "示例舰"], "船。"), entry("valley", ["示例谷地"], "谷地。")])
        self.assertEqual(lore.select("示例舰是什么"), [hit("ship", "船。", "key:示例舰")])
        self.assertEqual(lore.select("今天天气"), [])
        self.assertEqual(lore.select("示例舰号和示例谷地"),
                         [hit("ship", "船。", "key:示例舰号"), hit("valley", "谷地。", "key:示例谷地")])

    def test_sticky_keeps_an_entry_for_later_turns(self):
        lore = book([entry("ship", ["示例舰号"], "船。", sticky=2)])
        self.assertEqual([lore.select(t) for t in ("示例舰号呢", "然后", "再然后", "还有")],
                         [[hit("ship", "船。", "key:示例舰号")], [hit("ship", "船。", "sticky")],
                          [hit("ship", "船。", "sticky")], []])

    def test_cooldown_blocks_a_retrigger(self):
        lore = book([entry("ship", ["示例舰号"], "船。", cooldown=2)])
        self.assertEqual([lore.select("示例舰号") for _ in range(4)],
                         [[hit("ship", "船。", "key:示例舰号")], [], [], [hit("ship", "船。", "key:示例舰号")]])

    def test_budget_keeps_higher_priority_entries(self):
        lore = book([entry("low", ["谷地"], "低" * 30, priority=1), entry("high", ["谷地"], "高" * 30, priority=5),
                     entry("small", ["谷地"], "小" * 10, priority=0)], budget=45)
        self.assertEqual(lore.select("谷地"), [hit("high", "高" * 30, "key:谷地"), hit("small", "小" * 10, "key:谷地")])
        self.assertEqual(lore.last_hits, [{"id": "high", "reason": "key:谷地"}, {"id": "small", "reason": "key:谷地"}])

    def test_ascii_keys_require_ascii_letter_and_digit_boundaries(self):
        for text in ("macro", "imac", "mac2", "2mac", "中macro文"):
            with self.subTest(text=text):
                self.assertEqual(book([entry("desktop", ["mac"])]).select(text), [])
        for text in ("我的 mac 上", "我的MAC上", "(Mac)", "macro mac"):
            with self.subTest(text=text):
                self.assertEqual(book([entry("desktop", ["mac"])]).select(text),
                                 [hit("desktop", "设定。", "key:mac")])
        self.assertEqual(book([entry("m3", ["m3"])]).select("M30"), [])
        self.assertEqual(book([entry("mixed", ["Mac桌面"])]).select("iMac桌面"), [])
        self.assertEqual(book([entry("mixed", ["Mac桌面"])]).select("Mac桌面上"),
                         [hit("mixed", "设定。", "key:Mac桌面")])

    def test_aliases_and_sticky_turns_record_hit_reasons(self):
        lore = book([entry("ship", ["巨舰"], aliases=["示例舰号", "Ship"], sticky=1)])
        self.assertEqual(lore.last_hits, [])
        for text, reason in (("示例舰号呢", "alias:示例舰号"), ("示例舰号", "sticky"),
                             ("SHIP", "alias:Ship"), ("然后呢", "sticky")):
            self.assertEqual(lore.select(text), [hit("ship", "设定。", reason)])
            self.assertEqual(lore.last_hits, [{"id": "ship", "reason": reason}])
        self.assertEqual(lore.select("spaceship"), [])
        self.assertEqual(lore.last_hits, [])

    def test_loader_rejects_a_single_character_key(self):
        with self.assertRaisesRegex(ValueError, "short-key"):
            book([entry("short-key", ["岁"])])

    def test_loader_rejects_a_single_character_alias(self):
        with self.assertRaisesRegex(ValueError, "short-alias"):
            book([entry("short-alias", ["巨兽"], aliases=["岁"])])

    def test_loader_rejects_a_missing_tier(self):
        item = entry("missing-tier", ["示例舰号"])
        del item["tier"]
        with self.assertRaisesRegex(ValueError, "missing-tier"):
            book([item])

    def test_loader_rejects_a_missing_game_version_key(self):
        item = entry("missing-version", ["示例舰号"])
        del item["game_version"]
        with self.assertRaisesRegex(ValueError, "missing-version"):
            book([item])

    def test_loader_rejects_an_unknown_source_ref(self):
        with self.assertRaisesRegex(ValueError, "unknown-source"):
            book([entry("unknown-source", ["示例舰号"], source_ref="wiki")])

    def test_loader_rejects_a_missing_source_ref(self):
        item = entry("missing-source", ["示例舰号"])
        del item["source_ref"]
        with self.assertRaisesRegex(ValueError, "missing-source"):
            book([item])

    def test_loader_rejects_an_unknown_tier(self):
        with self.assertRaisesRegex(ValueError, "unknown-tier"):
            book([entry("unknown-tier", ["示例舰号"], tier="canon")])


if __name__ == "__main__":
    unittest.main()
