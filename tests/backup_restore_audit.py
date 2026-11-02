"""Full logical backup/restore against local, disposable PostgreSQL only."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.parse import urlparse, urlunparse

import psycopg
from psycopg.conninfo import conninfo_to_dict

repo = Path(__file__).resolve().parents[1]
source = os.environ.get('BAROS_POSTGRES_TEST_DATABASE_URL', '').replace('postgresql+psycopg://', 'postgresql://', 1)
parts = urlparse(source)
if parts.hostname not in {'localhost', '127.0.0.1', 'postgres'} or parts.path != '/baros_test':
    raise SystemExit('Requires a local disposable database named baros_test')
target = urlunparse(parts._replace(path='/baros_restore_test'))
admin = urlunparse(parts._replace(path='/postgres'))

with psycopg.connect(source) as db:
    db.execute('CREATE TABLE baros_restore_probe (id serial primary key, body text, payload bytea)')
    db.execute('INSERT INTO baros_restore_probe (body,payload) VALUES (%s,%s)',
               ('На, стой-ка — источник, редакция и письменный ответ\n"<текст>"', bytes(range(256)) * 100))
with psycopg.connect(source) as db:
    person=db.execute('SELECT id,organization_id FROM v2_accounts WHERE organization_id IS NOT NULL LIMIT 1').fetchone()
    assert person, 'Audit fixtures must contain a tenant account'
    db.execute('INSERT INTO v2_course_media (id,organization_id,creator_id,content,mime,size,created_at) VALUES (%s,%s,%s,%s,%s,%s,now())',
               ('backup_photo_binary_probe',person[1],person[0],bytes(range(256))*7,'image/jpeg',1792))
    db.execute('INSERT INTO v2_legal_acceptances (account_id,document,version,accepted_at) VALUES (%s,%s,%s,now())',
               (person[0],'privacy','backup-legal-version'))
    db.execute('INSERT INTO v2_settings (key,value) VALUES (%s,%s)',('legal_snapshot:backup-legal-version','Архивный текст и реквизиты · версия для проверки восстановления'))
with psycopg.connect(admin, autocommit=True) as db:
    if db.execute("SELECT 1 FROM pg_database WHERE datname='baros_restore_test'").fetchone():
        raise SystemExit('Restore test database already exists; refusing to reuse it')
    db.execute('CREATE DATABASE baros_restore_test')

def command(action, folder, expected=0):
    result = subprocess.run([sys.executable, str(repo / 'ops' / 'postgres_backup.py'), action, str(folder)],
        env={**os.environ, 'DATABASE_URL': source, 'RESTORE_TEST_DATABASE_URL': target},
        capture_output=True, text=True, timeout=120)
    assert result.returncode == expected, result.stdout + result.stderr
    assert conninfo_to_dict(source)['password'] not in result.stdout + result.stderr
    return result.stdout + result.stderr

with tempfile.TemporaryDirectory(prefix='baros-restore-check-') as temporary:
    folder = Path(temporary) / 'snapshot'
    print(command('backup', folder).strip())
    print(command('verify', folder).strip())
    assert 'empty database' in command('verify', folder, expected=1)
    data = (folder / 'baros.dump').read_bytes()
    (folder / 'baros.dump').write_bytes(data + b'corruption')
    assert 'checksum' in command('verify', folder, expected=1)
    with psycopg.connect(target) as db:
        assert db.execute('SELECT body,payload FROM baros_restore_probe').fetchone() == (
            'На, стой-ка — источник, редакция и письменный ответ\n"<текст>"', bytes(range(256)) * 100)
        next_id = db.execute("INSERT INTO baros_restore_probe (body) VALUES ('sequence restored') RETURNING id").fetchone()[0]
        assert next_id == 2
        assert db.execute("SELECT content FROM v2_course_media WHERE id='backup_photo_binary_probe'").fetchone()[0]==bytes(range(256))*7
        assert db.execute("SELECT count(*) FROM v2_legal_acceptances WHERE version='backup-legal-version'").fetchone()[0]==1
        assert db.execute("SELECT value FROM v2_settings WHERE key='legal_snapshot:backup-legal-version'").fetchone()[0]=='Архивный текст и реквизиты · версия для проверки восстановления'
print('BACKUP RESTORE PASS: complete content hashes, binary sources, Unicode, sequence, checksum and nonempty-target refusal')
