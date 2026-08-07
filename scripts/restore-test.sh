#!/bin/sh
set -eu

test_database="${RESTORE_TEST_DATABASE:-threatlens_restore_test}"
case "$test_database" in *[!a-zA-Z0-9_]*) echo "RESTORE_TEST_DATABASE contains invalid characters" >&2; exit 2 ;; esac
case "$test_database" in
  threatlens_restore_test*) ;;
  *) echo "RESTORE_TEST_DATABASE must start with threatlens_restore_test" >&2; exit 2 ;;
esac

archive="${1:-}"
if [ -z "$archive" ] || [ ! -f "$archive" ]; then
  echo "Usage: restore-test.sh /backups/threatlens-TIMESTAMP.dump" >&2
  exit 2
fi

admin_url="${POSTGRES_ADMIN_URL:-postgresql://threatlens:change-me@postgres:5432/postgres}"
test_url="${admin_url%/*}/$test_database"
psql "$admin_url" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $test_database"
psql "$admin_url" -v ON_ERROR_STOP=1 -c "CREATE DATABASE $test_database"
pg_restore --exit-on-error --no-owner --no-acl --dbname="$test_url" "$archive"
psql "$test_url" -v ON_ERROR_STOP=1 -c "SELECT count(*) AS migrations FROM schema_migrations"
psql "$admin_url" -v ON_ERROR_STOP=1 -c "DROP DATABASE $test_database"
