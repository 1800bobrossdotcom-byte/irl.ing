#!/usr/bin/env bash
# Rate–distortion benchmark (go/no-go exam 1): quality at equal bytes.
# Encodes a 6-second, 288×288 crop of the Xiph "foreman" sequence at fixed
# byte budgets with offline AV1, phone-like real-time AV1 (Chrome's WebCodecs
# settings: libaom realtime, speed 7, no lookahead), offline H.264, and the
# loops dots codec, then scores each against the original frame by frame.
#
#   scripts/bench/rd-bench.sh [work-dir]
#
# Needs ffmpeg with libaom-av1 and libx264, Node 22+, and network access to
# media.xiph.org (once; the clip is cached in the work dir).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="${1:-${TMPDIR:-/tmp}/irl-rd-bench}"
mkdir -p "$work" && cd "$work"
[ -f foreman_cif.y4m ] || curl -sSf -o foreman_cif.y4m https://media.xiph.org/video/derf/y4m/foreman_cif.y4m
[ -f ref.y4m ] || ffmpeg -hide_banner -loglevel error -y -i foreman_cif.y4m -frames:v 180 -vf "crop=288:288:32:0" -pix_fmt yuv420p ref.y4m

# Frames are paired by index so container timestamps can't misalign them.
pair='[0:v]setpts=N/30/TB[a];[1:v]setpts=N/30/TB[b];[a][b]'
score() { # file label
  local bytes psnr ssim
  bytes=$(stat -c %s "$1")
  psnr=$(ffmpeg -hide_banner -i "$1" -i ref.y4m -lavfi "${pair}psnr" -fps_mode passthrough -f null - 2>&1 | grep -o "y:[0-9.]*" | tail -1)
  ssim=$(ffmpeg -hide_banner -i "$1" -i ref.y4m -lavfi "${pair}ssim" -fps_mode passthrough -f null - 2>&1 | grep -o "All:[0-9.]*" | tail -1)
  printf '%-44s %8s B  PSNR-Y %6.2f dB  SSIM %s\n' "$2" "$bytes" "${psnr#y:}" "${ssim#All:}"
}
q() { ffmpeg -hide_banner -loglevel error -y "$@"; }

for kb in 25 50 100 200; do
  br=$((kb * 8 * 1000 / 6))
  q -i ref.y4m -c:v libaom-av1 -cpu-used 3 -b:v $br -pass 1 -passlogfile aom -an -f null /dev/null
  q -i ref.y4m -c:v libaom-av1 -cpu-used 3 -b:v $br -pass 2 -passlogfile aom aom_$kb.webm
  score aom_$kb.webm "AV1 offline, 2-pass, ${kb} KB target"
  q -i ref.y4m -c:v libaom-av1 -usage realtime -cpu-used 7 -lag-in-frames 0 -b:v $br -maxrate $br -minrate $br -bufsize $((br * 2)) rt_$kb.webm
  score rt_$kb.webm "AV1 phone-like real-time, ${kb} KB target"
  q -i ref.y4m -c:v libx264 -preset veryslow -b:v $br -pass 1 -passlogfile x264 -an -f null /dev/null
  q -i ref.y4m -c:v libx264 -preset veryslow -b:v $br -pass 2 -passlogfile x264 x264_$kb.mp4
  score x264_$kb.mp4 "H.264 offline, 2-pass, ${kb} KB target"
done

# Dots v1, scored generously: each keyframe fully formed and held (no in-flight gaps).
q -i ref.y4m -vf "fps=12,scale=160:160:flags=area" -f rawvideo -pix_fmt rgb24 cap160.rgb
for cfg in "32 16" "64 16" "128 16" "128 64"; do
  set -- $cfg
  node "$here/dots-frames.mjs" cap160.rgb "$1" "$2" 6 "dots_$1_$2.rgb" > /dev/null
  q -f rawvideo -pix_fmt rgb24 -s "${1}x${1}" -r 30000/1001 -i "dots_$1_$2.rgb" -vf scale=288:288:flags=bicubic -pix_fmt yuv420p "dots_$1_$2.y4m"
  bytes=$(node "$here/dots-frames.mjs" cap160.rgb "$1" "$2" 6 /dev/null)
  printf '%s' "$bytes" > "dots_$1_$2.size"
  line=$(score "dots_$1_$2.y4m" "Dots v1 ${1}², ${2} steps (best case)")
  # The y4m is uncompressed; report the real .irl size instead.
  echo "$line" | sed -E "s/ +[0-9]+ B / $(printf '%8s' "$bytes") B /"
done
