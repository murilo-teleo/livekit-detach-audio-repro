# Detached remote audio keeps playing in Chrome

Reproduction for [livekit/client-sdk-js#620](https://github.com/livekit/client-sdk-js/issues/620).
Fix proposed in [livekit/client-sdk-js#2234](https://github.com/livekit/client-sdk-js/pull/2234).

In Chrome, a remote audio track keeps playing after `track.detach(element)` while another remote
audio element in the page is still playing. `detachTrack` removes the track from the element's
`MediaStream` and only then sets `srcObject` to `null`. When an element stops, Chrome silences only
the tracks still in its stream, so the removed track keeps its playout volume and plays whatever
packets arrive. With no other remote audio playing, Chrome stops playout altogether, which is why the
bug is easy to miss with a single remote track. Firefox and WebKit on iPadOS aren't affected.

The script joins three participants to a room, each in its own browser context:

- `sandbox` and `client` each publish a steady sine tone as their microphone (440 Hz and 660 Hz).
- `listener` subscribes to both and renders each remote audio track with the same calls as
  components-react's `<RoomAudioRenderer>` / `<AudioTrack>`: it appends an `<audio>` element to a
  hidden div and calls `track.attach(element)`
  ([AudioTrack.tsx](https://github.com/livekit/components-js/blob/9cfeb0c492669401242ebcd7828a7dc832b1ae59/packages/react/src/components/participant/AudioTrack.tsx#L87),
  [useMediaTrackBySourceOrName.ts](https://github.com/livekit/components-js/blob/9cfeb0c492669401242ebcd7828a7dc832b1ae59/packages/react/src/hooks/useMediaTrackBySourceOrName.ts#L52-L70)).

The listener then stops rendering the sandbox audio, again with the same calls as an `<AudioTrack>`
unmount: it removes the `<audio>` element from the DOM and calls `track.detach(element)`. The
listener stays subscribed and the sandbox keeps publishing, as when an app hides a screen share or a
shared activity. These calls are in [participant.js](participant.js).

To tell whether the track is still played out, the script reads the listener's `inbound-rtp` stats
for it. Chrome measures `totalAudioEnergy` after the receiver's output gain, which follows the
`<audio>` elements playing the track, and `totalSamplesDuration` counts the samples pulled for
playout. Firefox measures them before playout, so they keep growing after a detach either way: this
check only works in Chrome. To test another browser, [listen](#test-any-browser-by-ear).

| Scenario | What it does | Chromium 151 |
| -- | -- | -- |
| `other-audio-playing` | stop rendering the sandbox audio while the client audio keeps playing | still played at full level |
| `no-other-audio` | the same with no client, so nothing else is playing | silent: playout stops |
| `srcObject-cleared-first` | `other-audio-playing`, setting `srcObject` to `null` before `detach` (the proposed fix) | silent: played at level 0 |

## Run

Start a local LiveKit server. On Linux:

```bash
docker run --rm --network host livekit/livekit-server --dev --bind 127.0.0.1
```

With Docker Desktop (macOS, Windows), map the ports instead:

```bash
docker run --rm -p 7880:7880 -p 7881:7881 -p 7882:7882/udp livekit/livekit-server --dev --bind 0.0.0.0 --node-ip 127.0.0.1
```

Then:

```bash
npm install
npx playwright install chromium
node repro.mjs
```

Output with livekit-client 2.23.0, livekit-server 1.13.11 and Playwright's Chromium 151:

```
other-audio-playing: stop rendering the sandbox audio while the client audio keeps playing
  sandbox while rendered:       level 0.303, 151 packets, 3.0 s pulled for playout
  sandbox after stopRendering:  level 0.303, 250 packets, 5.0 s pulled for playout
  client meanwhile:             level 0.307, 250 packets, 5.0 s pulled for playout
  => the sandbox audio is still played out after detach

no-other-audio: stop rendering the sandbox audio when nothing else is playing
  sandbox while rendered:       level 0.303, 151 packets, 3.0 s pulled for playout
  sandbox after stopRendering:  level 0.000, 250 packets, 0.0 s pulled for playout
  => the sandbox audio stopped

srcObject-cleared-first: same as other-audio-playing, with srcObject cleared before detach (the fix)
  sandbox while rendered:       level 0.303, 150 packets, 3.0 s pulled for playout
  sandbox after stopRendering:  level 0.000, 250 packets, 5.0 s pulled for playout
  client meanwhile:             level 0.307, 250 packets, 5.0 s pulled for playout
  => the sandbox audio stopped
```

## Test any browser by ear

```bash
node repro.mjs --listen
```

This publishes the tones from headless Chromium, the sandbox's one beeping on and off, and prints a
link to [listen.html](listen.html) with a token that can only subscribe in that room for 2 hours.
Open the link in the browser to test, one browser at a time, and follow the steps on the page:

1. **Start** plays the low beeping and the steady high tone.
2. **Stop the beeping with livekit's detach()**: in Chrome the beeping keeps going. In an unaffected
   browser it stops.
3. **Play the beeping again**.
4. **Stop the beeping with srcObject cleared first** (the proposed fix): the beeping stops.

The page plays and stops the tones with the same calls as the script, from `participant.js`, and
loads livekit-client 2.23.0 from jsDelivr.

The link printed for "this computer" is served from `127.0.0.1`. To test on a phone or a tablet,
use the hosted copy of the page and a LiveKit server it can reach over `wss://`, such as a
[LiveKit Cloud](https://cloud.livekit.io) project:

```bash
LISTEN_PAGE=https://murilo-teleo.github.io/livekit-detach-audio-repro/listen.html \
LIVEKIT_URL=wss://<project>.livekit.cloud LIVEKIT_API_KEY=<key> LIVEKIT_API_SECRET=<secret> \
node repro.mjs --listen
```

| Browser | livekit's detach() | srcObject cleared first |
| -- | -- | -- |
| Chromium 151 (Linux) | keeps playing | stops |
| Firefox 159 (Linux) | stops | stops |
| Safari, Chrome and Brave on iPadOS (all WebKit) | stops | stops |

Firefox was checked by ear and by recording its audio output, the iPad by ear.

## Options

Environment variables:

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` point it at another server (defaults:
  `ws://127.0.0.1:7880`, `devkey`, `secret`).
- `LK_CLIENT_UMD` loads another build of livekit-client in the script's participants, such as a
  local `client-sdk-js` with the fix:
  `LK_CLIENT_UMD=../client-sdk-js/dist/livekit-client.umd.js node repro.mjs`. listen.html always
  loads 2.23.0.
- `SCENARIOS` runs only some of them, for example `SCENARIOS=other-audio-playing`.
- `HEADED=1` opens visible windows with sound, so you can hear the 440 Hz tone keep playing after
  the sandbox audio stops being rendered.
- `LISTEN_PAGE` adds a link to a hosted copy of listen.html to the `--listen` output, with a QR
  code to open it on a phone or a tablet.

## Related

- [Chromium issue 41336384](https://issues.chromium.org/issues/41336384) (crbug 749928): an audio
  track removed from an element's `srcObject` keeps playing. Reported in 2017, closed as obsolete in a
  2020 cleanup without a fix.
- [twilio/twilio-video.js#140](https://github.com/twilio/twilio-video.js/issues/140): the same
  behavior in Twilio's SDK, worked around by clearing `srcObject`.
