# PyInstaller spec for the eBL ATF validator binary.
# Build with:  pyinstaller --noconfirm --clean validate_atf.spec
# Output:      dist-validator/validator/validate_atf(.exe)
#              dist-validator/validator/_internal/ebl-grammar/*.lark   (data file)
#              dist-validator/validator/_internal/lark/*                (library)
#
# The Electron main process locates this folder via process.resourcesPath/validator
# in packaged builds; in dev, run `npm run build:validator` first and Electron
# will pick it up from ./dist-validator/validator/.

import os
from PyInstaller.utils.hooks import collect_data_files

block_cipher = None

a = Analysis(
    ['validate_atf.py'],
    pathex=[],
    binaries=[],
    # The .lark grammar files are needed at runtime — bundle them next to the binary.
    datas=[
        ('ebl-grammar', 'ebl-grammar'),
    ],
    # lark imports internal modules dynamically; PyInstaller usually catches
    # these but we list a few explicitly to be safe.
    hiddenimports=[
        'lark',
        'lark.parsers',
        'lark.parsers.lalr_parser',
        'lark.parsers.earley',
        'lark.parsers.xearley',
        'lark.parsers.cyk',
        'lark.lark',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter',
        'matplotlib',
        'numpy',
        'pandas',
        'pytest',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='validate_atf',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='validator',
    distpath='dist-validator',
)
