# Chromium/Electron 启动参数集中定义。
# 这里仅负责输出 flags，不修改环境变量。

woc_flags_inline() {
  local provider="$1"
  local flags=()
  local flag
  while IFS= read -r flag; do
    flags+=("$flag")
  done < <("$provider")
  printf '%s' "${flags[*]}"
}

woc_chromium_software_flags() {
  printf '%s\n' \
    --no-sandbox \
    --disable-gpu \
    --disable-gpu-compositing \
    --disable-gpu-rasterization \
    --disable-accelerated-2d-canvas \
    --disable-vulkan \
    --disable-accelerated-video-decode \
    --disable-accelerated-video-encode \
    --disable-zero-copy \
    --disable-oop-rasterization \
    --disable-native-gpu-memory-buffers \
    --disable-features=CanvasOopRasterization,VaapiVideoDecoder,VaapiVideoEncoder,Vulkan \
    --enable-unsafe-swiftshader \
    --use-gl=swiftshader \
    --use-angle=swiftshader
}

woc_chromium_software_flags_inline() {
  woc_flags_inline woc_chromium_software_flags
}

woc_qq_chromium_flags() {
  woc_chromium_software_flags
  printf '%s\n' \
    --renderer-process-limit=2 \
    --enable-low-end-device-mode \
    --disable-breakpad \
    --disable-crash-reporter \
    --disable-background-networking \
    --disable-component-update \
    --disable-domain-reliability \
    --disable-sync
}

woc_qq_chromium_flags_inline() {
  woc_flags_inline woc_qq_chromium_flags
}
