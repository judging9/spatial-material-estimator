"""Serve the real application with isolated storage for browser acceptance tests."""
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import app
import store
import drawing_service
from test_drawing_service import pdf

root = Path(os.environ['STUDIO_TEST_ROOT'])
store.DATA_DIR = str(root / 'materials')
store.DB_PATH = str(root / 'materials' / 'test.db')
drawing_service.DATA_DIR = root / 'drawings'
store.init_db()
(root / 'two-pages.pdf').write_bytes(pdf())

class QuietHandler(app.Handler):
    def log_message(self, *args):
        pass

server = app.Server(('127.0.0.1', 0), QuietHandler)
print(f'http://127.0.0.1:{server.server_address[1]}', flush=True)
server.serve_forever()
