#!/bin/bash
# Local smoke check of the one-app image without Compose: initialize volumes,
# start the node container (first-run setup), check the users and the
# isolation of the publisher volume. Removes everything it created.
set -uo pipefail
IMAGE="${1:-localhost/cyberbaser-one-app:dev}"
P="cb-one-app-smoke-$$"
volumes=(node-state workspace notes publisher-state publisher-sockets)
cleanup() { podman rm -f "$P-node" >/dev/null 2>&1; for v in "${volumes[@]}"; do podman volume rm -f "$P-$v" >/dev/null 2>&1; done; }
trap cleanup EXIT
common=(--read-only --cap-drop ALL --security-opt no-new-privileges --security-opt label=disable --tmpfs /tmp)
podman run --rm "${common[@]}" --network none --user 0:0 --cap-add CHOWN --cap-add FOWNER \
  -v "$P-node-state:/var/lib/cyberbaser" -v "$P-workspace:/var/lib/cyberbaser-shared/workspace" -v "$P-notes:/var/lib/cyberbaser-shared/notes" \
  -v "$P-publisher-state:/var/lib/cyberbaser-publisher" -v "$P-publisher-sockets:/run/cyberbaser-publisher" \
  --entrypoint /usr/local/bin/cyberbaser-container-init "$IMAGE"
podman run -d --name "$P-node" "${common[@]}" --user 65532:65530 -e HOME=/var/lib/cyberbaser/home \
  -v "$P-node-state:/var/lib/cyberbaser" -v "$P-workspace:/opt/cyberbaser/.workspace" -v "$P-notes:/var/lib/cyberbaser-shared/notes" \
  -v "$P-publisher-sockets:/run/cyberbaser-publisher:ro" "$IMAGE" service-node >/dev/null
for _ in $(seq 1 60); do podman logs "$P-node" 2>&1 | grep -q '^Cyberbaser setup: ' && break; sleep 0.5; done
podman logs "$P-node" 2>&1 | grep -m1 '^Cyberbaser setup: ' | sed 's/token=.*/token=<one-time>/' || echo "no setup link"
echo "node runs as: $(podman exec "$P-node" id -un):$(podman exec "$P-node" id -gn)"
[ -z "$(podman exec "$P-node" ls -A /var/lib/cyberbaser-publisher)" ] && echo "PASS the node container has only the image empty folder there, not the publisher volume" || echo "FAIL node sees publisher state"
podman run --rm "${common[@]}" --network none --user 65533:65530 "$IMAGE" node /x 2>&1 | head -1
podman run --rm "${common[@]}" --network none --user 65532:65530 "$IMAGE" publisher /x /tmp/x.sock /tmp/x.git 2>&1 | head -1
podman run --rm "${common[@]}" --network none --user 65532:65530 -v "$P-publisher-state:/var/lib/cyberbaser-publisher" --entrypoint /bin/ls "$IMAGE" /var/lib/cyberbaser-publisher 2>&1 | head -1
