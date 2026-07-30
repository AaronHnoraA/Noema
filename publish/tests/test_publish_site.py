from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


PUBLISH_DIR = Path(__file__).resolve().parents[1]
SCRIPT = PUBLISH_DIR / "publish-site"
RUNTIME_ROOT = PUBLISH_DIR.parent
ASSETS_DIR = PUBLISH_DIR / "assets"


class PublishSiteIntegrationTest(unittest.TestCase):
    def run_publish(self, output: Path, roam: Path | None, state: Path) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env.update(
            {
                "AARONNOTE_PUBLISH_OUTPUT": str(output),
                "AARONNOTE_RUNTIME_ROOT": str(RUNTIME_ROOT),
                "AARONNOTE_PUBLISH_ASSETS": str(ASSETS_DIR),
                "AARONNOTE_PUBLISH_STATE_DIR": str(state),
                "PUBLISH_FORCE": "1",
            }
        )
        if roam is not None:
            env["AARONNOTE_ROAM_ROOT"] = str(roam)
        else:
            env.pop("AARONNOTE_ROAM_ROOT", None)
        result = subprocess.run(
            ["python3", str(SCRIPT)],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode != 0:
            self.fail(
                f"publish failed with exit {result.returncode}\n"
                f"stdout:\n{result.stdout}\n"
                f"stderr:\n{result.stderr}"
            )
        return result

    def test_fresh_publish_is_complete_and_privacy_safe(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            output = tmp / "site"
            roam = tmp / "vault"
            state = tmp / "state"
            notes_dir = roam / "math"
            notes_dir.mkdir(parents=True)

            (notes_dir / "a.md").write_text(
                """---
id: note-a
title: Alpha
date: 2026-07-19
tags:
  - math
---
[Beta](b.md) and [interactive figure](demo.html).
""",
                encoding="utf-8",
            )
            (notes_dir / "b.md").write_text(
                """---
id: note-b
title: Beta
date: 2026-07-18
tags:
  - qc
---
Linked from Alpha.
""",
                encoding="utf-8",
            )
            (notes_dir / "private.md").write_text(
                """---
id: note-private
title: Private
private: true
---
![private image](secret.png)
""",
                encoding="utf-8",
            )
            (notes_dir / "demo.html").write_text("<p>legitimate attachment</p>\n", encoding="utf-8")
            (notes_dir / "secret.png").write_bytes(b"private-image")

            stale_private = output / "roam" / "math" / "secret.png"
            stale_private.parent.mkdir(parents=True)
            stale_private.write_bytes(b"previously-published-private-image")
            stale_build_asset = output / "roam" / ".lake" / "packages" / "asset.png"
            stale_build_asset.parent.mkdir(parents=True)
            stale_build_asset.write_bytes(b"build-artifact")

            result = self.run_publish(output, roam, state)

            self.assertIn("Published 3 Markdown notes", result.stdout)
            self.assertTrue((output / "index.html").is_file())
            self.assertTrue((output / "notes.html").is_file())
            self.assertTrue((output / "vendor" / "reveal" / "reveal.css").is_file())
            self.assertTrue((output / "vendor" / "reveal" / "reveal.js").is_file())
            self.assertTrue((output / "js" / "home-reveal.js").is_file())
            self.assertTrue((output / "js" / "contact.js").is_file())
            self.assertTrue((output / "js" / "note-page.js").is_file())
            self.assertTrue((output / "js" / "app.js").is_file())
            self.assertTrue((output / "js" / "graph.js").is_file())
            self.assertTrue((output / "js" / "knowledge.js").is_file())
            self.assertTrue((output / "js" / "oneko.js").is_file())
            self.assertTrue((output / "js" / "oneko.gif").is_file())
            self.assertTrue((output / "roam" / "math" / "demo.html").is_file())
            self.assertTrue((notes_dir / "demo.html").is_file())
            self.assertFalse(stale_private.exists())
            self.assertFalse((output / "roam" / ".lake").exists())

            homepage = (output / "index.html").read_text(encoding="utf-8")
            self.assertEqual(homepage.count('class="home-slide '), 5)
            self.assertGreater(homepage.rfind('id="cli"'), homepage.rfind('id="about"'))
            self.assertIn("data-contact-link", homepage)
            self.assertNotIn("@student.unsw.edu.au", homepage)
            self.assertNotIn(
                "@student.unsw.edu.au",
                (output / "js" / "home-cli.js").read_text(encoding="utf-8"),
            )

            data_source = (output / "js" / "data.js").read_text(encoding="utf-8")
            data = json.loads(data_source.removeprefix("const SITE_DATA = ").removesuffix(";\n"))
            alpha = next(note for note in data["notes"] if note["id"] == "note-a")
            self.assertEqual(alpha["refs"], ["note-b"])

    def test_legacy_roam_symlink_is_detached_without_deleting_html(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            output = tmp / "site"
            vault = tmp / "vault"
            state = tmp / "state"
            vault.mkdir()
            attachment = vault / "diagram.html"
            attachment.write_text("<p>keep me</p>\n", encoding="utf-8")
            output.mkdir()
            (output / "roam").symlink_to(vault, target_is_directory=True)

            self.run_publish(output, None, state)

            self.assertTrue(attachment.is_file())
            self.assertFalse((output / "roam").is_symlink())
            self.assertEqual((output / "roam" / "diagram.html").read_text(encoding="utf-8"), "<p>keep me</p>\n")


if __name__ == "__main__":
    unittest.main()
