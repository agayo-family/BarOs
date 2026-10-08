import importlib
import os
import tempfile
import unittest
from datetime import timedelta
from fastapi.testclient import TestClient
from sqlalchemy import select, func

os.environ.setdefault('DATABASE_URL', 'sqlite:///'+tempfile.mktemp(prefix='baros-shifts-', suffix='.db'))
os.environ['BAROS_WORKER'] = '0'
from baros.db import Base, engine, SessionLocal
from baros.models import Organization
from baros.security import hash_password
from baros.v2.models import Account, VenueSettings, ShiftEntry, Notice
from baros.v2.domain import now, dump
from baros.v2.shifts import remind_shifts

app = importlib.import_module('baros.v2.app').app


class ShiftTests(unittest.TestCase):
    def setUp(self):
        Base.metadata.drop_all(engine)
        self.client = TestClient(app); self.client.__enter__()
        with SessionLocal() as db:
            org = Organization(name='Shift venue'); foreign = Organization(name='Foreign'); db.add_all([org, foreign]); db.flush()
            self.oid, self.foreign = org.id, foreign.id
            db.add_all([VenueSettings(organization_id=org.id, join_code='SHIFTTEST1'), VenueSettings(organization_id=foreign.id, join_code='SHIFTTEST2')])
            self.accounts = {}
            for login, role, oid in [('manager','manager',org.id), ('worker','employee',org.id), ('peer','employee',org.id), ('foreign','employee',foreign.id), ('owner','owner',None)]:
                a = Account(login=login, name=login, role=role, organization_id=oid, password_hash=hash_password('shift-test-password'))
                db.add(a); db.flush(); self.accounts[login] = a.id
            db.commit()
        self.login('worker')

    def tearDown(self): self.client.__exit__(None, None, None)

    def login(self, who):
        r = self.client.post('/api/auth/login', json={'login':who, 'password':'shift-test-password'})
        self.assertEqual(r.status_code, 200, r.text)
        self.headers = {'x-csrf-token':self.client.get('/api/me').json()['csrf']}
        if who == 'owner': self.headers['x-organization-id'] = str(self.oid)

    def put(self, path, body): return self.client.put('/api/shifts'+path, json=body, headers=self.headers)
    def post(self, path, body): return self.client.post('/api/shifts'+path, json=body, headers=self.headers)
    def shift(self, **kw):
        return dict(title='Night', day='2026-10-08', start_time='22:00', end_time='06:00', end_day_offset=1,
                    break_minutes=30, hourly_rate=30000, overtime_after=360, overtime_percent=150, allowance=5000, **kw)
    def create(self, body=None):
        r = self.post('', body or self.shift()); self.assertEqual(r.status_code, 200, r.text); return r.json()
    def body(self, row, **kw):
        fields = ('title','kind','color','emoji','start_time','end_time','end_day_offset','break_minutes','allowance','location','timezone','currency','hourly_rate','overtime_after','overtime_percent','reminder_minutes','day','account_id','status','tips','notes','actual_start','actual_end','actual_break','version')
        return {**{k:row[k] for k in fields}, **kw}
    def report(self, aid=None, start='2026-10-01', end='2026-10-31'):
        query = f'?start={start}&end={end}'+(f'&account_id={aid}' if aid is not None else '')
        return self.client.get('/api/shifts'+query, headers=self.headers)

    def test_overnight_break_overtime_and_actual_earnings(self):
        row = self.create(); self.assertEqual(row['planned_minutes'], 450)
        self.assertEqual(row['starts_at'], '2026-10-08T19:00:00Z'); self.assertEqual(row['ends_at'], '2026-10-09T03:00:00Z')
        self.assertEqual(row['forecast'], 252500); self.assertEqual(row['earned'], 0)
        r = self.put(f'/{row["id"]}/fact', {'version':row['version'], 'status':'completed', 'actual_start':'2026-10-08T19:00:00Z', 'actual_end':'2026-10-09T04:00:00Z', 'actual_break':30, 'tips':12000})
        self.assertEqual(r.status_code, 200, r.text); self.assertEqual(r.json()['actual_minutes'], 510)
        self.assertEqual(r.json()['earned'], 309500); self.assertEqual(r.json()['actual_overtime_minutes'],150)
        summary = self.report().json()['summary']; self.assertEqual(summary['actual_minutes'],510)
        self.assertEqual(summary['currencies']['RUB']['earned'],309500)

    def test_employee_sees_only_self_manager_sees_team_owner_remote(self):
        row = self.create(); self.assertEqual(self.report(self.accounts['peer']).status_code,403)
        self.assertEqual(self.report(0).status_code,403)
        self.assertEqual(self.post('',self.shift(account_id=self.accounts['peer'])).status_code,403)
        self.login('peer'); self.assertEqual(self.put('/'+str(row['id']),self.body(row)).status_code,404)
        self.login('manager'); self.assertEqual(len(self.report(0).json()['shifts']),1)
        self.assertEqual(self.post('',self.shift(account_id=self.accounts['foreign'])).status_code,404)
        self.login('owner'); self.assertEqual(len(self.report(0).json()['shifts']),1)
        self.headers['x-organization-id']=str(self.foreign); self.assertEqual(self.put('/'+str(row['id']),self.body(row)).status_code,404)

    def test_assigned_shift_plan_protected_employee_can_record_fact(self):
        self.login('manager'); row = self.create(self.shift(account_id=self.accounts['worker']))
        self.login('worker'); self.assertEqual(self.put('/'+str(row['id']),self.body(row,title='Changed')).status_code,403)
        self.assertEqual(self.client.delete(f'/api/shifts/{row["id"]}?version=1',headers=self.headers).status_code,403)
        r=self.put(f'/{row["id"]}/fact',{'version':1,'status':'completed','tips':500}); self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(r.json()['title'],'Night'); self.assertEqual(r.json()['actual_minutes'],450)
        self.assertEqual(r.json()['earned'],253000)
        self.assertEqual(self.put(f'/{row["id"]}/fact',{'version':1,'status':'completed'}).status_code,409)

    def test_overlap_split_shifts_cancel_and_optimistic_lock(self):
        row=self.create(); other=self.shift();other.update(start_time='23:00',end_time='07:00')
        self.assertEqual(self.post('',other).status_code,409)
        early=self.shift();early.update(start_time='09:00',end_time='17:00',end_day_offset=0)
        self.create(early)
        r=self.put('/'+str(row['id']),self.body(row,status='cancelled'));self.assertEqual(r.status_code,200)
        self.assertEqual(r.json()['forecast'],0);self.create(other)
        self.assertEqual(self.put('/'+str(row['id']),self.body(row)).status_code,409)
        self.assertEqual(self.client.delete(f'/api/shifts/{row["id"]}?version=1',headers=self.headers).status_code,409)
        self.assertEqual(self.client.delete(f'/api/shifts/{row["id"]}?version=2',headers=self.headers).status_code,200)

    def test_validation_invalid_duration_timezone_actual_and_money(self):
        for updates in [{'end_day_offset':0}, {'break_minutes':500}, {'hourly_rate':-1}, {'timezone':'bad/zone'},
                        {'actual_start':'2026-10-08T19:00:00Z'}, {'status':'completed','actual_start':'2026-10-08T19:00:00','actual_end':'2026-10-09T04:00:00'},
                        {'status':'completed','actual_break':500}]:
            body=self.shift();body.update(updates);self.assertIn(self.post('',body).status_code,(400,422))
        # DST gap in Europe/Berlin, while Moscow has no transition.
        body=self.shift();body.update(day='2026-03-29',start_time='02:30',end_time='10:00',end_day_offset=0,timezone='Europe/Berlin')
        self.assertEqual(self.post('',body).status_code,400)
        self.assertEqual(self.report(start='2026-10-31',end='2026-10-01').status_code,400)
        self.assertEqual(self.report(start='2020-01-01',end='2026-10-01').status_code,400)

    def test_templates_visibility_versions_and_snapshot(self):
        private=self.post('/templates',{'title':'Private'}).json()
        self.login('peer');self.assertEqual(self.client.get('/api/shifts/context').json()['templates'],[])
        self.login('manager');shared=self.post('/templates',{'title':'Shared','hourly_rate':25000}).json()
        self.login('worker');templates=self.client.get('/api/shifts/context').json()['templates'];self.assertEqual(len(templates),2)
        self.assertEqual(self.put('/templates/'+str(shared['id']),{'title':'Bad','version':1}).status_code,403)
        r=self.put('/templates/'+str(private['id']),{'title':'Updated','version':1});self.assertEqual(r.status_code,200)
        self.assertEqual(self.put('/templates/'+str(private['id']),{'title':'Stale','version':1}).status_code,409)
        self.assertEqual(self.client.delete(f'/api/shifts/templates/{private["id"]}?version=2',headers=self.headers).status_code,200)
        row=self.create();self.put('/preferences',{'hourly_rate':90000})
        self.assertEqual(self.report().json()['shifts'][0]['hourly_rate'],30000)

    def test_rotation_preview_atomic_conflicts_and_custom_pattern(self):
        t=self.post('/templates',{'title':'Day','start_time':'09:00','end_time':'17:00'}).json()
        body={'start':'2026-10-01','end':'2026-10-08','pattern':[t['id'],t['id'],None,None]}
        preview=self.post('/rotations/preview',body);self.assertEqual(preview.status_code,200,preview.text)
        self.assertEqual(preview.json()['count'],4);self.assertEqual(preview.json()['conflicts'],0)
        self.assertEqual(self.post('/rotations',body).json()['created'],4)
        self.assertEqual(self.post('/rotations/preview',body).json()['conflicts'],4)
        self.assertEqual(self.post('/rotations',body).status_code,409);self.assertEqual(len(self.report().json()['shifts']),4)
        # An early successful insertion must roll back when a later date conflicts.
        body.update(start='2026-09-30',end='2026-10-02',pattern=[t['id']])
        self.assertEqual(self.post('/rotations',body).status_code,409)
        self.assertEqual(len(self.report(start='2026-09-30',end='2026-10-31').json()['shifts']),4)
        self.assertEqual(self.post('/rotations',{**body,'pattern':[999]}).status_code,404)
        self.assertEqual(self.post('/rotations',{**body,'pattern':[None]}).status_code,400)

    def test_leave_counts_currency_separation_month_boundary_rounding(self):
        leave=self.shift(kind='vacation',status='completed');self.create(leave)
        work=self.shift();work.update(day='2026-10-31',hourly_rate=100,break_minutes=0,start_time='23:00',end_time='00:01',overtime_after=0,currency='USD',allowance=0,status='completed')
        row=self.create(work);self.assertEqual(row['earned'],102)
        s=self.report().json()['summary'];self.assertEqual(s['count'],1);self.assertEqual(s['kinds']['vacation']['count'],1)
        self.assertEqual(s['currencies']['RUB']['earned'],5000);self.assertEqual(s['currencies']['USD']['earned'],102)
        self.assertEqual(self.report(start='2026-11-01',end='2026-11-30').json()['summary']['count'],0)

    def test_exports_private_scope_csv_formula_and_ics_injection(self):
        body=self.shift();body.update(title='=HYPERLINK("bad")',notes='Hello\nEND:VEVENT\nBEGIN:BAD',location='Hall; 1,2')
        row=self.create(body)
        params='?start=2026-10-01&end=2026-10-31'
        csv=self.client.get('/api/shifts/export/csv'+params);self.assertEqual(csv.status_code,200);self.assertIn("'=HYPERLINK",csv.text)
        ics=self.client.get('/api/shifts/export/ics'+params);self.assertEqual(ics.status_code,200)
        self.assertEqual(ics.text.count('\r\nBEGIN:VEVENT\r\n'),1)
        self.assertIn('Hello\\nEND:VEVENT\\nBEGIN:BAD',ics.text);self.assertNotIn('hourly_rate',ics.text)
        self.assertIn('20261008T190000Z',ics.text);self.assertIn('Hall\\; 1\\,2',ics.text)
        self.assertTrue(all(len(l.encode())<=75 for l in ics.text.split('\r\n')))
        self.assertIn('TRIGGER:-PT60M',ics.text)
        self.assertEqual(self.client.get('/api/shifts/export/csv'+params+'&account_id='+str(self.accounts['peer'])).status_code,403)

    def test_leave_calendar_export_is_all_day(self):
        self.create(self.shift(kind='vacation'))
        response=self.client.get('/api/shifts/export/ics?start=2026-10-01&end=2026-10-31')
        self.assertEqual(response.status_code,200)
        self.assertIn('DTSTART;VALUE=DATE:20261008',response.text)
        self.assertIn('DTEND;VALUE=DATE:20261009',response.text)
        self.assertNotIn('VALARM',response.text)

    def test_venue_access_permissions_csrf_and_subscription(self):
        self.assertEqual(self.client.post('/api/shifts',json=self.shift()).status_code,403)
        self.assertEqual(self.client.get('/api/shifts/context',headers={'x-organization-id':str(self.foreign)}).status_code,403)
        with SessionLocal() as db:db.get(VenueSettings,self.oid).subscription_status='past_due';db.commit()
        self.assertEqual(self.report().status_code,402);self.assertEqual(self.post('',self.shift()).status_code,402)
        self.login('owner');self.assertEqual(self.report(0).status_code,200)
        self.login('manager')
        with SessionLocal() as db:
            v=db.get(VenueSettings,self.oid);v.subscription_status='trial';v.status='read_only';db.commit()
        self.assertEqual(self.post('',self.shift()).status_code,403)
        self.assertEqual(self.report(0).status_code,200)
        with SessionLocal() as db:
            db.get(VenueSettings,self.oid).status='active';db.get(Account,self.accounts['manager']).permissions_json=dump({'shifts_manage':False});db.commit()
        self.assertEqual(self.post('',self.shift()).status_code,403)
        self.assertEqual(self.report(0).status_code,403)
        self.assertEqual(self.client.get('/api/shifts/context').status_code,403)

    def test_notifications_assignment_reminder_once_and_cancelled(self):
        self.login('manager');row=self.create(self.shift(account_id=self.accounts['worker']))
        with SessionLocal() as db:
            self.assertEqual(db.scalar(select(func.count(Notice.id)).where(Notice.account_id==self.accounts['worker'])),1)
            r=db.get(ShiftEntry,row['id']);r.starts_at=now()+timedelta(minutes=30);r.ends_at=now()+timedelta(hours=8);db.commit()
            remind_shifts(db);db.commit();remind_shifts(db);db.commit()
            self.assertEqual(db.scalar(select(func.count(Notice.id)).where(Notice.account_id==self.accounts['worker'])),2)
            db.get(VenueSettings,self.oid).status='suspended';db.commit()
            r.version+=1;db.commit();remind_shifts(db);db.commit()
            self.assertEqual(db.scalar(select(func.count(Notice.id)).where(Notice.account_id==self.accounts['worker'])),2)


if __name__ == '__main__': unittest.main()
