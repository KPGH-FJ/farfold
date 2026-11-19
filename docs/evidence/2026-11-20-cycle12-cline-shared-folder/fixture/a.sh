#!/bin/sh
sleep 24 &
child=$!
printf "%s %s\n" "$$" "$child" >> ./a-started.txt
wait "$child" || exit $?
printf "%s\n" FF_C12_N20_CLINE_A_FINISH > ./a-result.txt
