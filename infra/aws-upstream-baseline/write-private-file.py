#!/usr/bin/env python3
import argparse
import os
from pathlib import Path
import secrets
import sys


def atomic_write_private(path: Path, content: str) -> None:
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as target:
            target.write(content)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
        path.chmod(0o600)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        temporary.unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    parser.add_argument("--required-key", action="append", default=[])
    args = parser.parse_args()

    content = sys.stdin.read()
    if not content:
        print("Refusing to replace a private file with empty content", file=sys.stderr)
        return 1

    values: dict[str, list[str]] = {}
    for line in content.splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values.setdefault(key, []).append(value)
    for required_key in args.required_key:
        matches = values.get(required_key, [])
        if len(matches) != 1 or not matches[0]:
            print(
                f"Expected exactly one non-empty {required_key} entry; found {len(matches)}",
                file=sys.stderr,
            )
            return 1

    atomic_write_private(args.path, content)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
