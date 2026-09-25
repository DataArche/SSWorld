"""Projection input/cache and a localhost-only bridge to the running SSEngine WASM API."""
import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LAYERS = ('roads', 'buildings', 'landuse', 'greenery', 'water_lines', 'water_polygons')

def prepare(config):
    layers = {}
    for k in LAYERS:
        p = ROOT / config['input_dir'] / (config.get('source_prefix','')+k+'.geojson')
        layers[k] = json.loads(p.read_text(encoding='utf-8'))
    inp = dict(layers=layers, anchor=config['anchor'], bbox=config['bbox'], views=config['views'])
    inp['input_digest'] = hashlib.sha256(json.dumps(inp,sort_keys=True).encode()).hexdigest()
    inp['engine_fingerprint'] = 'SSEngine WASM loaded by SSWorld preview; native double precision matrix API'
    return inp

def load(config):
    inp = prepare(config)
    cache = ROOT / config['output_dir'] / 'projection-cache.json'
    if not cache.exists(): raise RuntimeError('Native projection cache missing. Run --serve-projection and the SSEngine projector first.')
    data = json.loads(cache.read_text(encoding='utf-8'))
    if data.get('input_digest') != inp['input_digest']:
        raise RuntimeError('Source/anchor/AOI changed. Refresh using --serve-projection; no fallback projection is allowed.')
    if data['provenance']['max_roundtrip_error_m'] > .001: raise RuntimeError('Projection roundtrip error exceeds 1 mm')
    return data

def serve(config, port=8894):
    inp = prepare(config)
    output = ROOT / config['output_dir'] / 'projection-cache.json'
    class Handler(BaseHTTPRequestHandler):
        def respond(self, code, content_type='application/json'):
            self.send_response(code)
            self.send_header('Content-Type',content_type)
            self.send_header('Access-Control-Allow-Origin','http://127.0.0.1:8880')
            self.send_header('Access-Control-Allow-Headers','Content-Type')
            self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS')
            self.end_headers()
        def do_OPTIONS(self): self.respond(204)
        def do_GET(self):
            if self.path=='/input': self.respond(200); self.wfile.write(json.dumps(inp).encode())
            elif self.path.split('?')[0]=='/engine-project.mjs':
                self.respond(200,'text/javascript'); self.wfile.write(Path(__file__).with_name('engine_project.mjs').read_bytes())
            else: self.respond(404)
        def do_POST(self):
            if self.path != '/result': self.respond(404); return
            if self.headers.get('Origin') != 'http://127.0.0.1:8880': self.respond(403); return
            size=int(self.headers.get('Content-Length',0))
            if size>8_000_000: self.respond(413); return
            data=json.loads(self.rfile.read(size))
            if data.get('input_digest')!=inp['input_digest'] or data['provenance']['max_roundtrip_error_m']>.001:
                self.respond(400); return
            output.parent.mkdir(parents=True,exist_ok=True)
            output.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')
            self.respond(200); self.wfile.write(b'{"ok":true}')
            print('SSEngine projection saved:',output,flush=True)
        def log_message(self,*args): pass
    print(f'Projection bridge http://127.0.0.1:{port}; use the preview coordinate conversion button.',flush=True)
    ThreadingHTTPServer(('127.0.0.1',port),Handler).serve_forever()


