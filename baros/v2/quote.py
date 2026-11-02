"""A real, editable Word estimate built from the current public price settings."""
from datetime import datetime
from io import BytesIO
from zoneinfo import ZoneInfo

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


def money(value):
    return f'{value:,}'.replace(',', '\u00a0') + ' ₽'


def make_quote(prices, employees, mode):
    tier = next((t for t in prices['modes'][mode]['tiers'] if employees <= t['employees']), None)
    title = prices['modes'][mode]['title']
    document = Document()
    # Some Office templates carry a blue rule in the inherited Title style.
    # Keep the exported estimate clean in both Word and LibreOffice.
    for border in document.styles.element.xpath('.//w:pBdr'):
        border.getparent().remove(border)
    document.core_properties.author = 'BarOS'
    document.core_properties.title = 'Расчёт подключения BarOS'
    document.core_properties.subject = 'Предварительная стоимость для одного заведения'
    section = document.sections[0]
    section.page_width, section.page_height = Inches(8.5), Inches(11)
    section.top_margin = section.bottom_margin = Inches(.65)
    section.left_margin = section.right_margin = Inches(.75)
    for name in ['Normal', 'Title', 'Subtitle', 'Heading 1', 'Heading 2']:
        style = document.styles[name]
        style.font.name = 'Arial'
        style.font.color.rgb = RGBColor(0, 0, 0)
    normal = document.styles['Normal']
    normal.font.size = Pt(10.5)
    normal.paragraph_format.space_after = Pt(7)
    normal.paragraph_format.line_spacing = 1.12
    document.styles['Title'].font.size = Pt(27)
    document.styles['Title'].paragraph_format.space_after = Pt(9)
    document.styles['Heading 1'].font.size = Pt(13)
    document.styles['Heading 1'].paragraph_format.space_before = Pt(14)
    document.styles['Heading 1'].paragraph_format.space_after = Pt(7)
    p = document.add_paragraph('BAROS  /  ОБУЧЕНИЕ КОМАНДЫ')
    p.runs[0].font.size = Pt(9)
    p.runs[0].bold = True
    document.add_paragraph('Расчёт подключения BarOS', 'Title')
    date = datetime.now(ZoneInfo('Europe/Moscow')).strftime('%d.%m.%Y')
    document.add_paragraph(f'{date}  •  Одно заведение  •  {employees} сотрудников')
    document.add_paragraph(f'Способ подключения: {title}. ' +
                           (f"Тариф до {tier['employees']} сотрудников." if tier else 'Индивидуальные условия для команды больше 200 сотрудников.'))
    document.add_heading('Стоимость подключения', 1)
    if tier:
        rows = [('Подписка на один месяц', money(tier['monthly']))]
        if tier['preparation']:
            rows += [('Подготовка обучения разово', 'от ' + money(tier['preparation'])),
                     ('Первый месяц вместе с подготовкой', 'от ' + money(tier['monthly'] + tier['preparation']))]
        else:
            rows += [('Разовая подготовка командой BarOS', 'Не включена'),
                     ('Первый месяц', money(tier['monthly']))]
        table = document.add_table(rows=1, cols=2)
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        table.autofit = False
        table.columns[0].width, table.columns[1].width = Inches(4.5), Inches(2.5)
        for cell, text in zip(table.rows[0].cells, ['Состав расчёта', 'Стоимость']):
            cell.text = text
        for label, amount in rows:
            cells = table.add_row().cells
            cells[0].text, cells[1].text = label, amount
        for i, row in enumerate(table.rows):
            row._tr.get_or_add_trPr().append(OxmlElement('w:cantSplit'))
            for j, cell in enumerate(row.cells):
                cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
                properties = cell._tc.get_or_add_tcPr()
                shading = OxmlElement('w:shd')
                shading.set(qn('w:fill'), '292440' if i == 0 else ('F5F4FA' if i % 2 else 'FFFFFF'))
                properties.append(shading)
                borders = OxmlElement('w:tcBorders')
                for edge in ['top', 'left', 'bottom', 'right']:
                    line = OxmlElement('w:' + edge)
                    for key, value in [('val', 'single'), ('sz', '4'), ('color', 'D9D9D9')]:
                        line.set(qn('w:' + key), value)
                    borders.append(line)
                properties.append(borders)
                margins = OxmlElement('w:tcMar')
                for edge in ['top', 'left', 'bottom', 'right']:
                    item = OxmlElement('w:' + edge)
                    item.set(qn('w:w'), '130')
                    item.set(qn('w:type'), 'dxa')
                    margins.append(item)
                properties.append(margins)
                p = cell.paragraphs[0]
                p.paragraph_format.space_after = p.paragraph_format.space_before = Pt(2)
                if j == 1:
                    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
                for run in p.runs:
                    run.font.size = Pt(10)
                    run.bold = i == 0 or i == len(table.rows) - 1
                    if i == 0:
                        run.font.color.rgb = RGBColor(255, 255, 255)
        table.rows[0]._tr.get_or_add_trPr().append(OxmlElement('w:tblHeader'))
    else:
        document.add_paragraph('Стоимость согласуется после уточнения состава команды, числа заведений и объёма обучения. Фиксированная сумма в этот расчёт не включена.')
    document.add_heading('Что входит в подписку', 1)
    document.add_paragraph('Уроки и тесты с фотографиями, письменные ответы с проверкой управляющим, карточки и учебные игры. Назначения по должностям и аналитика команды. График смен, учёт часов и расчёт заработка.')
    if mode == 'managed':
        document.add_paragraph('Команда BarOS готовит обучение по вашим материалам. Темы, количество курсов, обновления и сроки согласуются отдельно до оплаты.')
    else:
        document.add_paragraph('Вы загружаете материалы, собираете и редактируете черновики. Управляющий проверяет содержание и публикует обучение.')
    document.add_heading('Следующий шаг', 1)
    document.add_paragraph('Пришлите название и город заведения, число сотрудников и первую задачу обучения. Согласуем объём пилота, критерии результата, сроки и счёт.')
    email = prices.get('contact_email')
    document.add_paragraph(('Почта: ' + email + '\n' if email else '') + 'Telegram: @Frooppe  •  https://t.me/Frooppe')
    p = document.add_paragraph('Предварительный расчёт на дату скачивания. Не является счётом или договором. Оплата по согласованному счёту напрямую исполнителю, без автоматических списаний. Окончательный состав работ и стоимость фиксируются в договоре.')
    for run in p.runs:
        run.font.size = Pt(8)
        run.font.color.rgb = RGBColor.from_string('686477')
    output = BytesIO()
    document.save(output)
    return output.getvalue()
