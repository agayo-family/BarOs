from datetime import datetime
from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, LargeBinary, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from ..db import Base


def now():
    return datetime.utcnow()


class Account(Base):
    __tablename__ = 'v2_accounts'
    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int | None] = mapped_column(ForeignKey('organizations.id'), index=True)
    legacy_user_id: Mapped[int | None] = mapped_column(Integer, unique=True)
    employee_id: Mapped[int | None] = mapped_column(ForeignKey('employees.id'), unique=True)
    login: Mapped[str] = mapped_column(String(255), unique=True)
    name: Mapped[str] = mapped_column(String(160))
    role: Mapped[str] = mapped_column(String(24), index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    positions_json: Mapped[str] = mapped_column(Text, default='[]')
    permissions_json: Mapped[str] = mapped_column(Text, default='{}')
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime)


class LoginSession(Base):
    __tablename__ = 'v2_sessions'
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey('v2_accounts.id'), index=True)
    csrf: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)


class VenueSettings(Base):
    __tablename__ = 'v2_venues'
    organization_id: Mapped[int] = mapped_column(ForeignKey('organizations.id'), primary_key=True)
    join_code: Mapped[str] = mapped_column(String(32), unique=True)
    status: Mapped[str] = mapped_column(String(24), default='active')
    plan: Mapped[str] = mapped_column(String(80), default='Пилот')
    subscription_status: Mapped[str] = mapped_column(String(24), default='trial')
    paid_until: Mapped[datetime | None] = mapped_column(DateTime)
    seat_limit: Mapped[int] = mapped_column(Integer, default=50)
    storage_limit_mb: Mapped[int] = mapped_column(Integer, default=200)
    ai_daily_limit: Mapped[int] = mapped_column(Integer, default=5)
    permissions_json: Mapped[str] = mapped_column(Text, default='{}')
    note: Mapped[str] = mapped_column(Text, default='')


class Invite(Base):
    __tablename__ = 'v2_invites'
    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey('organizations.id'), index=True)
    account_id: Mapped[int | None] = mapped_column(ForeignKey('v2_accounts.id'))
    kind: Mapped[str] = mapped_column(String(24), default='manager')
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    used_at: Mapped[datetime | None] = mapped_column(DateTime)


class SourceFile(Base):
    __tablename__ = 'v2_source_files'
    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey('organizations.id'), index=True)
    legacy_upload_id: Mapped[int | None] = mapped_column(Integer, unique=True)
    name: Mapped[str] = mapped_column(String(255))
    mime: Mapped[str] = mapped_column(String(120))
    size: Mapped[int] = mapped_column(Integer)
    content: Mapped[bytes | None] = mapped_column(LargeBinary)
    text: Mapped[str] = mapped_column(Text, default='')
    positions_json: Mapped[str] = mapped_column(Text, default='["all"]')
    extraction_status: Mapped[str] = mapped_column(String(24), default='ready')
    warning: Mapped[str] = mapped_column(Text, default='')
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class CourseSettings(Base):
    __tablename__ = 'v2_course_settings'
    course_id: Mapped[int] = mapped_column(ForeignKey('courses.id'), primary_key=True)
    positions_json: Mapped[str] = mapped_column(Text, default='["all"]')
    quiz_size: Mapped[int] = mapped_column(Integer, default=30)
    time_limit_minutes: Mapped[int] = mapped_column(Integer, default=30)
    max_attempts: Mapped[int] = mapped_column(Integer, default=0)
    deadline_days: Mapped[int] = mapped_column(Integer, default=7)
    due_at: Mapped[datetime | None] = mapped_column(DateTime)
    is_intro: Mapped[bool] = mapped_column(Boolean, default=False)
    ai_generated: Mapped[bool] = mapped_column(Boolean, default=False)
    bank_target: Mapped[int] = mapped_column(Integer, default=100)
    source_ids_json: Mapped[str] = mapped_column(Text, default='[]')
    version: Mapped[int] = mapped_column(Integer, default=0)
    edit_version: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)


