// mp4fix: turn the "fragmented" MP4 that Chromium records into a normal MP4.
// Windows Explorer, PowerPoint and older players need the normal layout to show the right
// length and to seek. The audio/video bytes are copied as they are - nothing is re-encoded.
//
// Fragmented:  ftyp | moov (empty index) | moof mdat | moof mdat | ...
// Normal:      ftyp | moov (full index)  | mdat (all the data)

const fs = require('fs');

const COPY_CHUNK = 4 * 1024 * 1024;
const NON_SYNC = 0x10000;   // sample flag: "not a key frame"

// ---------- reading boxes ----------

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  if (bytesRead !== len) throw new Error('unexpected end of file');
  return buf;
}

// Top-level boxes of the file, without loading the big mdat payloads.
async function scanTopLevel(fh, fileSize) {
  const boxes = [];
  let pos = 0;
  while (pos + 8 <= fileSize) {
    const h = await readAt(fh, pos, Math.min(16, fileSize - pos));
    let size = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    let hdr = 8;
    if (size === 1) { size = Number(h.readBigUInt64BE(8)); hdr = 16; }
    else if (size === 0) size = fileSize - pos;
    if (size < hdr || pos + size > fileSize) throw new Error(`bad box ${type} at ${pos}`);
    boxes.push({ type, pos, size, hdr });
    pos += size;
  }
  return boxes;
}

// Child boxes inside a buffer.
function children(buf, start, end) {
  const list = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(pos + 8)); hdr = 16; }
    else if (size === 0) size = end - pos;
    if (size < hdr || pos + size > end) throw new Error(`bad box ${type}`);
    list.push({ type, start: pos, end: pos + size, body: pos + hdr });
    pos += size;
  }
  return list;
}

const find = (list, type) => {
  const b = list.find((x) => x.type === type);
  if (!b) throw new Error(`missing ${type}`);
  return b;
};

// ---------- writing boxes ----------

function box(type, ...parts) {
  const head = Buffer.alloc(8);
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  head.writeUInt32BE(size, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, ...parts]);
}

function fullBox(type, version, flags, ...parts) {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE(((version << 24) | flags) >>> 0, 0);
  return box(type, vf, ...parts);
}

// Table of fixed-width rows: [count][row][row]...
function table(rows, width, writeRow) {
  const b = Buffer.alloc(4 + rows.length * width);
  b.writeUInt32BE(rows.length, 0);
  rows.forEach((r, i) => writeRow(b, 4 + i * width, r));
  return b;
}

const slice = (buf, b) => Buffer.from(buf.subarray(b.start, b.end));

// Copy of tkhd / mdhd / mvhd with a new duration written in.
function withDuration(buf, b, value) {
  const copy = slice(buf, b);
  const rel = b.body - b.start;
  const v1 = copy[rel] === 1;
  const off = rel + (b.type === 'tkhd' ? (v1 ? 28 : 20) : (v1 ? 24 : 16));
  if (v1) copy.writeBigUInt64BE(BigInt(Math.round(value)), off);
  else copy.writeUInt32BE(Math.min(Math.round(value), 0xffffffff), off);
  return copy;
}

// ---------- parsing the fragments ----------

