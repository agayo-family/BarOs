"""Real Chromium screen audit. Starts only a disposable local database."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

repo = Path(__file__).resolve().parent.parent
node = os.environ.get('CODEX_PRIMARY_RUNTIME_NODE') or shutil.which('node')
output = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else repo / 'test-results' / 'browser'
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='baros-browser-') as tmp:
    env = dict(os.environ, DATABASE_URL='sqlite:///' + str(Path(tmp) / 'test.db'),
               FIRST_RUN_TOKEN='browser-audit-disposable-setup-key', BAROS_WORKER='0',
               SESSION_SECRET='browser-audit-disposable-session-key', COOKIE_SECURE='0',
               MIN_LESSON_SECONDS='0', BAROS_AUDIT_URL='http://127.0.0.1:8159',
               BAROS_AUDIT_OUTPUT=str(output))
    with open(output / 'server.log', 'w') as log:
        server = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'baros.main:app',
                                   '--host', '127.0.0.1', '--port', '8159'],
                                  cwd=repo, env=env, stdout=log, stderr=log)
        try:
            for _ in range(100):
                if server.poll() is not None:
                    raise RuntimeError('Disposable server failed to start')
                try:
                    urllib.request.urlopen(env['BAROS_AUDIT_URL'] + '/health', timeout=1)
                    break
                except OSError:
                    time.sleep(.1)
            else:
                raise RuntimeError('Disposable server did not become ready')
            subprocess.run([node, str(repo / 'tests' / 'browser_audit.mjs')],
                           cwd=repo, env=env, check=True, timeout=1800)
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
