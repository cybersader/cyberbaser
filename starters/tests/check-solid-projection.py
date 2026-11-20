"""Compare a built Solid reader to its public projection, without printing paths."""
import json
import sys
from pathlib import Path


def check(condition, message):
    if not condition:
        raise SystemExit(message)


projection, site = (Path(arg).resolve(strict=True) for arg in sys.argv[1:])
rows = json.loads((site / 'notes.json').read_text())
expected = {p.relative_to(projection).as_posix() for p in projection.rglob('*')
            if p.is_file() and p.suffix.lower() == '.md'}
check(len(rows) == len(expected) and {row['source'] for row in rows} == expected,
      'Note manifest differs from the projected Markdown set.')
outputs = set()
for row in rows:
    file = (site / row['file']).resolve(strict=True)
    check(file.is_relative_to(site) and file.is_file() and file.suffix == '.html',
          'Unsafe or missing manifest destination.')
    outputs.add(file)
check(len(outputs) == len(rows), 'Multiple notes share an output file.')
media = 0
for p in (site / '_media').rglob('*'):
    if p.is_file():
        original = projection / p.relative_to(site / '_media')
        check(not p.is_symlink() and original.is_file() and original.read_bytes() == p.read_bytes(),
              'Media file is not byte-identical to projected input.')
        media += 1
print(f'Solid manifest: {len(expected)} projected notes have distinct pages; {media} images match projected bytes.')
