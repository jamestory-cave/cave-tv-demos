// A small MP4 reader for the upload checks: walks the box structure and
// reports the container brand, each track's kind and codec, the picture
// size and the duration. Reads structure only, never decodes video. This is
// what lets the Builder say "this is HEVC, the TV needs H.264" and "this
// film has no audio track" without trusting the browser's decoder.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'mvex', 'moof', 'traf']);

function readBoxes(view, start, end, visit, depth = 0) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(view.getUint8(pos + 4), view.getUint8(pos + 5), view.getUint8(pos + 6), view.getUint8(pos + 7));
    let header = 8;
    if (size === 1) {
      // 64-bit size
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) size = end - pos;
    if (size < header) break;
    visit(type, pos, pos + header, Math.min(pos + size, end), depth);
    pos += size;
  }
}

const fourcc = (view, at) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

/**
 * @param {ArrayBuffer} buffer  the whole file, or at least its first few MB
 *        plus (for files with the index at the end) the tail
 * @returns {{brand, compatible: string[], isMP4, moovFirst, duration, tracks: [{kind, codec, width, height}], video, audio}}
 */
export function probeMP4(buffer) {
  const view = new DataView(buffer);
  const result = { brand: '', compatible: [], isMP4: false, moovFirst: null, duration: null, tracks: [], video: null, audio: null, hasMoov: false };
  let firstTop = [];
  let current = null;
  let timescale = null;

  const walk = (start, end, depth) => readBoxes(view, start, end, (type, at, body, boxEnd, d) => {
    if (d === 0) firstTop.push(type);
    if (type === 'ftyp') {
      result.brand = fourcc(view, body);
      for (let p = body + 8; p + 4 <= boxEnd; p += 4) result.compatible.push(fourcc(view, p));
      const brands = [result.brand, ...result.compatible];
      result.isMP4 = brands.some((b) => /^(isom|iso[2-6]|mp41|mp42|avc1|M4V |M4A |mp71|dash)$/.test(b)) && result.brand !== 'qt  ';
      result.isQuickTime = result.brand === 'qt  ';
    } else if (type === 'moov') {
      result.hasMoov = true;
      walkBody(body, boxEnd, d + 1);
    } else if (type === 'mvhd') {
      const version = view.getUint8(body);
      if (version === 1) { timescale = view.getUint32(body + 20); result.duration = Number(view.getBigUint64(body + 24)) / timescale; }
      else { timescale = view.getUint32(body + 12); result.duration = view.getUint32(body + 16) / timescale; }
    } else if (type === 'trak') {
      current = { kind: 'other', codec: '', width: 0, height: 0 };
      result.tracks.push(current);
      walkBody(body, boxEnd, d + 1);
      current = null;
    } else if (type === 'tkhd' && current) {
      const version = view.getUint8(body);
      // v0: flags 4, times 8, id 4, reserved 4, duration 4, reserved 8, layer/alt/volume/reserved 8, matrix 36 -> width at 76
      // v1: times 16 and duration 8 -> width at 88. Width and height are fixed-point 16.16.
      const at = body + (version === 1 ? 88 : 76);
      if (at + 8 <= boxEnd) {
        const w = view.getUint32(at) / 65536, h = view.getUint32(at + 4) / 65536;
        if (w && h && !current.width) { current.width = Math.round(w); current.height = Math.round(h); }
      }
    } else if (type === 'hdlr' && current) {
      const handler = fourcc(view, body + 8);
      current.kind = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : handler === 'text' || handler === 'sbtl' ? 'text' : 'other';
    } else if (type === 'stsd' && current) {
      const entryStart = body + 8;
      if (entryStart + 8 <= boxEnd) {
        current.codec = fourcc(view, entryStart + 4);
        if (current.kind === 'video' && entryStart + 8 + 78 <= boxEnd) {
          // Visual sample entry: 8 header + 6 reserved + 2 data ref + 16 pre-defined/reserved + width(2) height(2)
          const w = view.getUint16(entryStart + 8 + 24), h = view.getUint16(entryStart + 8 + 26);
          if (w && h) { current.width = w; current.height = h; }
        }
        if (current.kind === 'audio' && entryStart + 8 + 28 <= boxEnd) {
          current.channels = view.getUint16(entryStart + 8 + 16);
          current.sampleRate = view.getUint32(entryStart + 8 + 24) / 65536;
        }
      }
    } else if (CONTAINERS.has(type)) {
      walkBody(body, boxEnd, d + 1);
    }
  }, depth);
  const walkBody = (s, e, d) => walk(s, e, d);
  walk(0, buffer.byteLength, 0);

  result.moovFirst = firstTop.includes('moov') && firstTop.includes('mdat') ? firstTop.indexOf('moov') < firstTop.indexOf('mdat') : (firstTop.includes('moov') ? true : null);
  result.video = result.tracks.find((t) => t.kind === 'video') || null;
  result.audio = result.tracks.find((t) => t.kind === 'audio') || null;
  return result;
}

export const CODEC_NAMES = {
  avc1: 'H.264', avc3: 'H.264', hvc1: 'HEVC (H.265)', hev1: 'HEVC (H.265)', dvh1: 'Dolby Vision', dvhe: 'Dolby Vision',
  av01: 'AV1', vp09: 'VP9', mp4v: 'MPEG-4 Part 2', apch: 'ProRes 422 HQ', apcn: 'ProRes 422', apcs: 'ProRes LT', ap4h: 'ProRes 4444', jpeg: 'Motion JPEG',
  mp4a: 'AAC', 'ac-3': 'Dolby Digital', 'ec-3': 'Dolby Digital Plus', alac: 'Apple Lossless', lpcm: 'PCM', sowt: 'PCM', twos: 'PCM', Opus: 'Opus', fLaC: 'FLAC',
};
export const codecName = (c) => CODEC_NAMES[c] || (c ? `"${c}"` : 'unknown');
export const isH264 = (c) => c === 'avc1' || c === 'avc3';
export const isAAC = (c) => c === 'mp4a';
