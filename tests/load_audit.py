"""Bounded local capacity audit. Cannot target an external server. Disposable SQLite only."""
import asyncio,json,os,platform,secrets,subprocess,sys,tempfile,time,urllib.request
from pathlib import Path
import httpx
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'docs'/'load-audit-2.4.json'

def process_stats(pid):
 try:
  fields=Path(f'/proc/{pid}/stat').read_text().split();cpu=(int(fields[13])+int(fields[14]))/os.sysconf('SC_CLK_TCK')
  rss=next(int(x.split()[1])*1024 for x in Path(f'/proc/{pid}/status').read_text().splitlines() if x.startswith('VmRSS:'))
  return cpu,rss
 except (OSError,StopIteration):return 0,0

def percentile(values,p):return sorted(values)[min(len(values)-1,int(len(values)*p))] if values else None

async def phases(server,accounts,cids,base):
 results=[]
 async with httpx.AsyncClient(base_url=base,timeout=30,trust_env=False,limits=httpx.Limits(max_connections=100,max_keepalive_connections=100)) as client:
  for kind in ['reading','cards','games']:
   for concurrent in [1,5,10,25,50]:
    times=[];statuses={};start=time.perf_counter();cpu0=(await client.get('/__audit_process')).json()['cpu_seconds']
    async def task(i):
     headers={'cookie':accounts[i]['cookie'],'x-csrf-token':accounts[i]['csrf']}
     async def request(method,path,body=None):
      t=time.perf_counter()
      try:r=await client.request(method,path,headers=headers,json=body);statuses[str(r.status_code)]=statuses.get(str(r.status_code),0)+1;data=r.json()
      except Exception as e:statuses[type(e).__name__]=statuses.get(type(e).__name__,0)+1;data={}
      times.append((time.perf_counter()-t)*1000);return data
     if kind=='reading':
      for _ in range(2):
       for path in ['/api/learning',f'/api/learning/{cids[0]}',f'/api/learning/{cids[0]}/cards',f'/api/games/{cids[0]}','/api/growth']:await request('GET',path)
     elif kind=='cards':
      for q in range(4):await request('POST',f'/api/learning/{cids[0]}/cards/{q}/practice',{})
     else:
      run=await request('POST',f'/api/games/{cids[0]}/start',{'mode':'truth','size':3,'difficulty':'normal'})
      for q in run.get('questions',[]):await request('POST',f"/api/games/runs/{run['id']}/answer",{'event_id':secrets.token_hex(8),'question_id':q['id'],'value':q['claim_true']})
    await asyncio.gather(*(task(i) for i in range(concurrent)))
    elapsed=time.perf_counter()-start;stats=(await client.get('/__audit_process')).json();cpu1,rss=stats['cpu_seconds'],stats['peak_rss_bytes']
    result={'flow':kind,'simultaneous_clients':concurrent,'requests':len(times),'seconds':round(elapsed,3),'rps':round(len(times)/elapsed,2),'p50_ms':round(percentile(times,.50),2),'p95_ms':round(percentile(times,.95),2),'p99_ms':round(percentile(times,.99),2),'status':statuses,'server_cpu_seconds':round(cpu1-cpu0,3),'rss_mb':round(rss/1024**2,1)}
    results.append(result);print(json.dumps(result),flush=True)
  # Registration ceiling for a shared IP is intentionally retained: 12 / 15 minutes.
  times=[];statuses={};cpu0=(await client.get('/__audit_process')).json()['cpu_seconds'];t=time.perf_counter()
  async def signup(i):
   start=time.perf_counter();r=await client.post('/api/auth/join',json={'code':'AUDITLOAD','name':'Load signup '+str(i),'login':'load-new-'+str(i),'password':'audit-password-123','positions':['bartender']});times.append((time.perf_counter()-start)*1000);statuses[str(r.status_code)]=statuses.get(str(r.status_code),0)+1
  await asyncio.gather(*(signup(i) for i in range(12)))
  rejected=await client.post('/api/auth/join',json={'code':'AUDITLOAD','name':'Beyond limit','login':'load-extra','password':'audit-password-123','positions':['bartender']})
  stats=(await client.get('/__audit_process')).json();cpu1,rss=stats['cpu_seconds'],stats['peak_rss_bytes'];results.append({'flow':'registration','simultaneous_clients':12,'requests':12,'seconds':round(time.perf_counter()-t,3),'p95_ms':round(percentile(times,.95),2),'status':statuses,'thirteenth_status':rejected.status_code,'server_cpu_seconds':round(cpu1-cpu0,3),'rss_mb':round(rss/1024**2,1)})
 return results

