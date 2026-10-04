#!/usr/bin/env python3
"""Merge aurora pipeline_cache.db files into the bundle's shader seed.

Each input is the /cache/pipeline_cache.db of one browser session that played
part of the VS-only profile (title, menus, every fighter, every legal stage,
and Training, which has since been removed; its few extra pipelines are
harmless). The union, gzipped, is tools/browser/vs_pipeline_cache.db.gz;
tools/browser/bundle.py ships it as initial_pipeline_cache.db, which aurora
imports on a first visit and compiles behind "Preparing graphics" instead of
on first use during play (pipeline_cache.cpp, seed_pipeline_cache).

  python3 tools/browser/merge_pipeline_caches.py OUT.db.gz session1.db ...
"""
import gzip
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    out, inputs = Path(sys.argv[1]), sys.argv[2:]
    with tempfile.TemporaryDirectory() as tmp:
        merged = Path(tmp) / 'merged.db'
        shutil.copyfile(inputs[0], merged)
        db = sqlite3.connect(merged)
        db.execute('PRAGMA journal_mode=DELETE')
        for path in inputs[1:]:
            db.execute('ATTACH DATABASE ? AS src', (path,))
            db.execute('INSERT OR IGNORE INTO pipeline_cache SELECT * FROM src.pipeline_cache')
            db.commit()
            db.execute('DETACH DATABASE src')
        rows = db.execute('SELECT type, config_version, COUNT(*) FROM pipeline_cache GROUP BY 1, 2').fetchall()
        db.execute('VACUUM')
        db.close()
        with open(merged, 'rb') as src, gzip.open(out, 'wb', compresslevel=9) as dst:
            shutil.copyfileobj(src, dst)
    print(out, rows, f'{out.stat().st_size / 1024:.0f} KiB')


if __name__ == '__main__':
    main()
