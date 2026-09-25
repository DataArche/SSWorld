"""Reusable real-road generator. See road_template/README.md."""
import argparse
import json
import sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'.deps/guanlan-gis'))

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--config',default='tools/road_template/configs/guanlan.json')
    p.add_argument('--serve-projection',action='store_true')
    a=p.parse_args()
    config=json.loads((ROOT/a.config).read_text(encoding='utf-8'))
    if a.serve_projection:
        from road_template.projection import serve
        serve(config)
    else:
        from road_template.generator import build
        print(json.dumps(build(config),ensure_ascii=False,indent=2))

if __name__=='__main__': main()
