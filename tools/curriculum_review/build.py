"""Reviewed authoring source; runtime consumes the generated standard_courses.json."""
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / 'baros/v2/standard_courses.json'
BASE = json.loads(subprocess.check_output(['git', 'show', 'f044c7e:baros/v2/standard_courses.json'], cwd=ROOT, text=True))

def P(title, answers, prompts, rule, lesson=0):
    assert len(answers) == len(prompts) == 4
    assert len(set(answers)) == 4
    return title, answers, prompts, rule, lesson

def review(key, packs):
    assert len(packs) == 10, key
    data = json.loads(TARGET.read_text())
    item = next(c for c in data['courses'] if c['key'] == key)
    old = next(c for c in BASE['courses'] if c['key'] == key)
    lessons = json.loads(json.dumps(old['course']['lessons']))
    questions = []
    for title, answers, prompts, rule, li in packs:
        assert 0 <= li < len(lessons)
        assert not any(re.match(r'(?i)^(только|сразу|всегда|никогда|да,|нет,)\b', a) for a in answers)
        for i, entry in enumerate(prompts):
            prompt, correct = entry if isinstance(entry, tuple) else (entry, i)
            order = [(j + correct - i) % 4 for j in range(4)]
            questions.append({'prompt': prompt, 'choices': [answers[j] for j in order],
                              'correct_index': order.index(correct), 'explanation': rule + ' Ответ: ' + answers[correct] + '.',
                              'type': 'understanding'})
        lessons[li]['body'] += '\n\n## ' + title + '\n' + rule
    assert len({q['prompt'] for q in questions}) == 40
    item['course']['lessons'] = lessons
    item['course']['questions'] = questions
    item['version'] = 3
    item['assessment_design'] = {'revision': 3, 'reviewed_at': '2026-10-27',
        'approach': 'Профессиональные понятия, условия работы и расчёты; близкие по форме варианты ответа'}
    data['version'] = '2026.10.3'
    TARGET.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    print(key, sum(c['version'] >= 3 for c in data['courses']), '/36')
