"""Check emitted files as well as the projection's built-in verification."""
from pathlib import Path
import sys

sites = Path(sys.argv[1])
for renderer in ('quartz', 'solid'):
    root = sites / renderer
    assert (root / 'index.html').is_file(), renderer
    html = 0
    for p in root.rglob('*'):
        assert not p.is_symlink(), p
        if not p.is_file():
            continue
        name = p.relative_to(root).as_posix().lower()
        assert not any(t in name for t in ('unlisted', 'unreleased', 'private-report', 'publish.yml', 'private-only')), name
        b = p.read_bytes()
        assert not any(t in b for t in (b'UNRELEASED-CANARY-97A2', b'OUTSIDE-CANARY-C419', b'PRIVATE-ASSET-68AD', b'DISPLAY-COMMENT-40DF')), name
        html += p.suffix == '.html'
    assert html >= 2, renderer
    print(f'{renderer}: {html} HTML pages; no denied note, asset or report in the emitted tree')
