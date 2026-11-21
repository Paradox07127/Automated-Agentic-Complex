"""Live hooks remain usable without opening either vendor's native history."""
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sessions.agent_meta import AgentMeta
from observation.attention import AttentionStore
from observation.blacklist import Blacklist
from support import deny_blacklist  # noqa: E402
import test_server


class HookOnlyHistoryTests(unittest.TestCase):
    request = test_server.ServerTest.request
    hook = test_server.ServerTest.hook

    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        test_server.ServerTest.setUp(self)
        self.server.agent_meta=AgentMeta()
        self.server.share_typed_text=True
        self.server.attention=AttentionStore(self.root/'attention.sqlite',Blacklist(deny_blacklist(self.root/'blacklist.json')))
        self.native=self.root/'native.jsonl';self.native.write_text('NATIVE-HISTORY-CANARY', encoding='utf-8')
        self.before=hashlib.sha256(self.native.read_bytes()).hexdigest()

    def tearDown(self):
        test_server.ServerTest.tearDown(self)
        self.server.attention.close()
        self.assertEqual(hashlib.sha256(self.native.read_bytes()).hexdigest(),self.before)

    def test_claude_and_codex_live_hooks_store_their_rows_without_reading_native_files(self):
        with patch('sessions.session_digest.read',side_effect=AssertionError('digest read')):
            for source in ('claude','codex'):
                self.assertEqual(self.hook(source,'UserPromptSubmit',session='live-'+source,
                    prompt='LIVE-'+source,session_title='Hook title',transcript_path=str(self.native)),(200,{}))
                self.assertEqual(self.hook(source,'Stop',session='live-'+source,
                    last_assistant_message='LIVE-STOP-'+source,transcript_path=str(self.native)),(200,{}))
        rows=self.server.attention.db.execute('SELECT kind,app,value FROM events_raw ORDER BY id').fetchall()
        self.assertEqual({r[1] for r in rows},{'claude','codex'})
        self.assertEqual({r[2] for r in rows},{'LIVE-claude','LIVE-codex','LIVE-STOP-claude','LIVE-STOP-codex'})

    def test_metadata_is_only_the_hook_title(self):
        self.assertEqual(self.server.agent_meta.session('claude','old',str(self.native),'Live title'),{'title':'Live title'})
