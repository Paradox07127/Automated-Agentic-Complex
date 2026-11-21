import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest

import live_routes

TOKEN = 'test-token'
ROUTES = [
    {'method': 'GET', 'path': '/ok', 'class': 'read', 'surfaces': ['main']},
    {'method': 'GET', 'path': '/closed', 'class': 'read', 'surfaces': ['main']},
    {'method': 'GET', 'path': '/broken', 'class': 'read', 'surfaces': ['stack']},
    {'method': 'GET', 'path': '/things', 'class': 'read', 'surfaces': ['main']},
    {'method': 'GET', 'path': '^/things/([a-z0-9]{1,16})/detail$', 'class': 'read', 'surfaces': ['main']},
    {'method': 'GET', 'path': '^/empty/([a-z0-9]{1,16})$', 'class': 'read', 'surfaces': ['main']},
    {'method': 'GET', 'path': '/stream', 'class': 'stream', 'surfaces': []},
    {'method': 'POST', 'path': '/ok', 'class': 'write', 'surfaces': ['main']},
]


class Handler(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *args):
        pass

    def reply(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        Handler.requests.append(self.path)
        if self.headers.get('Authorization') != 'Bearer ' + TOKEN:
            return self.reply(401, {'error': 'unauthorized'})
        if self.path == '/closed':
            self.close_connection = True
            return
        if self.path == '/broken':
            return self.reply(500, {'error': 'boom'})
        replies = {'/ok': {'ok': True}, '/things': {'things': [{'id': 'abc123', 'title': 'x'}]},
                   '/things/abc123/detail': {'id': 'abc123'}, '/empty': {'items': []}}
        if self.path in replies:
            return self.reply(200, replies[self.path])
        return self.reply(404, {'error': 'not_found'})


class LiveRoutesTest(unittest.TestCase):
    def setUp(self):
        Handler.requests = []
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.runtime = Path(directory.name) / 'ui-runtime.json'
        self.runtime.write_text(json.dumps({'base_url': f'http://127.0.0.1:{self.server.server_address[1]}',
                                            'ui_token': TOKEN}))

    def run_script(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = live_routes.main(['--runtime', str(self.runtime)], routes=ROUTES)
        return code, out.getvalue().splitlines()

    def test_closed_connection_and_server_error_fail_the_run(self):
        code, lines = self.run_script()
        self.assertEqual(code, 1)
        self.assertTrue(any(l.startswith('FAIL  /closed  连接被关') for l in lines), lines)
        self.assertTrue(any(l.startswith('FAIL  /broken  500') for l in lines), lines)
        self.assertTrue(any(l.startswith('PASS  /ok  200') for l in lines), lines)
        self.assertEqual(lines[-1], '汇总：通过 3，失败 2，跳过 1')

    def test_regex_route_takes_a_real_id_or_is_skipped(self):
        _, lines = self.run_script()
        self.assertTrue(any(l.startswith('PASS  /things/abc123/detail  200') for l in lines), lines)
        self.assertIn('SKIP  ^/empty/([a-z0-9]{1,16})$  跳过：没有样本 id', lines)
        self.assertIn('/empty', Handler.requests)

    def test_only_ui_read_routes_are_requested(self):
        self.run_script()
        self.assertNotIn('/stream', Handler.requests)
        self.assertEqual(set(Handler.requests),
                         {'/ok', '/closed', '/broken', '/things', '/things/abc123/detail', '/empty'})


if __name__ == '__main__':
    unittest.main()
