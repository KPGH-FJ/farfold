#!/bin/sh
sleep 180 &
child=$!
printf "%s %s\n" "$$" "$child" >> ./started.txt
wait "$child" || exit $?
printf "%s\n" FF_C12_N20_DEVIN_NATURAL > ./natural.txt
