#!/usr/bin/env python3
from pathlib import Path
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: read-dotenv-value.py <path> <key>", file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    expected_key = sys.argv[2]
    matches: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key == expected_key:
            matches.append(value)

    if len(matches) != 1:
        print(
            f"Expected exactly one {expected_key} entry in {path}; found {len(matches)}",
            file=sys.stderr,
        )
        return 1

    sys.stdout.write(matches[0])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
