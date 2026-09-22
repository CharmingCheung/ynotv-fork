# MPD-HLS compatibility audit

Reference reviewed: `/Users/charming/Downloads/Telegram/MPD-HLS - 20260405/MPD-HLS - 20260405`.

This is a compatibility checklist for ynoTV's native DASH path. It prevents a
provider-specific fix from being treated as complete before the surrounding MPD
rules have been checked.

## Ported

- Standard `SegmentTemplate` identifiers: `RepresentationID`, `Bandwidth`,
  `Number`, and `Time`.
- Optional integer width formats such as `$Number%05d$` and
  `$Bandwidth%07d$`.
- `$$` escaping and tolerance for vendor paths containing an unescaped literal
  dollar sign.
- RFC 3986 URL resolution for relative, absolute-path, and absolute template
  URLs, with manifest/BaseURL query inheritance when the template has no query.
- Field-level `SegmentTemplate` inheritance across Period, AdaptationSet, and
  Representation.
- `SegmentTemplate@duration` synthesis for static MPDs and dynamic MPDs with an
  `availabilityStartTime`; direct `UTCTiming` and `publishTime` are accepted as
  authoritative clocks.
- ISO-8601 duration components used by real MPDs, including year, month, week,
  day, hour, minute, and fractional second forms.
- Manual redirect following so configured request headers survive cross-host
  gateway-to-CDN redirects.
- Trick-mode exclusion, exact presentation-time math, compact long timelines,
  positive repeats, bounded `r=-1`, multi-quality video, logical audio tracks,
  and TTML/STPP discovery were already present in ynoTV.

## Still requiring an architecture-specific decision or follow-up

- HTTP `UTCTiming` (`http-xsdate`, `http-iso`, and `http-head`). Resolving it is
  asynchronous and should feed a session clock offset rather than block the XML
  parser.
- Full simultaneous multi-Period retention. ynoTV currently selects the latest
  Period and performs a generation transition; the gateway reference flattens
  and packages several Periods at once. Copying that model directly would break
  the packet-session ownership and seek index contracts.
- Multiple rotating ClearKeys. The current playback configuration carries one
  KID/key pair, so parser support alone would not make rotation playable.
- Provider-grade availability retries (longer jittered 403 retry windows) and
  explicit manifest/media response-size budgets.
- `SegmentList`, `SegmentBase`, and `SubNumber` addressing. These are rejected
  explicitly until the native packet path has corresponding index semantics.

When adding DASH support, compare the failing MPD against every row above and
add a synthetic regression fixture plus a real-source smoke test where access is
available.
