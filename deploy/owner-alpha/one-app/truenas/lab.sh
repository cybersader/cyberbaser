# Sourced by smoke.sh only. The real Compose recipe is unchanged except for
# the fixture namespace, a fake forge record and the synthetic Git rewrite.
compose() {
  CYBERBASER_IMAGE=$image CYBERBASER_DATA=$work/data CYBERBASER_REACH=$reach docker compose \
    --project-name "$pod" --file "$HERE/truenas/compose.yaml" --file "$work/fixture.yaml" "$@"
}

truenas_lab_init() {
  mkdir -- "$work/data"
  docker run --rm --init --pull never --network none --read-only --cap-drop ALL \
    --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --user 0:0 --security-opt no-new-privileges \
    --memory 64m --memory-swap 64m --cpus 1 --pids-limit 32 \
    --mount "type=bind,src=$work/data,dst=/lab-data" \
    --mount "type=bind,src=$work/install.json,dst=/lab-record" \
    --mount "type=bind,src=$HERE/truenas/paths.tsv,dst=/paths,readonly" --entrypoint /usr/bin/timeout "$image" \
    -s KILL 15 /usr/bin/bash -euc '
      while read -r rel uid gid mode; do
        [[ "$rel" == "#" ]] && continue
        dir="/lab-data/$rel"
        [[ ! -L "$dir" ]]
        if [[ "$rel" != . && ! -e "$dir" ]]; then mkdir -m "$mode" -- "$dir"; fi
        [[ -d "$dir" ]]
        chmod -- "$mode" "$dir"
        chown -- "$uid:$gid" "$dir"
      done < /paths
      chown 0:0 /lab-record'
  # JSON is YAML but does not need Compose/YAML quoting of host paths.
  jq -n --arg node "$node" --arg publisher "$publisher" --arg fixture "$fixture" \
    --arg record "$work/install.json" --arg git "$work/git" '
    def ro($src; $dst): {type:"bind", source:$src, target:$dst, read_only:true, bind:{create_host_path:false}};
    def role($name): {container_name:$name, network_mode:("container:" + $fixture),
      volumes:[ro($record; "/etc/cyberbaser/install.json")]};
    {services:{node: role($node), publisher:(role($publisher) |
      .volumes += [ro($git; "/usr/local/bin/git")])}}' > "$work/fixture.yaml"
  compose config --quiet
}

truenas_lab_cleanup() {
  local rc=0
  if [[ -s "$work/fixture.yaml" ]]; then compose down >/dev/null 2>&1 || rc=1; fi
  if docker container inspect "$fixture" >/dev/null 2>&1; then docker rm -f "$fixture" >/dev/null 2>&1 || rc=1; fi
  if [[ -d "$work/data" ]]; then
    # Unlink files in this synthetic, bound root only. Its children are owned
    # by container UIDs and the invoking lab user cannot traverse them.
    docker run --rm --init --pull never --network none --read-only --cap-drop ALL \
      --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --user 0:0 --security-opt no-new-privileges \
      --memory 64m --memory-swap 64m --cpus 1 --pids-limit 32 \
      --mount "type=bind,src=$work/data,dst=/lab-data" --entrypoint /usr/bin/timeout "$image" \
      -s KILL 30 /usr/bin/bash -euc '
        find /lab-data -xdev -mindepth 1 -depth -delete
        chown -- "$1:$2" /lab-data; chmod 0700 /lab-data
      ' bash "$UID" "$(id -g)" || rc=1
  fi
  return "$rc"
}

memory_peak() {
  local bytes
  bytes=$(dep "$node" /usr/bin/cat /sys/fs/cgroup/memory.peak)
  [[ "$bytes" =~ ^[1-9][0-9]*$ ]]
  printf 'MEASURE %s node cgroup memory.peak: %s bytes (%s MiB rounded up)\n' "$1" "$bytes" "$(((bytes + 1048575) / 1048576))"
}
