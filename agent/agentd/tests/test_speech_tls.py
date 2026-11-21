"""Real TLS transport, certificate validation and reconnect regressions."""
import sys
import ssl
import subprocess
import tempfile
import threading
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

from test_speech import FakeTTS, SpeechRelay, speech_module
import test_speech as fixture
from support import serve_in_thread


@unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
class SpeechTransportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tmp.cleanup)
        cls.cert, cls.key = (Path(cls.tmp.name) / name for name in ('cert.pem', 'key.pem'))
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-keyout', str(cls.key), '-out', str(cls.cert), '-subj', '/CN=localhost',
                        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
                       check=True, capture_output=True)

    def setUp(self):
        self.tts = FakeTTS()
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.cert, self.key)
        self.tts.socket = context.wrap_socket(self.tts.socket, server_side=True)
        thread = serve_in_thread(self.tts)
        self.addCleanup(self.tts.server_close)
        self.addCleanup(self.tts.shutdown)

    def relay(self, **extra):
        return SpeechRelay(f'https://127.0.0.1:{self.tts.server_port}/tts', 'epoch', 'si', 'zh',
                           token='synthetic-bearer', **extra)

    def test_default_ports_and_supported_schemes(self):
        for url, port, kind in [('https://example.invalid', 443, speech_module.http.client.HTTPSConnection),
                                ('https://example.invalid:9443', 9443, speech_module.http.client.HTTPSConnection),
                                ('http://127.0.0.1', 80, speech_module.http.client.HTTPConnection)]:
            relay = SpeechRelay(url, 'epoch', 'si', 'zh')
            self.assertEqual(relay.port, port)
            connection = relay._connection(relay.scheme, relay.host, relay.port)
            self.addCleanup(connection.close)
            self.assertIs(type(connection), kind)
        for url in ['ftp://localhost', 'https:///missing-host', 'https://user:secret@localhost']:
            with self.assertRaises(ValueError):
                SpeechRelay(url, 'epoch', 'si', 'zh')

    def test_trusted_https_stream_carries_audio_and_authentication(self):
        relay = self.relay()
        trusted = ssl.create_default_context(cafile=str(self.cert))
        self.assertTrue(trusted.check_hostname)
        self.assertEqual(trusted.verify_mode, ssl.CERT_REQUIRED)
        with mock.patch('ssl._create_default_https_context', return_value=trusted):
            relay.speak('line', 'synthetic words')
            lines = fixture.SpeechRelayTest.collect(self, relay, 1)
        self.assertEqual(lines[-1]['event'], 'complete')
        self.assertTrue(any(line['event'] == 'audio' for line in lines))
        self.assertEqual(self.tts.bodies[0][0], '/tts/speech_stream')
        self.assertEqual(self.tts.auth, ['Bearer synthetic-bearer'])

    def test_untrusted_certificate_never_sends_bearer_or_words(self):
        relay = self.relay()
        failed = threading.Event()
        relay.on_event = lambda kind, *_: failed.set() if kind == 'speech.failed' else None
        relay.speak('line', 'must not leave the client')
        self.assertTrue(failed.wait(3))
        self.assertEqual(self.tts.bodies, [])
        self.assertEqual(self.tts.auth, [])

    def test_tls_connection_setup_failure_reaches_a_terminal_state(self):
        relay = self.relay()
        with mock.patch.object(relay, '_connection', side_effect=OSError('synthetic TLS context failure')):
            speech_id = relay.speak('line', 'must not leave the client')
            pending = relay._speeches[speech_id]
            self.assertTrue(pending.done.wait(2))
        self.assertEqual(pending.state, 'failed')
        self.assertEqual(self.tts.bodies, [])

    def test_retry_after_ensure_still_uses_verified_https(self):
        ensure_calls = []
        ensurer = SimpleNamespace(request=lambda: ensure_calls.append('start'), wait_ready=lambda _: True)
        relay = self.relay(ensurer=ensurer)
        trusted = ssl.create_default_context(cafile=str(self.cert))
        real = relay._connection
        first = mock.Mock()
        first.connect.side_effect = ConnectionRefusedError('synthetic cold start')
        with mock.patch('ssl._create_default_https_context', return_value=trusted), \
                mock.patch.object(relay, '_connection', side_effect=[first, real(relay.scheme, relay.host, relay.port)]) as factory:
            relay.speak('line', 'synthetic retry')
            self.assertEqual(fixture.SpeechRelayTest.collect(self, relay, 1)[-1]['event'], 'complete')
        self.assertEqual(factory.call_count, 2)
        self.assertEqual(ensure_calls, ['start'])
        self.assertEqual(self.tts.auth, ['Bearer synthetic-bearer'])


if __name__ == '__main__':
    unittest.main()
