"""Preview and import multiple portable packages into one selected venue."""

import csv
import hashlib
import io
import json
from pathlib import PurePosixPath
from zipfile import BadZipFile, ZipFile

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import ValidationError
from sqlalchemy import select, update

from ..db import get_db
from ..models import Organization
from .auth import actor, manager
from .domain import require
from .media import validate_media
from .models import CoursePresentation, PackageReceipt, VenueSettings
from .packages import PackageIn, fingerprint, save_package

router = APIRouter(prefix='/api/packages/zip')
ARCHIVE_LIMIT = 15 * 1024 * 1024
PACKAGE_LIMIT = 2 * 1024 * 1024
TOTAL_LIMIT = 64 * 1024 * 1024


def archive_manifest(archive, names):
    manifests = [entry for entry in names if PurePosixPath(entry.filename).name == 'packages_manifest.csv']
    require(len(manifests) <= 1, 'В ZIP должен быть один реестр packages_manifest.csv')
    if not manifests:
        return {}
    entry = manifests[0]
    require(entry.file_size <= 256 * 1024, 'Реестр ZIP превышает 256 КБ')
    rows = csv.DictReader(io.StringIO(archive.read(entry).decode('utf-8-sig')))
    require({'file', 'venues'}.issubset(rows.fieldnames or []), 'В реестре нужны колонки file и venues')
    result = {}
    for row in rows:
        name = PurePosixPath((row.get('file') or '').replace('\\', '/')).name.casefold()
        require(name and name not in result, 'В реестре повторяется имя пакета или есть пустая строка')
        result[name] = row
    return result


def read_archive(raw, db, oid):
    try:
        with ZipFile(io.BytesIO(raw)) as archive:
            files = [entry for entry in archive.infolist() if not entry.is_dir()]
            entries = sorted([x for x in files if x.filename.casefold().endswith('.baros.json')], key=lambda x: x.filename.casefold())
            require(len(files) <= 5000 and 0 < len(entries) <= 200, 'Нужен ZIP с 1–200 файлами .baros.json')
            require(sum(entry.file_size for entry in entries) <= TOTAL_LIMIT, 'Учебные пакеты после распаковки превышают 64 МБ', 413)
            names = [PurePosixPath(x.filename).name.casefold() for x in entries]
            require(len(set(names)) == len(names), 'Имена .baros.json должны различаться внутри архива')
            manifest = archive_manifest(archive, files)
            result = []
            for entry, name in zip(entries, names):
                meta = manifest.get(name, {})
                allowed = [s.strip() for s in (meta.get('venues') or '').split(';') if s.strip()]
                readiness = (meta.get('readiness') or '').strip()
                blocked = 'заблок' in readiness.casefold() or readiness.casefold().startswith(('не импорт', 'block'))
                priority = (meta.get('priority') or '').strip().upper()
                info = {'file': entry.filename, 'title': '', 'kind': None, 'venues': allowed,
                        'readiness': readiness, 'priority': priority if priority in {'P0', 'P1', 'P2'} else None,
                        'blocked': blocked, 'unlisted': bool(manifest and not meta),
                        'error': None, 'duplicate': False}
                p = None
                try:
                    require(entry.file_size <= PACKAGE_LIMIT, 'Файл .baros.json превышает 2 МБ', 413)
                    p = PackageIn.model_validate_json(archive.read(entry).decode('utf-8-sig'))
                    info.update(title=(p.course or p.assessment).title, kind=p.kind,
                                positions=(p.course or p.assessment).positions)
                    validate_media(db, oid, (p.course or p.assessment).model_dump(mode='json'))
                    info['duplicate'] = bool(db.scalar(select(PackageReceipt.id).where(
                        PackageReceipt.organization_id == oid, PackageReceipt.fingerprint == fingerprint(p))))
                except ValidationError as error:
                    field = '.'.join(map(str, error.errors(include_input=False, include_context=False)[0]['loc']))
                    info['error'] = 'Проверьте формат учебного пакета' + (f' ({field})' if field else '')
                except HTTPException as error:
                    info['error'] = error.detail
                except (BadZipFile, RuntimeError, UnicodeError, NotImplementedError, ValueError, RecursionError):
                    info['error'] = 'Не удалось прочитать файл'
                if blocked:
                    info['error'] = 'Пакет заблокирован в реестре для проверки содержания'
                result.append((info, p))
            return result
    except (BadZipFile, RuntimeError, UnicodeError, NotImplementedError, ValueError, csv.Error) as error:
        raise HTTPException(400, 'Не удалось прочитать ZIP или реестр UTF-8') from error


async def archive_bytes(file):
    raw = await file.read(ARCHIVE_LIMIT + 1)
    require(0 < len(raw) <= ARCHIVE_LIMIT, 'Размер ZIP — не более 15 МБ', 413)
    return raw


@router.post('/preview')
async def preview_zip(request: Request, file: UploadFile = File(...), a=Depends(actor), db=Depends(get_db)):
    oid = manager(request, db, a, 'courses_manage', True)
    raw = await archive_bytes(file)
    entries = [info for info, _ in read_archive(raw, db, oid)]
    venue = db.get(Organization, oid).name
    labels = sorted({label for entry in entries for label in entry['venues']}, key=str.casefold)
    matches = [label for label in labels if label.casefold() in venue.casefold()]
    return {'hash': hashlib.sha256(raw).hexdigest(), 'venue': venue, 'venue_id': oid,
            'archive_venues': labels, 'suggested_venue': matches[0] if len(matches) == 1 else '', 'entries': entries}


@router.post('/import')
async def import_zip(request: Request, file: UploadFile = File(...), selection: str = Form(...),
                     archive_hash: str = Form(...), archive_venue: str = Form(''), include_unlisted: bool = Form(False),
                     a=Depends(actor), db=Depends(get_db)):
    oid = manager(request, db, a, 'courses_manage', True)
    raw = await archive_bytes(file)
    require(hashlib.sha256(raw).hexdigest() == archive_hash, 'Выбран другой ZIP. Откройте предварительный просмотр заново.', 409)
    try:
        names = json.loads(selection)
    except (ValueError, RecursionError) as error:
        raise HTTPException(400, 'Проверьте выбор файлов') from error
    require(isinstance(names, list) and 0 < len(names) <= 200 and all(isinstance(n, str) for n in names),
            'Выберите учебные пакеты')
    selected = set(names)
    entries = [(info, p) for info, p in read_archive(raw, db, oid) if info['file'] in selected]
    require(len(entries) == len(selected), 'Один из файлов уже отсутствует в ZIP', 409)
    for info, _ in entries:
        require(not info['error'], f"{PurePosixPath(info['file']).name}: {info['error']}", 409)
        require(not info['unlisted'] or include_unlisted, 'Подтвердите заведение для файлов без строки в реестре', 409)
        require(not info['venues'] or archive_venue in info['venues'],
                'Один из файлов предназначен для другого заведения', 409)
    # Start a real write transaction before per-package savepoints, including SQLite.
    db.execute(update(VenueSettings).where(VenueSettings.organization_id == oid).values(
        organization_id=VenueSettings.organization_id))
    results = []
    for info, p in entries:
        saved = save_package(db, oid, a, p)
        if p.course and info['priority'] and not saved['duplicate']:
            db.add(CoursePresentation(course_id=saved['id'], priority_default=info['priority']))
        results.append({**saved, 'file': info['file'], 'title': info['title']})
    db.commit()
    return {'venue_id': oid, 'imported': sum(not row['duplicate'] for row in results), 'entries': results}
