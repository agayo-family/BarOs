"""Batch calendar changes validate every date and commit atomically."""
import unittest
import test_shifts as fixtures

class BatchTests(unittest.TestCase):
    setUp=fixtures.ShiftTests.setUp
    tearDown=fixtures.ShiftTests.tearDown
    login=fixtures.ShiftTests.login
    post=fixtures.ShiftTests.post
    put=fixtures.ShiftTests.put
    report=fixtures.ShiftTests.report
    shift=fixtures.ShiftTests.shift
    create=fixtures.ShiftTests.create

    def template(self):
        body=self.shift();body.pop('day')
        r=self.post('/templates',body);self.assertEqual(r.status_code,200,r.text);return r.json()

    def test_preview_totals_apply_arbitrary_dates_and_atomic_conflict(self):
        t=self.template();body={'template_id':t['id'],'template_version':t['version'],'days':['2026-10-08','2026-10-14','2026-10-19']}
        preview=self.post('/batch/preview',body);self.assertEqual(preview.status_code,200,preview.text);self.assertEqual(preview.json()['conflicts'],0)
        self.assertEqual(preview.json()['totals']['RUB'],252500*3);self.assertEqual(sum(x['planned_minutes'] for x in preview.json()['items']),450*3)
        r=self.post('/batch',body);self.assertEqual(r.status_code,200,r.text);self.assertEqual(r.json()['created'],3)
        conflicting={**body,'days':['2026-10-01','2026-10-08']};self.assertEqual(self.post('/batch/preview',conflicting).json()['conflicts'],1)
        self.assertEqual(self.post('/batch',conflicting).status_code,409)
        self.assertEqual(len(self.report().json()['shifts']),3,'Earlier inserts in a failing batch must roll back')

    def test_template_revision_scope_csrf_and_employee_target(self):
        t=self.template();body={'template_id':t['id'],'template_version':t['version'],'days':['2026-10-08']}
        self.assertEqual(self.client.post('/api/shifts/batch',json=body).status_code,403)
        self.assertEqual(self.post('/batch',{**body,'account_id':self.accounts['peer']}).status_code,403)
        self.assertEqual(self.post('/batch',{**body,'days':['2026-10-08','2026-10-08']}).status_code,422)
        self.assertEqual(self.post('/batch',{**body,'template_version':999}).status_code,409)
        self.login('foreign');self.assertEqual(self.post('/batch',body).status_code,404)
        self.login('manager');self.assertEqual(self.post('/batch',body).status_code,404,'An employee private template stays private')

    def test_manager_shared_template_assigns_team_and_blocks_stale_preview(self):
        self.login('manager');t=self.template();body={'account_id':self.accounts['worker'],'template_id':t['id'],'template_version':t['version'],'days':['2026-10-06','2026-10-09']}
        self.assertEqual(self.post('/batch/preview',body).status_code,200)
        fields=('title','kind','color','emoji','start_time','end_time','end_day_offset','break_minutes','allowance','location','timezone','currency','hourly_rate','overtime_after','overtime_percent','reminder_minutes','version')
        self.assertEqual(self.put('/templates/'+str(t['id']),{k:t[k] for k in fields}).status_code,200)
        self.assertEqual(self.post('/batch',body).status_code,409)
        self.assertEqual(self.post('/batch',{**body,'template_version':2}).status_code,200)
        self.login('worker');rows=self.report().json()['shifts'];self.assertEqual(len(rows),2)
        self.assertEqual({r['creator_id'] for r in rows},{self.accounts['manager']})
