"""The pages bundle holds only runtime modules and only the pinned cli-login."""

import hashlib
import io
import re
import tomllib
import zipfile
from pathlib import Path

import pytest

import build_pages

HERE = Path(__file__).resolve().parent


def wheel(files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, body in files.items():
            archive.writestr(name, body)
    return buffer.getvalue()


def test_the_bundle_has_runtime_modules_and_no_specs(tmp_path):
    data = wheel({
        "cli_login/__init__.py": "",
        "cli_login/broker/pages.py": "PAGES = 1",
        "cli_login/broker/pages_test.py": "spec",
        "cli_login/testing.py": "fixtures",
        "cli_login-0.3.0.dist-info/METADATA": "metadata",
    })
    written = build_pages.build(data, tmp_path / "out", hashlib.sha256(data).hexdigest())
    assert "cli_login/broker/pages.py" in written
    assert "prospectus_cli/pages.py" in written
    assert not [name for name in written if name.endswith("_test.py") or "testing" in name or "dist-info" in name]
    assert (tmp_path / "out" / "prospectus_cli" / "pages.py").exists()


def test_a_wheel_that_does_not_match_the_pin_is_refused(tmp_path):
    with pytest.raises(SystemExit, match="sha256"):
        build_pages.build(wheel({"cli_login/__init__.py": "tampered"}), tmp_path / "out", "0" * 64)
    assert not (tmp_path / "out").exists()


def test_one_cli_login_version_everywhere():
    version, digest = build_pages.pin()
    assert f"cli_login-{version}-py3-none-any.whl" in build_pages.WHEEL_URL
    project = tomllib.loads((HERE / "pyproject.toml").read_text())["project"]
    assert project["dependencies"] == [f"cli-login=={version}"]
    assert re.fullmatch(r"[0-9a-f]{64}", digest)
