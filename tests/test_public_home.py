"""Commercial settings stay private to the owner and never grant paid access."""
import unittest
from sqlalchemy import select
import test_packages as fixtures
from baros.db import SessionLocal
from baros.v2.models import Account, VenueSettings, Setting
from baros.security import hash_password


class PublicHomeTests(unittest.TestCase):
    setUp = fixtures.PackageTests.setUp
    tearDown = fixtures.PackageTests.tearDown
    login = fixtures.PackageTests.login

    def owner(self):
        with SessionLocal() as db:
            db.add(Account(role='owner', login='pricing.owner', name='Владелец',
                           password_hash=hash_password('test-import-password')))
            db.commit()
        self.login('pricing.owner')

    def save(self, version=0, prices=None, **extra):
        return self.client.put('/api/owner/pricing', headers=self.headers,
                               json={'version': version, 'prices': prices or [10000, 15000, 25000], **extra})

    def test_public_read_contains_no_account_or_secret_and_defaults(self):
        self.client.cookies.clear()
        r = self.client.get('/api/pricing')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['tiers'], [{'employees': 50, 'monthly': 9900},
                                             {'employees': 100, 'monthly': 14900},
                                             {'employees': 200, 'monthly': 24900}])
        self.assertNotIn('csrf', r.text)
        self.assertNotIn('account', r.text)
        self.assertEqual(r.headers['cache-control'], 'no-store')

    def test_only_owner_can_change_prices(self):
        for name in ['manager', 'worker', 'foreign']:
            self.login(name)
            self.assertEqual(self.save().status_code, 403)
        self.client.cookies.clear()
        self.assertEqual(self.save().status_code, 401)
        self.assertEqual(self.client.get('/api/pricing').json()['version'], 0)

    def test_owner_edit_persists_and_conflict_preserves_newer_prices(self):
        self.owner()
        r = self.save(contact_email='sales@example.org')
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()['version'], 1)
        self.assertEqual(self.save().status_code, 409)
        self.client.cookies.clear()
        r = self.client.get('/api/pricing').json()
        self.assertEqual(r['contact_email'], 'sales@example.org')
        self.assertEqual(r['tiers'][0]['monthly'], 10000)

    def test_validation_csrf_and_cross_site_request_cannot_publish(self):
        self.owner()
        self.assertEqual(self.client.put('/api/owner/pricing', json={'version': 0, 'prices': [1, 2, 3]}).status_code, 403)
        for prices in [[0, 100, 200], [200, 100, 300], [100, 100, 300], [100, 200], [True, 200, 300], ['100', 200, 300], [100, 200, 1000001]]:
            self.assertEqual(self.save(prices=prices).status_code, 422, prices)
        for email in ['javascript:alert(1)', 'x@example.org?cc=other@example.org', 'x@example.org\nBCC:other@example.org']:
            self.assertEqual(self.save(contact_email=email).status_code, 422)
        self.assertEqual(self.client.put('/api/owner/pricing', headers={**self.headers, 'origin':'https://other.example'}, json={'version':0,'prices':[100,200,300]}).status_code, 403)

    def test_public_price_changes_never_change_venue_subscription(self):
        with SessionLocal() as db:
            before = [(v.organization_id, v.plan, v.seat_limit, v.subscription_status, v.paid_until) for v in db.scalars(select(VenueSettings)).all()]
        self.owner()
        self.assertEqual(self.save().status_code, 200)
        with SessionLocal() as db:
            after = [(v.organization_id, v.plan, v.seat_limit, v.subscription_status, v.paid_until) for v in db.scalars(select(VenueSettings)).all()]
            self.assertTrue(db.get(Setting, 'public_pricing').value)
        self.assertEqual(before, after)

    def test_public_and_existing_entry_routes_still_serve_app(self):
        for path in ['/', '/about', '/login', '/join', '/owner-recovery', '/first-run', '/invite/example', '/app', '/app/pricing']:
            r = self.client.get(path)
            self.assertEqual(r.status_code, 200, path)
            self.assertIn('app.js', r.text)
