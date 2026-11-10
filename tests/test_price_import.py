"""Source price previews use isolated test storage and never insert rows."""
import http.client
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
import excelio
import scrape
import store
from openpyxl import Workbook


class PriceParserTests(unittest.TestCase):
    def test_csv_and_xlsx_import_preserve_units_and_explicit_provenance(self):
        csv = '名称,规格,单位,价格,地区,价格日期,来源\n墙砖,300x600,㎡,88.50,杭州,2026-11-01,市信息价\n'.encode('utf-8')
        result = excelio.parse_price_file(csv, 'local.csv')
        self.assertEqual(result['rows'][0]['price'], 88.5)
        self.assertEqual(result['rows'][0]['region'], '杭州')
        self.assertTrue(result['rows'][0]['date_provided'])
        workbook = Workbook()
        sheet = workbook.active
        sheet.append(['材料名称', '计价单位', '单价'])
        sheet.append(['砂石', '吨', 140])
        buffer = io.BytesIO()
        workbook.save(buffer)
        result = excelio.parse_price_file(buffer.getvalue(), 'quote.xlsx')
        self.assertEqual(result['rows'][0]['unit'], '吨')
        self.assertFalse(result['rows'][0]['date_provided'])
        self.assertFalse(result['rows'][0]['region_provided'])

    def test_import_rejects_negative_or_nonfinite_prices(self):
        csv = '名称,单位,价格\n砖,m²,-100\n沙,吨,Infinity\n钢,吨,NaN\n木,m²,99\n'.encode('utf-8')
        result = excelio.parse_price_file(csv, 'prices.csv')
        self.assertEqual(len(result['errors']), 3)
        self.assertEqual([row['name'] for row in result['rows']], ['木'])

    def test_web_rows_read_full_table_not_only_twelve_row_sample(self):
        html = '<table><tr><th>名称</th><th>单位</th><th>价格</th></tr>' + ''.join('<tr><td>材料%d</td><td>平方米</td><td>%d.5</td></tr>' % (n, n) for n in range(20)) + '</table>'
        with mock.patch.object(scrape, 'fetch', return_value=html):
            preview = scrape.generic_preview('https://example.com/prices')
            self.assertEqual(len(preview['tables'][0]['sample']), 12)
            result = scrape.generic_rows('https://example.com/prices', 0, {'name':0,'unit':1,'price':2}, '杭州', '当地网站')
            self.assertEqual(len(result['rows']), 20)
            self.assertEqual(result['rows'][-1]['price'], 19.5)
            self.assertFalse(result['rows'][0]['date_provided'])

    def test_web_prices_never_strip_negative_signs_into_positive_quotes(self):
        html = '<table><tr><th>名称</th><th>单位</th><th>价格</th></tr><tr><td>不良</td><td>m²</td><td>-90</td></tr><tr><td>空值</td><td>吨</td><td>Infinity</td></tr><tr><td>正常</td><td>吨</td><td>¥ 1,230.50 元</td></tr></table>'
        with mock.patch.object(scrape, 'fetch', return_value=html):
            result = scrape.generic_rows('https://example.com', 0, {'name':0,'unit':1,'price':2})
        self.assertEqual(len(result['rows']), 1)
        self.assertEqual(result['rows'][0]['price'], 1230.5)


class PricePreviewApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='studio-price-test-')
        root = Path(cls.temporary.name)
        cls.patches = [mock.patch.object(store,'DATA_DIR',str(root)), mock.patch.object(store,'DB_PATH',str(root/'test.db'))]
        for patch in cls.patches:
            patch.start()
        store.init_db()
        class QuietHandler(app.Handler):
            def log_message(self, *args):
                pass
        cls.server = app.Server(('127.0.0.1',0), QuietHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        for patch in reversed(cls.patches):
            patch.stop()
        cls.temporary.cleanup()

    def post(self, route, payload):
        connection = http.client.HTTPConnection('127.0.0.1',self.server.server_address[1])
        try:
            connection.request('POST',route,json.dumps(payload).encode('utf-8'),{'Content-Type':'application/json'})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_official_preview_returns_real_upstream_payload_without_inserting_prices(self):
        upstream = {'url':'https://www.stats.gov.cn/sj/zxfb/latest.html','title':'2026年11月上旬流通领域重要生产资料市场价格','price_date':'2026-11-10','period':'2026年11月上旬','rows':[{'name':'螺纹钢','unit':'吨','price':3410,'source':'国家统计局'}]}
        before = store.stats()
        with mock.patch.object(scrape,'nbs_fetch',return_value=upstream) as fetch:
            status,result = self.post('/api/scrape/nbs/preview',{})
        self.assertEqual(status,200)
        self.assertEqual(result['data'],upstream)
        fetch.assert_called_once_with(None)
        self.assertEqual(store.stats(),before)

    def test_failed_official_request_reports_error_without_changing_saved_prices(self):
        before = store.stats()
        with mock.patch.object(scrape,'nbs_fetch',side_effect=RuntimeError('source connection failed')):
            status,result = self.post('/api/scrape/nbs/preview',{})
        self.assertEqual(status,500)
        self.assertFalse(result['ok'])
        self.assertIn('source connection failed',result['error'])
        self.assertEqual(store.stats(),before)

    def test_mapped_website_preview_does_not_mutate_legacy_store(self):
        html = '<table><tr><th>名称</th><th>单位</th><th>单价</th></tr><tr><td>墙砖</td><td>m²</td><td>88.5</td></tr></table>'
        before = store.stats()
        with mock.patch.object(scrape,'fetch',return_value=html):
            status,result = self.post('/api/scrape/rows/preview',{'url':'https://example.com/price','mapping':{'name':0,'unit':1,'price':2},'region':'杭州','source':'信息价'})
        self.assertEqual(status,200)
        self.assertEqual(result['data']['rows'][0]['price'],88.5)
        self.assertEqual(store.stats(),before)

    def test_invalid_table_or_url_request_rejected_before_fetch(self):
        for payload in [[],{'url':'file:///secret','mapping':{}},{'url':'https://example.com','mapping':{},'table_index':-1},{'url':'https://user:password@example.com','mapping':{}}]:
            with mock.patch.object(scrape,'fetch') as fetch:
                status,result = self.post('/api/scrape/rows/preview',payload)
                self.assertEqual(status,400)
                fetch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
