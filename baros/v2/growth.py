"""Optional learning rewards. All currency mutations are transactional and server owned."""
import io
import math
from datetime import timedelta
from fastapi import APIRouter, Depends, Request, UploadFile, File
from fastapi.responses import Response
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import Field
from sqlalchemy import select, func
from ..db import get_db
from .auth import actor, manager, tenant, rate
from .domain import require, parse, dump, now, iso
from .models import Account, LearningProfile, RewardEvent
from .schemas import StrictModel
from .companions import PET_IDS, SHOP, ACHIEVEMENTS, catalog

router=APIRouter(prefix='/api/growth')
DAILY_XP=400
DAILY_GOLD=200


def locked_profile(db,a):
    db.scalar(select(Account).where(Account.id==a.id).with_for_update())
    p=db.get(LearningProfile,a.id)
    if not p:
        p=LearningProfile(account_id=a.id,xp=0,gold=0,pet_xp=0,pet_swaps=0,inventory='[]',equipped='{}',achievements='{}',stats='{}',avatar_version=0,companion_enabled=True)
        db.add(p);db.flush()
    return p


def level_info(xp,step=100):
    level=int((1+math.sqrt(1+8*max(0,xp)/step))/2)
    base=step*level*(level-1)//2; goal=step*level
    return {'level':level,'progress':xp-base,'next':goal,'percent':round(100*(xp-base)/goal)}


def profile_data(db,a,p):
    stats=parse(p.stats);earned=parse(p.achievements)
    return {'account_id':a.id,'name':a.name,'role':a.role,'xp':p.xp,'gold':p.gold,**level_info(p.xp),
            'pet_id':p.pet_id,'pet_xp':p.pet_xp,'pet_level':level_info(p.pet_xp,50)['level'],
            'pet_progress':level_info(p.pet_xp,50),'pet_swaps_left':1-p.pet_swaps,
            'inventory':parse(p.inventory,[]),'equipped':parse(p.equipped),'stats':stats,
            'avatar_url':f'/api/growth/avatar/{a.id}?v={p.avatar_version}' if p.avatar else None,
            'companion_enabled':p.companion_enabled,'daily_limits':{'xp':DAILY_XP,'gold':DAILY_GOLD},
            'achievements':[{'id':key,'name':name,'description':desc,'icon':icon,'target':target,
                  'progress':min(target,stats.get(stat,0)),'earned_at':earned.get(key)} for key,name,desc,icon,stat,target in ACHIEVEMENTS]}


def reward(db,a,event,category,xp,gold,**increments):
    if a.role!='employee':return {'xp':0,'gold':0,'reason':'preview'}
    p=locked_profile(db,a)
    if db.scalar(select(RewardEvent.id).where(RewardEvent.account_id==a.id,RewardEvent.event_key==event)):
        return {'xp':0,'gold':0,'reason':'already_credited'}
    midnight=now().replace(hour=0,minute=0,second=0,microsecond=0)
    totals=db.execute(select(func.coalesce(func.sum(RewardEvent.xp),0),func.coalesce(func.sum(RewardEvent.gold),0)).where(RewardEvent.account_id==a.id,RewardEvent.created_at>=midnight)).one()
    xp=max(0,min(xp,DAILY_XP-totals[0]));gold=max(0,min(gold,DAILY_GOLD-totals[1]))
    # Even at the daily limit, the event is recorded once and cannot be replayed tomorrow.
    db.add(RewardEvent(account_id=a.id,event_key=event,category=category,xp=xp,gold=gold))
    p.xp+=xp;p.gold+=gold
    if p.pet_id:p.pet_xp+=xp
    stats=parse(p.stats)
    for key,value in increments.items():stats[key]=stats.get(key,0)+value
    today=midnight.date().isoformat()
    if stats.get('last_day')!=today:stats['days']=stats.get('days',0)+1;stats['last_day']=today
    p.stats=dump(stats);earned=parse(p.achievements);new=[]
    for key,name,desc,icon,stat,target in ACHIEVEMENTS:
        if key not in earned and stats.get(stat,0)>=target:earned[key]=iso(now());new.append(name)
    p.achievements=dump(earned)
    db.flush()
    return {'xp':xp,'gold':gold,'achievements':new,'level':level_info(p.xp)['level'],'pet_level':level_info(p.pet_xp,50)['level'],
            'reason':'daily_limit' if not xp and not gold else 'earned'}


@router.get('/catalog')
def growth_catalog(a=Depends(actor)):
    return {'pets':catalog(),'shop':SHOP}


@router.get('')
def growth_profile(a=Depends(actor),db=Depends(get_db)):
    p=locked_profile(db,a);db.commit();return profile_data(db,a,p)


