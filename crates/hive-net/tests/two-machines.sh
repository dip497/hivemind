#!/usr/bin/env bash
# R10's "Done when", on one computer: machines are network namespaces, so each has its own
# interfaces, addresses and routes, and reaches the others only as the networks below allow.
#
#   1. One network with no internet: two machines on a LAN whose router goes nowhere. They find
#      each other by mDNS and connect directly, knowing only the other's id.
#   2. Two networks: a machine on each, and a relay (`hive-net serve --relay`) with a leg on both
#      that routes nothing between them. They reach each other through it; directly they cannot.
#   3. R13's: a server on one public address that every network reaches, with a relay and a
#      lookup server on one port. A machine says where it is; from a third network another finds
#      it by its id alone, and reads the host record of a workspace it hosts.
#
# Needs root and iproute2 (`ip netns`). Builds hive-net first, unless HIVE_NET_BIN names one
# (CI builds it as its own user and runs this with sudo).
#
#   sudo bash crates/hive-net/tests/two-machines.sh
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${HIVE_NET_BIN:-}" ]; then cargo build --quiet --locked; fi
BIN="${HIVE_NET_BIN:-$PWD/target/debug/hive-net}"

TMP=$(mktemp -d)
NS=(hm-a hm-b hm-c hm-d hm-e hm-lan hm-relay)
cleanup() {
  for ns in "${NS[@]}"; do ip netns pids "$ns" 2>/dev/null | xargs -r kill 2>/dev/null || true; done
  for ns in "${NS[@]}"; do ip netns del "$ns" 2>/dev/null || true; done
  rm -rf "$TMP"
}
trap cleanup EXIT
cleanup_quiet() { for ns in "${NS[@]}"; do ip netns del "$ns" 2>/dev/null || true; done; }
cleanup_quiet

fail=0
check() { # label want got
  if [ "$2" = "$3" ]; then printf '  ok   %-58s %s\n' "$1" "$2"
  else printf '  FAIL %-58s want %s, got %s\n' "$1" "$2" "$3"; fail=1; fi
}
key() { mkdir -p "$TMP/$1"; openssl rand -hex 32 > "$TMP/$1/device.key"; echo "$TMP/$1"; }
in_ns() { local ns=$1; shift; ip netns exec "$ns" "$@"; }
# Wire namespace $1 to namespace $2 with a veth pair: $1 gets address $3, $2 gets $4 (both /24).
wire() {
  ip link add "v-$1" type veth peer name "v-$1-p"
  ip link set "v-$1" netns "$1"; ip link set "v-$1-p" netns "$2"
  in_ns "$1" ip addr add "$3/24" dev "v-$1"; in_ns "$1" ip link set "v-$1" up
  in_ns "$2" ip addr add "$4/24" dev "v-$1-p"; in_ns "$2" ip link set "v-$1-p" up
}
# Start `hive-net <args>` in namespace $1 and print the first line it prints (all it prints is kept
# in $TMP/$1.out). The file is made anew each time: what ran in $1 before may still write to the old
# one (a relay still running there; the shell of a device stopped there to start it again, which
# writes "Terminated" as the device dies, at the end of what the device had written). Only emptied,
# the file read NULs and "Terminated" first, which was taken for the device's id.
start() {
  local ns=$1 out=$TMP/$1.out; shift
  rm -f "$out"
  in_ns "$ns" "$BIN" "$@" > "$out" 2>&1 &
  for _ in $(seq 1 100); do [ -s "$out" ] && break; sleep 0.1; done
  head -1 "$out"
}

for ns in "${NS[@]}"; do ip netns add "$ns"; in_ns "$ns" ip link set lo up; done

# ── 1. one network, no internet ────────────────────────────────────────────
# The LAN is a bridge in its own namespace; each machine's default route is a router that is
# not there, as on a Wi-Fi whose uplink is down.
in_ns hm-lan ip link add br0 type bridge; in_ns hm-lan ip link set br0 up
wire hm-a hm-lan 10.10.0.2 10.10.0.102; in_ns hm-lan ip link set v-hm-a-p master br0
wire hm-b hm-lan 10.10.0.3 10.10.0.103; in_ns hm-lan ip link set v-hm-b-p master br0
for ns in hm-a hm-b; do in_ns "$ns" ip route add default via 10.10.0.1; done
A=$(key a); B=$(key b)
id_a=$(start hm-a run --identity "$A")
out=$(in_ns hm-b "$BIN" ping "$id_a" --identity "$B" 2>&1 || true)
check "on one network with no internet, found by its id alone" "yes" "$(grep -q "^$id_a answered" <<<"$out" && echo yes || echo "no: $out")"
check "and reached directly" "yes" "$(grep -q "directly" <<<"$out" && echo yes || echo "no: $out")"

