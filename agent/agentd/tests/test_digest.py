"""observation.digest: a timeline segment as compact text."""
import datetime
import unittest

import support  # noqa: F401  (puts agentd on the path)
from observation.digest import CAP, digest

T0 = 1_800_000_000.0  # a segment start


def rec(ts, kind, app="Code", window_id=1, target=None, tree=None, **extra):
    return {"ts": T0 + ts, "kind": kind, "app": app, "bundle_id": None, "pid": 7, "window_id": window_id,
            "window_title": "server.py", "url_host": None, "target": target, "keys": None, "text": None, "tree": tree,
            **extra}


def button(title):
    return {"role": "AXButton", "subrole": None, "title": title, "description": None, "identifier": None, "value": None}


def at(ts):
    return datetime.datetime.fromtimestamp(T0 + ts).strftime("%H:%M:%S")


class DigestTest(unittest.TestCase):
    def test_a_diff_keeps_the_text_of_its_added_and_changed_lines(self):
        tree = {"mode": "diff", "text": "+\t\t4 group\n+\t\t5 button Save\n-\t6 static text Old\n~\t7 static text Saved 3\n"
                                        "+\t8 group (showing 1-2 of 9 items)\n+\t9 static text ,"}
        text = digest([rec(0, "click", target=button("Save"), tree=tree)])
        self.assertIn(f'{at(0)} clicked button "Save" (+2)\n  button Save | Saved 3', text)
        self.assertNotIn("Old", text)
        self.assertNotIn("group", text)

    def test_no_change_and_a_repeated_line_add_nothing(self):
        text = digest([rec(0, "window", tree={"mode": "full", "text": "0 window Code\n\t1 button Run"}),
                       rec(5, "shortcut", keys="cmd+s", tree={"mode": "no_change", "text": ""}),
                       rec(9, "submit", keys="return", tree={"mode": "diff", "text": "~\t1 button Run"})])
        self.assertEqual(text.count("button Run"), 1)
        self.assertIn(f"{at(5)} shortcut cmd+s\n{at(9)} submit return", text)

    def test_clicks_in_one_window_are_one_line(self):
        text = digest([rec(0, "click", target=button("A"), tree={"mode": "diff", "text": "+\t1 static text x\n+\t2 static text y"}),
                       rec(1, "click", target=button("B")),
                       rec(2, "click", target=button("C"), window_id=2)])
        self.assertIn('clicked button "A" (+2) → button "B" (+0)\n  x | y', text)
        self.assertIn(f'{at(2)} clicked button "C" (+0)', text)

    def test_a_run_of_inputs_into_one_field_is_its_last_value(self):
        field = {"role": "AXTextField", "subrole": None, "title": "Message", "description": None, "identifier": None}
        text = digest([rec(0, "text_input", target={**field, "value": "he"}, text="he"),
                       rec(1, "text_input", target={**field, "value": None}, text="hello"),
                       rec(2, "text_input", target={**field, "value": "hello world"}, text="ni3hao3")])
        self.assertEqual(text.count("typed"), 1)
        self.assertIn(f'{at(0)} typed in text field "Message": "hello world"', text)

    def test_over_the_cap_the_apps_share_it_by_dwell(self):
        def lines(n, word):
            return {"mode": "full", "text": "\n".join(f"\t{i} static text {word} {i} " + "x" * 80 for i in range(n))}
        # Long holds 400 s (no gap over GAP_S), Short its last GAP_S.
        records = [rec(0, "window", app="Long", tree=lines(300, "long")), *(rec(t, "click", app="Long") for t in (100, 200, 300)),
                   rec(400, "window", app="Short", tree=lines(300, "short"))]
        text = digest(records)
        self.assertLessEqual(len(text), CAP)
        long, short = text.split("## Short")
        self.assertGreater(len(long), 2 * len(short))
        self.assertIn("…", short)

    def test_an_empty_segment_is_empty(self):
        self.assertEqual(digest([]), "")


if __name__ == "__main__":
    unittest.main()
