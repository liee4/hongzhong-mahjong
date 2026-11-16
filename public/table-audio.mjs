const callSounds = { pung: 'pung', kong: 'kong', exposedKong: 'kong', concealedKong: 'kong', addedKong: 'kong', hu: 'hu' };
const words = { pung: '碰', kong: '杠', hu: '胡' };
const effectNames = ['discard', 'pung', 'kong', 'hu'];
const defaultVolume = 40;
const clampVolume = value => Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : defaultVolume;
const musicGainFor = volume => volume * 55 / 10_000;

export function createTableAudio(initial = {}, env = globalThis) {
  let settings = { music: initial.music !== false, musicVolume: clampVolume(initial.musicVolume), effects: initial.effects !== false, voice: initial.voice !== false };
  let inRoom = false;
  let context;
  let musicGain;
  let effectsGain;
  let musicSource;
  let startingMusic = false;
  let resuming;
  const clips = new Map();

  function load(name) {
    if (!clips.has(name)) {
      const loaded = env.fetch(`/audio/${name}.wav`)
        .then(response => {
          if (!response.ok) throw new Error(`Audio unavailable: ${name}`);
          return response.arrayBuffer();
        })
        .then(bytes => context.decodeAudioData(bytes))
        .catch(() => { clips.delete(name); return null; });
      clips.set(name, loaded);
    }
    return clips.get(name);
  }

  function createSource(buffer, gain, loop = false) {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.connect(gain);
    source.start();
    return source;
  }

  function syncMusic() {
    if (!inRoom || !settings.music) {
      if (musicSource) { musicSource.stop(); musicSource = null; }
      return;
    }
    if (context?.state !== 'running' || musicSource || startingMusic) return;
    startingMusic = true;
    void load('music').then(buffer => {
      startingMusic = false;
      if (buffer && inRoom && settings.music && context.state === 'running') {
        musicSource = createSource(buffer, musicGain, true);
      }
    });
  }

  function unlock() {
    if (!settings.music && !settings.effects) return;
    const Audio = env.AudioContext ?? env.webkitAudioContext;
    if (!Audio) return;
    if (!context) {
      try { context = new Audio(); } catch { return; }
      musicGain = context.createGain();
      musicGain.gain.value = musicGainFor(settings.musicVolume);
      musicGain.connect(context.destination);
      effectsGain = context.createGain();
      effectsGain.gain.value = settings.effects ? 0.55 : 0;
      effectsGain.connect(context.destination);
    }
    if (settings.effects) for (const name of effectNames) void load(name);
    if (context.state === 'running') syncMusic();
    else if (context.state !== 'closed' && !resuming) {
      resuming = context.resume().then(syncMusic).catch(() => {}).finally(() => { resuming = undefined; });
    }
  }

  function playEffect(name) {
    if (!settings.effects || !context) return;
    void Promise.all([load(name), resuming]).then(([buffer]) => {
      if (buffer && settings.effects && context.state === 'running') createSource(buffer, effectsGain);
    });
  }

  function playVoice(name) {
    const synthesizer = env.speechSynthesis;
    if (!settings.voice || !words[name] || !synthesizer || !env.SpeechSynthesisUtterance) return;
    try {
      const voices = synthesizer.getVoices();
      const mandarin = voices.filter(voice => /^(?:cmn(?:[-_].*)?|zh(?:[-_]Hans)?[-_](?:CN|SG)|zh(?:[-_]Hant)?[-_]TW|zh|zh[-_]Hans)$/i.test(voice.lang));
      const chosen = mandarin.find(voice => voice.localService && /^zh[-_]CN$/i.test(voice.lang)) ??
        mandarin.find(voice => voice.localService) ?? mandarin[0];
      if (!chosen && voices.length) return;
      const utterance = new env.SpeechSynthesisUtterance(words[name]);
      utterance.lang = chosen?.lang ?? 'zh-CN';
      if (chosen) utterance.voice = chosen;
      utterance.rate = 1.06;
      utterance.volume = 0.9;
      synthesizer.speak(utterance);
    } catch { /* Speech availability is independent of play and the recorded cues. */ }
  }

  return {
    unlock,
    preferences: () => ({ ...settings }),
    configure(next) {
      settings = { ...settings, ...next };
      settings.musicVolume = clampVolume(settings.musicVolume);
      if (musicGain) musicGain.gain.value = musicGainFor(settings.musicVolume);
      if (effectsGain) effectsGain.gain.value = settings.effects ? 0.55 : 0;
      if (!settings.voice) env.speechSynthesis?.cancel();
      unlock();
      syncMusic();
    },
    setInRoom(active) {
      inRoom = active;
      if (!inRoom) env.speechSynthesis?.cancel();
      syncMusic();
    },
    playAction(type) {
      const name = callSounds[type];
      if (!name) return;
      playEffect(name);
      playVoice(name);
    },
    receive(view, previous) {
      const event = view.event;
      if (!previous || !Number.isInteger(event?.id) || event.id === previous.event?.id) return;
      if (event.type === 'discard') playEffect('discard');
      else if (event.seat !== view.seat && !event.seats?.includes(view.seat)) {
        const name = callSounds[event.type];
        if (name) { playEffect(name); playVoice(name); }
      }
    },
  };
}
