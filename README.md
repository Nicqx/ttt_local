# Ultimate Tic-Tac-Toe

Szobakódos böngészős amőba. Erőforrások: `ultimate-tic-tac-toe` Deployment és `ultimate-tic-tac-toe-service:8090` Service; publikus útvonal: `/tic-tac-toe/`.

## Telepítés és frissítés

```bash
cd ~/codes/ttt_local
git pull --ff-only
KUBECTL='sudo k3s kubectl' ./update.sh --target nuc --dry-run
KUBECTL='sudo k3s kubectl' ./update.sh --target nuc
```

Előfeltétel: Docker, Git, Bash, működő k3s, Redis és ingress. A korábbi manifest mentése a `~/.local/state/nicqx-apps/nuc/ultimate-tic-tac-toe/` könyvtárba kerül.

## Ellenőrzés

```bash
sudo k3s kubectl get pod,service -n default -l app=ultimate-tic-tac-toe -o wide
sudo k3s kubectl logs deployment/ultimate-tic-tac-toe -n default --tail=50
curl -fsSI https://pmqxyz.hopto.org/tic-tac-toe/ | head -n 1
```

## Migráció

Az alkalmazásimage állapotmentes; a sessionök Redisben vannak. Előbb a `redis` repo eljárásával migráld a játékadatokat, utána klónozd ezt a repót és futtasd az update-et. Külön PVC nincs.

## Leállítás, rollback, eltávolítás

```bash
sudo k3s kubectl scale deployment/ultimate-tic-tac-toe -n default --replicas=0
sudo k3s kubectl scale deployment/ultimate-tic-tac-toe -n default --replicas=1
sudo k3s kubectl apply -f /teljes/ut/korabbi-manifest.yaml
sudo k3s kubectl rollout status deployment/ultimate-tic-tac-toe -n default --timeout=180s
sudo k3s kubectl delete deployment/ultimate-tic-tac-toe service/ultimate-tic-tac-toe-service -n default
```

Az eltávolítás nem töröl Redis-adatot vagy ingress-szabályt.
