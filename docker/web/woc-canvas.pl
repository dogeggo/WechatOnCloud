# perl -0777 -pe 补丁脚本（被 woc-www-patch.sh 引用）。
# KasmVNC/noVNC 会频繁对 2D canvas 做 getImageData 读回；显式声明 willReadFrequently，
# 避免 Chromium 在运行时反复提示 Canvas2D readback 性能警告。

s/getContext\(("2d"|'2d')\)/getContext($1,{willReadFrequently:true})\/\* WOC-CANVAS \*\//g;
