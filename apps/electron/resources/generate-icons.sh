#!/bin/bash
# 使用项目现有 Electron 生成全部 Xcode 图标，无需额外图像工具。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec bun run generate:icons
