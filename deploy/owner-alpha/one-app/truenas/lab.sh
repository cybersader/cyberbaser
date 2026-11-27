# Sourced by smoke.sh only. The real Compose recipe is unchanged except for
# separate networkless fixture namespaces, a fake forge record and a Git rewrite.
compose() {
  CYBERBASER_IMAGE=$image CYBERBASER_DATA=$work/data CYBERBASER_REACH=$reach docker compose \
    --project-name "$pod" --file "$HERE/truenas/compose.yaml" --file "$work/fixture.yaml" "$@"
}

truenas_lab_init() {
  for owned in cb-final2-node cb-final2-publisher cb-final2-reconciler cb-final2-forge cb-final2-relay cb-final2-initialize cb-final2-cleanup cb-final2-image-check; do
    if docker container inspect "$owned" >/dev/null 2>&1; then printf 'Lab container name already in use: %s\n' "$owned" >&2; return 1; fi
  done
  if docker network inspect cb-final2-bridge >/dev/null 2>&1; then printf 'Lab bridge name already in use.\n' >&2; return 1; fi
  lab_owned=1
  docker network create --internal --label org.cyberbaser.lab=cb-final2 cb-final2-bridge >/dev/null
  mkdir -- "$work/data"
  mkdir -m 0777 -- "$work/relay"
  # Verify the release topology before swapping its egress for a lab-only relay.
  CYBERBASER_IMAGE=$image CYBERBASER_DATA=$work/data docker compose \
    --project-name "$pod" --file "$HERE/truenas/compose.yaml" config --format json | jq -e '
      .services.node.network_mode == "host" and .services.publisher.network_mode == null
      and (.services.publisher.networks | keys) == ["default"] and .services.publisher.ports == null' >/dev/null
  docker run --rm --name cb-final2-initialize --init --pull never --network none --read-only --cap-drop ALL \
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
    --arg forge_net "$forge_net" --arg record "$work/install.json" --arg git "$work/git" '
    def ro($src; $dst): {type:"bind", source:$src, target:$dst, read_only:true, bind:{create_host_path:false}};
    def role($name; $ns): {container_name:$name, network_mode:("container:" + $ns),
      volumes:[ro($record; "/etc/cyberbaser/install.json")]};
    {services:{"config-reconciler":{container_name:"cb-final2-reconciler"}, node: role($node; $fixture), publisher:(role($publisher; $forge_net) |
      .volumes += [ro($git; "/usr/local/bin/git")])}}' > "$work/fixture.yaml"
  compose config --quiet
}

truenas_lab_cleanup() {
  local rc=0
  ((lab_owned)) || return 0
  if [[ -s "$work/fixture.yaml" ]]; then compose down >/dev/null 2>&1 || rc=1; fi
  local owned
  for owned in "$forge_net" "$fixture"; do
    if docker container inspect "$owned" >/dev/null 2>&1; then docker rm -f "$owned" >/dev/null 2>&1 || rc=1; fi
  done
  docker network rm cb-final2-bridge >/dev/null 2>&1 || rc=1
  if [[ -d "$work/data" ]]; then
    # Unlink files in this synthetic, bound root only. Its children are owned
    # by container UIDs and the invoking lab user cannot traverse them.
    docker run --rm --name cb-final2-cleanup --init --pull never --network none --read-only --cap-drop ALL \
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
  local phase=$1 name bytes
  shift
  for name in "$@"; do
    bytes=$(dep "$name" /usr/bin/cat /sys/fs/cgroup/memory.peak)
    [[ "$bytes" =~ ^[1-9][0-9]*$ ]]
    dep "$name" /usr/bin/awk '$1 ~ /^(oom|oom_kill|oom_group_kill)$/ { n++; if ($2 != 0) fail = 1 } END { exit (fail || n < 3) }' /sys/fs/cgroup/memory.events
    printf 'MEASURE %s %s cgroup memory.peak: %s bytes\n' "$phase" "$name" "$bytes"
  done
}
