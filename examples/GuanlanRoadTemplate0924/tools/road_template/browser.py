"""Drive the SSWorld preview in a real Chrome (WebGPU) for the two steps that need the engine.

  project  press the page's coordinate-conversion button (needs `generate_roads.py --serve-projection` running)
  shots    capture views 0..N as PNG for visual acceptance

Needs a Windows Python with Playwright (e.g. bindings/python/.venv) and Chrome; headless has no WebGPU.
"""
import argparse,json,time
from pathlib import Path
from playwright.sync_api import sync_playwright

def main():
    p=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('command',choices=['project','shots'])
    p.add_argument('--config',default='tools/road_template/configs/guanlan.json')
    p.add_argument('--port',type=int,default=8880)
    p.add_argument('--views',default='0,1,2,3')
    p.add_argument('--out',default=None,help='shots directory (default: .cache/road_template/captures/<name>)')
    a=p.parse_args()
    root=Path(__file__).resolve().parents[2];config=json.loads((root/a.config).read_text(encoding='utf-8'))
    url=f"http://127.0.0.1:{a.port}/projects/{config['name']}/index.html"
    with sync_playwright() as pw:
        browser=pw.chromium.launch(channel='chrome',headless=False,args=['--enable-unsafe-webgpu'])
        page=browser.new_page(viewport={'width':1440,'height':860});errors=[]
        page.on('console',lambda m:errors.append(m.text) if m.type=='error' else None)
        page.goto(url)
        page.wait_for_function("['ready','error'].includes(document.body.dataset.runtime)",timeout=180000)
        if page.evaluate('document.body.dataset.runtime')!='ready':raise SystemExit(f'preview failed to load: {errors[:5]}')
        if a.command=='project':
            page.click('#info-toggle');page.click('#project-coordinates')
            page.wait_for_function("/已转换|失败/.test(document.getElementById('projection-message').textContent)",timeout=120000)
            message=page.inner_text('#projection-message');print(message)
            if '失败' in message:raise SystemExit(1)
        else:
            out=Path(a.out) if a.out else root/'.cache/road_template/captures'/config['name'];out.mkdir(parents=True,exist_ok=True)
            time.sleep(12)  # instance rows are filled by the logic Timer after load
            for v in map(int,a.views.split(',')):
                page.evaluate(f"window.SSWorld.logical.write('viewMode',{v});window.SSWorld.recallView?.()");time.sleep(7)
                page.screenshot(path=str(out/f'view{v}.png'));print(out/f'view{v}.png')
        browser.close()

if __name__=='__main__':main()
