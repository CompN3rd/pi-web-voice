"""Original build-environment regression: MIT. No downloads or compiler needed."""
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from build import build_environment


class BuildEnvironmentTest(unittest.TestCase):
    def test_host_overrides_cannot_replace_pinned_tools(self):
        work = Path('/data/isolated/work')
        config = work / 'emscripten.config'
        expected = build_environment(work, config)
        overrides = {key: '/untrusted/tool' for key in [
            'EM_LLVM_ROOT', 'EM_BINARYEN_ROOT', 'EM_NODE_JS', 'EM_CONFIG',
            'EM_CACHE', 'EMCC_CFLAGS', 'EM_COMPILER_WRAPPER', 'EMSDK',
            'PYTHONPATH', 'PYTHONHOME', 'LD_PRELOAD', 'PATH', 'HOME', 'TMPDIR']}
        with patch.dict(os.environ, overrides, clear=True):
            actual = build_environment(work, config)
        self.assertEqual(actual, expected)
        self.assertEqual(actual['EM_CONFIG'], str(config))
        self.assertEqual(actual['PATH'], '/usr/bin:/bin')
        for key in ['EM_LLVM_ROOT', 'EM_BINARYEN_ROOT', 'EM_NODE_JS', 'PYTHONPATH', 'LD_PRELOAD']:
            self.assertNotIn(key, actual)


if __name__ == '__main__':
    unittest.main()
