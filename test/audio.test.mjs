import test from 'node:test';
import assert from 'node:assert/strict';
import { createTableAudio } from '../public/table-audio.mjs';

test('本地点击和对手动作各响一次，音乐和音效可分别关闭', async () => {
  const sounds = [];
  const voices = [];
  let stops = 0;
  const speakers = [{ lang: 'zh-CN', localService: true }];
  const env = {
    AudioContext: class {
      state = 'running';
      destination = {};
      createGain() { return { gain: { value: 0 }, connect() {} }; }
      createBufferSource() {
        return { connect() {}, start() { sounds.push(this.buffer); }, stop() { stops++; } };
      }
      async decodeAudioData(buffer) { return buffer; }
    },
    async fetch(url) { return { ok: true, async arrayBuffer() { return url; } }; },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: { getVoices: () => speakers, speak: line => voices.push(line.text), cancel() {} },
  };
  const audio = createTableAudio({}, env);
  audio.unlock();
  audio.setInRoom(true);
  audio.playAction('pung');
  const ownPung = { seat: 0, event: { id: 1, type: 'pung', seat: 0 } };
  audio.receive(ownPung, { seat: 0, event: null });
  const theirKong = { seat: 0, event: { id: 2, type: 'concealedKong', seat: 1, tile: null } };
  audio.receive(theirKong, ownPung);
  audio.receive(theirKong, theirKong);
  audio.playAction('hu');
  const doubleHu = { seat: 0, event: { id: 3, type: 'hu', seat: 1, seats: [1, 0] } };
  audio.receive(doubleHu, theirKong);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(voices, ['碰', '杠', '胡']);
  assert.deepEqual(sounds.sort(), ['/audio/hu.wav', '/audio/kong.wav', '/audio/music.wav', '/audio/pung.wav']);

  audio.configure({ music: false, effects: false, voice: false });
  audio.receive({ seat: 0, event: { id: 4, type: 'discard', seat: 1 } }, doubleHu);
  audio.playAction('hu');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stops, 1);
  assert.equal(sounds.length, 4);
  assert.equal(voices.length, 3);
});

test('背景音乐音量实时调整且不影响音效音量', () => {
  const gains = [];
  const env = {
    AudioContext: class {
      state = 'running';
      destination = {};
      createGain() {
        const gain = { value: 0 };
        gains.push(gain);
        return { gain, connect() {} };
      }
    },
  };
  const audio = createTableAudio({ effects: false }, env);
  audio.unlock();
  const [music, effects] = gains;
  assert.equal(audio.preferences().musicVolume, 40);
  assert.equal(music.value, 0.22);
  audio.configure({ musicVolume: 70 });
  assert.equal(music.value, 0.385);
  assert.equal(effects.value, 0);
  audio.configure({ musicVolume: -20 });
  assert.equal(music.value, 0);
  audio.configure({ musicVolume: 900 });
  assert.equal(audio.preferences().musicVolume, 100);
  assert.equal(music.value, 0.55);
});
