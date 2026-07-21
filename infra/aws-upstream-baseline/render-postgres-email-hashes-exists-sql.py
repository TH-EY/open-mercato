#!/usr/bin/env python3
import re
import sys


HASH_PATTERN = re.compile(r"(?:v2:)?[a-f0-9]{64}\Z")


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"superadmin", "admin", "employee"}:
        print(
            "Usage: render-postgres-email-hashes-exists-sql.py <superadmin|admin|employee>",
            file=sys.stderr,
        )
        return 2

    expected_role = sys.argv[1]
    hashes = [line.strip() for line in sys.stdin if line.strip()]
    if not 1 <= len(hashes) <= 4:
        print("Expected between one and four email hashes", file=sys.stderr)
        return 1
    if any(not HASH_PATTERN.fullmatch(value) for value in hashes):
        print("Invalid email hash", file=sys.stderr)
        return 1

    literals = ", ".join("'" + value + "'" for value in hashes)
    print(
        "select distinct u.id::text || chr(9) || u.tenant_id::text "
        "from users u "
        "join user_roles ur on ur.user_id = u.id and ur.deleted_at is null "
        "join roles r on r.id = ur.role_id and r.deleted_at is null "
        f"where u.email_hash in ({literals}) and u.deleted_at is null "
        f"and r.name = '{expected_role}' and r.tenant_id = u.tenant_id;"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
