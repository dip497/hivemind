#!/usr/bin/env bash
# R16's "Done when", on one computer: what leaves a device, counted. The device is a network
# namespace whose only link leads to a second namespace, the network's servers; its default route
# points there, so anything it sends anywhere else is counted by nft on its way out, and dropped.
#
#   1. On the local network (the default), hive-net sends nothing off it.
#   2. On a network someone runs, it talks to that network's servers (its relay, and the lookup
#      server where it says where it is) and to nothing else.
#   3. The app, with its update check off, reaches nothing outside the network (skipped unless the
#      app is built: `pnpm build` in apps/desktop).
#
# Needs root, iproute2 and nft. Builds hive-net first unless HIVE_NET_BIN names one.
#
#   sudo bash scripts/traffic-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
if [ -z "${HIVE_NET_BIN:-}" ]; then (cd crates/hive-net && cargo build --quiet --locked); fi
BIN="${HIVE_NET_BIN:-$ROOT/crates/hive-net/target/debug/hive-net}"

TMP=$(mktemp -d)
NS=(hm-dev hm-srv)
cleanup() {
  for ns in "${NS[@]}"; do ip netns pids "$ns" 2>/dev/null | xargs -r kill 2>/dev/null || true; done
  sleep 0.5
  for ns in "${NS[@]}"; do ip netns pids "$ns" 2>/dev/null | xargs -r kill -9 2>/dev/null || true; done
  for ns in "${NS[@]}"; do ip netns del "$ns" 2>/dev/null || true; done
  rm -rf "$TMP"
}
trap cleanup EXIT
for ns in "${NS[@]}"; do ip netns del "$ns" 2>/dev/null || true; done

fail=0
check() { # label want got
  if [ "$2" = "$3" ]; then printf '  ok   %-60s %s\n' "$1" "$2"
  else printf '  FAIL %-60s want %s, got %s\n' "$1" "$2" "$3"; fail=1; fi
}
in_ns() { local ns=$1; shift; ip netns exec "$ns" "$@"; }
key() { mkdir -p "$TMP/$1"; openssl rand -hex 32 > "$TMP/$1/device.key"; echo "$TMP/$1"; }

for ns in "${NS[@]}"; do ip netns add "$ns"; in_ns "$ns" ip link set lo up; done
ip link add v-dev type veth peer name v-srv
ip link set v-dev netns hm-dev; ip link set v-srv netns hm-srv
in_ns hm-dev ip addr add 10.20.0.2/24 dev v-dev; in_ns hm-dev ip link set v-dev up
in_ns hm-srv ip addr add 10.20.0.1/24 dev v-srv; in_ns hm-srv ip link set v-srv up
in_ns hm-dev ip route add default via 10.20.0.1
in_ns hm-dev ip -6 route add default dev v-dev 2>/dev/null || true

# What leaves the device: to the network's servers (10.20.0.1), and to anywhere else that is not
# this device, multicast (mDNS) or link-local.
count_from_scratch() {
  in_ns hm-dev nft flush ruleset
  in_ns hm-dev nft -f - <<'NFT'
table inet hm {
  counter servers {}
  counter elsewhere {}
  set addr4 { type ipv4_addr; flags dynamic; }
  set addr6 { type ipv6_addr; flags dynamic; }
  chain out {
    type filter hook output priority 0; policy accept;
    oifname "lo" accept
    ip daddr 224.0.0.0/4 accept
    ip6 daddr ff00::/8 accept
    ip6 daddr fe80::/10 accept
    ip daddr 10.20.0.1 counter name servers accept
    meta nfproto ipv4 add @addr4 { ip daddr }
    meta nfproto ipv6 add @addr6 { ip6 daddr }
    meta l4proto tcp counter
    meta l4proto udp counter
    meta l4proto icmp counter
    meta l4proto ipv6-icmp counter
    counter name elsewhere
  }
}
NFT
}
packets() { in_ns hm-dev nft list counter inet hm "$1" | awk '/packets/ {print $2}'; }
# Run `$@` in the device for `$1` seconds, then stop it (and only what runs in the device: the
# servers run on).
for_a_while() { local secs=$1; shift; (in_ns hm-dev "$@" >"$TMP/run.out" 2>&1 & echo $! >"$TMP/run.pid"); sleep "$secs"; kill "$(cat "$TMP/run.pid")" 2>/dev/null || true; ip netns pids hm-dev | xargs -r kill 2>/dev/null || true; sleep 0.5; }

