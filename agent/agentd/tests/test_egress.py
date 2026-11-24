from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from brain.outbound import OutboundBlocked, OutboundGuard  # noqa: E402


class RecordingClient:
    def __init__(self, text="{}", chunks=()):
        self.text, self.chunks, self.bodies = text, list(chunks), []
        self.messages = self
        self.beta = SimpleNamespace(messages=self)

    def with_options(self, **options):
        return self

    def create(self, **body):
        self.bodies.append(("/v1/messages", {}, deepcopy(body)))
        return SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text=self.text)])

    @contextmanager
    def stream(self, **body):
        self.bodies.append(("/v1/messages", {}, deepcopy(body)))
        final = SimpleNamespace(stop_reason="end_turn", usage=SimpleNamespace(input_tokens=1, output_tokens=1,
                                                                             cache_read_input_tokens=0))
        yield SimpleNamespace(text_stream=iter(self.chunks), get_final_message=lambda: final)


class RedactTest(unittest.TestCase):
    def test_json_redaction_preserves_escapes_and_is_idempotent(self):
        from brain.egress import redact
        value = {'tool_response': 'before\nalice@example.com\tBearer secret-value\nEND',
                 'tool_input': {'command': 'print("Bearer secret-value")'},
                 'phone': 13800138000}
        masked, counts = redact(json.dumps(value))
        parsed = json.loads(masked)
        self.assertEqual(parsed['tool_response'], 'before\n[已遮蔽:邮箱]\tBearer [已遮蔽:密钥]\nEND')
        self.assertEqual(parsed['tool_input']['command'], 'print("Bearer [已遮蔽:密钥]")')
        self.assertEqual(parsed['phone'], '[已遮蔽:电话]')
        self.assertEqual(counts, {'key':2, 'email':1, 'phone':1})
        self.assertEqual(redact(masked), (masked, {'key':0, 'email':0, 'phone':0}))

    def test_nested_json_and_duplicate_or_masked_keys_keep_every_member(self):
        from brain.egress import redact
        nested = json.dumps({'email': 'alice@example.com', 'tail':'END'})
        masked, _ = redact(json.dumps({'response': nested}))
        self.assertEqual(json.loads(json.loads(masked)['response']), {'email':'[已遮蔽:邮箱]', 'tail':'END'})
        raw = '{"alice@example.com":1,"bob@example.com":2,"same":3,"same":4}'
        pairs = json.loads(redact(raw)[0], object_pairs_hook=list)
        self.assertEqual(pairs, [('[已遮蔽:邮箱]',1),('[已遮蔽:邮箱]',2),('same',3),('same',4)])
        unchanged = ' { "value" : [1.00, "@MainActor", "END"] } '
        self.assertEqual(redact(unchanged)[0], unchanged)
        # Escaped newline/tab prefixes are transport, not email local-parts.
        code = json.dumps({'output':'line\n@Example.actor\t@Other.annotation\nEND'})
        self.assertEqual(redact(code), (code, {'key':0,'email':0,'phone':0}))

    def test_long_code_tokens_do_not_stall_collection_or_lose_body(self):
        code="""from brain.egress import redact
n=400000
body='A'*n+' alice@example.com '+'B'*n
masked,counts=redact(body)
assert masked=='A'*n+' [已遮蔽:邮箱] '+'B'*n
assert counts=={'key':0,'email':1,'phone':0}
import json
encoded=json.dumps({'tool_response':body,'tail':'END'})
masked,counts=redact(encoded)
assert json.loads(masked)=={'tool_response':'A'*n+' [已遮蔽:邮箱] '+'B'*n,'tail':'END'}
assert counts=={'key':0,'email':1,'phone':0}
print('complete long body and email redaction verified')
"""
        result=subprocess.run([sys.executable,'-c',code],cwd=Path(__file__).resolve().parents[1],
            text=True,capture_output=True,timeout=5, encoding="utf-8")
        self.assertEqual(result.returncode,0,result.stderr)

    def test_keys_emails_and_phones(self):
        from brain.egress import redact
        samples = {
            "key": ["sk-ant-api03-abcdef", "sk-" + "a" * 20, "ghp_abcdef", "gho_abcdef",
                    "ghs_abcdef", "github_pat_abcdef", "AKIA1234567890ABCDEF", "xoxa-123-abc",
                    "xoxb-123-abc", "xoxp-123-abc", "xoxr-123-abc", "xoxs-123-abc",
                    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature", "Bearer secret-value"],
            "email": ["alice+work@example.com"],
            "phone": ["13800138000", "+86 138 0013 8000", "86-138-0013-8000", "+1-212-555-0123",
                      "+12345678", "+123456789012345"],
        }
        labels = {"key": "密钥", "email": "邮箱", "phone": "电话"}
        for kind, values in samples.items():
            for value in values:
                with self.subTest(value=value):
                    masked, counts = redact(value)
                    prefix = "Bearer " if value.startswith("Bearer ") else ""
                    self.assertEqual(masked, prefix + f"[已遮蔽:{labels[kind]}]")
                    self.assertEqual(counts, {key: int(key == kind) for key in labels})

    def test_named_secret_values_and_basic_credentials(self):
        from brain.egress import redact
        cases = {
            "password=hunter2xyz": "password=[已遮蔽:密钥]",
            "api_key: abcdefghij123": "api_key: [已遮蔽:密钥]",
            "token=abcdef123456 next": "token=[已遮蔽:密钥] next",
            "csrf_token=abc123": "csrf_token=[已遮蔽:密钥]",
            "Authorization: Basic dXNlcjpwYXNz": "Authorization: Basic [已遮蔽:密钥]",
            "Authorization: Bearer abc.def": "Authorization: Bearer [已遮蔽:密钥]",
            "secret = 'two words'": "secret = '[已遮蔽:密钥]'",
            '"refresh_token": "r-1", "n": 2': '"refresh_token": "[已遮蔽:密钥]", "n": 2',
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                masked, counts = redact(value)
                self.assertEqual(masked, expected)
                self.assertEqual(counts, {"key": 1, "email": 0, "phone": 0})
                self.assertEqual(redact(masked), (masked, {"key": 0, "email": 0, "phone": 0}))

    def test_prefixed_and_suffixed_secret_names_are_masked(self):
        from brain.egress import redact
        cases = {
            "SECRET_KEY=abcd1234efgh": "SECRET_KEY=[已遮蔽:密钥]",
            "PRIVATE_KEY=abc": "PRIVATE_KEY=[已遮蔽:密钥]",
            "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY":
                "AWS_SECRET_ACCESS_KEY=[已遮蔽:密钥]",
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                masked, counts = redact(value)
                self.assertEqual(masked, expected)
                self.assertEqual(counts, {"key": 1, "email": 0, "phone": 0})
        for value in ("token_count=5", "secretary: Alice"):
            with self.subTest(value=value):
                self.assertEqual(redact(value), (value, {"key": 0, "email": 0, "phone": 0}))

    def test_international_phone_followed_by_more_digits_is_masked(self):
        from brain.egress import redact
        cases = {
            "call +1 650 555 0199 94043": "call [已遮蔽:电话] 94043",
            "+86 138 0013 8000 2026": "[已遮蔽:电话] 2026",
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                masked, counts = redact(value)
                self.assertEqual(masked, expected)
                self.assertEqual(counts, {"key": 0, "email": 0, "phone": 1})

    def test_quoted_secret_value_cut_before_its_closing_quote_is_masked(self):
        from brain.egress import redact
        cases = {
            'password="hunter2': 'password="[已遮蔽:密钥]',
            "window: token='abc def": "window: token='[已遮蔽:密钥]",
            'secret: "ends in escape\\': 'secret: "[已遮蔽:密钥]',
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                masked, counts = redact(value)
                self.assertEqual(masked, expected)
                self.assertEqual(counts, {"key": 1, "email": 0, "phone": 0})
                self.assertEqual(redact(masked), (masked, {"key": 0, "email": 0, "phone": 0}))

    def test_json_member_names_follow_the_plain_text_secret_rule(self):
        from brain.egress import redact
        masked, counts = redact(json.dumps({"csrf_token": "xxx", "x-api-key": "k1", "token_count": "7", "mytoken": "m"}))
        self.assertEqual(json.loads(masked), {"csrf_token": "[已遮蔽:密钥]", "x-api-key": "[已遮蔽:密钥]",
                                              "token_count": "7", "mytoken": "m"})
        self.assertEqual(counts, {"key": 2, "email": 0, "phone": 0})

    def test_basic_and_bearer_in_prose_are_not_credentials(self):
        from brain.egress import redact
        for value in ("Explain basic arithmetic to me", "Basic concepts first", "Teach me basic math.",
                      "He is a bearer of bad news", "The bearer is John.", "bearer bonds, basic income"):
            with self.subTest(value=value):
                self.assertEqual(redact(value), (value, {"key": 0, "email": 0, "phone": 0}))
        cases = {
            "Authorization: Bearer abc": "Authorization: Bearer [已遮蔽:密钥]",
            "Authorization: Basic dXNlcjpwYXNz": "Authorization: Basic [已遮蔽:密钥]",
            "curl -H 'Authorization:basic dXNlcjpwYXNz'": "curl -H 'Authorization:basic [已遮蔽:密钥]'",
            "send Basic dXNlcjpwYXNz now": "send Basic [已遮蔽:密钥] now",
            "send bearer abc.def-123 now": "send bearer [已遮蔽:密钥] now",
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                masked, counts = redact(value)
                self.assertEqual(masked, expected)
                self.assertEqual(counts, {"key": 1, "email": 0, "phone": 0})
                self.assertEqual(redact(masked), (masked, {"key": 0, "email": 0, "phone": 0}))

    def test_json_members_named_as_secrets_are_masked(self):
        from brain.egress import redact
        masked, counts = redact(json.dumps({"password": "hunter2", "Api-Key": "k1", "tokens": 3, "token_count": "7", "name": "token"}))
        self.assertEqual(json.loads(masked), {"password": "[已遮蔽:密钥]", "Api-Key": "[已遮蔽:密钥]", "tokens": 3,
                                              "token_count": "7", "name": "token"})
        self.assertEqual(counts, {"key": 2, "email": 0, "phone": 0})
        self.assertEqual(redact(masked), (masked, {"key": 0, "email": 0, "phone": 0}))

    def test_non_sensitive_text_is_unchanged(self):
        from brain.egress import redact
        for value in ("12345678901234567890", "991380013800099", "1.2.3", "sk-short",
                      "今天一起看看进度。", "+1234567", "+1234567890123456"):
            with self.subTest(value=value):
                self.assertEqual(redact(value), (value, {"key": 0, "email": 0, "phone": 0}))

    def test_uuid_is_unchanged(self):
        from brain.egress import redact
        value = json.dumps({"id": "94ecc1f3-7678-4a0b-9736-c15881642072"})
        self.assertEqual(redact(value), (value, {"key": 0, "email": 0, "phone": 0}))

    def test_phone_next_to_uuid_is_redacted(self):
        from brain.egress import redact
        uuid = "94ecc1f3-7678-4a0b-9736-c15881642072"
        masked, counts = redact(f"{uuid} 13800138000")
        self.assertEqual(masked, f"{uuid} [已遮蔽:电话]")
        self.assertEqual(counts, {"key": 0, "email": 0, "phone": 1})

    def test_counts_and_replacement_order(self):
        from brain.egress import redact
        masked, counts = redact("Authorization: Bearer alice@example.com alice@example.com 13800138000 ghp_13800138000")
        self.assertEqual(masked, "Authorization: Bearer [已遮蔽:密钥] [已遮蔽:邮箱] [已遮蔽:电话] [已遮蔽:密钥]")
        self.assertEqual(counts, {"key": 2, "email": 1, "phone": 1})


class EgressPolicyTest(unittest.TestCase):
    def test_secret_member_masks_every_json_type(self):
        from brain.egress import EgressPolicy
        client = RecordingClient()
        policy = EgressPolicy()
        for value in (1234, True, None, ["marker"], {"nested": "marker"}, ""):
            with self.subTest(value=value):
                client.create(text=policy.user_text(json.dumps({"password": value, "other": 1234})))
                self.assertEqual(json.loads(client.bodies[-1][2]["text"]), {"password": "[已遮蔽:密钥]", "other": 1234})

    def test_thought_evidence_is_redacted_and_original_lines_stay_blocked(self):
        from brain.egress import EgressPolicy
        from character.thoughts import Thoughts
        from test_thoughts import FakeSemantic
        line = '甲乙丙丁戊己庚'
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'windows.json'
            path.write_text(json.dumps({'n': 7, 'hashes': [hashlib.sha256(line.encode()).hexdigest()[:16]]}), encoding="utf-8")
            policy = EgressPolicy(guard=OutboundGuard(path))
            semantic = FakeSemantic()
            semantic.replies.append('{"thought":"想法", "offer":null}')
            thoughts = Thoughts(None, None, semantic, consent=lambda: True,
                                context=lambda: line + ' alice@example.com Bearer secret-value', egress=policy)
            self.assertEqual(thoughts._ask('activity', {}, None, []), {'thought': '想法', 'offer': None, 'reply': None})
            [sent] = semantic.calls
            self.assertNotIn('alice@example.com', sent['evidence']['observed'])
            self.assertEqual(policy.redactions, {'key': 1, 'email': 1, 'phone': 0})
            with self.assertRaises(OutboundBlocked):
                policy.authored('persona', line)

    def test_authored_observed_and_replayed_have_distinct_rules(self):
        from brain.egress import EgressPolicy
        line = "甲乙丙丁戊己庚"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "windows.json"
            path.write_text(json.dumps({"n": 7, "hashes": [hashlib.sha256(line.encode()).hexdigest()[:16]]}), encoding="utf-8")
            policy = EgressPolicy(guard=OutboundGuard(path))
            for method in (policy.authored, policy.replayed):
                with self.assertRaises(OutboundBlocked):
                    method("test", line + " alice@example.com")
            self.assertEqual(policy.redactions, {"key": 0, "email": 0, "phone": 0})
            self.assertEqual(policy.observed(line + " alice@example.com"), line + " [已遮蔽:邮箱]")
            self.assertEqual(policy.authored("test", "alice@example.com"), "alice@example.com")
            self.assertEqual(policy.replayed("test", "alice@example.com"), "[已遮蔽:邮箱]")

    def test_redactions_accumulate_across_threads(self):
        from brain.egress import EgressPolicy
        policy = EgressPolicy()
        with ThreadPoolExecutor(8) as pool:
            list(pool.map(policy.observed, ["ghp_abcdef alice@example.com 13800138000"] * 100))
        policy.replayed("history", "alice@example.com")
        self.assertEqual(policy.redactions, {"key": 100, "email": 101, "phone": 100})

    def test_user_text_keeps_contacts_and_masks_keys(self):
        from brain.egress import EgressPolicy
        policy = EgressPolicy()
        text = "帮我给 13812345678 打电话，邮件发 alice@example.com，用 sk-abcdefghijklmnopqrstuvwx"
        self.assertEqual(policy.user_text(text),
                         "帮我给 13812345678 打电话，邮件发 alice@example.com，用 [已遮蔽:密钥]")
        self.assertEqual(policy.user_text('{"to": "alice@example.com", "auth": "Bearer abc.def\\n"}'),
                         '{"to":"alice@example.com","auth":"Bearer [已遮蔽:密钥]\\n"}')
        self.assertEqual(policy.redactions, {"key": 2, "email": 0, "phone": 0})
        self.assertEqual(policy.observed("屏幕上写着 13812345678"), "屏幕上写着 [已遮蔽:电话]")
        self.assertEqual(EgressPolicy(redact=False).user_text(text), text)

    def test_disabled_redaction_preserves_text_and_counts(self):
        from brain.egress import EgressPolicy
        policy = EgressPolicy(redact=False)
        text = "ghp_abcdef alice@example.com 13800138000"
        self.assertEqual(policy.observed(text), text)
        self.assertEqual(policy.replayed("history", text), text)
        self.assertEqual(policy.redactions, {"key": 0, "email": 0, "phone": 0})


if __name__ == "__main__":
    unittest.main()