function parseMoov(buf, hdr) {
  const top = children(buf, hdr, buf.length);
  const mvhd = find(top, 'mvhd');
  const movieScale = buf.readUInt32BE(mvhd.body + (buf[mvhd.body] === 1 ? 20 : 12));
  const tracks = new Map();

  for (const trak of top.filter((b) => b.type === 'trak')) {
    const tk = children(buf, trak.body, trak.end);
    const tkhd = find(tk, 'tkhd');
    const id = buf.readUInt32BE(tkhd.body + (buf[tkhd.body] === 1 ? 20 : 12));
    const mdia = find(tk, 'mdia');
    const md = children(buf, mdia.body, mdia.end);
    const mdhd = find(md, 'mdhd');
    const timescale = buf.readUInt32BE(mdhd.body + (buf[mdhd.body] === 1 ? 20 : 12));
    const hdlr = find(md, 'hdlr');
    const minf = find(md, 'minf');
    const mi = children(buf, minf.body, minf.end);
    const stbl = find(mi, 'stbl');
    const stsd = find(children(buf, stbl.body, stbl.end), 'stsd');
    tracks.set(id, {
      id, timescale, tk, tkhd, md, mdhd, mi,
      handler: buf.toString('latin1', hdlr.body + 8, hdlr.body + 12),
      stsd: slice(buf, stsd),
      defaults: { sdi: 1, duration: 0, size: 0, flags: 0 },
      dur: [], size: [], flags: [], cts: [],
      chunks: [],          // { offset, count, bytes } - one per run of samples
      start: null,         // decode time of the first sample
      time: 0,             // decode time reached so far
    });
  }

  const mvex = top.find((b) => b.type === 'mvex');
  if (mvex) {
    for (const trex of children(buf, mvex.body, mvex.end).filter((b) => b.type === 'trex')) {
      const t = tracks.get(buf.readUInt32BE(trex.body + 4));
      if (t) {
        t.defaults = {
          sdi: buf.readUInt32BE(trex.body + 8),
          duration: buf.readUInt32BE(trex.body + 12),
          size: buf.readUInt32BE(trex.body + 16),
          flags: buf.readUInt32BE(trex.body + 20),
        };
      }
    }
  }
  return { top, mvhd, movieScale, tracks };
}

function parseMoof(buf, hdr, moofPos, tracks) {
  for (const traf of children(buf, hdr, buf.length).filter((b) => b.type === 'traf')) {
    const tc = children(buf, traf.body, traf.end);
    const tfhd = find(tc, 'tfhd');
    const flags = buf.readUInt32BE(tfhd.body) & 0xffffff;
    const t = tracks.get(buf.readUInt32BE(tfhd.body + 4));
    if (!t) throw new Error('fragment for unknown track');

    let o = tfhd.body + 8;
    let base = moofPos;
    let { sdi, duration: dDur, size: dSize, flags: dFlags } = t.defaults;
    if (flags & 0x1) { base = Number(buf.readBigUInt64BE(o)); o += 8; }
    if (flags & 0x2) { sdi = buf.readUInt32BE(o); o += 4; }
    if (flags & 0x8) { dDur = buf.readUInt32BE(o); o += 4; }
    if (flags & 0x10) { dSize = buf.readUInt32BE(o); o += 4; }
    if (flags & 0x20) { dFlags = buf.readUInt32BE(o); o += 4; }
    if (sdi !== 1) throw new Error('more than one sample description');

    const tfdt = tc.find((b) => b.type === 'tfdt');
    if (tfdt) {
      const decodeTime = buf[tfdt.body] === 1 ? Number(buf.readBigUInt64BE(tfdt.body + 4)) : buf.readUInt32BE(tfdt.body + 4);
      if (t.start === null) {
        t.start = decodeTime;
        t.time = decodeTime;
      } else if (decodeTime > t.time && t.dur.length) {
        // A gap between fragments: stretch the last sample so the timeline stays right.
        t.dur[t.dur.length - 1] += decodeTime - t.time;
        t.time = decodeTime;
      }
    }
    if (t.start === null) t.start = 0;

    let next = base;
    for (const trun of tc.filter((b) => b.type === 'trun')) {
      const v1 = buf[trun.body] === 1;
      const tf = buf.readUInt32BE(trun.body) & 0xffffff;
      const count = buf.readUInt32BE(trun.body + 4);
      let p = trun.body + 8;
      let offset = next;
      if (tf & 0x1) { offset = base + buf.readInt32BE(p); p += 4; }
      let firstFlags = null;
      if (tf & 0x4) { firstFlags = buf.readUInt32BE(p); p += 4; }

      const chunkStart = offset;
      for (let i = 0; i < count; i++) {
        let d = dDur, s = dSize, f = i === 0 && firstFlags !== null ? firstFlags : dFlags, c = 0;
        if (tf & 0x100) { d = buf.readUInt32BE(p); p += 4; }
        if (tf & 0x200) { s = buf.readUInt32BE(p); p += 4; }
        if (tf & 0x400) { f = buf.readUInt32BE(p); p += 4; }
        if (tf & 0x800) { c = v1 ? buf.readInt32BE(p) : buf.readUInt32BE(p); p += 4; }
        if (!s) throw new Error('sample with no size');
        t.dur.push(d);
        t.size.push(s);
        t.flags.push(f);
        t.cts.push(c);
        t.time += d;
        offset += s;
      }
      if (count) t.chunks.push({ offset: chunkStart, count, bytes: offset - chunkStart });
      next = offset;
    }
  }
}

