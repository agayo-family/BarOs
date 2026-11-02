"""Private, database-backed course illustrations; never fetch remote image URLs."""
import io, re, secrets, warnings
from PIL import Image, ImageOps, UnidentifiedImageError
from fastapi import APIRouter, Depends, Request, UploadFile, File
from fastapi.responses import Response
from sqlalchemy import select, func
from ..db import get_db
from ..models import Course, Lesson, Question
from .auth import actor, manager, tenant, owner, rate
from .models import CourseMedia, SourceFile, CourseRevision, ImportedAssessment, WrittenAttempt, Exam, VenueSettings, GameRun
from .domain import require, parse, applies, course_settings

router=APIRouter()

def validate_media(db,oid,value):
    ids=set(re.findall(r'/api/media/([A-Za-z0-9_-]{20,80})',str(value)))
    if not ids:return
    found=set(db.scalars(select(CourseMedia.id).where(CourseMedia.id.in_(ids),CourseMedia.organization_id.in_([oid]) | CourseMedia.organization_id.is_(None))).all())
    require(ids==found,'В обучении есть недоступное фото. Загрузите его в это заведение.',409)

@router.post('/api/media')
async def upload(request:Request, file:UploadFile=File(...), global_asset:bool=False, a=Depends(actor), db=Depends(get_db)):
    if global_asset: owner(a);oid=None
    else: oid=manager(request,db,a,'courses_manage',True)
    rate(db,'course-media:'+str(a.id),40,3600)
    raw=await file.read(8*1024*1024+1);require(0<len(raw)<=8*1024*1024,'Размер фото — не больше 8 МБ',413)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error',Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as original:
                require(original.format in {'JPEG','PNG','WEBP'},'Загрузите JPEG, PNG или WebP')
                require(original.width*original.height<=16000000,'Изображение слишком большое')
                im=ImageOps.exif_transpose(original);im.thumbnail((1600,1600))
                # Fresh raster drops EXIF, comments, profiles and source filenames.
                clean=Image.new('RGB',im.size,'white')
                if im.mode in {'RGBA','LA'} or 'transparency' in im.info:
                    rgba=im.convert('RGBA');clean.paste(rgba,mask=rgba.getchannel('A'))
                else:clean.paste(im.convert('RGB'))
                buffer=io.BytesIO();clean.save(buffer,format='JPEG',quality=88,optimize=True);content=buffer.getvalue()
    except (UnidentifiedImageError,OSError,ValueError,Image.DecompressionBombError,Image.DecompressionBombWarning):
        require(False,'Не удалось прочитать фото. Выберите корректный JPEG, PNG или WebP')
    if oid is not None:
        limit=db.scalar(select(VenueSettings).where(VenueSettings.organization_id==oid).with_for_update()).storage_limit_mb*1024*1024
        used=(db.scalar(select(func.coalesce(func.sum(SourceFile.size),0)).where(SourceFile.organization_id==oid)) or 0)+(db.scalar(select(func.coalesce(func.sum(CourseMedia.size),0)).where(CourseMedia.organization_id==oid)) or 0)
        require(used+len(content)<=limit,'Достигнут лимит хранилища заведения',409)
    row=CourseMedia(id=secrets.token_urlsafe(24),organization_id=oid,creator_id=a.id,content=content,mime='image/jpeg',size=len(content));db.add(row);db.commit()
    return {'url':'/api/media/'+row.id,'width':clean.width,'height':clean.height,'size':row.size}

@router.get('/api/media/{mid}')
def image(mid:str,request:Request,a=Depends(actor),db=Depends(get_db)):
    row=db.get(CourseMedia,mid);require(row,'Фото не найдено',404)
    if a.role!='owner':
        oid=tenant(request,db,a,learning=a.role=='employee');require(row.organization_id in {oid,None},'Фото не найдено',404)
        if a.role=='employee' or row.organization_id is None:
            needle='/api/media/'+mid;allowed=False
            if a.role=='manager':
                allowed=bool(db.scalar(select(Lesson.id).join(Course,Course.id==Lesson.course_id).where(Course.organization_id==oid,Lesson.body.contains(needle)).limit(1))) or bool(db.scalar(select(Question.id).join(Course,Course.id==Question.course_id).where(Course.organization_id==oid,(Question.prompt.contains(needle)|Question.explanation.contains(needle))).limit(1))) or bool(db.scalar(select(ImportedAssessment.id).where(ImportedAssessment.organization_id==oid,ImportedAssessment.payload.contains(needle)).limit(1)))
            revisions=db.execute(select(CourseRevision,Course).join(Course,Course.id==CourseRevision.course_id).where(Course.organization_id==oid,Course.published==True,CourseRevision.payload.contains(needle))).all()
            for rev,course in revisions:
                cfg=course_settings(db,course)
                own_attempt=db.scalar(select(Exam.id).where(Exam.account_id==a.id,Exam.revision_id==rev.id).limit(1))
                own_game=db.scalar(select(GameRun.id).where(GameRun.account_id==a.id,GameRun.revision_id==rev.id).limit(1))
                if a.role=='manager' or (not cfg.archived and applies(a,parse(rev.payload)) and (rev.version==cfg.version or own_attempt or own_game)):allowed=True;break
            if not allowed:
                for item in db.scalars(select(ImportedAssessment).where(ImportedAssessment.organization_id==oid,ImportedAssessment.published==True,ImportedAssessment.archived==False,ImportedAssessment.payload.contains(needle))).all():
                    if applies(a,parse(item.payload)):allowed=True;break
            if not allowed:allowed=bool(db.scalar(select(WrittenAttempt.id).where(WrittenAttempt.account_id==a.id,WrittenAttempt.snapshot.contains(needle)).limit(1)))
            require(allowed,'Фото не найдено',404)
    else:
        supplied=request.headers.get('x-organization-id')
        if supplied:require(supplied.isdigit() and row.organization_id in {int(supplied),None},'Фото не найдено',404)
    return Response(row.content,media_type=row.mime,headers={'Cache-Control':'private, no-store'})
