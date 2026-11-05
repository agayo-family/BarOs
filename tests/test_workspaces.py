"""Regression checks for multi-venue scope, revocation and group distribution."""
import copy
import re
import unittest

import test_packages as fixtures
from sqlalchemy import select

from baros.db import SessionLocal
from baros.models import Course, Organization
from baros.security import hash_password
from baros.v2.models import Account, CourseMedia, VenueSettings, WrittenAttempt
from baros.v2.workspaces import migrate_memberships


class WorkspaceTests(unittest.TestCase):
    setUp = fixtures.PackageTests.setUp
    tearDown = fixtures.PackageTests.tearDown
    login = fixtures.PackageTests.login

    def request(self, method, path, data=None, oid=None, status=200):
        headers = dict(self.headers)
        if oid is not None:
            headers['x-organization-id'] = str(oid)
        result = self.client.request(method, '/api' + path, json=data, headers=headers)
        self.assertEqual(result.status_code, status, result.text[:700])
        if result.headers.get('content-type', '').startswith('application/json'):
            return result.json()
        return result.content

    def configure(self):
        with SessionLocal() as db:
            self.second = db.get(Account, self.ids['foreign']).organization_id
            third = Organization(name='Чужая точка')
            db.add(third)
            db.flush()
            self.third = third.id
            db.add(VenueSettings(organization_id=third.id, join_code='NETWORKTHIRD'))
            db.add(Account(name='Администратор теста', login='network.owner', role='owner',
                           password_hash=hash_password('test-import-password')))
            db.add(Account(name='Вторая команда', login='second.worker', role='employee',
                           organization_id=self.second, positions_json='["bartender"]',
                           password_hash=hash_password('test-import-password')))
            db.commit()
        self.login('network.owner')

    def grant(self, oid, active=True, permissions=None, login='manager'):
        self.request('PUT', f'/owner/venues/{oid}/access',
                     {'login': login, 'active': active, 'permissions': permissions or {}})

    def group(self, name, venues, people=()):
        gid = self.request('POST', '/owner/groups', {'name': name})['id']
        for oid in venues:
            self.request('PUT', f'/owner/groups/{gid}/venues/{oid}', {'active': True})
        for login, role in people:
            self.request('PUT', f'/owner/groups/{gid}/people', {'login': login, 'role': role})
        return gid

    def test_each_request_selects_only_authorized_point(self):
        self.configure()
        self.grant(self.second)
        self.login('manager')
        me = self.request('GET', '/me')
        self.assertEqual({v['id'] for v in me['workspaces']['venues']}, {self.oid, self.second})
        self.assertEqual(self.request('GET', '/venue')['id'], self.oid)
        self.assertEqual(self.request('GET', '/venue', oid=self.second)['id'], self.second)
        course = fixtures.COURSE['course']
        one = self.request('POST', '/courses', course, oid=self.oid)['id']
        two = self.request('POST', '/courses', course, oid=self.second)['id']
        self.request('GET', f'/courses/{one}', oid=self.second, status=404)
        self.request('GET', f'/courses/{two}', oid=self.oid, status=404)
        for path in ['/venue','/staff','/courses','/reports/analytics','/sources','/export','/support']:
            self.request('GET', path, oid=self.third, status=403)
        self.request('GET', '/venue', oid='00'+str(self.second), status=403)
        for path in ['/sources','/export','/reports/analytics/export','/shifts/context']:
            self.request('GET', path, oid=self.second, status=403)
        export_url = '/shifts/export/csv?start=2026-11-01&end=2026-11-10&account_id=0'
        self.request('GET', '/export', oid=self.oid)
        self.login('network.owner')
        self.grant(self.second, permissions={'shifts_manage':True})
        self.login('manager')
        self.request('GET', '/shifts/context', oid=self.second)
        self.request('GET', export_url, oid=self.second, status=403)
        self.login('network.owner')
        self.grant(self.second, permissions={'exports_access':True,'uploads_manage':True,'shifts_manage':True})
        self.login('manager')
        for path in ['/sources','/export','/reports/analytics/export','/shifts/context']:
            self.request('GET', path, oid=self.second)
        self.request('GET', export_url, oid=self.second)
        self.login('worker')
        self.request('GET', '/learning', oid=self.second, status=403)
        self.request('GET', '/workspaces/overview', status=403)

    def test_revocation_blocks_existing_session_and_survives_backfill(self):
        self.configure()
        self.grant(self.second)
        self.login('manager')
        self.request('GET', '/courses', oid=self.second)
        manager_cookie = self.client.cookies.get('baros_v2_session')
        csrf = dict(self.headers)
        self.login('network.owner')
        self.grant(self.second, False)
        self.grant(self.oid, False)
        with SessionLocal() as db:
            migrate_memberships(db)
            migrate_memberships(db)
            db.commit()
        self.client.cookies.clear()
        self.client.cookies.set('baros_v2_session', manager_cookie)
        self.headers = csrf
        self.request('POST', '/courses', fixtures.COURSE['course'], oid=self.second, status=403)
        self.request('GET', '/venue', status=403)
        self.assertEqual(self.request('GET', '/me')['workspaces']['venues'], [])
        self.assertEqual(self.request('GET', '/workspaces/overview')['totals']['employees'], 0)

    def test_group_scope_and_delegation(self):
        self.configure()
        gid = self.group('Группа А', [self.oid, self.second], [('manager','lead'),('foreign','manager')])
        other = self.group('Группа Б', [self.third])
        self.login('manager')
        result = self.request('GET', f'/workspaces/overview?group_id={gid}')
        self.assertEqual({v['id'] for v in result['venues']}, {self.oid,self.second})
        self.assertEqual(result['totals']['employees'], 4)
        self.assertEqual(result['totals']['ready'], 0)
        self.assertEqual(self.request('GET', f'/workspaces/overview?group_id={gid}&position=waiter')['totals']['employees'], 1)
        self.request('GET', '/staff', oid=self.second, status=403)
        self.request('GET', f'/workspaces/groups/{other}', status=404)
        self.request('GET', '/owner/groups', status=403)
        endpoint = f'/workspaces/groups/{gid}/venues/{self.oid}/access'
        self.request('PUT', endpoint, {'login':'foreign','active':True,'permissions':{'shifts_manage':True}}, status=403)
        self.request('PUT', endpoint, {'login':'foreign','active':True})
        self.login('foreign')
        self.request('GET', '/venue', oid=self.oid)
        self.request('PUT', endpoint, {'login':'foreign','active':True}, status=403)
        self.login('network.owner')
        self.request('PUT', f'/owner/groups/{gid}/venues/{self.oid}', {'active':False})
        self.request('PUT', f'/owner/groups/{gid}/venues/{self.oid}', {'active':True})
        self.login('foreign')
        self.request('GET', '/venue', oid=self.oid, status=403)

    def test_group_versions_deliver_private_drafts_and_keep_local_edits(self):
        self.configure()
        gid = self.group('Группа А', [self.oid, self.second], [('manager','methodist')])
        self.grant(self.second)
        mid = 'test_private_photo_group_001'
        with SessionLocal() as db:
            db.add(CourseMedia(id=mid, organization_id=self.oid, creator_id=self.ids['manager'],
                               content=b'private fixture bytes', mime='image/jpeg', size=21))
            db.commit()
        self.login('manager')
        base = f'/workspaces/groups/{gid}/standards'
        course = copy.deepcopy(fixtures.COURSE['course'])
        course['lessons'][0]['body'] += f'\n![Фото](/api/media/{mid})'
        self.request('POST', base, {'course':course,'source_venue':self.second}, status=403)
        first = self.request('POST', base, {'course':course,'source_venue':self.oid})
        distribution = f"{base}/{first['id']}/distribute"
        self.request('POST', distribution, {'venues':[self.second,self.third]}, status=403)
        row = self.request('POST', distribution, {'venues':[self.second]})['items'][0]
        cid = row['course_id']
        self.assertTrue(self.request('POST', distribution, {'venues':[self.second]})['items'][0]['existing'])
        item = self.request('GET', f'/courses/{cid}', oid=self.second)
        self.assertEqual(item['group_standard']['version'], 1)
        delivery = self.request('GET', f'/workspaces/groups/{gid}')['standards'][0]['deliveries']
        self.assertEqual([(row['venue_id'], row['state'], row['edited']) for row in delivery], [(self.second,'draft',False)])
        private_copy = re.search(r'/api/media/([\w-]+)',item['lessons'][0]['body'])[1]
        self.assertNotEqual(private_copy, mid)
        self.request('GET', f'/media/{private_copy}?venue={self.second}')
        self.request('GET', f'/media/{private_copy}', oid=self.oid, status=404)
        with SessionLocal() as db:
            existing = db.get(Course, cid)
            self.assertFalse(existing.published)
            existing.title = 'Местная редакция'
            db.commit()
        latest = self.request('POST', base, {'course':course,'source_venue':self.oid,
                                            'key':first['key'],'expected_version':1})
        self.request('POST', base, {'course':course,'source_venue':self.oid,
                                   'key':first['key'],'expected_version':1}, status=409)
        new = self.request('POST', f"{base}/{latest['id']}/distribute", {'venues':[self.second]})['items'][0]
        self.assertNotEqual(cid, new['course_id'])
        self.assertEqual(self.request('GET', f'/courses/{cid}', oid=self.second)['title'], 'Местная редакция')

    def test_overview_queue_is_personal_only_with_direct_access(self):
        self.configure()
        gid = self.group('Группа А', [self.oid, self.second], [('manager','lead')])
        self.login('foreign')
        aid = self.request('POST', '/packages/import', {'package':fixtures.PACKAGE})['id']
        self.request('POST', f'/assessments/{aid}/publish', {'reviewed':True})
        self.login('second.worker')
        entry = self.request('POST', f'/assessments/{aid}/start', {})
        with SessionLocal() as db:
            attempt = db.get(WrittenAttempt, entry['id'])
            attempt.status = 'submitted'
            db.commit()
        self.login('manager')
        report = self.request('GET', f'/workspaces/overview?group_id={gid}')
        self.assertEqual(report['totals']['pending_review'], 1)
        self.assertEqual(report['queue'], [])
        self.assertNotIn('second.worker', str(report))
        self.login('network.owner')
        self.grant(self.second)
        self.login('manager')
        report = self.request('GET', f'/workspaces/overview?group_id={gid}')
        self.assertEqual(report['queue'][0]['venue_id'], self.second)
        self.assertEqual(report['queue'][0]['id'], entry['id'])
