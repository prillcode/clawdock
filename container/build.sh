#!/bin/bash
# Build ClawDock agent container images

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="clawdock-agent"
BUILD_TARGET="${1:-all}"

build_image() {
  local tag="$1"
  local dockerfile="$2"
  
  echo "Building ${IMAGE_NAME}:${tag}..."
  docker build -f "${dockerfile}" -t "${IMAGE_NAME}:${tag}" .
  echo "✓ Built ${IMAGE_NAME}:${tag}"
  echo ""
}

case "$BUILD_TARGET" in
  base)
    build_image "base" "Dockerfile.base"
    ;;
  
  devtools)
    # Build base first if it doesn't exist (devtools extends base)
    if ! docker image inspect "${IMAGE_NAME}:base" &>/dev/null; then
      echo "Base image not found. Building base first..."
      build_image "base" "Dockerfile.base"
    fi
    build_image "devtools" "Dockerfile.devtools"
    ;;
  
  all)
    build_image "base" "Dockerfile.base"
    build_image "devtools" "Dockerfile.devtools"
    ;;
  
  *)
    echo "Usage: $0 [base|devtools|all]"
    echo ""
    echo "  base      - Build minimal base image (family channels)"
    echo "  devtools  - Build extended devtools image (dev/gamedev channels)"
    echo "  all       - Build both images (default)"
    exit 1
    ;;
esac

echo "Build complete!"
echo ""
echo "Available images:"
docker images "${IMAGE_NAME}" --format "  {{.Repository}}:{{.Tag}} ({{.Size}})"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | docker run -i ${IMAGE_NAME}:base"
