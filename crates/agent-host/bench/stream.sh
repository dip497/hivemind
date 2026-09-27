#!/usr/bin/env bash
# Agent-like output: a spinner redraw every 0.4 s, then a burst of streamed lines.
while :; do
  for i in $(seq 20); do printf '\r\033[33m✻\033[0m Working on it… (%ss · esc to interrupt)  ' $i; sleep 0.4; done
  printf '\n'
  for j in $(seq 12); do printf '\033[2m│\033[0m streamed line %s %s\n' $j "$(head -c 45 /dev/urandom | base64)"; done
done
