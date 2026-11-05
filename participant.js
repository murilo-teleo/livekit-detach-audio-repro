// The participant code shared by index.html (driven by repro.mjs) and listen.html (driven by hand).
// It expects the livekit-client UMD bundle (global LivekitClient) and a #audio-renderer element.
const { Room, Track } = LivekitClient;

window.join = async ({ url, token, autoSubscribe }) => {
	window.room = new Room();
	await room.connect(url, token, { autoSubscribe });
};

// Publishes a sine tone as the microphone, so no real microphone is needed. With beep, the tone
// turns on and off every quarter second, which is easy to pick out by ear.
window.publishTone = async ({ frequency, name, beep = false }) => {
	const context = new AudioContext();
	await context.resume();
	const oscillator = new OscillatorNode(context, { frequency });
	const gain = new GainNode(context, { gain: 0.3 });
	if (beep) {
		// A 2 Hz square wave moves the gain between 0 and 0.3.
		gain.gain.value = 0.15;
		const beeper = new OscillatorNode(context, { type: 'square', frequency: 2 });
		beeper.connect(new GainNode(context, { gain: 0.15 })).connect(gain.gain);
		beeper.start();
	}
	const destination = context.createMediaStreamDestination();
	oscillator.connect(gain).connect(destination);
	oscillator.start();
	const [mediaStreamTrack] = destination.stream.getAudioTracks();
	await room.localParticipant.publishTrack(mediaStreamTrack, {
		name,
		source: Track.Source.Microphone,
	});
};

const remoteAudioTrack = (identity) =>
	room.remoteParticipants.get(identity)?.getTrackPublication(Track.Source.Microphone)?.audioTrack;

window.hasAudioTrack = (identity) => remoteAudioTrack(identity) !== undefined;

const elements = new Map();

// The same calls as components-react's <AudioTrack> on mount: React renders the <audio>
// element, then the effect in useMediaTrackBySourceOrName calls track.attach(element).
// https://github.com/livekit/components-js/blob/9cfeb0c492669401242ebcd7828a7dc832b1ae59/packages/react/src/components/participant/AudioTrack.tsx#L87
// https://github.com/livekit/components-js/blob/9cfeb0c492669401242ebcd7828a7dc832b1ae59/packages/react/src/hooks/useMediaTrackBySourceOrName.ts#L52-L70
window.render = (identity) => {
	const element = document.createElement('audio');
	document.getElementById('audio-renderer').append(element);
	remoteAudioTrack(identity).attach(element);
	elements.set(identity, element);
};

// The same calls as components-react's <AudioTrack> on unmount: React removes the <audio>
// element from the DOM, then the cleanup of that effect calls track.detach(element).
// The track stays subscribed and its publisher keeps sending.
// clearSrcObjectFirst is what the proposed detachTrack fix does before removeTrack.
window.stopRendering = (identity, { clearSrcObjectFirst = false } = {}) => {
	const element = elements.get(identity);
	element.remove();
	if (clearSrcObjectFirst) {
		element.srcObject = null;
	}
	remoteAudioTrack(identity).detach(element);
	elements.delete(identity);
};

// The receiver's inbound-rtp stats. Chrome measures totalAudioEnergy after the receiver's
// output gain, which follows the <audio> elements playing the track, so energy that keeps
// growing after stopRendering means the track is still being played out. Firefox measures it
// before playout, so there it keeps growing either way.
window.receiverStats = async (identity) => {
	const report = await remoteAudioTrack(identity).receiver.getStats();
	for (const stats of report.values()) {
		if (stats.type === 'inbound-rtp') {
			return {
				packetsReceived: stats.packetsReceived,
				totalAudioEnergy: stats.totalAudioEnergy,
				totalSamplesDuration: stats.totalSamplesDuration,
			};
		}
	}
};
