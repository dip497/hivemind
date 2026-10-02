#!/usr/bin/env bash
# R13's checks, against the stack `infra/compose.yml` runs (CI runs them on every change, so the
# stack cannot rot): the network's link printed and kept across a restart, naming its push server,
# which answers; a device nobody enrolled turned away by the relay, and told why; devices enrolled with the admin's links let
# in; one found by its id alone through the lookup server and reached through the relay; a
# workspace's host record read back; and after the server restarts, its devices back on it.
#
#   docker compose -f infra/compose.yml up -d --build && bash infra/check.sh
#
# The devices are hive-net on this machine (HIVE_NET_BIN, or the crate's debug build), reaching
# the stack at HIVE_URL (default http://127.0.0.1:3340).
set -euo pipefail
cd "$(dirname "$0")/.."
BIN="${HIVE_NET_BIN:-$PWD/crates/hive-net/target/debug/hive-net}"
BASE="${HIVE_URL:-http://127.0.0.1:3340}"
COMPOSE=(docker compose -f infra/compose.yml)
TMP=$(mktemp -d)
RUNS=()
cleanup() { for pid in "${RUNS[@]}"; do kill "$pid" 2>/dev/null || true; done; rm -rf "$TMP"; }
trap cleanup EXIT

fail=0
check() { # label want got
  if [ "$2" = "$3" ]; then printf '  ok   %-64s %s\n' "$1" "$2"
  else printf '  FAIL %-64s want %s, got %s\n' "$1" "$2" "$3"; fail=1; fi
}
device() {
  mkdir -p "$TMP/$1"
  for k in device person; do openssl rand -hex 32 > "$TMP/$1/$k.key"; done
  echo "$TMP/$1"
}
# The latest network link the server printed.
printed_link() { "${COMPOSE[@]}" logs hive-net 2>/dev/null | grep -o 'hivemind://network/[A-Za-z0-9_-]*' | tail -1; }
# Ask until it answers yes, for at most $1 seconds (however long each asking takes).
within() { local until=$((SECONDS + $1)); shift; while [ "$SECONDS" -lt "$until" ]; do "$@" && return 0; sleep 1; done; return 1; }
on_relay() { "$BIN" doctor --identity "$1" --relay "$BASE" | python3 -c 'import json,sys; r=json.load(sys.stdin)["relays"][0]; print("yes" if r["ok"] else "no: " + str(r.get("refused")))'; }
# The voucher an enrolment link carries.
voucher_of() { python3 -c 'import base64,json,sys; s=sys.argv[1].split("/")[-1]; print(json.dumps(json.loads(base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)))["enrol"]))' "$1"; }
enrol() {
  local link
  link=$("${COMPOSE[@]}" exec -T hive-net /usr/local/bin/hive-net access enrol-link /data/network.json --admin /data/admin.key)
  "$BIN" access redeem "$BASE/access" "$(voucher_of "$link")" --identity "$1"
}

within 60 curl -sf "$BASE/healthz" -o /dev/null || { echo "the stack does not answer at $BASE"; exit 1; }
link=$(printed_link)
check "the server printed the network's link" yes "$([ -n "$link" ] && echo yes || echo no)"
check "it names this server's relay, lookup, access and push server" yes "$("$BIN" profile verify "$link" | python3 -c "import json,sys; p=json.load(sys.stdin)['profile']; print('yes' if p['relays'][0]['url']=='$BASE' and p['lookup']=='$BASE/pkarr' and p['access']['url']=='$BASE/access' and p['push']['url']=='$BASE/push' and p['push']['kinds']==['unifiedpush'] and len(p['push'].get('vapid',''))==87 else 'no: '+json.dumps(p))")"
check "its push server answers" '"ok"' "$(curl -sf "$BASE/push/healthz" || echo none)"

A=$(device a); B=$(device b); STRANGER=$(device stranger)
refused=$(on_relay "$STRANGER")
check "a device nobody enrolled is turned away by the relay, and told why" yes "$(grep -q "not allowed" <<<"$refused" && echo yes || echo "$refused")"
enrol "$A"; enrol "$B"
check "devices enrolled with the admin's links are let in" "yes yes" "$(on_relay "$A") $(on_relay "$B")"

"$BIN" run --identity "$A" --relay "$BASE" --lookup "$BASE/pkarr" > "$TMP/a.out" 2>&1 &
RUNS+=($!)
within 30 test -s "$TMP/a.out"
id_a=$(head -1 "$TMP/a.out")
# B knows A's id and the network, nothing else (no mDNS with relays named on the command line).
ping_a() { "$BIN" ping "$id_a" --identity "$B" --relay "$BASE" --lookup "$BASE/pkarr" 2>&1 | grep -q "^$id_a answered"; }
check "a device is found by its id through the lookup server, and reached" yes "$(within 30 ping_a && echo yes || echo no)"
workspace=$("$BIN" host-record publish --identity "$A" --lookup "$BASE/pkarr" --workspace ws-check --seq 1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["workspace"])')
check "a workspace's host record is read back" "$id_a" "$("$BIN" host-record resolve "$workspace" --lookup "$BASE/pkarr" | python3 -c 'import json,sys; print((json.load(sys.stdin) or {}).get("host"))')"

"${COMPOSE[@]}" restart hive-net >/dev/null
within 60 curl -sf "$BASE/healthz" -o /dev/null
check "after a restart, its devices are back and reach each other" yes "$(within 60 ping_a && echo yes || echo no)"
# Printed again on the restart, and the same: the admin key and the profile were kept.
check "and it printed the same link again" 2 "$("${COMPOSE[@]}" logs hive-net 2>/dev/null | grep -c "network link: $link\$" || true)"

if [ "$fail" = 0 ]; then echo "compose stack: all ok"; else echo "compose stack: FAILED"; exit 1; fi
