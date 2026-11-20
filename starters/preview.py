"""Local-only static preview for the starter output, including Pages-style URLs."""
import argparse
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Pages(SimpleHTTPRequestHandler):
    def translate_path(self, url):
        filename = super().translate_path(url)
        if not os.path.exists(filename) and os.path.isfile(filename + '.html'):
            return filename + '.html'
        return filename

    def list_directory(self, path):
        self.send_error(404)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--port', type=int, default=8080)
    args = parser.parse_args()
    root = args.directory.resolve(strict=True)
    if not (root / 'index.html').is_file():
        parser.error('serve only a built reader directory containing index.html')
    with ThreadingHTTPServer(('127.0.0.1', args.port), partial(Pages, directory=str(root))) as server:
        print(f'Previewing {root.name} at http://127.0.0.1:{server.server_port}/', flush=True)
        server.serve_forever()
