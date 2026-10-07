from pydantic import BaseModel, Field, field_validator, ConfigDict
from datetime import datetime
from .domain import POSITIONS, QTYPES

class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)

class LoginIn(StrictModel):
    login: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=1, max_length=200)
class OwnerRecoveryIn(StrictModel):
    token: str = Field(min_length=1, max_length=512)
    login: str = Field(min_length=3, max_length=255, pattern=r'^[a-zA-Z0-9_.@+\-]+$')
    password: str = Field(min_length=12, max_length=200)
class JoinIn(StrictModel):
    code: str = Field(min_length=6, max_length=32)
    name: str = Field(min_length=2, max_length=160)
    login: str = Field(min_length=3, max_length=80, pattern=r'^[a-zA-Z0-9_.@+\-]+$')
    password: str = Field(min_length=10, max_length=200)
    positions: list[str] = Field(min_length=1, max_length=8)
class InviteIn(StrictModel):
    name: str = Field(min_length=2, max_length=160)
    organization: str = Field(min_length=2, max_length=200)
class VenueIn(StrictModel):
    name: str = Field(min_length=2, max_length=200)
    plan: str = Field(default='Пилот', min_length=1, max_length=80)
    days: int = Field(default=30, ge=1, le=3660)
    seat_limit: int = Field(default=50, ge=1, le=10000)
class VenueUpdate(StrictModel):
    name: str = Field(min_length=2, max_length=200)
    status: str = Field(pattern='^(active|read_only|suspended|archived)$')
    plan: str = Field(min_length=1, max_length=80)
    subscription_status: str = Field(pattern='^(trial|active|past_due|suspended)$')
    paid_until: datetime | None = None
    seat_limit: int = Field(ge=1, le=10000)
    storage_limit_mb: int = Field(ge=15, le=10000)
    ai_daily_limit: int = Field(ge=0, le=100)
    note: str = Field(default='', max_length=2000)
    permissions: dict[str, bool] = Field(default_factory=dict)
class StaffIn(StrictModel):
    name: str = Field(min_length=2, max_length=160)
    positions: list[str] = Field(default_factory=list, max_length=8)
    active: bool = True
    permissions: dict[str, bool] = Field(default_factory=dict)
class ProfileIn(StrictModel):
    name: str = Field(min_length=2, max_length=160)
    current_password: str = Field(default='', max_length=200)
    new_password: str = Field(default='', max_length=200)
class LessonIn(StrictModel):
    title: str = Field(min_length=2, max_length=200)
    body: str = Field(min_length=10, max_length=40000)
class QuestionIn(StrictModel):
    prompt: str = Field(min_length=10, max_length=2000)
    choices: list[str] = Field(min_length=4, max_length=4)
    correct_index: int = Field(ge=0, le=3)
    explanation: str = Field(min_length=5, max_length=3000)
    type: str = 'knowledge'
    @field_validator('choices')
    @classmethod
    def unique_choices(cls, v):
        v = [s.strip() for s in v]
        if any(len(s) < 1 or len(s) > 1500 for s in v) or len({s.casefold() for s in v}) != 4:
            raise ValueError('Нужны четыре различных непустых ответа')
        return v
    @field_validator('type')
    @classmethod
    def valid_type(cls, v):
        if v not in QTYPES: raise ValueError('Неизвестный тип вопроса')
        return v
class CourseIn(StrictModel):
    title: str = Field(min_length=2, max_length=200)
    description: str = Field(default='', max_length=3000)
    positions: list[str] = Field(default=['all'], min_length=1, max_length=8)
    passing_score: int = Field(default=80, ge=1, le=100)
    required: bool = True
    quiz_size: int = Field(default=30, ge=1, le=100)
    time_limit_minutes: int = Field(default=30, ge=1, le=180)
    max_attempts: int = Field(default=0, ge=0, le=50)
    deadline_days: int = Field(default=7, ge=1, le=365)
    due_at: datetime | None = None
    is_intro: bool = False
    edit_version: int | None = None
    lessons: list[LessonIn] = Field(default_factory=list, max_length=100)
    questions: list[QuestionIn] = Field(default_factory=list, max_length=1000)
class PublishIn(StrictModel):
    reviewed: bool
    edit_version: int
class GenerateIn(StrictModel):
    title: str = Field(default='Обучение по материалам заведения', min_length=2, max_length=200)
    source_ids: list[int] = Field(default_factory=list, max_length=20)
    positions: list[str] = Field(default=['all'], min_length=1, max_length=8)
    interview: bool = False
class InterviewIn(StrictModel):
    venue_type: str = Field(min_length=2, max_length=200)
    concept: str = Field(min_length=10, max_length=5000)
    guest_profile: str = Field(min_length=5, max_length=3000)
    service_style: str = Field(min_length=10, max_length=5000)
    must_know: str = Field(min_length=10, max_length=8000)
    common_mistakes: str = Field(default='', max_length=5000)
    special_rules: str = Field(default='', max_length=8000)
    tone: str = Field(default='', max_length=2000)
    roles_present: list[str] = Field(default_factory=list, max_length=8)
class AnswerIn(StrictModel):
    answers: dict[str, int] = Field(default_factory=dict, max_length=100)
class ReadIn(StrictModel):
    complete: bool = False
class SourceUpdate(StrictModel):
    text: str = Field(max_length=180000)
    positions: list[str] = Field(default=['all'], min_length=1, max_length=8)
