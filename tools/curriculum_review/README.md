# Редакция общей библиотеки 2026.10.3

Рабочая версия хранится в `baros/v2/standard_courses.json`. Эти исходники позволяют повторить редакционные изменения поверх сохранённой версии f044c7e. Из корня репозитория выполните последовательно:

```sh
python3 tools/curriculum_review/bar.py
python3 tools/curriculum_review/waiter.py
python3 tools/curriculum_review/admin.py
python3 tools/curriculum_review/hookah.py
python3 tools/curriculum_review/cook.py
python3 tools/curriculum_review/clean.py
python3 tools/curriculum_review/language.py
python3 tools/curriculum_review/finalize.py
```

Нужна git-история с указанным исходным коммитом. Никакой генерации или вызовов ИИ в работающем приложении нет. P описывает четыре самостоятельных вопроса о близких понятиях; revise содержит одну строку на каждый вопрос исходного банка. finalize сохраняет второй смысловой проход.

Сохранение редактором идёт в БД и не переписывает эти исходники. Включение библиотеки — отдельное действие владельца. Технические метрики длины ответа не доказывают методическое качество; нужны чтение и пробное прохождение реальными сотрудниками.
