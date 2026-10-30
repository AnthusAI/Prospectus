"""Build the remote CLI sign-in pages Lambda bundle: prospectus_cli plus the pinned cli-login, nothing else.

    python3 cli/build_pages.py [out_dir]     (default .artifacts/cli-pages)

The cli-login wheel is downloaded from PyPI and refused unless its sha256 equals the pin in requirements-lambda.txt,
the same version the broker stack runs. Standard library only, so the Amplify build image needs no pip.
"""

from __future__ import annotations

import hashlib
import io
import re
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
WHEEL_URL = (
    "https://files.pythonhosted.org/packages/ff/e4/34b95d35dbce4d992f3ab1f36df8d4c841e79d16313b630c42f90cb3434a/"
    "cli_login-0.3.0-py3-none-any.whl"
)


def pin() -> tuple[str, str]:
    """The (version, sha256) pinned in requirements-lambda.txt."""
    text = (HERE / "requirements-lambda.txt").read_text()
    match = re.search(r"^cli-login==(\S+) --hash=sha256:([0-9a-f]{64})$", text, re.MULTILINE)
    if not match:
        raise SystemExit("requirements-lambda.txt must pin cli-login==<version> --hash=sha256:<digest>")
    return match.group(1), match.group(2)


def _shipped(name: str) -> bool:
    return name.endswith(".py") and not name.endswith("_test.py") and "/testing" not in name


def build(wheel: bytes, out: Path, digest: str) -> list[str]:
    if hashlib.sha256(wheel).hexdigest() != digest:
        raise SystemExit("the cli-login wheel does not match its pinned sha256; refusing to build")
    if out.exists():
        shutil.rmtree(out)
    written = []
    with zipfile.ZipFile(io.BytesIO(wheel)) as archive:
        for name in sorted(archive.namelist()):
            if name.startswith("cli_login/") and _shipped(name):
                target = out / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(name))
                written.append(name)
    for path in sorted((HERE / "src" / "prospectus_cli").rglob("*.py")):
        name = path.relative_to(HERE / "src").as_posix()
        if _shipped(name):
            target = out / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(path.read_bytes())
            written.append(name)
    return written


def main(argv: list[str]) -> None:  # pragma: no cover - network
    version, digest = pin()
    if f"cli_login-{version}-" not in WHEEL_URL:
        raise SystemExit("WHEEL_URL names a different cli-login version than requirements-lambda.txt")
    with urllib.request.urlopen(WHEEL_URL, timeout=30) as response:
        wheel = response.read()
    out = Path(argv[1] if len(argv) > 1 else ".artifacts/cli-pages")
    files = build(wheel, out, digest)
    print(f"{out}: {len(files)} files, cli-login {version}")


if __name__ == "__main__":  # pragma: no cover
    main(sys.argv)
