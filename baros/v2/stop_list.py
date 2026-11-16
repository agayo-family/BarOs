"""The current menu availability is shared only within the selected venue."""

from typing import Literal

from fastapi import APIRouter, Depends, Request
from pydantic import Field, StrictBool
from sqlalchemy import select, update

from ..db import get_db
from .auth import actor, manager, tenant
from .domain import iso, log, now, parse, require
from .models import StopListItem, VenueSettings
from .schemas import StrictModel

router = APIRouter(prefix='/api/stop-list')
Station = Literal['bar', 'kitchen']


class CreateItem(StrictModel):
    station: Station
    name: str = Field(min_length=1, max_length=140)


class ChangeItem(StrictModel):
    unavailable: StrictBool
    version: int = Field(ge=1)


def stations(account):
    if account.role != 'employee':
        return {'bar', 'kitchen'}
    job_titles = set(parse(account.positions_json, []))
    result = set()
    if job_titles & {'bartender', 'barista'}:
        result.add('bar')
    if 'cook' in job_titles:
        result.add('kitchen')
    return result


def scope(request, db, account, write=False):
    if account.role == 'employee':
        oid = tenant(request, db, account, write=write, learning=write)
        if write:
            require(db.get(VenueSettings, oid).status != 'read_only', 'Заведение доступно только для чтения', 403)
        return oid
    return manager(request, db, account, 'courses_manage' if write else None, write)


def view(row):
    return {'id': row.id, 'name': row.name, 'station': row.station, 'unavailable': row.unavailable,
            'updated_at': iso(row.updated_at), 'version': row.version}


@router.get('')
def list_items(request: Request, current: bool = False, a=Depends(actor), db=Depends(get_db)):
    oid = scope(request, db, a)
    cfg = db.get(VenueSettings, oid)
    editable = stations(a)
    if a.role == 'manager':
        from .auth import venue_permissions
        if cfg.status == 'read_only' or not venue_permissions(db, a, oid, ['courses_manage'])['courses_manage']:
            editable = set()
    if a.role != 'owner' and (cfg.status == 'read_only' or cfg.subscription_status in {'past_due', 'suspended'} or
            cfg.paid_until and cfg.paid_until <= now()):
        editable = set()
    query = select(StopListItem).where(StopListItem.organization_id == oid)
    if current or not editable:
        query = query.where(StopListItem.unavailable.is_(True))
    return {'items': [view(row) for row in db.scalars(query.order_by(StopListItem.station, StopListItem.name)).all()],
            'editable_stations': sorted(editable)}


@router.post('')
def create_item(data: CreateItem, request: Request, a=Depends(actor), db=Depends(get_db)):
    oid = scope(request, db, a, True)
    require(data.station in stations(a), 'Вы можете менять только свой раздел', 403)
    name = ' '.join(data.name.split())
    require(name, 'Введите название позиции')
    key = name.casefold()[:180]
    db.execute(update(VenueSettings).where(VenueSettings.organization_id == oid).values(
        organization_id=VenueSettings.organization_id))
    row = db.scalar(select(StopListItem).where(StopListItem.organization_id == oid,
        StopListItem.station == data.station, StopListItem.name_key == key))
    if row:
        db.commit()
        return view(row)
    row = StopListItem(organization_id=oid, station=data.station, name=name, name_key=key)
    db.add(row)
    db.flush()
    log(db, a, oid, 'Добавлена позиция стоп-листа', item_id=row.id, station=data.station)
    db.commit()
    return view(row)


@router.put('/{item_id}')
def update_item(item_id: int, data: ChangeItem, request: Request, a=Depends(actor), db=Depends(get_db)):
    oid = scope(request, db, a, True)
    row = db.scalar(select(StopListItem).where(StopListItem.id == item_id,
        StopListItem.organization_id == oid).with_for_update())
    require(row, 'Позиция не найдена', 404)
    require(row.station in stations(a), 'Вы можете менять только свой раздел', 403)
    if row.unavailable != data.unavailable:
        require(data.version == row.version, 'Позицию уже обновили. Проверьте актуальный стоп-лист.', 409)
        result = db.execute(update(StopListItem).where(StopListItem.id == item_id, StopListItem.version == data.version)
            .values(unavailable=data.unavailable, version=data.version + 1, updated_at=now()))
        require(result.rowcount == 1, 'Позицию уже обновили. Проверьте актуальный стоп-лист.', 409)
        log(db, a, oid, 'Изменён стоп-лист', item_id=row.id, unavailable=data.unavailable)
    db.commit()
    return view(row)


@router.delete('/{item_id}')
def remove_item(item_id: int, request: Request, a=Depends(actor), db=Depends(get_db)):
    oid = manager(request, db, a, 'courses_manage', True)
    row = db.scalar(select(StopListItem).where(StopListItem.id == item_id,
        StopListItem.organization_id == oid).with_for_update())
    require(row, 'Позиция не найдена', 404)
    require(not row.unavailable, 'Сначала снимите позицию со стоп-листа', 409)
    db.delete(row)
    log(db, a, oid, 'Удалена позиция стоп-листа', item_id=item_id)
    db.commit()
    return {'ok': True}
