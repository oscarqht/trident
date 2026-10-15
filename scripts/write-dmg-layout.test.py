"""macOS integration regression: Finder aliases must survive a DMG remount.

Run with a Python environment containing ds_store and mac_alias.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from ds_store import DSStore
from mac_alias import Alias


@unittest.skipUnless(sys.platform == 'darwin', 'requires macOS disk images')
class DmgLayoutTest(unittest.TestCase):
    def test_background_alias_is_volume_relative_through_symlinked_mount(self):
        with tempfile.TemporaryDirectory(prefix='trident-layout-test-') as temporary:
            root = Path(temporary).resolve()
            image = root / 'installer.dmg'
            mount = root / 'Trident'
            mount.mkdir()
            linked = root / 'linked'
            linked.symlink_to(mount, target_is_directory=True)
            subprocess.run(['hdiutil', 'create', '-size', '16m', '-fs', 'HFS+',
                            '-volname', 'Trident', str(image)], check=True, capture_output=True)
            subprocess.run(['hdiutil', 'attach', '-nobrowse', '-mountpoint', str(mount),
                            str(image)], check=True, capture_output=True)
            try:
                (mount / '.background').mkdir()
                (mount / '.background/background.png').write_bytes(
                    (Path(__file__).resolve().parent.parent / 'src-tauri/dmg/background.png').read_bytes())
                (mount / 'Trident.app').mkdir()
                (mount / 'Applications').symlink_to('/Applications')
                layout = {'window': [660, 432], 'iconSize': 96, 'textSize': 12,
                          'items': {'Trident.app': [259, 258], 'Applications': [315, 97]}}
                subprocess.run([sys.executable, str(Path(__file__).with_name('write-dmg-layout.py')),
                                str(linked), json.dumps(layout)], check=True)
            finally:
                subprocess.run(['hdiutil', 'detach', str(mount)], check=True, capture_output=True)
            compressed = root / 'release.dmg'
            subprocess.run(['hdiutil', 'convert', str(image), '-format', 'UDZO',
                            '-o', str(compressed)], check=True, capture_output=True)
            # Inspect after remounting at a different path, as a downloaded installer would be.
            remount = root / 'remount'
            remount.mkdir()
            subprocess.run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint',
                            str(remount), str(compressed)], check=True, capture_output=True)
            try:
                with DSStore.open(str(remount / '.DS_Store'), 'r') as store:
                    options = store['.']['icvp']
                    alias = Alias.from_bytes(options['backgroundImageAlias'])
                    self.assertEqual(options['backgroundType'], 2)
                    self.assertEqual(options['iconSize'], 96)
                    self.assertEqual(store['Trident.app']['Iloc'], (259, 258))
                    self.assertEqual(alias.target.posix_path, '/.background/background.png')
                    self.assertEqual(alias.target.carbon_path, b'Trident:.background:\x00background.png')
                    self.assertEqual(len(alias.target.cnid_path), 1)
                    self.assertEqual(os.stat(remount / '.background/background.png').st_ino,
                                     alias.target.cnid)
            finally:
                subprocess.run(['hdiutil', 'detach', str(remount)], check=True, capture_output=True)


if __name__ == '__main__':
    unittest.main()