@router.get('/employees/{aid}')
def employee_growth(aid:int,request:Request,a=Depends(actor),db=Depends(get_db)):
    oid=manager(request,db,a)
    employee=db.get(Account,aid)
    require(employee and employee.role=='employee' and employee.organization_id==oid,'Сотрудник не найден',404)
    p=locked_profile(db,employee);db.commit();return profile_data(db,employee,p)


class PetIn(StrictModel):
    pet_id:str=Field(max_length=30)
    confirm_swap:bool=False


@router.post('/pet')
def choose_pet(data:PetIn,a=Depends(actor),db=Depends(get_db)):
    require(data.pet_id in PET_IDS,'Питомец не найден',404)
    p=locked_profile(db,a)
    if p.pet_id!=data.pet_id:
        if p.pet_id:
            require(p.pet_swaps<1,'Единственная смена питомца уже использована',409)
            require(data.confirm_swap,'Подтвердите смену: уровень нового питомца начнётся с первого',409)
            p.pet_swaps+=1
        p.pet_id=data.pet_id;p.pet_xp=0
    db.commit();return profile_data(db,a,p)


class ItemIn(StrictModel):
    item_id:str=Field(max_length=40)


@router.post('/buy')
def buy(data:ItemIn,a=Depends(actor),db=Depends(get_db)):
    item=next((x for x in SHOP if x['id']==data.item_id),None);require(item,'Предмет не найден',404)
    p=locked_profile(db,a);inventory=parse(p.inventory,[])
    if item['id'] not in inventory:
        require(p.pet_id,'Сначала выберите питомца',409)
        require(level_info(p.xp)['level']>=item['level'],'Предмет откроется на следующем уровне',409)
        require(p.gold>=item['price'],'Недостаточно золота',409)
        p.gold-=item['price'];inventory.append(item['id']);p.inventory=dump(inventory)
    db.commit();return profile_data(db,a,p)


class EquipIn(StrictModel):
    slot:str=Field(pattern='^(wings|artifact)$')
    item_id:str|None=Field(default=None,max_length=40)


@router.put('/equip')
def equip(data:EquipIn,a=Depends(actor),db=Depends(get_db)):
    p=locked_profile(db,a);items=parse(p.equipped)
    if data.item_id:
        item=next((x for x in SHOP if x['id']==data.item_id and x['slot']==data.slot),None)
        require(item and data.item_id in parse(p.inventory,[]),'Предмет сначала нужно приобрести',409)
        items[data.slot]=data.item_id
    else:items.pop(data.slot,None)
    p.equipped=dump(items);db.commit();return profile_data(db,a,p)


class PreferencesIn(StrictModel):
    companion_enabled:bool


@router.put('/preferences')
def preferences(data:PreferencesIn,a=Depends(actor),db=Depends(get_db)):
    p=locked_profile(db,a);p.companion_enabled=data.companion_enabled;db.commit();return {'ok':True}


@router.post('/avatar')
async def avatar_upload(file:UploadFile=File(...),a=Depends(actor),db=Depends(get_db)):
    rate(db,'avatar:'+str(a.id),10,3600)
    raw=await file.read(5*1024*1024+1);require(len(raw)<=5*1024*1024,'Аватар: максимум 5 МБ',413)
    try:
        with Image.open(io.BytesIO(raw)) as image:
            require(image.format in {'JPEG','PNG','WEBP'},'Выберите JPEG, PNG или WebP')
            require(image.width*image.height<=16_000_000,'Изображение слишком большое')
            image=ImageOps.exif_transpose(image);image=ImageOps.fit(image.convert('RGB'),(256,256))
            out=io.BytesIO();image.save(out,'JPEG',quality=85,optimize=True);data=out.getvalue()
    except (UnidentifiedImageError,OSError,Image.DecompressionBombError):
        require(False,'Не удалось прочитать изображение')
    p=locked_profile(db,a);p.avatar=data;p.avatar_version+=1;db.commit();return profile_data(db,a,p)


@router.delete('/avatar')
def avatar_delete(a=Depends(actor),db=Depends(get_db)):
    p=locked_profile(db,a);p.avatar=None;p.avatar_version+=1;db.commit();return {'ok':True}


@router.get('/avatar/{aid}')
def avatar_image(aid:int,request:Request,a=Depends(actor),db=Depends(get_db)):
    if aid!=a.id:
        oid=manager(request,db,a);target=db.get(Account,aid)
        require(target and target.organization_id==oid,'Аватар недоступен',404)
    p=db.get(LearningProfile,aid);require(p and p.avatar,'Аватар не найден',404)
    return Response(p.avatar,media_type='image/jpeg',headers={'Cache-Control':'private, no-store'})