with tempfile.TemporaryDirectory(prefix='baros-load-local-') as folder:
 db=Path(folder)/'load.db';env=dict(os.environ,DATABASE_URL='sqlite:///'+str(db),BAROS_WORKER='0',COOKIE_SECURE='0')
 # Seed in a child process so already-imported production configuration cannot be reused.
 seed=r'''
import json,secrets
from baros.db import Base,engine,SessionLocal
from baros.models import Organization,Course
from baros.v2.models import *
from baros.v2.domain import dump,digest,now
from datetime import timedelta
Base.metadata.create_all(engine)
accounts=[];cids=[]
with SessionLocal() as db:
 o=Organization(name='Disposable load venue');db.add(o);db.flush();db.add(VenueSettings(organization_id=o.id,join_code='AUDITLOAD',seat_limit=1000))
 for i in range(200):
  a=Account(organization_id=o.id,name='Load '+str(i),login='load-'+str(i),role='employee',password_hash='fixture-never-login',positions_json='["bartender"]',last_seen_at=now());db.add(a);db.flush();raw=secrets.token_urlsafe(40);csrf=secrets.token_urlsafe(32)
  db.add(LoginSession(token_hash=digest(raw),account_id=a.id,csrf=csrf,expires_at=now()+timedelta(days=1)));accounts.append({'cookie':'baros_v2='+raw,'csrf':csrf})
 for ci in range(10):
  c=Course(organization_id=o.id,title='Load topic '+str(ci),published=True);db.add(c);db.flush();cids.append(c.id)
  p={'title':c.title,'description':'Load test','positions':['bartender'],'lessons':[{'title':'Theory '+str(j),'body':'Стандарт обслуживания. '*200} for j in range(3)],'questions':[{'prompt':'Вопрос '+str(j),'choices':['90 °C','70 °C','80 °C','100 °C'],'correct_index':0,'explanation':'Стандарт: 90 °C','type':'knowledge'} for j in range(100)],'quiz_size':30,'passing_score':80,'time_limit_minutes':30,'max_attempts':0,'required':True,'deadline_days':7,'due_at':None,'is_intro':False}
  r=CourseRevision(course_id=c.id,version=1,payload=dump(p));db.add(r);db.add(CourseSettings(course_id=c.id,version=1,positions_json='["bartender"]'))
 db.add(Setting(key='migration_v2',value='fixture'));db.commit()
print(json.dumps({'accounts':accounts[:50],'courses':cids,'payload_bytes':len(dump(p).encode())}))
'''
 data=json.loads(subprocess.check_output([sys.executable,'-c',seed],cwd=ROOT,env=env))
 # Cookie name is discovered from the app source in seed process, not guessed by a caller.
 data=json.loads(json.dumps(data).replace('baros_v2=',subprocess.check_output([sys.executable,'-c','from baros.v2.auth import COOKIE;print(COOKIE)'],cwd=ROOT,env=env,text=True).strip()+'='))
 with open(Path(folder)/'server.log','w') as log:
  server=subprocess.Popen([sys.executable,'-c',"import resource,uvicorn;from baros.main import app;app.add_api_route('/__audit_process',lambda:{'cpu_seconds':resource.getrusage(resource.RUSAGE_SELF).ru_utime+resource.getrusage(resource.RUSAGE_SELF).ru_stime,'peak_rss_bytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*1024},methods=['GET']);app.router.routes.insert(0,app.router.routes.pop());uvicorn.run(app,host='127.0.0.1',port=8151,access_log=False)"],cwd=ROOT,env=env,stdout=log,stderr=log)
  try:
   for _ in range(100):
    if server.poll() is not None:raise RuntimeError('Local load server failed')
    try:urllib.request.urlopen('http://127.0.0.1:8151/health',timeout=1);break
    except OSError:time.sleep(.1)
   result=asyncio.run(phases(server,data['accounts'],data['courses'],'http://127.0.0.1:8151'))
   report={'date_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'environment':{'python':platform.python_version(),'database':'disposable SQLite','workers':1,'local_cpu_count':os.cpu_count(),'ai_worker':False},'dataset':{'accounts':200,'courses':10,'questions_each':100,'lessons_each':3,'one_revision_payload_bytes':data['payload_bytes'],'db_bytes':db.stat().st_size},'results':result,'limitations':['Not a production Render/Postgres measurement','Closed-loop clients, no browser rendering/network or think time','No paid AI calls or OCR in this benchmark']}
   OUT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
  finally:
   server.terminate();server.wait(timeout=10)
 print('Report:',OUT)
