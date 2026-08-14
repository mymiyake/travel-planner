#!/bin/bash
# 여행 코스 플래너 실행 스크립트 (더블클릭 실행 가능)
cd "$(dirname "$0")"
echo "▶ 서버 시작 (http://localhost:8792)"
# 기존 인스턴스 정리
pkill -f "node server.js" 2>/dev/null
node server.js &
SRV=$!
sleep 2
if command -v ngrok >/dev/null 2>&1; then
  echo "▶ ngrok 터널 시작…"
  ngrok http 8792
else
  echo "ngrok 미설치 — 로컬만 실행됩니다. http://localhost:8792 로 접속하세요."
  wait $SRV
fi
