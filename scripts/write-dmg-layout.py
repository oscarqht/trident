"""Write a mounted DMG's .DS_Store without Finder, for headless CI runners.

Usage: write-dmg-layout.py <mount> <layout-json>
Requires the ds_store and mac_alias packages.
"""
import json
import os
import sys

from ds_store import DSStore
from mac_alias import Alias

mount, layout = sys.argv[1], json.loads(sys.argv[2])
background = next((os.path.join(mount, '.background', n) for n in os.listdir(os.path.join(mount, '.background'))), None) \
    if os.path.isdir(os.path.join(mount, '.background')) else None
width, height = layout['window']
bounds = f"{{{{100, 100}}, {{{width}, {height}}}}}"
icvp = {
    'viewOptionsVersion': 1,
    'backgroundType': 0,
    'backgroundColorRed': 1.0,
    'backgroundColorGreen': 1.0,
    'backgroundColorBlue': 1.0,
    'gridOffsetX': 0.0,
    'gridOffsetY': 0.0,
    'gridSpacing': 100.0,
    'arrangeBy': 'none',
    'showIconPreview': False,
    'showItemInfo': False,
    'labelOnBottom': True,
    'textSize': float(layout['textSize']),
    'iconSize': float(layout['iconSize']),
    'scrollPositionX': 0.0,
    'scrollPositionY': 0.0,
}
if background:
    icvp['backgroundType'] = 2
    icvp['backgroundImageAlias'] = Alias.for_file(background).to_bytes()

with DSStore.open(os.path.join(mount, '.DS_Store'), 'w+') as store:
    store['.']['vSrn'] = ('long', 1)
    store['.']['bwsp'] = {
        'ShowStatusBar': False,
        'WindowBounds': bounds,
        'ContainerShowSidebar': False,
        'PreviewPaneVisibility': False,
        'SidebarWidth': 0,
        'ShowTabView': False,
        'ShowToolbar': False,
        'ShowPathbar': False,
        'ShowSidebar': False,
    }
    store['.']['icvp'] = icvp
    store['.']['icvl'] = ('type', b'icnv')
    for name, (x, y) in layout['items'].items():
        if os.path.lexists(os.path.join(mount, name)):
            store[name]['Iloc'] = (x, y)
