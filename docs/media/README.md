# Demo media

These assets come from the user-supplied `Screencast from 2026-09-20 10-59-22.webm`. They document an **older hybrid/local-fallback controller**, not the current API-authoritative implementation.

| Asset | Content |
| --- | --- |
| [space-shooter-demo.webm](space-shooter-demo.webm) | Original, unchanged recording: approximately 84.61 seconds, 1155 × 1014, VP8/WebM, no audio stream |
| [historical-prototype-preview.gif](historical-prototype-preview.gif) | Source interval 20–28 seconds, 900 × 790, 8 fps, looping at real-time speed |
| [historical-prototype-poster.png](historical-prototype-poster.png) | Full-resolution frame at approximately 20 seconds |
| [space-shooter-demo.png](space-shooter-demo.png) | Previously captured legacy poster showing an ended run and failed API counters |

The original recording's SHA-256 is:

```text
a883e54d422ec707002f739ef8cfe7a7022b10beed87ee0d41a3d28d8dba76bf
```

The preview uses frame sampling, resizing, and GIF color quantization only. No gameplay is synthesized, reordered, or accelerated. The UI and its failed-request/local-action indicators remain visible. The old poster displays 195 API failures and zero applied model commands; counters and difficulty settings change during the full recording.

The README uses a Markdown image for the inline animation and links to the complete video. This keeps an in-repository visual preview without relying on an HTML video tag being preserved by every Markdown renderer. The full WebM is a separate asset; the GIF is only an excerpt.

## Rebuild the preview

Media preparation is optional and not a runtime dependency of the shooter. With a full FFmpeg installation:

```bash
ffmpeg -ss 20 -t 8 -i space-shooter-demo.webm \
  -vf 'fps=8,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse' \
  -loop 0 historical-prototype-preview.gif

ffmpeg -ss 20 -i space-shooter-demo.webm \
  -frames:v 1 historical-prototype-poster.png
```

The committed GIF was encoded from 64 sampled PNG frames using Pillow, with alternating 120/130 ms frame durations (8 seconds total), because the available FFmpeg build lacked palette/GIF filters. Different encoders can produce different bytes for the same excerpt.

None of these historical media files is current-model benchmark evidence. See the main README for the API boundary, current-controller results, and remaining limitations.
