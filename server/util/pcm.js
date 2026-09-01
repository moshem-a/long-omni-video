// Wrap raw PCM (signed 16-bit little-endian) in a minimal WAV container so the
// browser and ffmpeg can read Gemini's TTS output directly.
export function wrapWavHeader(pcm, sampleRate = 24000, channels = 1, bits = 16) {
  const blockAlign = (channels * bits) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // audio format = PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  pcm.copy(buf, 44);
  return buf;
}

// Duration of raw PCM in seconds.
export function pcmDurationSec(pcm, sampleRate = 24000, channels = 1, bits = 16) {
  const bytesPerSample = (channels * bits) / 8;
  return pcm.length / (sampleRate * bytesPerSample);
}
