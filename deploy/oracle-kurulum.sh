#!/usr/bin/env bash
# Oracle Cloud (Ubuntu 22.04/24.04, ARM) sunucusunda tek seferlik kurulum.
# Proje klasörünün içinde çalıştır:  bash deploy/oracle-kurulum.sh
set -euo pipefail

echo "==> Docker kuruluyor"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

echo "==> Sunucu içi güvenlik duvarı açılıyor (Oracle Ubuntu imajı varsayılan olarak kapatır)"
open_port() { # proto port
  sudo iptables -C INPUT -p "$1" --dport "$2" -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 5 -p "$1" --dport "$2" -j ACCEPT
}
open_port tcp 80
open_port tcp 443
open_port tcp 3478
open_port udp 3478
sudo iptables -C INPUT -p udp --dport 49160:49200 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 5 -p udp --dport 49160:49200 -j ACCEPT
sudo apt-get install -y iptables-persistent >/dev/null 2>&1 || true
sudo netfilter-persistent save || true

echo "==> .env hazırlanıyor"
if [ ! -f .env ]; then
  PUB=$(curl -fsS https://api.ipify.org || echo "1.2.3.4")
  PRIV=$(hostname -I | awk '{print $1}')
  SECRET=$(openssl rand -hex 32)
  cat > .env <<EOF
PUBLIC_IP=$PUB
PRIVATE_IP=$PRIV
DOMAIN=${PUB//./-}.sslip.io
TURN_SECRET=$SECRET
EOF
  echo ".env oluşturuldu:"; cat .env
fi

echo "==> Başlatılıyor"
sudo docker compose up -d --build
source .env
echo
echo "Hazır! Tarayıcıdan aç:  https://$DOMAIN"
echo "Not: Oracle panelinde de (VCN > Security List) aynı portları açmayı unutma:"
echo "     TCP 80, 443, 3478 ve UDP 3478, 49160-49200"
