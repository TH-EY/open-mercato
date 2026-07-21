#!/usr/bin/env python3
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: render-postgres-password-sql.py <role>", file=sys.stderr)
        return 2

    role = sys.argv[1]
    password = sys.stdin.read()
    if not role or not password:
        print("PostgreSQL role and password must be non-empty", file=sys.stderr)
        return 1

    escaped_role = role.replace('"', '""')
    escaped_password = password.replace("'", "''")
    print("set password_encryption = 'scram-sha-256';")
    print(f'alter role "{escaped_role}" login password \'{escaped_password}\';')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