# ── 2. two networks, and a relay on both that routes nothing between them ─
wire hm-c hm-relay 10.1.0.2 10.1.0.1
wire hm-d hm-relay 10.2.0.2 10.2.0.1
in_ns hm-relay sysctl -qw net.ipv4.ip_forward=0
in_ns hm-c ip route add default via 10.1.0.1
in_ns hm-d ip route add default via 10.2.0.1
start hm-relay serve --relay --bind 0.0.0.0:3340 >/dev/null
C=$(key c); D=$(key d)
id_c=$(start hm-c run --identity "$C" --relay http://10.1.0.1:3340)
# A TCP connection to the relay's port, from each network (bash's /dev/tcp: no tools needed).
reaches() { in_ns "$1" timeout 2 bash -c "exec 3<>/dev/tcp/$2/3340" 2>/dev/null && echo yes || echo no; }
check "the relay is reachable from both networks" "yes yes" "$(reaches hm-c 10.1.0.1) $(reaches hm-d 10.2.0.1)"
out=$(in_ns hm-d "$BIN" ping "$id_c" --identity "$D" --relay http://10.2.0.1:3340 2>&1 || true)
check "from another network, reached through the relay" "yes" "$(grep -q "^$id_c answered.*through a relay" <<<"$out" && echo yes || echo "no: $out")"
# Its direct address, as it says it: dialled there, from the other network, it does not answer.
direct_c=$(grep -o "direct 10\.1\.0\.2:[0-9]*" "$TMP/hm-c.out" | head -1 | cut -d' ' -f2)
check "it has a direct address" "yes" "$([ -n "$direct_c" ] && echo yes || echo no)"
out=$(in_ns hm-d "$BIN" ping "$id_c" --identity "$D" --addr "$direct_c" 2>&1 || true)
check "and is not reached at it directly" "yes" "$(grep -q "answered" <<<"$out" && echo "no: $out" || echo yes)"

# ── 3. three networks, and a server on one address all of them reach ──────
# The server's own address, 192.0.2.1, is on its loopback; each network's default route leads to
# its leg of the server, which forwards nothing, so each machine reaches the server and no other.
wire hm-e hm-relay 10.3.0.2 10.3.0.1
in_ns hm-e ip route add default via 10.3.0.1
in_ns hm-relay ip addr add 192.0.2.1/32 dev lo
SERVER=http://192.0.2.1:3341
start hm-relay serve --relay --lookup --data "$TMP/server" --bind 0.0.0.0:3341 --lookup-limit off >/dev/null
E=$(key e); openssl rand -hex 32 > "$C/person.key"
in_ns hm-c pkill -f -- "--identity $C" || true
id_c=$(start hm-c run --identity "$C" --relay "$SERVER" --lookup "$SERVER/pkarr")
check "the server is reachable from the third network" "yes" "$(in_ns hm-e timeout 2 bash -c "exec 3<>/dev/tcp/192.0.2.1/3341" 2>/dev/null && echo yes || echo no)"
found=no
for _ in $(seq 1 20); do
  out=$(in_ns hm-e "$BIN" ping "$id_c" --identity "$E" --relay "$SERVER" --lookup "$SERVER/pkarr" 2>&1 || true)
  if grep -q "^$id_c answered" <<<"$out"; then found=yes; break; fi
  sleep 1
done
check "from a third network, found by its id through the lookup server" "yes" "$([ "$found" = yes ] && echo yes || echo "no: $out")"
published=$(in_ns hm-c "$BIN" host-record publish --identity "$C" --lookup "$SERVER/pkarr" --workspace ws-1 --seq 1 2>&1 || true)
workspace=$(grep -o '"workspace":"[0-9a-f]*"' <<<"$published" | cut -d'"' -f4)
read_back=$(in_ns hm-e "$BIN" host-record resolve "$workspace" --lookup "$SERVER/pkarr" 2>&1 || true)
check "and the host record of a workspace it hosts is read there" "yes" "$(grep -q "\"host\":\"$id_c\"" <<<"$read_back" && echo yes || echo "no: $published / $read_back")"

if [ "$fail" = 0 ]; then echo "two machines: all ok"; else echo "two machines: FAILED"; exit 1; fi
