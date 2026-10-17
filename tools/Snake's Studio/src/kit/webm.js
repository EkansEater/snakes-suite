// Browsers record WebM as a live stream: the file never says how long it is, so players
// show no length and seek badly. withDuration() writes the length into its Info element.

function readVint(b, o, keepMarker = false) {
  const first = b[o];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8) return null;
  let v = keepMarker ? first : first & (0xff >> len);
  for (let i = 1; i < len; i++) v = v * 256 + b[o + i];
  return { v, len };
}
const isUnknown = (b, o, len) => (b[o] & (0xff >> len)) === (0xff >> len) && [...b.subarray(o + 1, o + len)].every((x) => x === 0xff);
function writeSize(b, o, len, value) {
  for (let i = len - 1; i >= 1; i--) { b[o + i] = value % 256; value = Math.floor(value / 256); }
  b[o] = (0x80 >> (len - 1)) | value;
}

/** The WebM with its duration (milliseconds) written in, or as it was if that cannot be done. */
export function withDuration(bytes, ms) {
  const b = bytes;
  const SEGMENT = 0x18538067;
  const INFO = 0x1549a966;
  const DURATION = 0x4489;
  try {
    // EBML header, then the Segment.
    let o = 0;
    const hid = readVint(b, o, true);
    const hsize = readVint(b, o + hid.len);
    o += hid.len + hsize.len + hsize.v;
    const sid = readVint(b, o, true);
    if (sid.v !== SEGMENT) return bytes;
    const segSizeAt = o + sid.len;
    const ssize = readVint(b, segSizeAt);
    const segUnknown = isUnknown(b, segSizeAt, ssize.len);
    let p = segSizeAt + ssize.len;
    // Find Info among the Segment's first children.
    for (let n = 0; n < 8 && p < b.length; n++) {
      const id = readVint(b, p, true);
      const size = readVint(b, p + id.len);
      if (id.v === INFO) {
        const body = p + id.len + size.len;
        const end = body + size.v;
        // Already has a duration?
        for (let q = body; q < end;) {
          const cid = readVint(b, q, true);
          const cs = readVint(b, q + cid.len);
          if (cid.v === DURATION) return bytes;
          q += cid.len + cs.len + cs.v;
        }
        const added = 11; // ID (2) + size (1) + float64 (8)
        if (size.v + added >= 2 ** (7 * size.len) - 1) return bytes; // the size field is too short
        const out = new Uint8Array(b.length + added);
        out.set(b.subarray(0, end));
        const dv = new DataView(out.buffer);
        out[end] = 0x44; out[end + 1] = 0x89; out[end + 2] = 0x88;
        dv.setFloat64(end + 3, ms); // in TimecodeScale units: milliseconds by default
        out.set(b.subarray(end), end + added);
        writeSize(out, p + id.len, size.len, size.v + added);
        if (!segUnknown) writeSize(out, segSizeAt, ssize.len, ssize.v + added);
        return out;
      }
      p += id.len + size.len + size.v;
    }
  } catch { /* leave the file as it is */ }
  return bytes;
}
