#!/bin/sh
node_bin=$1
source_root=$2
fixture_root=$3
entry=$4
input=$5
exec "$node_bin" --no-warnings --permission \
  --allow-fs-read="$source_root" --allow-fs-read="$fixture_root" --allow-fs-write="$fixture_root" \
  --allow-fs-read="/proc/$$" --allow-fs-read=/proc/self \
  --allow-fs-read=/proc/sys/kernel/random/boot_id "$entry" "$input"
