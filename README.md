# ttt_local
rm ultimate-tic-tac-toe.tar
docker build --no-cache -t ultimate-tic-tac-toe:latest .
docker save ultimate-tic-tac-toe:latest -o ultimate-tic-tac-toe.tar
sudo k3s ctr image import ultimate-tic-tac-toe.tar
kubectl apply -f ultimate-tic-tac-toe-deployment.yaml
kubectl rollout restart deployment/ultimate-tic-tac-toe

