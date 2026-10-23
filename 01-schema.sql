"""Create a temporary static tree for QA and an offline demo for review."""
from pathlib import Path
import base64
import mimetypes
import re
import shutil

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / 'dist'
DIST.mkdir(exist_ok=True)
for filename in ['index.html', 'styles.css', 'config.js', '.nojekyll']:
    shutil.copy2(ROOT / filename, DIST / filename)
for dirname in ['assets', 'data', 'js']:
    shutil.copytree(ROOT / dirname, DIST / dirname, dirs_exist_ok=True)

def data_url(path):
    mime = mimetypes.guess_type(path)[0] or 'application/octet-stream'
    return f'data:{mime};base64,' + base64.b64encode(path.read_bytes()).decode()

def module_url(path):
    source = path.read_text()
    source = re.sub(r"from '(\./[^']+)'", lambda match: 'from ' + repr(module_url((path.parent / match[1]).resolve())), source)
    return 'data:text/javascript;base64,' + base64.b64encode(source.encode()).decode()

html = (ROOT / 'index.html').read_text()
html = html.replace('<link rel="stylesheet" href="./styles.css">', '<style>' + (ROOT / 'styles.css').read_text() + '</style>')
for filename in ['config.js', 'data/items.js', 'assets/supabase.js']:
    source = (ROOT / filename).read_text().replace('</script', '<\\/script')
    html = html.replace(f'<script src="./{filename}"></script>', '<script>' + source + '</script>')
html = html.replace('<script type="module" src="./js/app.js"></script>', '<script type="module">import ' + repr(module_url(ROOT / 'js/app.js')) + ';</script>')
html = re.sub(r'(src|href)="(\./assets/[^\"]+)"', lambda match: f'{match[1]}="{data_url(ROOT / match[2])}"', html)
output = ROOT.parent / 'Obzhivaemsya-demo.html'
output.write_text(html)
print(str(output))
