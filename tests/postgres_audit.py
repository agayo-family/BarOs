"""Concurrency against a disposable PostgreSQL, never a deployed database."""
from concurrent.futures import ThreadPoolExecutor
import importlib
import os
from pathlib import Path
import sys
import unittest
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

url = os.environ.get('BAROS_POSTGRES_TEST_DATABASE_URL', '')
parsed = urlparse(url)
if parsed.hostname not in {'localhost', '127.0.0.1', 'postgres'} or parsed.path != '/baros_test':
    raise SystemExit('Requires a local disposable PostgreSQL database named baros_test')
os.environ.update(DATABASE_URL=url, BAROS_WORKER='0', COOKIE_SECURE='0',
                  FIRST_RUN_TOKEN='postgres-disposable-setup-only', SESSION_SECRET='postgres-disposable-session-only')
from fastapi.testclient import TestClient
from sqlalchemy import select, func
from baros.db import Base, engine, SessionLocal
from baros.models import Organization, Employee
from baros.v2.models import Account, VenueSettings

app = importlib.import_module('baros.v2.app').app
PASSWORD = 'postgres-disposable-password'


class PostgresConcurrencyTests(unittest.TestCase):
    def setUp(self):
        Base.metadata.drop_all(engine)
        self.client = TestClient(app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)

    def parallel(self, fn):
        with ThreadPoolExecutor(max_workers=2) as pool:
            return sorted(pool.map(fn, range(2)))

    def venues(self, limit=50):
        with SessionLocal() as db:
            ids=[]
            for i in range(2):
                o=Organization(name='Local concurrent venue '+str(i));db.add(o);db.flush()
                db.add(VenueSettings(organization_id=o.id,join_code='CONCURRENT'+str(i),seat_limit=limit));ids.append(o.id)
            db.commit()
        return ids

    def join(self, login, code):
        with TestClient(app) as c:
            return c.post('/api/auth/join',json={'code':code,'name':'Concurrent learner',
                          'login':login,'password':PASSWORD,'positions':['bartender']}).status_code

    def test_first_run_creates_exactly_one_owner(self):
        def setup(i):
            # Lifespan is already active; do not race schema initialization.
            c=TestClient(app)
            return c.post('/api/auth/setup',json={'token':os.environ['FIRST_RUN_TOKEN'],
                'login':'concurrent.owner'+str(i),'name':'Local owner','password':PASSWORD}).status_code
        self.assertEqual(self.parallel(setup),[200,409])
        with SessionLocal() as db:
            self.assertEqual(db.scalar(select(func.count(Account.id)).where(Account.role=='owner')),1)

    def test_last_seat_cannot_be_double_booked(self):
        self.venues(limit=1)
        def signup(i):
            c=TestClient(app)
            return c.post('/api/auth/join',json={'code':'CONCURRENT0','name':'Concurrent learner',
                'login':'last.seat'+str(i),'password':PASSWORD,'positions':['bartender']}).status_code
        self.assertEqual(self.parallel(signup),[200,409])
        with SessionLocal() as db:
            self.assertEqual(db.scalar(select(func.count(Account.id))),1)
            self.assertEqual(db.scalar(select(func.count(Employee.id))),1)

    def test_duplicate_login_across_venues_is_409_and_leaves_no_orphan(self):
        self.venues()
        def signup(i):
            c=TestClient(app)
            return c.post('/api/auth/join',json={'code':'CONCURRENT'+str(i),'name':'Concurrent learner',
                'login':'same.login','password':PASSWORD,'positions':['bartender']}).status_code
        self.assertEqual(self.parallel(signup),[200,409])
        with SessionLocal() as db:
            self.assertEqual(db.scalar(select(func.count(Account.id))),1)
            self.assertEqual(db.scalar(select(func.count(Employee.id))),1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
