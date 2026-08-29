import hashlib
import json
import sys
import zipfile
from pathlib import Path


root = Path(__file__).resolve().parent.parent
package = json.loads((root / "package.json").read_text(encoding="utf-8"))
version = package["version"]
dist = root / "dist"
release = root / "release"
archive = release / f"vast-translator-{version}-chrome-web-store.zip"
checksum = archive.with_suffix(archive.suffix + ".sha256")

if not (dist / "manifest.json").is_file():
    raise SystemExit("dist/ 根目录缺少 manifest.json，请先运行 npm run build")

release.mkdir(exist_ok=True)
archive.unlink(missing_ok=True)
checksum.unlink(missing_ok=True)

with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
    for path in sorted(dist.rglob("*")):
        if path.is_file():
            output.write(path, path.relative_to(dist).as_posix())

with zipfile.ZipFile(archive) as output:
    names = output.namelist()
    if names.count("manifest.json") != 1:
        raise SystemExit("ZIP 第一层必须且只能包含一个 manifest.json")
    forbidden = ("tests/", "test/", "research/", ".env", "error.log")
    for name in names:
        if name.endswith(".map") or any(part in name for part in forbidden):
            raise SystemExit(f"ZIP 包含禁止文件：{name}")

digest = hashlib.sha256(archive.read_bytes()).hexdigest()
checksum.write_text(f"{digest}  {archive.name}\n", encoding="ascii")
print(json.dumps({"version": version, "archive": str(archive), "sha256": digest}, ensure_ascii=False))
