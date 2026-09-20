#!/bin/sh
set -eu

TARGET=""
DRY_RUN=0
NO_PULL=0
NAMESPACE="${NAMESPACE:-default}"
KUBECTL="${KUBECTL:-kubectl}"
K3S_CTR="${K3S_CTR:-sudo k3s ctr}"

usage() {
  echo "Hasznalat: $0 --target pi5|nuc [--dry-run] [--no-pull]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-pull) NO_PULL=1; shift ;;
    *) usage; exit 2 ;;
  esac
done

[ "$TARGET" = "pi5" ] || [ "$TARGET" = "nuc" ] || { usage; exit 2; }

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"

if [ -n "$(git status --porcelain)" ] && [ "$NO_PULL" -eq 0 ]; then
  echo "HIBA: Helyi modositas van. Commitold/mentsd, vagy hasznald a --no-pull opciot." >&2
  exit 1
fi

if [ "$NO_PULL" -eq 0 ]; then
  git pull --ff-only
fi

NODE_NAME=$($KUBECTL get nodes -o jsonpath='{.items[0].metadata.name}')
NODE_ARCH=$($KUBECTL get nodes -o jsonpath='{.items[0].status.nodeInfo.architecture}')
NODE_COUNT=$($KUBECTL get nodes --no-headers | wc -l | tr -d ' ')
[ "$NODE_COUNT" = "1" ] || { echo "HIBA: Csak egy node-os cluster tamogatott." >&2; exit 1; }

case "$TARGET" in
  pi5) EXPECTED_NAME=pi5; EXPECTED_ARCH=arm64 ;;
  nuc) EXPECTED_NAME=nuc; EXPECTED_ARCH=amd64 ;;
esac

[ "$NODE_NAME" = "$EXPECTED_NAME" ] && [ "$NODE_ARCH" = "$EXPECTED_ARCH" ] || {
  echo "HIBA: A kube-context nem a $TARGET clusterre mutat ($NODE_NAME/$NODE_ARCH)." >&2
  exit 1
}

REV=$(git rev-parse --short=12 HEAD 2>/dev/null || echo local)
IMAGE="ultimate-tic-tac-toe:${REV}-${NODE_ARCH}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
sed "s|image: ultimate-tic-tac-toe:1.1.0|image: $IMAGE|" ultimate-tic-tac-toe-deployment.yaml > "$TMP/resources.yaml"

echo "Cel ellenorizve: $TARGET ($NODE_ARCH); namespace: $NAMESPACE"

if [ "$DRY_RUN" -eq 1 ]; then
  $KUBECTL apply -n "$NAMESPACE" --dry-run=server -f "$TMP/resources.yaml" >/dev/null
  echo "Szerveroldali dry-run sikeres; build es cluster-modositas nem tortent."
  exit 0
fi

command -v docker >/dev/null 2>&1 || { echo "HIBA: docker nem talalhato." >&2; exit 1; }

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/nicqx-apps/$TARGET/ultimate-tic-tac-toe"
mkdir -p -m 700 "$STATE_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
$KUBECTL get deployment/ultimate-tic-tac-toe service/ultimate-tic-tac-toe-service -n "$NAMESPACE" -o yaml \
  > "$STATE_DIR/${STAMP}-${REV}.yaml" 2>/dev/null || true
chmod 600 "$STATE_DIR/${STAMP}-${REV}.yaml"
echo "Korabbi manifestek mentese: $STATE_DIR/${STAMP}-${REV}.yaml"

docker build --pull -t "$IMAGE" .
docker save -o "$TMP/image.tar" "$IMAGE"
$K3S_CTR images import "$TMP/image.tar"
$KUBECTL apply -n "$NAMESPACE" -f "$TMP/resources.yaml"
$KUBECTL rollout status deployment/ultimate-tic-tac-toe -n "$NAMESPACE" --timeout=180s
echo "Ready: Deployment/ultimate-tic-tac-toe ($IMAGE)"
