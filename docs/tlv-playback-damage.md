# TLV playback damage contract

For `video.type: "tlv"`, DPlayer consumes tlvdemux's `onPlaybackDamage`
callback as the canonical source-damage signal.

- Every callback is observable as `tlv_playback_damage` with the complete
  `TLVPlaybackDamage` payload and stable `TLV_SOURCE_DAMAGE` code.
- A severe recovered interval is announced immediately, but receipt of the
  callback never moves playback by itself. DPlayer moves to the recovery point
  only after the media element emits `waiting`, the user is not paused or
  seeking, and at least 0.5 seconds of common audio/video data is buffered at
  the recovery point.
- A severe interval without a recovery point remains visible as an honest
  waiting state for live playback or an unrecoverable-tail state for a
  recording. Warning-only intervals remain observable without interrupting the
  viewer.
- User-facing copy stays brief: it names the damaged recording or stream, says
  whether playback will skip, wait, or stop, and preserves the stable error
  code. It never names DPlayer or exposes buffering and recovery internals.
- Damage state is scoped to one TLV playback generation and selected video
  layer. Restarting, seeking through the TLV loader, changing the video layer,
  switching source, or destroying the player clears it.
- The damage notice has an always-allocated, non-interactive overlay slot.
  Empty, warning, recoverable, waiting, recovered, and terminal states do not
  move the video, subtitles, controller, or focus targets. The recovered state
  clears the slot's text after playback has resumed.

Automatic rain-broadcast layer selection is a separate mechanism. A layer
switch must not be reported as source-damage recovery, and source damage must
not fabricate a rain-broadcast switch.
