"""Venue-scoped shift calendar. Money is integer minor units; time is UTC internally."""
import csv
import io
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from pydantic import Field, field_validator, model_validator
from sqlalchemy import select, update, delete
from ..db import get_db
from .auth import actor, tenant
from .domain import require, dump, parse, now, iso, log, add_notice
from .models import Account, ShiftEntry, ShiftTemplate, ShiftPreference, VenueSettings
from .schemas import StrictModel

router = APIRouter(prefix='/api/shifts')
KINDS = {'work': 'Рабочая смена', 'training': 'Обучение', 'off': 'Выходной', 'vacation': 'Отпуск', 'sick': 'Больничный', 'event': 'Личное событие'}
WORK = {'work', 'training'}


class PaySettings(StrictModel):
    timezone: str = Field(default='Europe/Moscow', max_length=80)
    currency: str = Field(default='RUB', pattern=r'^(RUB|USD|EUR|KZT|BYN|GEL)$')
    hourly_rate: int = Field(default=0, ge=0, le=100000000)
    overtime_after: int = Field(default=480, ge=0, le=2880)
    overtime_percent: int = Field(default=100, ge=100, le=500)
    reminder_minutes: int = Field(default=60, ge=0, le=1440)

    @field_validator('timezone')
    @classmethod
    def zone(cls, value):
        try: ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError): raise ValueError('Неизвестный часовой пояс')
        return value


class TemplateIn(PaySettings):
    title: str = Field(min_length=1, max_length=100)
    kind: str = Field(default='work', pattern=r'^(work|training|off|vacation|sick|event)$')
    color: str = Field(default='#7062e8', pattern=r'^#[0-9a-fA-F]{6}$')
    emoji: str = Field(default='☕', max_length=8)
    start_time: str = Field(default='09:00', pattern=r'^([01]\d|2[0-3]):[0-5]\d$')
    end_time: str = Field(default='18:00', pattern=r'^([01]\d|2[0-3]):[0-5]\d$')
    end_day_offset: int = Field(default=0, ge=0, le=2)
    break_minutes: int = Field(default=0, ge=0, le=1440)
    allowance: int = Field(default=0, ge=0, le=100000000)
    location: str = Field(default='', max_length=200)
    version: int | None = Field(default=None, ge=1)


class ShiftIn(TemplateIn):
    day: date
    account_id: int | None = Field(default=None, ge=1)
    status: str = Field(default='planned', pattern=r'^(planned|completed|cancelled)$')
    tips: int = Field(default=0, ge=0, le=100000000)
    notes: str = Field(default='', max_length=2000)
    actual_start: datetime | None = None
    actual_end: datetime | None = None
    actual_break: int | None = Field(default=None, ge=0, le=1440)

    @model_validator(mode='after')
    def actual_pair(self):
        if bool(self.actual_start) != bool(self.actual_end): raise ValueError('Укажите начало и конец фактической смены')
        return self


class FactIn(StrictModel):
    version: int = Field(ge=1)
    status: str = Field(pattern=r'^(planned|completed)$')
    actual_start: datetime | None = None
    actual_end: datetime | None = None
    actual_break: int | None = Field(default=None, ge=0, le=1440)
    tips: int = Field(default=0, ge=0, le=100000000)
    notes: str = Field(default='', max_length=2000)


class RotationIn(StrictModel):
    account_id: int | None = Field(default=None, ge=1)
    start: date
    end: date
    pattern: list[int | None] = Field(min_length=1, max_length=60)


def scope(request, db, a, write=False):
    oid = tenant(request, db, a, 'shifts_manage' if a.role == 'manager' and write else None,
                 write=write, learning=a.role == 'employee')
    if a.role == 'manager':
        require(parse(db.get(VenueSettings, oid).permissions_json).get('shifts_manage', True) and
                parse(a.permissions_json).get('shifts_manage', True), 'Доступ к графику ограничен владельцем BarOS', 403)
    if write:
        require(a.role == 'owner' or db.get(VenueSettings, oid).status != 'read_only', 'Заведение доступно только для чтения', 403)
    return oid


def target(db, a, oid, account_id=None):
    aid = account_id or a.id
    require(a.role != 'employee' or aid == a.id, 'Доступны только ваши смены', 403)
    person = db.get(Account, aid)
    require(person and person.organization_id == oid and person.role in {'employee', 'manager'}, 'Сотрудник не найден', 404)
    return person