class CourseRevision(Base):
    __tablename__ = 'v2_revisions'
    __table_args__ = (UniqueConstraint('course_id', 'version'),)
    id: Mapped[int] = mapped_column(primary_key=True)
    course_id: Mapped[int] = mapped_column(ForeignKey('courses.id'), index=True)
    version: Mapped[int] = mapped_column(Integer)
    payload: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Enrollment(Base):
    __tablename__ = 'v2_enrollments'
    __table_args__ = (UniqueConstraint('account_id', 'revision_id'),)
    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey('v2_accounts.id'), index=True)
    revision_id: Mapped[int] = mapped_column(ForeignKey('v2_revisions.id'), index=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class LessonRead(Base):
    __tablename__ = 'v2_lesson_reads'
    __table_args__ = (UniqueConstraint('account_id', 'revision_id', 'lesson_index'),)
    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey('v2_accounts.id'), index=True)
    revision_id: Mapped[int] = mapped_column(ForeignKey('v2_revisions.id'), index=True)
    lesson_index: Mapped[int] = mapped_column(Integer)
    seconds: Mapped[int] = mapped_column(Integer, default=0)
    last_ping: Mapped[datetime] = mapped_column(DateTime, default=now)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)


class Exam(Base):
    __tablename__ = 'v2_exams'
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey('v2_accounts.id'), index=True)
    revision_id: Mapped[int] = mapped_column(ForeignKey('v2_revisions.id'), index=True)
    questions_json: Mapped[str] = mapped_column(Text)
    answers_json: Mapped[str] = mapped_column(Text, default='{}')
    started_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)
    result_json: Mapped[str] = mapped_column(Text, default='{}')


class Notice(Base):
    __tablename__ = 'v2_notices'
    __table_args__ = (UniqueConstraint('account_id', 'event_key'),)
    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey('v2_accounts.id'), index=True)
    event_key: Mapped[str] = mapped_column(String(160))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text)
    url: Mapped[str] = mapped_column(String(200), default='/app')
    read: Mapped[bool] = mapped_column(Boolean, default=False)
    push_sent: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class PushSubscription(Base):
    __tablename__ = 'v2_push_subscriptions'
    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey('v2_accounts.id'), index=True)
    endpoint_hash: Mapped[str] = mapped_column(String(64), unique=True)
    payload: Mapped[str] = mapped_column(Text)
    failures: Mapped[int] = mapped_column(Integer, default=0)


class Job(Base):
    __tablename__ = 'v2_jobs'
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey('organizations.id'), index=True)
    account_id: Mapped[int] = mapped_column(ForeignKey('v2_accounts.id'))
    course_id: Mapped[int | None] = mapped_column(ForeignKey('courses.id'))
    status: Mapped[str] = mapped_column(String(24), default='queued', index=True)
    phase: Mapped[str] = mapped_column(String(200), default='В очереди')
    progress: Mapped[int] = mapped_column(Integer, default=0)
    target: Mapped[int] = mapped_column(Integer, default=100)
    context: Mapped[str] = mapped_column(Text)
    positions_json: Mapped[str] = mapped_column(Text)
    source_ids_json: Mapped[str] = mapped_column(Text, default='[]')
    checkpoint: Mapped[str] = mapped_column(Text, default='{}')
    error: Mapped[str] = mapped_column(Text, default='')
    call_count: Mapped[int] = mapped_column(Integer, default=0)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime)
    lease_token: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Setting(Base):
    __tablename__ = 'v2_settings'
    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[str] = mapped_column(Text)


class Event(Base):
    __tablename__ = 'v2_events'
    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int | None] = mapped_column(Integer, index=True)
    actor_id: Mapped[int | None] = mapped_column(Integer)
    actor_name: Mapped[str] = mapped_column(String(160), default='Система')
    action: Mapped[str] = mapped_column(String(200))
    details: Mapped[str] = mapped_column(Text, default='{}')
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class RateBucket(Base):
    __tablename__ = 'v2_rate_buckets'
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    count: Mapped[int] = mapped_column(Integer, default=0)
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
