---
'@mawesome/dependency-audit': patch
---

Stop masking the decompression-bomb guard for local `file:` tarballs: an oversized/hostile `.tgz` now fails its target instead of being silently treated as an absent dependency.
