"""Recovery is authorized by a server key and must preserve the existing account."""
import importlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_temporary = tempfile.TemporaryDirectory(prefix='baros-recovery-test-')
os.environ['DATABASE_URL'] = 'sqlite:///' + str(Path(_temporary.name) / 'test.db')
os.environ['BAROS_WORKER'] = '0'
os.environ['COOKIE_SECURE'] = '0'

from fastapi.testclient import TestClient
from sqlalchemy import select
from baros.db import Base, engine, SessionLocal
from baros.models import Organization, Course
from baros.security import hash_password, verify_password
from baros.v2.models import Account, LoginSession, Setting, Event, RateBucket
from baros.v2.domain import digest

module = importlib.import_module('baros.v2.app')
TOKEN = 'test-only-random-recovery-token-123456789'
OLD_PASSWORD = 'test-only-old-password'
NEW_PASSWORD = 'test-only-new-password'


class OwnerRecoveryTests(unittest.TestCase):
    def setUp(self):
        Base.metadata.drop_all(engine)
        self.key_patch = patch.object(module, 'FIRST_RUN_TOKEN', TOKEN)
        self.key_patch.start()
        self.client = TestClient(module.app)
        self.client.__enter__()
        with SessionLocal() as db:
            venue = Organization(name='Existing venue')
            db.add(venue)
            db.flush()
            account = Account(name='Existing owner', login='forgotten@example.test',
                              role='owner', password_hash=hash_password(OLD_PASSWORD))
            other = Account(name='Other account', login='reserved', role='manager',
                            organization_id=venue.id, password_hash=hash_password(OLD_PASSWORD))
            course = Course(organization_id=venue.id, title='Existing course')
            db.add_all([account, other, course])
            db.commit()
            self.owner_id, self.venue_id, self.course_id = account.id, venue.id, course.id
        self.assertEqual(self.client.post('/api/auth/login', json={
            'login': 'forgotten@example.test', 'password': OLD_PASSWORD}).status_code, 200)
        self.previous_session = dict(self.client.cookies)
        self.client.cookies.clear()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.key_patch.stop()

    def recover(self, **changes):
        payload = {'token': TOKEN, 'login': 'new.owner', 'password': NEW_PASSWORD}
        payload.update(changes)
        return self.client.post('/api/auth/owner-recovery', json=payload)

    def test_wrong_key_does_not_disclose_or_change_account(self):
        self.assertEqual(self.recover(token='неверный ключ').status_code, 403)
        with SessionLocal() as db:
            owner = db.get(Account, self.owner_id)
            self.assertEqual(owner.login, 'forgotten@example.test')
            self.assertTrue(verify_password(OLD_PASSWORD, owner.password_hash))
            self.assertIsNone(db.get(Setting, 'owner_recovery_token_used'))

    def test_disabled_or_weak_server_key_cannot_recover(self):
        for key in ['', 'short-key']:
            with patch.object(module, 'FIRST_RUN_TOKEN', key):
                self.assertFalse(self.client.get('/api/public').json()['owner_recovery_configured'])
                self.assertEqual(self.recover().status_code, 503)

    def test_validation_and_conflicting_login_do_not_spend_key(self):
        self.assertEqual(self.recover(password='short').status_code, 422)
        self.assertEqual(self.recover(login='reserved').status_code, 409)
        self.assertEqual(self.recover().status_code, 200)

    def test_recovery_preserves_data_revokes_sessions_and_rejects_replay(self):
        response = self.recover()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'ok': True, 'login': 'new.owner'})
        self.assertEqual(self.client.get('/api/me').json()['account']['id'], self.owner_id)
        with SessionLocal() as db:
            owner = db.get(Account, self.owner_id)
            self.assertTrue(verify_password(NEW_PASSWORD, owner.password_hash))
            self.assertFalse(verify_password(OLD_PASSWORD, owner.password_hash))
            self.assertEqual(owner.name, 'Existing owner')
            self.assertEqual(db.get(Organization, self.venue_id).name, 'Existing venue')
            self.assertEqual(db.get(Course, self.course_id).title, 'Existing course')
            self.assertEqual(db.scalar(select(Account).where(Account.login=='reserved')).role, 'manager')
            self.assertEqual(len(db.scalars(select(LoginSession).where(LoginSession.account_id==owner.id)).all()), 1)
            self.assertEqual(db.get(Setting, 'owner_recovery_token_used').value, digest(TOKEN))
            audit = db.scalars(select(Event)).all()
            self.assertTrue(any(e.action=='Владелец восстановил доступ' for e in audit))
            self.assertFalse(any(TOKEN in e.details or NEW_PASSWORD in e.details for e in audit))
        self.assertEqual(self.recover(password='test-only-another-password').status_code, 409)
        self.client.cookies.clear()
        self.client.cookies.update(self.previous_session)
        self.assertEqual(self.client.get('/api/me').status_code, 401)
        self.client.cookies.clear()
        self.assertEqual(self.client.post('/api/auth/login', json={
            'login': 'forgotten@example.test', 'password': OLD_PASSWORD}).status_code, 401)
        self.assertEqual(self.client.post('/api/auth/login', json={
            'login': 'new.owner', 'password': NEW_PASSWORD}).status_code, 200)

    def test_rotation_and_rate_limit(self):
        self.assertEqual(self.recover().status_code, 200)
        rotated = TOKEN + '-rotated'
        with patch.object(module, 'FIRST_RUN_TOKEN', rotated):
            self.assertEqual(self.recover(token=TOKEN).status_code, 403)
            self.assertEqual(self.recover(token=rotated).status_code, 200)
        with SessionLocal() as db:
            db.query(RateBucket).delete()
            db.commit()
        for _ in range(5):
            self.assertEqual(self.recover(token='invalid').status_code, 403)
        self.assertEqual(self.recover(token='invalid').status_code, 429)

    def test_cross_site_request_is_blocked(self):
        result = self.client.post('/api/auth/owner-recovery', json={
            'token': TOKEN, 'login': 'new.owner', 'password': NEW_PASSWORD},
            headers={'origin': 'https://unrelated.example'})
        self.assertEqual(result.status_code, 403)


if __name__ == '__main__':
    unittest.main()
