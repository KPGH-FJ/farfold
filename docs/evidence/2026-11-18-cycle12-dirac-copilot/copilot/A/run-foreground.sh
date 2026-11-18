#!/bin/sh
set -eu
umask 077
run_dir=$(/usr/bin/dirname "$0")
[ "$(/bin/pwd -P)" = "$run_dir" ] || { printf 'Unexpected workspace\n' >&2; exit 2; }
/bin/mkdir "$run_dir/run-once" || exit 3
started=$(/bin/date +%s)
/bin/sleep 175 &
child=$!
printf '%s %s %s %s\n' "$$" "$child" "$started" '175' > "$run_dir/started.tmp"
/bin/mv "$run_dir/started.tmp" "$run_dir/started.txt"
wait "$child"
printf '%s\n' 'FF_C12_COPILOT_PHYSICAL_STOP_A_DONE' > "$run_dir/result.tmp"
/bin/mv "$run_dir/result.tmp" "$run_dir/result.txt"
printf '%s\n' 'FF_C12_COPILOT_PHYSICAL_STOP_A_DONE'
