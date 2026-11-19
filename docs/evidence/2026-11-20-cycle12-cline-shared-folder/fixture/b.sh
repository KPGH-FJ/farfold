#!/bin/sh
sleep 24 &
child=$!
printf "%s %s\n" "$$" "$child" >> ./b-started.txt
wait "$child" || exit $?
printf "%s\n" FF_C12_N20_CLINE_B_FINISH > ./b-result.txt
