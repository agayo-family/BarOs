"""Deterministic checks of generated teaching material; never an AI quality score."""
import math
from decimal import Decimal
import re
from .schemas import LessonIn

# Check measured quantities, not heading numbers or numbered exercise steps.
_QUANTITY = re.compile(r'(?<![\w.,])([-+]?\d+(?:[ \u00a0]\d{3})*(?:[.,]\d+)?)\s*(°\s*[cс]|мл|ml|литр(?:а|ов)?|л|грамм(?:а|ов)?|гр|г|кг|kg|g|минут(?:а|ы)?|мин|час(?:а|ов)?|ч|сут(?:ки|ок)?|дн(?:я|ей)?|день|дней|лет|год(?:а)?|%|₽|руб(?:лей|ля)?)(?!\w)', re.I)
_ALIASES = {'ml':'мл','литр':'л','литра':'л','литров':'л','грамм':'г','грамма':'г','граммов':'г','гр':'г','g':'г','kg':'кг',
            'минута':'мин','минут':'мин','минуты':'мин','час':'ч','часа':'ч','часов':'ч','сутки':'сут','суток':'сут',
            'дня':'день','дней':'день','лет':'год','года':'год','руб':'₽','рубля':'₽','рублей':'₽'}


def quantities(text):
    found=set()
    for number,unit in _QUANTITY.findall(str(text)):
        unit=re.sub(r'\s+','',unit.casefold()).replace('°с','°c')
        found.add((format(Decimal(re.sub(r'\s+','',number).replace(',','.')).normalize(),'f'),_ALIASES.get(unit,unit)))
    return found


def reading_minutes(body):
    return max(1,math.ceil(len(str(body).split())/180))


def validate_theory(result,context):
    if not isinstance(result.get('title'),str) or not 2<=len(result['title'].strip())<=200 or not isinstance(result.get('description',''),str) or len(result.get('description',''))>3000:
        raise ValueError('AI вернул неверные название или описание курса. Прогресс сохранён.')
    read_limitations(result)
    raw=result.get('lessons')
    if not isinstance(raw,list) or not 1 <= len(raw) <= 30:
        raise ValueError('AI не создал корректную структуру теории: нужно от 1 до 30 уроков. Прогресс сохранён.')
    lessons=[LessonIn.model_validate(lesson).model_dump() for lesson in raw]
    allowed=quantities(context)
    for lesson in lessons:
        if quantities(lesson['title']+'\n'+lesson['body'])-allowed:
            raise ValueError('В теории AI найдена величина или единица измерения, которой нет в источнике. Проверьте материал и продолжите генерацию.')
    if len({re.sub(r'\s+',' ',l['body']).casefold() for l in lessons}) != len(lessons):
        raise ValueError('AI повторил один и тот же урок. Добавьте материал или продолжите генерацию.')
    return lessons


def review_material(lessons,questions):
    """Flags are for human review. Exact citations do not prove semantic correctness."""
    rows=[];warnings=[]
    for index,lesson in enumerate(lessons):
        body=lesson['body'];headings=re.findall(r'^#{1,3}\s+(.+)$',body,re.M)
        objective=bool(re.search(r'(цель|результат|после урока|научитесь|сможете)',body,re.I))
        recap=bool(re.search(r'(коротко|итог|запомните|повторение|ключевые факты)',body,re.I))
        count=sum(q.get('lesson_index')==index for q in questions)
        remarks=[]
        if not headings:remarks.append('Разделите текст на смысловые блоки с заголовками.')
        if not objective:remarks.append('Укажите, что сотрудник сможет сделать после урока.')
        if not recap:remarks.append('Добавьте короткое повторение основных фактов.')
        if not count:remarks.append('Проверьте, нужна ли проверка знаний по этому уроку: связанных вопросов пока нет.')
        rows.append({'lesson_index':index,'title':lesson['title'],'minutes':reading_minutes(body),'questions':count,'remarks':remarks})
    titles=[re.sub(r'\s+',' ',l['title']).casefold() for l in lessons]
    if len(set(titles))!=len(titles):warnings.append('Названия уроков повторяются. Уточните различия тем.')
    return {'requires_review':True,'lessons':rows,'warnings':warnings,
            'note':'Проверка структуры и числовых величин не доказывает правильность всех фактов. Сверьте теорию, ответы и объяснения с источниками перед публикацией.'}


def read_limitations(result):
    items=result.get('limitations',[])
    if not isinstance(items,list) or len(items)>20 or any(not isinstance(item,str) or len(item)>2000 for item in items):
        raise ValueError('AI вернул неверный список замечаний к материалу. Прогресс сохранён.')
    return items
