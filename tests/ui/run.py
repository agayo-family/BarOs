"""Real local API + JSDOM integration audits. Always uses a disposable database."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

folder = Path(__file__).resolve().parent
repo = folder.parent.parent
node = os.environ.get('CODEX_PRIMARY_RUNTIME_NODE') or shutil.which('node')
if not node or not (folder/'node_modules'/'jsdom').exists():
    raise SystemExit('Install Node.js, then run: npm ci --prefix tests/ui --ignore-scripts')

with tempfile.TemporaryDirectory(prefix='baros-ui-audit-') as tmp:
    workspace = Path(tmp)
    shutil.copytree(repo/'baros'/'static'/'v2', workspace/'ui')
    (workspace/'ui'/'package.json').write_text('{"type":"module"}')
    for name in ['audit.mjs', 'shifts.mjs', 'games.mjs']:
        shutil.copyfile(folder/name, workspace/name)
    (workspace/'node_modules').symlink_to(folder/'node_modules', target_is_directory=True)
    scripts = sys.argv[1:] or ['audit.mjs', 'shifts.mjs', 'games.mjs']
    for index, script in enumerate(scripts):
        if script not in {'audit.mjs', 'shifts.mjs', 'games.mjs'}: raise SystemExit('Unknown audit script')
        env = dict(os.environ, DATABASE_URL='sqlite:///'+str(workspace/f'audit-{index}.db'),
                   FIRST_RUN_TOKEN='baros-ui-audit-only', SESSION_SECRET='baros-ui-audit-test-only',
                   COOKIE_SECURE='0', BAROS_WORKER='0', BAROS_AUDIT_URL='http://127.0.0.1:8147')
        with open(workspace/'server.log', 'w') as log:
            server = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'baros.main:app', '--host', '127.0.0.1', '--port', '8147'],
                                      cwd=repo, env=env, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    if server.poll() is not None: raise RuntimeError('Test server failed to start')
                    try:
                        urllib.request.urlopen(env['BAROS_AUDIT_URL']+'/health', timeout=1)
                        break
                    except OSError: time.sleep(.1)
                else: raise RuntimeError('Test server did not become ready')
                result = subprocess.run([node, str(workspace/script)], env=env, timeout=90)
                if result.returncode: raise RuntimeError('UI audit failed: '+script)
            except Exception:
                print((workspace/'server.log').read_text()[-4000:]); raise
            finally:
                server.terminate()
                try: server.wait(timeout=5)
                except subprocess.TimeoutExpired: server.kill(); server.wait()
