"""Track source changes without modifying an approved course or its history."""
from sqlalchemy import select
from ..models import Course
from .models import CourseProgram, CourseSettings
from .domain import digest, dump, parse


def fingerprint(source):
    return digest(dump([source.text, parse(source.positions_json, [])]))


def mark_changed(db, organization_id, source_id, reason):
    rows = db.scalars(select(CourseSettings).join(Course, Course.id == CourseSettings.course_id)
                      .where(Course.organization_id == organization_id).with_for_update()).all()
    count = 0
    for settings in rows:
        if source_id not in parse(settings.source_ids_json, []):
            continue
        row = db.get(CourseProgram, settings.course_id)
        data = parse(row.payload) if row else {}
        old = data.get('source_review', {})
        ids = set(old.get('source_ids', [])) | {source_id}
        data['source_review'] = {'required': True, 'source_ids': sorted(ids), 'reason': reason}
        if row:
            row.payload = dump(data)
        else:
            db.add(CourseProgram(course_id=settings.course_id, payload=dump(data)))
        count += 1
    return count


def acknowledge(db, course_id):
    row = db.get(CourseProgram, course_id)
    if row:
        data = parse(row.payload)
        if data.get('source_review', {}).get('required'):
            data['source_review'] = {'required': False, 'source_ids': []}
            row.payload = dump(data)
