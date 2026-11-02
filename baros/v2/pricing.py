"""Public subscription estimates and owner-managed commercial settings.

These settings never change an existing venue's access or charge a customer.
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator
from sqlalchemy import select
from ..db import get_db
from .auth import actor, owner
from .domain import dump, parse, require, log
from .models import Setting

router = APIRouter()
KEY = 'public_pricing'
LIMITS = (50, 100, 200)


class PricingIn(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    version: StrictInt = Field(ge=0)
    prices: list[StrictInt] = Field(min_length=3, max_length=3)
    contact_email: str = Field(default='', max_length=254, pattern=r'^$|^[A-Za-z0-9.!#$%&\x27*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$')

    @model_validator(mode='after')
    def valid_prices(self):
        if any(p < 100 or p > 1000000 for p in self.prices):
            raise ValueError('Цена должна быть от 100 до 1 000 000 рублей')
        if not self.prices[0] < self.prices[1] < self.prices[2]:
            raise ValueError('Цена должна увеличиваться вместе с лимитом сотрудников')
        return self


def pricing(db):
    row = db.get(Setting, KEY)
    saved = parse(row.value) if row else {}
    prices = saved.get('prices', [9900, 14900, 24900])
    return {'version': saved.get('version', 0), 'currency': 'RUB', 'period': 'month',
            'per_venue': True, 'contact_email': saved.get('contact_email', ''),
            'tiers': [{'employees': limit, 'monthly': price} for limit, price in zip(LIMITS, prices)]}


@router.get('/api/pricing')
def public_pricing(db=Depends(get_db)):
    return pricing(db)


@router.put('/api/owner/pricing')
def save_pricing(body: PricingIn, a=Depends(actor), db=Depends(get_db)):
    owner(a)
    # A startup-created shared row serializes concurrent edits, including the
    # first edit. The version guard also rejects stale open browser forms.
    row = db.scalar(select(Setting).where(Setting.key == KEY).with_for_update())
    require(row, 'Обновите страницу и повторите действие', 409)
    current = pricing(db)
    require(current['version'] == body.version, 'Тарифы уже изменены. Обновите страницу.', 409)
    row.value = dump({'version': body.version + 1, 'prices': body.prices,
                      'contact_email': body.contact_email})
    log(db, a, None, 'Обновлены публичные тарифы', pricing_version=body.version + 1)
    db.commit()
    return pricing(db)
