"""Real parser tests for source-refresh provenance; no live network calls."""
import sys
from pathlib import Path
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import scrape


class RefreshSourceParserTests(unittest.TestCase):
    def test_unknown_official_title_never_substitutes_the_collection_day(self):
        self.assertEqual(scrape._period_date('流通领域重要生产资料价格资料'), ('', '流通领域重要生产资料价格资料'))
        self.assertEqual(scrape._period_date('2026年11月上旬流通领域价格')[0], '2026-11-10')

    def test_mapped_regions_and_sources_are_read_from_the_actual_rows(self):
        html = '<table><tr><th>名称</th><th>单位</th><th>价格</th><th>地区</th><th>来源</th></tr><tr><td>瓷砖</td><td>m²</td><td>88.605</td><td>宁波</td><td>真实来源B</td></tr></table>'
        with mock.patch.object(scrape, 'fetch', return_value=html):
            result = scrape.generic_rows('https://source.example/prices', 0, {'name': 0, 'unit': 1, 'price': 2, 'region': 3, 'source': 4}, '杭州', '既有来源A')
        self.assertEqual(result['rows'][0]['region'], '宁波')
        self.assertEqual(result['rows'][0]['source'], '真实来源B')
        self.assertTrue(result['rows'][0]['region_provided'])
        self.assertTrue(result['rows'][0]['source_provided'])
        self.assertFalse(result['rows'][0]['date_provided'])

    def test_empty_optional_rows_preserve_explicit_source_context_without_claiming_a_date(self):
        html = '<table><tr><th>名称</th><th>单位</th><th>价格</th></tr><tr><td>实际材料</td><td>吨</td><td>0</td></tr></table>'
        with mock.patch.object(scrape, 'fetch', return_value=html):
            result = scrape.generic_rows('https://source.example/prices', 0, {'name': 0, 'unit': 1, 'price': 2}, '杭州', '供应商实际报价')
        self.assertEqual(result['rows'][0]['price'], 0)
        self.assertEqual(result['rows'][0]['region'], '杭州')
        self.assertEqual(result['rows'][0]['source'], '供应商实际报价')
        self.assertFalse(result['rows'][0]['date_provided'])


if __name__ == '__main__':
    unittest.main()
