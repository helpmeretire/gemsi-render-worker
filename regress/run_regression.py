#!/usr/bin/env python3
"""Validator regression: every bad_* fixture MUST FAIL, every good_* fixture MUST PASS. Exit 1 otherwise."""
import json, subprocess, sys, glob, os, tempfile
here = os.path.dirname(os.path.abspath(__file__)); root = os.path.dirname(here)
ok = True
for f in sorted(glob.glob(os.path.join(here, '*.json'))):
    name = os.path.basename(f); want = 'FAIL' if name.startswith('bad_') else 'PASS'
    out = subprocess.run([sys.executable, os.path.join(root, 'render_master.py'), f, os.path.join(tempfile.gettempdir(), 'rg.pdf')], capture_output=True, text=True).stdout
    try: res = json.loads(out[out.find('{'):]); got = res['status']; iss = res['issues'][:2]
    except Exception: got, iss = 'ERROR', [out[-200:]]
    flag = 'OK ' if got == want else 'XX '
    if got != want: ok = False
    print(f'{flag}{name}: expected {want}, got {got} {iss if got=="FAIL" else ""}')
sys.exit(0 if ok else 1)