// ---------- building the new index ----------

function buildStbl(t, chunkOffsets) {
  const n = t.dur.length;

  const stts = [];
  for (const d of t.dur) {
    const last = stts[stts.length - 1];
    if (last && last.d === d) last.c++;
    else stts.push({ c: 1, d });
  }
  const parts = [t.stsd, fullBox('stts', 0, 0, table(stts, 8, (b, o, r) => { b.writeUInt32BE(r.c, o); b.writeUInt32BE(r.d, o + 4); }))];

  if (t.cts.some((c) => c !== 0)) {
    const ctts = [];
    for (const c of t.cts) {
      const last = ctts[ctts.length - 1];
      if (last && last.c === c) last.n++;
      else ctts.push({ n: 1, c });
    }
    const v = t.cts.some((c) => c < 0) ? 1 : 0;
    parts.push(fullBox('ctts', v, 0, table(ctts, 8, (b, o, r) => { b.writeUInt32BE(r.n, o); b.writeInt32BE(r.c, o + 4); })));
  }

  // Key frames list. Left out when every sample is a key frame (normal for audio).
  const sync = [];
  t.flags.forEach((f, i) => { if (!(f & NON_SYNC)) sync.push(i + 1); });
  if (sync.length < n) parts.push(fullBox('stss', 0, 0, table(sync, 4, (b, o, r) => b.writeUInt32BE(r, o))));

  const stsc = [];
  t.chunks.forEach((ch, i) => {
    const last = stsc[stsc.length - 1];
    if (!last || last.per !== ch.count) stsc.push({ first: i + 1, per: ch.count });
  });
  parts.push(fullBox('stsc', 0, 0, table(stsc, 12, (b, o, r) => {
    b.writeUInt32BE(r.first, o); b.writeUInt32BE(r.per, o + 4); b.writeUInt32BE(1, o + 8);
  })));

  const stsz = Buffer.alloc(8 + n * 4);
  stsz.writeUInt32BE(0, 0);
  stsz.writeUInt32BE(n, 4);
  t.size.forEach((s, i) => stsz.writeUInt32BE(s, 8 + i * 4));
  parts.push(fullBox('stsz', 0, 0, stsz));

  parts.push(fullBox('co64', 0, 0, table(chunkOffsets, 8, (b, o, r) => b.writeBigUInt64BE(BigInt(r), o))));
  return box('stbl', ...parts);
}

function buildTrak(buf, t, movieScale, chunkOffsets) {
  const mediaDur = t.dur.reduce((a, b) => a + b, 0);
  const toMovie = (v) => v * movieScale / t.timescale;
  const firstCts = t.cts.length ? t.cts[0] : 0;

  let edts = null;
  if (t.start > 0 || firstCts > 0) {
    const edits = [];
    if (t.start > 0) edits.push([toMovie(t.start), -1]);       // empty edit = start later
    edits.push([toMovie(mediaDur), firstCts]);
    edts = box('edts', fullBox('elst', 0, 0, table(edits, 12, (b, o, [d, m]) => {
      b.writeUInt32BE(Math.round(d), o); b.writeInt32BE(m, o + 4); b.writeInt16BE(1, o + 8); b.writeInt16BE(0, o + 10);
    })));
  }
  const trackDur = toMovie(t.start + mediaDur);

  const minf = box('minf', ...t.mi.map((b) => (b.type === 'stbl' ? buildStbl(t, chunkOffsets) : slice(buf, b))));
  const mdia = box('mdia', ...t.md.map((b) => {
    if (b.type === 'mdhd') return withDuration(buf, b, mediaDur);
    if (b.type === 'minf') return minf;
    return slice(buf, b);
  }));
  const kids = [];
  for (const b of t.tk) {
    if (b.type === 'tkhd') {
      kids.push(withDuration(buf, b, trackDur));
      if (edts) kids.push(edts);
    } else if (b.type === 'mdia') kids.push(mdia);
    else if (b.type !== 'edts') kids.push(slice(buf, b));
  }
  return { trak: box('trak', ...kids), duration: trackDur };
}

