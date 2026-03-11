# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for Teleprompter.

Build on Windows with:
    uv run pyinstaller teleprompter.spec

Output: dist/teleprompter.exe
"""

from PyInstaller.utils.hooks import collect_all, collect_submodules

# Collect all submodules and data for packages that use dynamic imports
datas_uvicorn, binaries_uvicorn, hiddenimports_uvicorn = collect_all("uvicorn")
datas_fastapi, binaries_fastapi, hiddenimports_fastapi = collect_all("fastapi")
datas_starlette, binaries_starlette, hiddenimports_starlette = collect_all("starlette")
datas_docx, binaries_docx, hiddenimports_docx = collect_all("docx")

a = Analysis(
    ["server.py"],
    pathex=[],
    binaries=(
        binaries_uvicorn
        + binaries_fastapi
        + binaries_starlette
        + binaries_docx
    ),
    datas=(
        # Include the entire public/ directory — served as static files
        [("public", "public")]
        + datas_uvicorn
        + datas_fastapi
        + datas_starlette
        + datas_docx
    ),
    hiddenimports=(
        hiddenimports_uvicorn
        + hiddenimports_fastapi
        + hiddenimports_starlette
        + hiddenimports_docx
        + [
            "uvicorn.logging",
            "uvicorn.loops",
            "uvicorn.loops.asyncio",
            "uvicorn.protocols",
            "uvicorn.protocols.websockets",
            "uvicorn.protocols.websockets.websockets_impl",
            "uvicorn.protocols.http",
            "uvicorn.protocols.http.h11_impl",
            "uvicorn.lifespan",
            "uvicorn.lifespan.on",
            "websockets",
            "websockets.legacy",
            "websockets.legacy.server",
            "h11",
            "anyio",
            "anyio._backends._asyncio",
            "multipart",
        ]
    ),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "uvloop",       # Unix-only; not available on Windows
        "tkinter",
        "matplotlib",
        "numpy",
        "pandas",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="teleprompter",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    # windowed=True hides the terminal window on Windows.
    # Set to False temporarily if you need to see startup errors.
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon="public/favicon.ico",  # Uncomment and provide a .ico file to set a custom icon
)
