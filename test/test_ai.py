import unittest
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from ai import app, suggestion_for


class AnalyzeTest(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_health(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["ok"])

    def test_low_spend(self):
        response = self.client.post("/analyze", json={"totalSpent": 5})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["suggestion"], suggestion_for(5))

    def test_medium_spend(self):
        response = self.client.post("/analyze", json={"totalSpent": 25})
        self.assertEqual(response.status_code, 200)
        self.assertIn("increasing", response.get_json()["suggestion"])

    def test_high_spend(self):
        response = self.client.post("/analyze", json={"totalSpent": 80})
        self.assertEqual(response.status_code, 200)
        self.assertIn("saving", response.get_json()["suggestion"])

    def test_rejects_non_numeric(self):
        response = self.client.post("/analyze", json={"totalSpent": "lots"})
        self.assertEqual(response.status_code, 400)

    def test_rejects_negative(self):
        response = self.client.post("/analyze", json={"totalSpent": -1})
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
