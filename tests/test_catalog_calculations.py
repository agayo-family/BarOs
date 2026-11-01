"""Numerical explanations must use this question's values, not a sibling variant."""
import unittest
from baros.v2.catalog import candidate

class CatalogCalculationTests(unittest.TestCase):
 def test_explanations_use_the_given_quantities(self):
  data=candidate()
  courses={c['key']:c['course']['questions'] for c in data['courses']}
  cases=[('bar-01-station',4,'10 ÷ 100 × 100% = 10%'),
         ('bar-01-station',7,'20 ÷ 50 × 100% = 40%'),
         ('bar-01-station',12,'96 ÷ 1,2 = 80 мл'),
         ('bar-01-station',15,'180 ÷ 1,2 = 150 мл'),
         ('bar-05-wine-beer',12,'500 ÷ 125 = 4 порций'),
         ('bar-06-economics',12,'(300 − 150) ÷ 150 × 100% = 100%'),
         ('bar-06-economics',32,'600 − 120 = 480 ₽'),
         ('bar-06-economics',35,'600 − 30 = 570 ₽')]
  for key,index,calculation in cases:
   with self.subTest(course=key,question=index+1):self.assertIn(calculation,courses[key][index]['explanation'])
