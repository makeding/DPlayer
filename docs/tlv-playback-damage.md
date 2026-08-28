# TLV playback damage contract

## Browser SDK ownership

For `tlvdemux >= 0.3.3`, protocol and playback lifecycle behavior is owned by
the public browser SDK. DPlayer must consume the SDK's MSE output pipeline,
recorded-source and 16 MiB recorded-seek coordinator, track/layer selection,
live input coalescing, playback-damage recovery, and Worker client/runtime.
DPlayer owns only its UI, product-mode transactions, public events, subtitle and
data-broadcast presentation, tone-mapping presentation, labels, and persisted
preferences. Local copies, fallback readers, duplicate Worker protocols, and
parallel Range/seek/MSE implementations are forbidden.

The published `DPlayer.min.js` is self-contained: it embeds the tlvdemux Worker
and WASM JavaScript runtime and creates an owned Blob URL for Worker startup.
Host applications must not copy, rename, or publish tlvdemux sidecar files.

The cutover preserves the deployed DPlayer API and observable events. An
explicit recorded seek must share the SDK's 16 MiB source-read budget and report
the SDK's seek-specific error; it must not fall back to an unbounded read or be
reported as a startup failure. Manual rainfall selection followed by automatic
selection must restore the healthy preferred paired A/V layer at the next
usable RAP, including when the manual request was made before the initial
playback entry.

Live playback uses the SDK's dedicated Live entry. Its first valid common A/V
range may start after timestamp zero; DPlayer aligns the media clock only after
the configured Live startup buffer is ready. A Live stream that never forms a
common A/V range must stop after the same 16 MiB no-progress budget.

A fresh recorded playback from timestamp zero enables the SDK's atomic entry
alignment before either SourceBuffer is installed. Live playback, an explicit
recorded seek, and a reused MediaSource do not enable it. An explicit rainfall
splice offset remains authoritative and is never compounded with a derived
startup offset; an unmapped startup can read only the SDK's existing 16 MiB
budget before reporting `MSE_STARTUP_NO_COMMON_AV`.

Recorded media time uses tlvdemux's probed presentation range. Automatic
dual-video playback uses the union start/end reported by the SDK; an explicit
`videoPacketId` restricts the probe to that track. DPlayer passes the same
presentation start/end to fresh MSE alignment, demuxer timestamp offset,
duration, explicit seek, selected-layer damage recovery, audio switching, and
running layer switching. Media time zero always maps to the probed presentation
start; APIs that consume source presentation timestamps receive that origin
exactly once.

Before every sequential push, DPlayer reports the unchanged HTML media clock
through `setMsePlaybackPosition`. Parser prefetch may retain a future damage
authorization, but it cannot seek over healthy media before playback reaches
the damaged span. Automatic recovery remains selected-layer-only, waits for a
real media `waiting` event plus 0.5 seconds of common buffered A/V at the mapped
recovery point, and executes once.

For `video.type: "tlv"`, DPlayer consumes tlvdemux's `onPlaybackDamage`
callback as the canonical source-damage signal.

- Every callback is observable as `tlv_playback_damage` with the complete
  `TLVPlaybackDamage` payload and stable `TLV_SOURCE_DAMAGE` code.
- A severe recovered interval is announced immediately, but receipt of the
  callback never moves playback by itself. DPlayer moves to the recovery point
  only after the media element emits `waiting`, the user is not paused or
  seeking, and at least 0.5 seconds of common audio/video data is buffered at
  the recovery point.
- A severe interval without a recovery point remains observable as an honest
  waiting state for live playback or an unrecoverable-tail state for a
  recording. Warning-only intervals remain observable without interrupting the
  viewer.
- DPlayer's TLV core never invents or automatically renders TLV damage/error
  copy and never creates a damage overlay. The host application owns
  presentation and consumes `tlv_playback_damage` / `tlv_error`; HonomiTV
  generates the human-facing copy and explicitly displays it through the
  current DPlayer instance's public `notice()` API (the lower-left in-player
  notice). HonomiTV's global Snackbar/Toast is not used for TLV failures.
- The host-facing event remains complete: UI ownership must not discard the
  damage action, severity, offsets, timestamps, recovery point, or stable error
  code. Human-facing copy names what failed, explains the consequence, and
  gives the next action without exposing buffering and recovery internals.
- Damage state is scoped to one TLV playback generation and selected video
  layer. Restarting, seeking through the TLV loader, changing the video layer,
  switching source, or destroying the player clears it.
- HonomiTV deduplicates repeated notifications from one playback generation so
  a single damaged interval cannot repeatedly replace the in-player notice.
  Restarting the player starts a new notification generation.

Automatic rain-broadcast layer selection is a separate mechanism. A layer
switch must not be reported as source-damage recovery, and source damage must
not fabricate a rain-broadcast switch.
