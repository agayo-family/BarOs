"""Structural evidence only; does not claim to prove educational effectiveness."""
from collections import Counter
import json
import re
import subprocess
from build import ROOT, TARGET

data=json.loads(TARGET.read_text())
base=json.loads(subprocess.check_output(['git','show','f044c7e:baros/v2/standard_courses.json'],cwd=ROOT,text=True))
questions=[q for c in data['courses'] for q in c['course']['questions']]
old=[q for c in base['courses'] for q in c['course']['questions']]
def metrics(qs):
    lengths=[(len(q['choices'][q['correct_index']].split()),[len(a.split()) for i,a in enumerate(q['choices']) if i!=q['correct_index']]) for q in qs]
    return {'mean_correct_words':round(sum(a for a,b in lengths)/len(qs),3),
            'mean_wrong_words':round(sum(sum(b) for a,b in lengths)/(3*len(qs)),3),
            'longest_choice_first_tie_accuracy':round(sum(max(range(4),key=lambda i:len(q['choices'][i]))==q['correct_index'] for q in qs)/len(qs),4)}
assert len(data['courses'])==36 and len(questions)==1440
assert all(c['version']==3 and len(c['course']['questions'])==40 for c in data['courses'])
assert all(len(set(q['choices']))==4 and 0<=q['correct_index']<4 for q in questions)
assert len({q['prompt'].casefold() for q in questions})==len(questions)
assert all(not re.search(r'(?mi)^##\s*(задание|домашнее|практическая проверка)\b',l['body']) for c in data['courses'] for l in c['course']['lessons'])
prefixes=sum(bool(re.match(r'(?i)^(только|сразу|всегда|никогда)\b',a)) for q in questions for a in q['choices'])
assert prefixes==0
report={'date':'2026-10-27','catalog_version':data['version'],'courses':len(data['courses']),
        'roles':dict(Counter(c['role'] for c in data['courses'])),
        'lessons':sum(len(c['course']['lessons']) for c in data['courses']),
        'changed_lesson_bodies':sum(l['body']!=b['body'] for c,bc in zip(data['courses'],base['courses']) for l,b in zip(c['course']['lessons'],bc['course']['lessons'])),
        'questions':len(questions),'answer_positions':dict(Counter(q['correct_index'] for q in questions)),
        'formulaic_choice_prefixes':prefixes,'before':metrics(old),'after':metrics(questions),
        'course_details':[{'key':c['key'],'lessons':len(c['course']['lessons']),
                           'words':sum(len(l['body'].split()) for l in c['course']['lessons']),
                           'questions':len(c['course']['questions'])} for c in data['courses']],
        'limitations':['Лингвистическая эвристика не является проверкой знания профессии.',
                      'Требуются чтение владельцем и наблюдение пробного прохождения сотрудниками.',
                      'Разные обоснованные сервисные ответы оцениваются в отдельных письменных работах.']}
(ROOT/'docs/audit-2.9-curriculum.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='course_details'},ensure_ascii=False))
