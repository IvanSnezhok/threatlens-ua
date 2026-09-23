#!/bin/sh
set -eu

# Добовий повний дамп бази — і єдина регулярна робота на цьому хості, яка читає ВСЮ базу підряд.
#
# Три речі, які тут вирішено вимірюванням (postgres:18-alpine, відновлена бойова база 919 МіБ,
# 22.09.2026):
#
#   формат               wall     CPU (user)   розмір
#   --format=custom      10.88 с    10.44 с    128.0 МБ   (zlib — типове стиснення pg_dump)
#   ... --compress=zstd:3 3.42 с     1.70 с     73.5 МБ
#
# Тобто zstd коштує вшестеро менше процесора, іде втричі швидше й лишає на диску на 43 % менше.
# За чотирнадцять діб зберігання це 1.03 ГБ замість 1.79 ГБ. `pg_restore` читає обидва формати, тож
# старі архіви лишаються відновлюваними тим самим `scripts/restore-test.sh`.
#
# `nice`/`ionice` — тому, що конкурент у цього процесу рівно один і він важливий: Postgres, з якого
# читають конвеєр тривог, SSE-хаб і черга сповіщень. Дамп не має пріоритету над попередженням.
# Обидві утиліти є в busybox цього образу; якщо раптом немає — запуск не має падати через це.
#
# Прив'язка до години замість «спати добу від моменту старту»: без неї момент дампу дрейфує з
# кожним перезапуском контейнера й рано чи пізно припадає на нічний удар — саме ту годину, коли
# система під навантаженням. `BACKUP_AT_UTC_HOUR` типово 9 UTC = 12:00 за Києвом: денне затишшя.
# Перший дамп на порожній теці робиться ОДРАЗУ — нове розгортання не має добу лишатися без архіву.
backup_dir=/backups
retention_days="${BACKUP_RETENTION_DAYS:-14}"
interval_seconds="${BACKUP_INTERVAL_SECONDS:-86400}"
anchor_hour="${BACKUP_AT_UTC_HOUR:-9}"

mkdir -p "$backup_dir"

# Обгортка, а не жорсткий виклик: у мінімальному образі без util-linux `ionice` може не існувати, і
# резервне копіювання, яке через це не запустилося, — гірша аварія за будь-яку конкуренцію за диск.
run_low_priority() {
  if command -v ionice >/dev/null 2>&1; then
    nice -n 19 ionice -c 3 "$@"
  else
    nice -n 19 "$@"
  fi
}

seconds_until_anchor() {
  now_hour="$(date -u +%H)"
  now_minute="$(date -u +%M)"
  now_second="$(date -u +%S)"
  # 10# — інакше `08` і `09` читаються як вісімкові й shell падає на «illegal number».
  elapsed=$(( (10#$now_hour - 10#$anchor_hour) * 3600 + 10#$now_minute * 60 + 10#$now_second ))
  if [ "$elapsed" -lt 0 ]; then elapsed=$(( elapsed + 86400 )); fi
  echo $(( 86400 - elapsed ))
}

# Добовий інтервал — єдиний, для якого прив'язка до години має сенс. Якщо оператор виставив інший
# (наприклад, годину на стенді), поведінка лишається тією, що була: перший дамп одразу, далі — крок.
if [ "$interval_seconds" -eq 86400 ] && [ -n "$(find "$backup_dir" -maxdepth 1 -name 'threatlens-*.dump' -print -quit)" ]; then
  sleep "$(seconds_until_anchor)"
fi

while true; do
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="$backup_dir/threatlens-$timestamp.dump"
  run_low_priority pg_dump --format=custom --compress=zstd:3 --no-owner --no-acl "$DATABASE_URL" --file="$target"
  run_low_priority pg_restore --list "$target" >/dev/null
  sha256sum "$target" > "$target.sha256"
  find "$backup_dir" -type f -name 'threatlens-*.dump' -mtime "+$retention_days" -delete
  find "$backup_dir" -type f -name 'threatlens-*.dump.sha256' -mtime "+$retention_days" -delete
  sleep "$interval_seconds"
done
