"""Operator backup and restore verification. Connection strings stay in env vars.

Requires matching PostgreSQL client tools (PG_BIN optionally names their folder).
Never restore over an existing database; no --clean or --create is used.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict

PG_ENV = {'host': 'PGHOST', 'hostaddr': 'PGHOSTADDR', 'port': 'PGPORT', 'dbname': 'PGDATABASE',
          'user': 'PGUSER', 'password': 'PGPASSWORD', 'sslmode': 'PGSSLMODE',
          'sslcert': 'PGSSLCERT', 'sslkey': 'PGSSLKEY', 'sslrootcert': 'PGSSLROOTCERT',
          'sslcrl': 'PGSSLCRL', 'sslcrldir': 'PGSSLCRLDIR', 'options': 'PGOPTIONS',
          'application_name': 'PGAPPNAME', 'connect_timeout': 'PGCONNECT_TIMEOUT',
          'channel_binding': 'PGCHANNELBINDING', 'target_session_attrs': 'PGTARGETSESSIONATTRS',
          'gssencmode': 'PGGSSENCMODE', 'passfile': 'PGPASSFILE', 'service': 'PGSERVICE'}


def connection(variable):
    value = os.environ.get(variable, '').replace('postgresql+psycopg://', 'postgresql://', 1)
    if not value.startswith(('postgresql://', 'postgres://')):
        raise ValueError('Set a PostgreSQL URL in the selected environment variable')
    return value


def run_tool(name, url, *args):
    binary = str(Path(os.environ['PG_BIN']) / name) if os.environ.get('PG_BIN') else name
    params = conninfo_to_dict(url)
    if set(params) - set(PG_ENV):
        raise ValueError('Connection has unsupported client options; use a standard PostgreSQL URL')
    env = {k: v for k, v in os.environ.items() if k not in PG_ENV.values()}
    env.update({PG_ENV[k]: v for k, v in params.items()})
    result = subprocess.run([binary, *map(str, args)], env=env,
                            capture_output=True, timeout=1200)
    if result.returncode:
        # PostgreSQL errors may contain connection details or data. Do not echo them.
        raise RuntimeError(f'{name} failed; check connectivity, tool version and database permissions')
    return result


def inventory(db):
    """Hash the complete row multiset, including binary sources and saved work.

    Order-independent 256-bit sums and XORs include a count to retain duplicates.
    Only hashes/counts go into the manifest; row contents never go to stdout.
    """
    tables = db.execute("""SELECT n.nspname, c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relkind='r' AND n.nspname NOT LIKE 'pg_%'
          AND n.nspname <> 'information_schema' ORDER BY 1,2""").fetchall()
    result = []
    for schema, table in tables:
        count = total = xor = 0
        with db.cursor(name='backup_' + uuid.uuid4().hex) as rows:
            rows.execute(sql.SQL('SELECT row_to_json(t)::text FROM {}.{} t').format(
                sql.Identifier(schema), sql.Identifier(table)))
            for (row,) in rows:
                value = int.from_bytes(hashlib.sha256(row.encode('utf-8')).digest(), 'big')
                count += 1
                total = (total + value) % (1 << 256)
                xor ^= value
        result.append({'schema': schema, 'table': table, 'rows': count,
                       'sum_sha256': f'{total:064x}', 'xor_sha256': f'{xor:064x}'})
    return result


def file_hash(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def backup(variable, directory):
    url = connection(variable)
    # Exclusive new directory: never overwrite a previous backup or expose a partial one.
    directory.mkdir(mode=0o700, parents=False, exist_ok=False)
    archive = directory / 'baros.dump'
    temporary = directory / 'baros.dump.partial'
    with psycopg.connect(url) as db:
        db.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        db.execute("SET LOCAL TIME ZONE 'UTC'")
        snapshot = db.execute('SELECT pg_export_snapshot()').fetchone()[0]
        run_tool('pg_dump', url, '--format=custom', '--no-owner', '--no-acl',
                 '--snapshot=' + snapshot, '--file=' + str(temporary))
        tables = inventory(db)
        version = db.execute('SHOW server_version').fetchone()[0]
    temporary.chmod(0o600)
    run_tool('pg_restore', url, '--list', temporary)
    manifest = {'format': 'baros-postgres-backup', 'version': 1,
                'created_at': datetime.now(timezone.utc).isoformat(),
                'server_version': version, 'archive_sha256': file_hash(temporary),
                'tables': tables}
    archive_tmp = directory / 'manifest.json.partial'
    archive_tmp.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    archive_tmp.chmod(0o600)
    temporary.rename(archive)
    archive_tmp.rename(directory / 'manifest.json')
    print(f'Backup created: {len(tables)} tables; archive and manifest are required together')


def verify(variable, directory):
    url = connection(variable)
    archive = directory / 'baros.dump'
    manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('format') != 'baros-postgres-backup' or manifest.get('version') != 1:
        raise ValueError('Unsupported backup manifest')
    if file_hash(archive) != manifest['archive_sha256']:
        raise ValueError('Archive checksum does not match; nothing restored')
    with psycopg.connect(url) as db:
        # Any existing user relation means this is not an empty verification target.
        populated = db.execute("""SELECT EXISTS(SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema')""").fetchone()[0]
        if populated:
            raise ValueError('Restore verification requires a separate empty database')
    run_tool('pg_restore', url, '--dbname=' + conninfo_to_dict(url)['dbname'],
             '--single-transaction', '--exit-on-error', '--no-owner', '--no-acl', archive)
    with psycopg.connect(url) as db:
        db.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        db.execute("SET LOCAL TIME ZONE 'UTC'")
        actual = inventory(db)
    if actual != manifest['tables']:
        raise RuntimeError('Restored row counts or content hashes differ from the source snapshot')
    print(f'Restore verified: {len(actual)} tables; all row counts and content hashes match')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['backup', 'verify'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('--database-env', default=None, help='Environment variable name, never the URL')
    args = parser.parse_args()
    variable = args.database_env or ('DATABASE_URL' if args.action == 'backup' else 'RESTORE_TEST_DATABASE_URL')
    try:
        if args.action == 'backup':
            backup(variable, args.directory)
        else:
            verify(variable, args.directory)
    except (Exception, KeyboardInterrupt) as exc:
        # Avoid traceback/DSN leakage; no credentials or database rows in operator output.
        detail = str(exc) if isinstance(exc, (ValueError, RuntimeError)) else type(exc).__name__
        print('Backup operation stopped: ' + detail, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
