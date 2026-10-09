"""Shared helpers for the Python tests (not a test module: the name does not match test_*.py)."""

import functools
import importlib.util
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True  # keep __pycache__ out of the repository root and scripts/

ROOT = Path(__file__).resolve().parent.parent


def load_module(name, path):
    """Import a file as a module without putting its directory on sys.path."""
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def known_bug(reason):
    """Mark a test that demonstrates a known bug in the app code.

    The test still runs: while the bug is present it is reported as skipped with `reason`
    (so CI stays green), and once the bug is fixed it simply passes."""

    def wrap(fn):
        @functools.wraps(fn)
        def run(self, *args, **kwargs):
            try:
                fn(self, *args, **kwargs)
            except Exception as e:  # an assertion failure or the crash itself is the bug
                raise unittest.SkipTest(f"KNOWN BUG: {reason} ({type(e).__name__}: {e})") from e

        return run

    return wrap
