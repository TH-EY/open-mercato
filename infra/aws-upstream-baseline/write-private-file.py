#!/usr/bin/env python3
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
    if len(sys.argv) != 2:
        print("Usage: write-private-file.py <path>", file=sys.stderr)
        return 2

    atomic_write_private(Path(sys.argv[1]), sys.stdin.read())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
