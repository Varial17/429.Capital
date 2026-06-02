#!/usr/bin/env python3
"""Tiny static file server for local preview of site/.

Avoids `python3 -m http.server` because that module evaluates os.getcwd() at
import time, which some sandboxes block. Directory is bound by absolute path.

Usage:  python3 serve.py [port]
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = str(Path(__file__).resolve().parent / "site")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8753

handler = partial(SimpleHTTPRequestHandler, directory=ROOT)
print(f"Serving {ROOT} at http://localhost:{PORT}")
ThreadingHTTPServer(("127.0.0.1", PORT), handler).serve_forever()