// New moov: mvhd with the real length, rebuilt tracks (original order), other boxes kept, mvex dropped.
function buildMoov(buf, info, offsetsFor) {
  let movieDur = 0;
  const traks = [];
  for (const t of info.tracks.values()) {
    const r = buildTrak(buf, t, info.movieScale, offsetsFor(t));
    movieDur = Math.max(movieDur, r.duration);
    traks.push(r.trak);
  }
  const others = info.top.filter((b) => !['mvhd', 'trak', 'mvex'].includes(b.type)).map((b) => slice(buf, b));
  return box('moov', withDuration(buf, info.mvhd, movieDur), ...traks, ...others);
}

// ---------- main entry ----------

// Returns true when a fixed file was written to dst, false when src needs no fixing.
async function fixMp4(src, dst) {
  const fh = await fs.promises.open(src, 'r');
  let out = null;
  try {
    const fileSize = (await fh.stat()).size;
    const top = await scanTopLevel(fh, fileSize);
    const moovBox = top.find((b) => b.type === 'moov');
    if (!moovBox || !top.some((b) => b.type === 'moof')) return false;

    const moovBuf = await readAt(fh, moovBox.pos, moovBox.size);
    const info = parseMoov(moovBuf, moovBox.hdr);

    const mdats = [];
    for (const b of top) {
      if (b.type === 'moof') {
        parseMoof(await readAt(fh, b.pos, b.size), b.hdr, b.pos, info.tracks);
      } else if (b.type === 'mdat') {
        mdats.push({ start: b.pos + b.hdr, size: b.size - b.hdr });
      }
    }
    let joined = 0;
    for (const m of mdats) { m.joined = joined; joined += m.size; }

    // Where each chunk sits inside the joined data.
    const where = (ch) => {
      const m = mdats.find((x) => ch.offset >= x.start && ch.offset + ch.bytes <= x.start + x.size);
      if (!m) throw new Error('sample data outside mdat');
      return m.joined + (ch.offset - m.start);
    };
    for (const t of info.tracks.values()) {
      if (!t.dur.length) throw new Error(`track ${t.id} has no samples`);
      for (const ch of t.chunks) ch.rel = where(ch);
    }

    const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2avc1mp41', 'latin1'));
    const mdatHdr = joined + 8 > 0xffffffff ? Buffer.alloc(16) : Buffer.alloc(8);
    if (mdatHdr.length === 16) { mdatHdr.writeUInt32BE(1, 0); mdatHdr.writeBigUInt64BE(BigInt(joined + 16), 8); }
    else mdatHdr.writeUInt32BE(joined + 8, 0);
    mdatHdr.write('mdat', 4, 'latin1');

    // moov size does not depend on the offset values (co64 is fixed width), so build once to measure.
    const moovSize = buildMoov(moovBuf, info, (t) => t.chunks.map(() => 0)).length;
    const dataStart = ftyp.length + moovSize + mdatHdr.length;
    const moov = buildMoov(moovBuf, info, (t) => t.chunks.map((ch) => dataStart + ch.rel));
    if (moov.length !== moovSize) throw new Error('index size changed');

    out = await fs.promises.open(dst, 'w');
    await out.write(ftyp);
    await out.write(moov);
    await out.write(mdatHdr);
    const chunk = Buffer.alloc(COPY_CHUNK);
    for (const m of mdats) {
      for (let done = 0; done < m.size;) {
        const len = Math.min(COPY_CHUNK, m.size - done);
        const { bytesRead } = await fh.read(chunk, 0, len, m.start + done);
        if (bytesRead !== len) throw new Error('short read');
        await out.write(chunk, 0, len);
        done += len;
      }
    }
    return true;
  } finally {
    await fh.close();
    if (out) await out.close();
  }
}

module.exports = { fixMp4 };