def templates_query(a, oid):
    return select(ShiftTemplate).where(ShiftTemplate.organization_id == oid,
        (ShiftTemplate.shared == True) | (ShiftTemplate.creator_id == a.id)).order_by(ShiftTemplate.id)


def template_card(row):
    return {**parse(row.payload), 'id': row.id, 'version': row.version, 'shared': row.shared, 'creator_id': row.creator_id}


def local_instant(day, clock, zone):
    local = datetime.combine(day, time.fromisoformat(clock)).replace(tzinfo=zone)
    # Reject a non-existent local wall clock on a daylight-saving transition.
    require(local.astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None) == local.replace(tzinfo=None),
            'Такого местного времени нет из-за перевода часов. Выберите другое время.')
    return local.astimezone(timezone.utc).replace(tzinfo=None)


def normalized(data):
    zone = ZoneInfo(data.timezone)
    start = local_instant(data.day, data.start_time, zone)
    end = local_instant(data.day + timedelta(days=data.end_day_offset), data.end_time, zone)
    if data.kind not in WORK and data.kind != 'event':
        start = local_instant(data.day, '00:00', zone)
        end = local_instant(data.day + timedelta(days=1), '00:00', zone)
    require(end > start and (end - start).total_seconds() <= 172800, 'Конец должен быть после начала, продолжительность — не больше 48 часов')
    require(data.kind not in WORK or data.break_minutes < (end-start).total_seconds()/60, 'Перерыв должен быть короче смены')
    payload = data.model_dump(mode='json', exclude={'account_id', 'version'})
    if data.actual_start:
        require(data.kind in WORK and data.status == 'completed', 'Фактическое время доступно только для завершённой рабочей смены')
        require(data.actual_start.tzinfo and data.actual_end.tzinfo, 'Фактическое время должно содержать часовой пояс')
        ast = data.actual_start.astimezone(timezone.utc)
        aend = data.actual_end.astimezone(timezone.utc)
        require(0 < (aend-ast).total_seconds() <= 172800, 'Проверьте фактическое начало и конец смены')
        require((data.actual_break if data.actual_break is not None else data.break_minutes) < (aend-ast).total_seconds()/60,
                'Фактический перерыв должен быть короче смены')
        payload['actual_start'], payload['actual_end'] = ast.isoformat(), aend.isoformat()
    elif data.actual_break is not None:
        require(data.kind in WORK and data.status == 'completed', 'Фактический перерыв доступен после завершения смены')
        require(data.actual_break < (end-start).total_seconds()/60, 'Фактический перерыв должен быть короче смены')
    return payload, start, end


