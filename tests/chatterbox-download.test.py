import hashlib
import importlib.util
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('chatterbox_install', Path(__file__).resolve().parents[1] / 'engine/chatterbox/install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.weights = self.root / 'weights'
        self.data = b'locked checkpoint fixture'
        self.lock = {'model': {'repository': 'ResembleAI/chatterbox', 'revision': 'a' * 40,
                              'files': {'s3gen.safetensors': hashlib.sha256(self.data).hexdigest()}}}

    def test_network_download_uses_exact_revision_owned_staging_and_no_account_token(self):
        def download(**kwargs):
            self.assertEqual(kwargs['repo_id'], self.lock['model']['repository'])
            self.assertEqual(kwargs['revision'], self.lock['model']['revision'])
            self.assertEqual(kwargs['filename'], 's3gen.safetensors')
            self.assertIs(kwargs['token'], False)
            self.assertEqual(kwargs['local_dir'], self.weights / '.download')
            kwargs['local_dir'].mkdir()
            candidate = kwargs['local_dir'] / kwargs['filename']
            candidate.write_bytes(self.data)
            return str(candidate)
        with patch.dict('sys.modules', {'huggingface_hub': types.SimpleNamespace(hf_hub_download=download)}):
            model = installer.acquire_checkpoint(self.lock, self.weights, download=True)
        self.assertEqual(model.read_bytes(), self.data)
        self.assertFalse((self.weights / '.download').exists())
        # Already verified bytes work fully offline on a retry after graph failure.
        self.assertEqual(installer.acquire_checkpoint(self.lock, self.weights), model)

    def test_corrupt_download_never_publishes_and_is_removed_for_a_real_retry(self):
        downloaded = self.weights / '.download' / 's3gen.safetensors'
        downloaded.parent.mkdir(parents=True)
        downloaded.write_bytes(b'corrupt')
        with patch.dict('sys.modules', {'huggingface_hub': types.SimpleNamespace(hf_hub_download=lambda **_: downloaded)}):
            with self.assertRaisesRegex(RuntimeError, 'SHA-256 mismatch'):
                installer.acquire_checkpoint(self.lock, self.weights, download=True)
        self.assertFalse((self.weights / 's3gen.safetensors').exists())
        self.assertFalse(downloaded.exists())

    def test_interrupted_download_keeps_partial_bytes_for_the_same_revision(self):
        partial = self.weights / '.download' / 'partial.incomplete'
        def download(**_):
            partial.parent.mkdir(parents=True)
            partial.write_bytes(b'partial')
            raise ConnectionError('download interrupted')
        with patch.dict('sys.modules', {'huggingface_hub': types.SimpleNamespace(hf_hub_download=download)}):
            with self.assertRaisesRegex(ConnectionError, 'interrupted'):
                installer.acquire_checkpoint(self.lock, self.weights, download=True)
        self.assertEqual(partial.read_bytes(), b'partial')
        self.assertFalse((self.weights / 's3gen.safetensors').exists())

    def test_explicit_local_import_checks_hash_and_preserves_the_source(self):
        source = self.root / 'import.safetensors'
        source.write_bytes(b'wrong')
        with self.assertRaisesRegex(RuntimeError, 'Imported checkpoint'):
            installer.acquire_checkpoint(self.lock, self.weights, checkpoint=source)
        source.write_bytes(self.data)
        model = installer.acquire_checkpoint(self.lock, self.weights, checkpoint=source)
        self.assertEqual(source.read_bytes(), model.read_bytes())


if __name__ == '__main__':
    unittest.main()
