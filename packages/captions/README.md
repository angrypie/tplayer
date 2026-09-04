# `@tplayer/captions`

TPlayer's framework-independent caption core converts timed words into readable
caption segments, serializes those segments as compact TCAP bytes, and performs
media-time lookup without allocating a result object on every playback tick.
It has no React, browser-storage, server, or transcription-provider dependency.

The package is private while its API is exercised in TPlayer. Its direct
subpath exports (`/types`, `/segmenter`, `/codec`, and `/lookup`) are intended to
be retained when a future publication build points them at compiled `dist/`
artifacts.

## TCAP v1

TCAP is little-endian and uses a 1,000-unit-per-second timescale. A 40-byte
header is followed by fixed 16-byte segment records and one contiguous UTF-8
text pool. Every record contains unsigned 32-bit start time, end time, relative
text offset, and text byte length. Start is inclusive and end is exclusive.

The decoder rejects unknown versions, noncanonical sections, invalid UTF-8,
out-of-bounds text, overlapping segments, and segments outside the declared
track duration. The format stores display segments only; provider-specific
word timings, model identity, language, source fingerprints, and job state
belong in the integrating application's metadata.

## API

```ts
import { decodeCaptionTrack, encodeCaptionTrack } from '@tplayer/captions/codec'
import { createCaptionLookup } from '@tplayer/captions/lookup'
import { segmentTimedWords } from '@tplayer/captions/segmenter'

const segments = segmentTimedWords(timedWords)
const bytes = encodeCaptionTrack({ segments })
const track = decodeCaptionTrack(bytes)
const lookup = createCaptionLookup(track)

if (lookup.seek(mediaTimeMilliseconds)) {
	updateVisibleCaption(lookup.text)
}
```

`CaptionLookup.seek()` mutates one cursor and reports whether the visible
segment changed. It checks the current and adjacent records before falling back
to binary search, so ordinary forward playback is constant-time while seeks
remain logarithmic. The benchmark warms decoded text, performs one million
lookups, and checks both throughput and retained JavaScript heap/object deltas
after a full collection.

Run package checks with:

```sh
bun run --cwd packages/captions test
bun run --cwd packages/captions benchmark
```