def minute_count(start, end, pause):
    return max(0, int((end-start).total_seconds() // 60) - pause)


def pay(minutes, data):
    extra = max(0, minutes-data['overtime_after']) if data['overtime_after'] else 0
    weighted = Decimal(minutes-extra) + Decimal(extra)*Decimal(data['overtime_percent'])/100
    wage = int((weighted*Decimal(data['hourly_rate'])/60).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
    return wage + data['allowance'], extra


def card(row, person=None):
    d = parse(row.payload)
    planned = minute_count(row.starts_at, row.ends_at, d['break_minutes']) if d['kind'] in WORK else 0
    actual = None
    if d['status'] == 'completed':
        start = datetime.fromisoformat(d['actual_start']) if d.get('actual_start') else row.starts_at
        end = datetime.fromisoformat(d['actual_end']) if d.get('actual_end') else row.ends_at
        actual = minute_count(start, end, d['actual_break'] if d.get('actual_break') is not None else d['break_minutes']) if d['kind'] in WORK else 0
    forecast, overtime = pay(planned, d)
    earned, actual_overtime = pay(actual or 0, d)
    cancelled = d['status'] == 'cancelled'
    return {**d, 'id': row.id, 'account_id': row.account_id, 'name': person.name if person else '',
            'creator_id': row.creator_id, 'version': row.version, 'starts_at': iso(row.starts_at), 'ends_at': iso(row.ends_at),
            'planned_minutes': 0 if cancelled else planned, 'actual_minutes': actual if not cancelled else None,
            'overtime_minutes': 0 if cancelled else overtime, 'actual_overtime_minutes': actual_overtime if actual is not None and not cancelled else 0,
            'forecast': 0 if cancelled else forecast, 'earned': earned+d['tips'] if actual is not None and not cancelled else 0}


def notify(db, a, row, action):
    if row.account_id != a.id:
        d = parse(row.payload)
        add_notice(db, row.account_id, f'shift:{row.id}:{row.version}:{action}', f'Смена: {action}',
                   f'{d["title"]} · {row.start_day} · {d["start_time"]}–{d["end_time"]}. Откройте календарь, чтобы посмотреть детали.', '/app/shifts')


def overlap(db, oid, aid, data, start, end, exclude=None):
    if data['status'] == 'cancelled' or data['kind'] not in WORK: return
    rows = db.scalars(select(ShiftEntry).where(ShiftEntry.organization_id == oid, ShiftEntry.account_id == aid,
        ShiftEntry.starts_at < end, ShiftEntry.ends_at > start)).all()
    for row in rows:
        d = parse(row.payload)
        require(row.id == exclude or d['status'] == 'cancelled' or d['kind'] not in WORK,
                f'Смена пересекается с «{d["title"]}» ({row.start_day}). Измените время.', 409)


def range_check(start, end):
    require(0 <= (end-start).days <= 730, 'Выберите период не больше двух лет')


def selection(request, db, a, start, end, account_id):
    oid = scope(request, db, a)
    range_check(start, end)
    if account_id == 0:
        require(a.role in {'owner', 'manager'}, 'Доступны только ваши смены', 403)
        aid = None
    else:
        aid = target(db, a, oid, account_id).id
    q = select(ShiftEntry).where(ShiftEntry.organization_id == oid, ShiftEntry.start_day >= start.isoformat(), ShiftEntry.start_day <= end.isoformat())
    if aid: q = q.where(ShiftEntry.account_id == aid)
    people = {p.id: p for p in db.scalars(select(Account).where(Account.organization_id == oid)).all()}
    return oid, [card(r, people.get(r.account_id)) for r in db.scalars(q.order_by(ShiftEntry.starts_at, ShiftEntry.id)).all()]


def totals(rows):
    currencies, kinds, people = {}, {}, {}
    active = [r for r in rows if r['status'] != 'cancelled']
    for r in active:
        c = currencies.setdefault(r['currency'], {'forecast': 0, 'earned': 0, 'tips': 0})
        c['forecast'] += r['forecast']; c['earned'] += r['earned']; c['tips'] += r['tips'] if r['status'] == 'completed' else 0
        k = kinds.setdefault(r['kind'], {'count': 0, 'minutes': 0, 'actual_minutes': 0})
        k['count'] += 1; k['minutes'] += r['planned_minutes']; k['actual_minutes'] += r['actual_minutes'] or 0
        p = people.setdefault(r['account_id'], {'name': r['name'], 'count': 0, 'minutes': 0, 'actual_minutes': 0})
        p['count'] += r['kind'] in WORK; p['minutes'] += r['planned_minutes']; p['actual_minutes'] += r['actual_minutes'] or 0
    return {'count': sum(r['kind'] in WORK for r in active), 'completed': sum(r['kind'] in WORK and r['status'] == 'completed' for r in active),
            'planned_minutes': sum(r['planned_minutes'] for r in active), 'actual_minutes': sum(r['actual_minutes'] or 0 for r in active),
            'overtime_minutes': sum(r['actual_overtime_minutes'] for r in active), 'currencies': currencies, 'kinds': kinds, 'people': people}


@router.get('/context')
def context(request: Request, a=Depends(actor), db=Depends(get_db)):
    oid = scope(request, db, a)
    people = db.scalars(select(Account).where(Account.organization_id == oid, Account.role.in_(['employee', 'manager'])).order_by(Account.name)).all() if a.role != 'employee' else [a]
    pref = db.get(ShiftPreference, a.id)
    return {'accounts': [{'id': p.id, 'name': p.name, 'active': p.active, 'positions': parse(p.positions_json, [])} for p in people],
            'templates': [template_card(r) for r in db.scalars(templates_query(a, oid)).all()],
            'preferences': PaySettings(**parse(pref.payload) if pref else {}).model_dump(), 'kinds': KINDS}


@router.put('/preferences')
def preferences(data: PaySettings, request: Request, a=Depends(actor), db=Depends(get_db)):
    scope(request, db, a, True)
    p = db.get(ShiftPreference, a.id)
    if not p: p = ShiftPreference(account_id=a.id); db.add(p)
    p.payload = dump(data.model_dump()); db.commit()
    return data.model_dump()


@router.get('')
def listing(request: Request, start: date, end: date, account_id: int | None = None, a=Depends(actor), db=Depends(get_db)):
    _, rows = selection(request, db, a, start, end, account_id)
    return {'shifts': rows, 'summary': totals(rows)}


@router.post('/templates')
def create_template(data: TemplateIn, request: Request, a=Depends(actor), db=Depends(get_db)):
    oid = scope(request, db, a, True)
    normalized(ShiftIn(**data.model_dump(exclude={'version'}), day=date(2026, 1, 1)))
    row = ShiftTemplate(organization_id=oid, creator_id=a.id, shared=a.role != 'employee', payload=dump(data.model_dump(exclude={'version'})))
    db.add(row); db.flush(); log(db, a, oid, 'Создан шаблон смены', template_id=row.id); db.commit()
    return template_card(row)


def editable_template(db, a, oid, tid):
    row = db.get(ShiftTemplate, tid)
    require(row and row.organization_id == oid and (row.shared or row.creator_id == a.id), 'Шаблон не найден', 404)
    require(a.role != 'employee' or row.creator_id == a.id, 'Общий шаблон изменяет управляющий', 403)
    return row


@router.put('/templates/{tid}')
def edit_template(tid: int, data: TemplateIn, request: Request, a=Depends(actor), db=Depends(get_db)):
    oid = scope(request, db, a, True); row = editable_template(db, a, oid, tid)
    normalized(ShiftIn(**data.model_dump(exclude={'version'}), day=date(2026, 1, 1)))
    require(data.version == row.version, 'Шаблон изменён. Обновите раздел.', 409)
    updated = db.execute(update(ShiftTemplate).where(ShiftTemplate.id == tid, ShiftTemplate.version == data.version).values(payload=dump(data.model_dump(exclude={'version'})), version=data.version+1))
    require(updated.rowcount, 'Шаблон изменён. Обновите раздел.', 409)
    log(db, a, oid, 'Изменён шаблон смены', template_id=tid); db.commit(); db.refresh(row)
    return template_card(row)


@router.delete('/templates/{tid}')
def remove_template(tid: int, request: Request, version: int, a=Depends(actor), db=Depends(get_db)):
    oid = scope(request, db, a, True); row = editable_template(db, a, oid, tid)
    changed = db.execute(delete(ShiftTemplate).where(ShiftTemplate.id == tid, ShiftTemplate.version == version))
    require(changed.rowcount, 'Шаблон изменён. Обновите раздел.', 409)
    log(db, a, oid, 'Удалён шаблон смены', template_id=tid); db.commit(); return {'ok': True}


def add_shift(db, a, oid, data):
    person = target(db, a, oid, data.account_id); require(person.active, 'Доступ сотрудника отключён')
    payload, start, end = normalized(data)
    # A per-person lock serializes overlap checks and batch insertion on PostgreSQL.
    db.scalar(select(Account).where(Account.id == person.id).with_for_update())
    overlap(db, oid, person.id, payload, start, end)
    row = ShiftEntry(organization_id=oid, account_id=person.id, creator_id=a.id, start_day=data.day.isoformat(),
                     starts_at=start, ends_at=end, payload=dump(payload))
    db.add(row); db.flush(); notify(db, a, row, 'назначена')
    return row, person


@router.post('')
def create_shift(data: ShiftIn, request: Request, a=Depends(actor), db=Depends(get_db)):
    oid = scope(request, db, a, True); row, person = add_shift(db, a, oid, data)
    log(db, a, oid, 'Добавлена смена', shift_id=row.id, account_id=person.id); db.commit(); return card(row, person)


def accessible_entry(db, a, oid, sid):
    row = db.get(ShiftEntry, sid)
    require(row and row.organization_id == oid and (a.role != 'employee' or row.account_id == a.id), 'Смена не найдена', 404)
    return row


def replace_entry(db, a, row, data, oid):
    require(data.version == row.version, 'Смена изменена в другом окне. Обновите календарь.', 409)
    person = target(db, a, oid, data.account_id or row.account_id)
    require(person.id == row.account_id, 'Для другого сотрудника создайте отдельную смену')
    payload, start, end = normalized(data)
    db.scalar(select(Account).where(Account.id == person.id).with_for_update())
    overlap(db, oid, person.id, payload, start, end, row.id)
    old = row.version
    changed = db.execute(update(ShiftEntry).where(ShiftEntry.id == row.id, ShiftEntry.version == old).values(
        payload=dump(payload), start_day=data.day.isoformat(), starts_at=start, ends_at=end, updated_at=now(), version=old+1))
    require(changed.rowcount, 'Смена изменена. Обновите календарь.', 409)
    db.refresh(row); notify(db, a, row, 'изменена'); return person


@router.put('/{sid:int}')
def edit_shift(sid: int, data: ShiftIn, request: Request, a=Depends(actor), db=Depends(get_db)):
    oid = scope(request, db, a, True); row = accessible_entry(db, a, oid, sid)
    require(a.role != 'employee' or row.creator_id == a.id, 'Назначенную смену изменяет управляющий. Вы можете внести фактическое время.', 403)
    person = replace_entry(db, a, row, data, oid)
    log(db, a, oid, 'Изменена смена', shift_id=sid); db.commit(); return card(row, person)


@router.put('/{sid:int}/fact')
def edit_fact(sid: int, data: FactIn, request: Request, a=Depends(actor), db=Depends(get_db)):
    oid = scope(request, db, a, True); row = accessible_entry(db, a, oid, sid)
    require(parse(row.payload)['status'] != 'cancelled', 'Смена отменена управляющим', 409)
    merged = {**parse(row.payload), **data.model_dump(mode='json'), 'account_id': row.account_id}
    person = replace_entry(db, a, row, ShiftIn(**merged), oid)
    log(db, a, oid, 'Внесено фактическое время смены', shift_id=sid); db.commit(); return card(row, person)


@router.delete('/{sid:int}')
def remove_shift(sid: int, request: Request, version: int, a=Depends(actor), db=Depends(get_db)):
    oid = scope(request, db, a, True); row = accessible_entry(db, a, oid, sid)
    require(a.role != 'employee' or row.creator_id == a.id, 'Назначенную смену удаляет управляющий', 403)
    require(row.version == version, 'Смена изменена. Обновите календарь.', 409)
    notify(db, a, row, 'удалена')
    changed = db.execute(delete(ShiftEntry).where(ShiftEntry.id == sid, ShiftEntry.version == version))
    require(changed.rowcount, 'Смена изменена. Обновите календарь.', 409)
    log(db, a, oid, 'Удалена смена', shift_id=sid); db.commit(); return {'ok': True}


def rotation_items(db, a, oid, data):
    target(db, a, oid, data.account_id)
    range_check(data.start, data.end)
    available = {r.id: r for r in db.scalars(templates_query(a, oid)).all()}
    require(any(data.pattern), 'Добавьте хотя бы одну смену в цикл')
    require(all(t is None or t in available for t in data.pattern), 'Шаблон удалён или недоступен', 404)
    items = []
    for offset in range((data.end-data.start).days+1):
        tid = data.pattern[offset % len(data.pattern)]
        if tid is None: continue
        items.append(ShiftIn(**parse(available[tid].payload), day=data.start+timedelta(days=offset), account_id=data.account_id))
    return items


@router.post('/rotations/preview')
def preview_rotation(data: RotationIn, request: Request, a=Depends(actor), db=Depends(get_db)):
    oid = scope(request, db, a, True); items = rotation_items(db, a, oid, data)
    aid = target(db, a, oid, data.account_id).id; preview = []
    previous = []
    for item in items:
        payload, start, end = normalized(item); conflict = ''
        try:
            overlap(db, oid, aid, payload, start, end)
            require(not any(s < end and e > start for s, e in previous) if item.kind in WORK else True, 'Смены цикла пересекаются', 409)
        except Exception as exc:
            if not hasattr(exc, 'detail'): raise
            conflict = exc.detail
        if item.kind in WORK: previous.append((start, end))
        preview.append({'day': item.day.isoformat(), 'title': item.title, 'start_time': item.start_time, 'end_time': item.end_time, 'conflict': conflict})
    return {'count': len(preview), 'conflicts': sum(bool(p['conflict']) for p in preview), 'items': preview}


@router.post('/rotations')
def apply_rotation(data: RotationIn, request: Request, a=Depends(actor), db=Depends(get_db)):
    oid = scope(request, db, a, True); items = rotation_items(db, a, oid, data)
    for item in items: add_shift(db, a, oid, item)
    log(db, a, oid, 'Создан цикл смен', count=len(items), account_id=data.account_id or a.id)
    db.commit(); return {'created': len(items)}


def ics_text(value):
    return str(value).replace('\\', '\\\\').replace('\r', '').replace('\n', '\\n').replace(';', '\\;').replace(',', '\\,')


@router.get('/export/{format}')
def export(format: str, request: Request, start: date, end: date, account_id: int | None = None, a=Depends(actor), db=Depends(get_db)):
    oid, rows = selection(request, db, a, start, end, account_id)
    require(format in {'csv', 'ics'}, 'Формат не поддерживается')
    if format == 'csv':
        out = io.StringIO(); w = csv.writer(out, delimiter=';')
        w.writerow(['Сотрудник', 'Дата', 'Название', 'Тип', 'Начало', 'Конец', 'Часовой пояс', 'Перерыв (мин)', 'Статус', 'План (мин)', 'Факт (мин)', 'Прогноз', 'Заработано', 'Чаевые', 'Валюта', 'Место', 'Заметки'])
        for r in rows:
            values = [r['name'], r['day'], r['title'], KINDS[r['kind']], r['start_time'], r['end_time']+(' +'+str(r['end_day_offset'])+' д.' if r['end_day_offset'] else ''), r['timezone'], r['break_minutes'], r['status'], r['planned_minutes'], r['actual_minutes'], r['forecast']/100, r['earned']/100, r['tips']/100, r['currency'], r['location'], r['notes']]
            w.writerow(["'"+str(v) if str(v).lstrip().startswith(('=', '+', '-', '@')) else v for v in values])
        body, media = out.getvalue().encode('utf-8-sig'), 'text/csv'
    else:
        lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BarOS//Shift Calendar//RU', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH']
        for r in rows:
            if r['status'] == 'cancelled': continue
            stamp = lambda v: datetime.fromisoformat(v.replace('Z', '+00:00')).strftime('%Y%m%dT%H%M%SZ')
            lines += ['BEGIN:VEVENT', f'UID:baros-shift-{oid}-{r["id"]}@baros', f'SEQUENCE:{r["version"]}', f'DTSTAMP:{now().strftime("%Y%m%dT%H%M%SZ")}']
            if r['kind'] in {'off', 'vacation', 'sick'}:
                day = date.fromisoformat(r['day'])
                lines += ['DTSTART;VALUE=DATE:'+day.strftime('%Y%m%d'), 'DTEND;VALUE=DATE:'+(day+timedelta(days=1)).strftime('%Y%m%d')]
            else:
                lines += [f'DTSTART:{stamp(r["starts_at"])}', f'DTEND:{stamp(r["ends_at"])}']
            lines += ['SUMMARY:'+ics_text(r['title']+' · '+r['name']), 'LOCATION:'+ics_text(r['location']), 'DESCRIPTION:'+ics_text(r['notes'])]
            if r['kind'] in WORK and r['reminder_minutes']:
                lines += ['BEGIN:VALARM', f'TRIGGER:-PT{r["reminder_minutes"]}M', 'ACTION:DISPLAY', 'DESCRIPTION:'+ics_text(r['title']), 'END:VALARM']
            lines += ['END:VEVENT']
        lines += ['END:VCALENDAR']
        # Fold by UTF-8 octets, preserving multi-byte characters (RFC 5545).
        folded = []
        for line in lines:
            chunk = ''
            for char in line:
                if len((chunk+char).encode()) > 73: folded.append(chunk); chunk = ' '
                chunk += char
            folded.append(chunk)
        body, media = ('\r\n'.join(folded)+'\r\n').encode(), 'text/calendar'
    log(db, a, oid, 'Экспортирован график смен', format=format); db.commit()
    return Response(body, media_type=media, headers={'Content-Disposition': f'attachment; filename="baros-shifts.{format}"'})


def remind_shifts(db):
    instant = now()
    rows = db.scalars(select(ShiftEntry).where(ShiftEntry.starts_at > instant, ShiftEntry.starts_at <= instant+timedelta(days=1))).all()
    for row in rows:
        d = parse(row.payload)
        person = db.get(Account, row.account_id); venue = db.get(VenueSettings, row.organization_id)
        if not person or not person.active or not venue or venue.status in {'suspended', 'archived'}: continue
        if d['kind'] not in WORK or d['status'] != 'planned' or not d['reminder_minutes']: continue
        if row.starts_at-timedelta(minutes=d['reminder_minutes']) > instant: continue
        add_notice(db, row.account_id, f'shift-remind:{row.id}:{row.version}', 'Скоро ваша смена',
                   f'{d["title"]} начинается в {d["start_time"]} ({d["timezone"]}). {d["location"]}', '/app/shifts')