echo "1. the local network"
count_from_scratch
DEV=$(key dev)
for_a_while 8 "$BIN" run --identity "$DEV"
in_ns hm-dev "$BIN" ping "$(in_ns hm-dev "$BIN" id --identity "$(key other)")" --identity "$DEV" >/dev/null 2>&1 || true
check "packets sent off the local network" 0 "$(packets elsewhere)"

echo "2. a network someone runs"
in_ns hm-srv "$BIN" serve --relay --lookup --data "$TMP/server" --bind 10.20.0.1:3340 >"$TMP/relay.out" 2>&1 &
for _ in $(seq 1 50); do [ -s "$TMP/relay.out" ] && break; sleep 0.1; done
ADMIN=$(openssl rand -hex 32); echo "$ADMIN" > "$TMP/admin.key"
ADMIN_ID=$(in_ns hm-dev "$BIN" access voucher --kind enrol --admin "$TMP/admin.key" | sed -E 's/.*"by":"([0-9a-f]+)".*/\1/')
printf '{"v":1,"name":"Office","relays":[{"url":"http://10.20.0.1:3340"}],"lookup":"http://10.20.0.1:3340/pkarr","admin":"%s","local":{"mdns":true}}' "$ADMIN_ID" > "$TMP/office.json"
"$BIN" profile sign "$TMP/office.json" --admin "$TMP/admin.key" > "$TMP/office-signed.json"
count_from_scratch
for_a_while 8 "$BIN" run --identity "$DEV" --profile "$TMP/office-signed.json"
check "talked to the network's servers" yes "$([ "$(packets servers)" -gt 0 ] && echo yes || echo no)"
# Its record, filed under its key in z-base-32 (as iroh names it).
z32() { python3 -c 'import sys
a = "ybndrfg8ejkmcpqxot1uwisza345h769"; b = bytes.fromhex(sys.argv[1]); n = int.from_bytes(b, "big")
bits = len(b) * 8; pad = (5 - bits % 5) % 5; n <<= pad; bits += pad
print("".join(a[(n >> (bits - 5 * (i + 1))) & 31] for i in range(bits // 5)))' "$1"; }
record=$(z32 "$(in_ns hm-dev "$BIN" id --identity "$DEV")")
said=$(in_ns hm-dev timeout 5 bash -c "exec 3<>/dev/tcp/10.20.0.1/3340; printf 'GET /pkarr/$record HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n' >&3; head -1 <&3" 2>/dev/null || true)
check "said where it is, at the network's lookup server" yes "$(grep -q ' 200 ' <<<"$said" && echo yes || echo "no: $said")"
check "packets sent anywhere else" 0 "$(packets elsewhere)"

echo "3. the app, its update check off"
ELECTRON="$ROOT/apps/desktop/node_modules/electron/dist/electron"
if [ -x "$ELECTRON" ] && [ -f "$ROOT/apps/desktop/out/main/index.js" ]; then
  APPDATA_DIR="$TMP/app"; mkdir -p "$APPDATA_DIR/hivemind-dev"
  echo '{"network":{"updateCheck":false}}' > "$APPDATA_DIR/settings.json"
  mkdir -p "$TMP/project" && git -C "$TMP/project" init -q
  count_from_scratch
  (cd "$TMP/project" && in_ns hm-dev env -u ELECTRON_RUN_AS_NODE XDG_CONFIG_HOME="$APPDATA_DIR" HIVE_SETTINGS="$APPDATA_DIR/settings.json" \
    HIVEMIND_HIVE_NET="$BIN" xvfb-run -a "$ELECTRON" "$ROOT/apps/desktop/out/main/index.js" --no-sandbox >"$TMP/app.out" 2>&1 &)
  sleep 25
  in_ns hm-dev pkill -f "out/main/index.js" 2>/dev/null || true
  sleep 1
  check "packets the app sent off the local network" 0 "$(packets elsewhere)"
  [ "$(packets elsewhere)" = 0 ] || { echo "  where to:"; in_ns hm-dev nft list table inet hm | grep -E "elements|l4proto"; }
else
  echo "  skip (build the app first: pnpm build in apps/desktop)"
fi

exit $fail
