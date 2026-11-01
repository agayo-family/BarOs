"""Real PDF extraction remains usable after the security update."""
import unittest
from unittest.mock import patch
import pymupdf
from PIL import Image
from baros.v2.extraction import extract,ocr

class ExtractionTests(unittest.TestCase):
 def pdf(self,encrypted=False):
  doc=pymupdf.open();page=doc.new_page();page.insert_text((72,72),'Training menu: peach syrup 20 ml, sparkling water 80 ml. Check the recipe before service.')
  try:return doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256,owner_pw='owner-test-password',user_pw='user-test-password') if encrypted else doc.tobytes()
  finally:doc.close()
 def test_text_pdf_keeps_recipe_and_page_label(self):
  text,note=extract('menu.pdf',self.pdf());self.assertIn('peach syrup 20 ml',text);self.assertIn('water 80 ml',text);self.assertIn('Страница 1',text);self.assertEqual(note,'')
 def test_password_pdf_explains_the_next_step(self):
  with self.assertRaisesRegex(ValueError,'Снимите пароль'):extract('locked.pdf',self.pdf(True))
 def test_missing_recognition_language_has_user_guidance(self):
  with patch('baros.v2.extraction.pytesseract.get_languages',return_value=['eng']):
   with self.assertRaisesRegex(ValueError,'Вставьте текст вручную'):ocr(Image.new('RGB',(20,20)))
