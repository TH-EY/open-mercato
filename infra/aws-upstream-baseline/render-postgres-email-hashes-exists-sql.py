#!/usr/bin/env python3
import json
import re
import sys


def main() -> int:
    try:
        values = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        print(f"Invalid email hash JSON: {error}", file=sys.stderr)
        return 1

    pattern = re.compile(r"(?:v2:)?[a-f0-9]{64}")
    if (
        not isinstance(values, list)
        or not 1 <= len(values) <= 4
        or not all(isinstance(value, str) and pattern.fullmatch(value) for value in values)
    ):
        print("Expected one to four valid application email lookup hashes", file=sys.stderr)
        return 1

    quoted = ", ".join(f"'{value}'" for value in dict.fromkeys(values))
    print(
        "select exists (select 1 from users "
        f"where email_hash in ({quoted}) and deleted_at is null)::int;"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
