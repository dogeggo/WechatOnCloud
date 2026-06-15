#!/usr/bin/env bash
# 本地构建面板镜像 + 应用实例镜像，打成与 docker-compose.yml 一致的标签。
# 用途：GHCR 尚未发布（没打 tag）时自测，或自托管者想自己构建而非拉取官方镜像。
# 构建完成后直接 `docker compose up -d` 即可（compose 默认 pull_policy=missing，会优先用本地镜像）。
#
# 用法：
#   ./scripts/build-local.sh                # 构建本机架构，标签 latest
#   WOC_VERSION=v1.0.0 ./scripts/build-local.sh   # 指定标签（需与 .env 的 WOC_VERSION 一致）
set -euo pipefail

OWNER="${WOC_IMAGE_OWNER:-dogeggo}"
TAG="${WOC_VERSION:-latest}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PANEL_IMAGE="docker.io/${OWNER}/aoc-panel:${TAG}"
INSTANCE_IMAGE="docker.io/${OWNER}/app-on-cloud:${TAG}"

echo "==> 构建面板镜像 ${PANEL_IMAGE}"
docker build -t "${PANEL_IMAGE}" "${ROOT}/panel"

echo "==> 构建应用实例镜像 ${INSTANCE_IMAGE}"
docker build -t "${INSTANCE_IMAGE}" "${ROOT}/docker"

echo
echo "完成。本地镜像："
# 注意：docker images 只接受一个仓库参数，故用 --filter 各列一次
docker images --filter "reference=${PANEL_IMAGE}" --format '  {{.Repository}}:{{.Tag}}  {{.Size}}'
docker images --filter "reference=${INSTANCE_IMAGE}" --format '  {{.Repository}}:{{.Tag}}  {{.Size}}'
echo
echo "下一步：docker compose up -d   （记得先把 .env 里 WOC_VERSION 设为 ${TAG}）"
