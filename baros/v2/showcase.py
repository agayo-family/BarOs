"""Explicitly selected public venue names and dedicated sanitized public logos.

Private course photographs and venue account details are never used here.
"""
import base64
import io
import re
import secrets
import warnings
from fastapi import APIRouter, Depends, File, UploadFile, Response
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import select
from ..db import get_db
from ..models import Organization
from .auth import actor, owner, rate
from .models import Setting, VenueSettings
from .domain import dump, parse, require, log

router = APIRouter()
KEY = 'public_showcase'
PREFIX = 'public_showcase_logo:'


class VenueIn(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    organization_id: StrictInt = Field(ge=1)
    name: str = Field(min_length=2, max_length=100)
    city: str = Field(default='', max_length=80)
    description: str = Field(default='', max_length=100)
    logo_id: str | None = Field(default=None, pattern=r'^[A-Za-z0-9_-]{24,48}$')


class ShowcaseIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: StrictInt = Field(ge=0)
    items: list[VenueIn] = Field(max_length=12)
    permission_confirmed: StrictBool


def config(db):
    row = db.get(Setting, KEY)
    value = parse(row.value) if row else {}
    return {'version': value.get('version', 0), 'items': value.get('items', [])}


def public_items(db):
    saved = config(db)['items']
    if not saved:
        return []
    active = set(db.scalars(select(Organization.id).join(VenueSettings,
        VenueSettings.organization_id == Organization.id).where(
        Organization.id.in_([item['organization_id'] for item in saved]),
        VenueSettings.status.in_(['active', 'read_only']))).all())
    return [item for item in saved if item['organization_id'] in active]


@router.get('/api/showcase')
def public_showcase(db=Depends(get_db)):
    return {'items': [{'id': str(item['organization_id']), 'name': item['name'],
                       'city': item['city'], 'description': item['description'],
                       'logo': '/api/showcase/logos/' + item['logo_id'] if item['logo_id'] else None}
                      for item in public_items(db)]}


@router.get('/api/owner/showcase')
def owner_showcase(a=Depends(actor), db=Depends(get_db)):
    owner(a)
    venues = db.execute(select(Organization.id, Organization.name, VenueSettings.status)
        .join(VenueSettings, VenueSettings.organization_id == Organization.id)
        .order_by(Organization.name)).all()
    return {**config(db), 'venues': [{'id': i, 'name': n, 'status': s} for i, n, s in venues]}


@router.put('/api/owner/showcase')
def save_showcase(body: ShowcaseIn, a=Depends(actor), db=Depends(get_db)):
    owner(a)
    require(not body.items or body.permission_confirmed,
            'Подтвердите разрешение заведений на публичный показ названий и логотипов')
    ids = [item.organization_id for item in body.items]
    require(len(set(ids)) == len(ids), 'Одно заведение можно добавить один раз')
    available = set(db.scalars(select(VenueSettings.organization_id).where(
        VenueSettings.organization_id.in_(ids), VenueSettings.status.in_(['active', 'read_only']))).all())
    require(set(ids) == available, 'Выберите подключённые действующие заведения', 409)
    for item in body.items:
        require(not item.logo_id or db.get(Setting, PREFIX + item.logo_id), 'Логотип не найден. Загрузите его ещё раз.', 409)
    row = db.scalar(select(Setting).where(Setting.key == KEY).with_for_update())
    require(row, 'Обновите страницу и повторите действие', 409)
    require(config(db)['version'] == body.version, 'Список уже изменён. Обновите страницу.', 409)
    row.value = dump({'version': body.version + 1, 'items': [item.model_dump() for item in body.items]})
    log(db, a, None, 'Обновлены заведения на публичном сайте', venues=len(ids))
    db.commit()
    return owner_showcase(a, db)


@router.post('/api/owner/showcase/logo')
async def upload_logo(file: UploadFile = File(...), a=Depends(actor), db=Depends(get_db)):
    owner(a)
    rate(db, 'showcase-logo:' + str(a.id), 30, 3600)
    raw = await file.read(4 * 1024 * 1024 + 1)
    require(0 < len(raw) <= 4 * 1024 * 1024, 'Логотип должен быть не больше 4 МБ', 413)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as original:
                require(original.format in {'JPEG', 'PNG', 'WEBP'}, 'Загрузите JPEG, PNG или WebP')
                require(original.width * original.height <= 16000000, 'Изображение слишком большое')
                image = ImageOps.exif_transpose(original).convert('RGBA')
                image.thumbnail((320, 320))
                clean = Image.new('RGBA', image.size, (0, 0, 0, 0))
                clean.paste(image)
                output = io.BytesIO()
                clean.save(output, 'PNG', optimize=True)
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        require(False, 'Не удалось прочитать логотип. Выберите корректное изображение')
    logo_id = secrets.token_urlsafe(24)
    db.add(Setting(key=PREFIX + logo_id, value=base64.b64encode(output.getvalue()).decode('ascii')))
    db.commit()
    return {'logo_id': logo_id, 'preview': '/api/owner/showcase/logos/' + logo_id}


def logo_response(logo_id, db):
    require(re.fullmatch(r'[A-Za-z0-9_-]{24,48}', logo_id), 'Логотип не найден', 404)
    row = db.get(Setting, PREFIX + logo_id)
    require(row, 'Логотип не найден', 404)
    return Response(base64.b64decode(row.value), media_type='image/png', headers={'Cache-Control': 'no-store'})


@router.get('/api/owner/showcase/logos/{logo_id}')
def private_logo(logo_id: str, a=Depends(actor), db=Depends(get_db)):
    owner(a)
    return logo_response(logo_id, db)


@router.get('/api/showcase/logos/{logo_id}')
def public_logo(logo_id: str, db=Depends(get_db)):
    require(any(item.get('logo_id') == logo_id for item in public_items(db)), 'Логотип не найден', 404)
    return logo_response(logo_id, db)
