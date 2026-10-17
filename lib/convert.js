// Document -> PDF.
//  - .txt is converted right here (no outside service, no cost).
//  - .docx / .doc / .html / .rtf / .odt go through ConvertAPI (key held in CONVERTAPI_SECRET on Render).
const { ApiError } = require("./errors");

// Helvetica character widths (1/1000 em) for ASCII 32..126, used to wrap lines.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
  334, 260, 334, 584];

// Characters outside plain ASCII that the built-in PDF font can show (Windows-1252 codes).
const CP1252 = { "\u2018": 0x91, "\u2019": 0x92, "\u201C": 0x93, "\u201D": 0x94, "\u2013": 0x96, "\u2014": 0x97,
  "\u2022": 0x95, "\u2026": 0x85, "\u20AC": 0x80, "\u20A6": 0x4E /* naira -> N */ };

function code(ch) {
  const c = ch.codePointAt(0);
  if (c >= 32 && c <= 126) return c;
  if (c >= 0xA0 && c <= 0xFF) return c;
  return CP1252[ch] || 63; // '?'
}
const widthOf = (ch) => (code(ch) >= 32 && code(ch) <= 126 ? HELV[code(ch) - 32] : 556);

/** Plain text -> a simple, readable PDF (A4, Helvetica 11pt). */
function textToPdf(text) {
  const PAGE_W = 595.28, PAGE_H = 841.89, M = 56, SIZE = 11, LEAD = 15;
  const maxW = (PAGE_W - 2 * M) * 1000 / SIZE;
  const measure = (s) => { let w = 0; for (const ch of s) w += widthOf(ch); return w; };

  const lines = [];
  for (const para of String(text).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n")) {
    if (!para.trim()) { lines.push(""); continue; }
    let cur = "", curW = 0;
    for (const tok of para.match(/\s+|\S+/g)) {
      const w = measure(tok);
      if (curW + w <= maxW) { cur += tok; curW += w; continue; }
      if (/^\s+$/.test(tok)) { lines.push(cur.trimEnd()); cur = ""; curW = 0; continue; }
      if (cur.trim()) { lines.push(cur.trimEnd()); cur = ""; curW = 0; }
      if (w <= maxW) { cur = tok; curW = w; continue; }
      for (const ch of tok) {                      // a single very long word: break it
        const cw = widthOf(ch);
        if (curW + cw > maxW) { lines.push(cur); cur = ""; curW = 0; }
        cur += ch; curW += cw;
      }
    }
    lines.push(cur.trimEnd());
  }

  const perPage = Math.floor((PAGE_H - 2 * M) / LEAD);
  const pages = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (!pages.length) pages.push([]);

  const esc = (s) => {
    let out = "";
    for (const ch of s) {
      const c = code(ch);
      out += c === 40 || c === 41 || c === 92 ? "\\" + String.fromCharCode(c) : String.fromCharCode(c);
    }
    return out;
  };

  const objs = [];                                  // objs[n-1] = body of object n
  objs[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  const kids = [];
  pages.forEach((pg, i) => {
    const pageNum = 4 + 2 * i, contentNum = 5 + 2 * i;
    kids.push(`${pageNum} 0 R`);
    let y = PAGE_H - M - SIZE, stream = "";
    for (const line of pg) {
      if (line) stream += `BT /F1 ${SIZE} Tf 1 0 0 1 ${M} ${y.toFixed(2)} Tm (${esc(line)}) Tj ET\n`;
      y -= LEAD;
    }
    objs[pageNum - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`;
    objs[contentNum - 1] = { stream };
  });
  objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;

  const parts = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets = [];
  let pos = parts[0].length;
  objs.forEach((body, i) => {
    offsets.push(pos);
    const buf = typeof body === "string"
      ? Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, "latin1")
      : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< /Length ${Buffer.byteLength(body.stream, "latin1")} >>\nstream\n`, "latin1"),
        Buffer.from(body.stream, "latin1"), Buffer.from("endstream\nendobj\n", "latin1")]);
    parts.push(buf); pos += buf.length;
  });
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += String(o).padStart(10, "0") + " 00000 n \n";
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}

/** Works out the document type from its name and first bytes. Returns null if unsupported. */
function docKind(filename, buf) {
  const ext = String(filename || "").split(".").pop().toLowerCase();
  const head = buf.subarray(0, 8);
  const isZip = head[0] === 0x50 && head[1] === 0x4B;
  const isOle = head[0] === 0xD0 && head[1] === 0xCF && head[2] === 0x11 && head[3] === 0xE0;
  switch (ext) {
    case "txt": return "txt";
    case "html": case "htm": return "html";
    case "docx": return isZip ? "docx" : null;
    case "odt": return isZip ? "odt" : null;
    case "doc": return isOle ? "doc" : (isZip ? "docx" : null);
    case "rtf": return head.toString("latin1").startsWith("{\\rtf") ? "rtf" : null;
    default: return null;
  }
}

async function viaConvertApi(buffer, kind) {
  const secret = process.env.CONVERTAPI_SECRET;
  if (!secret) throw new ApiError(503, "CONVERT_NOT_CONFIGURED", "Online document conversion isn't set up yet. Try a .txt file, or use Convert to PDF on your phone.");

  const form = new FormData();
  form.append("File", new Blob([buffer]), `document.${kind}`);
  let r;
  try {
    r = await fetch(`https://v2.convertapi.com/convert/${kind}/to/pdf`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(100_000),
    });
  } catch (e) {
    console.error("ConvertAPI network error:", e.message);
    throw new ApiError(504, "CONVERT_TIMEOUT", "The converter took too long. Please try again.");
  }
  if (!r.ok) {
    console.error("ConvertAPI error", r.status, (await r.text()).slice(0, 300));
    if (r.status === 401 || r.status === 403 || r.status === 402) {
      throw new ApiError(503, "CONVERT_UNAVAILABLE", "Document conversion is temporarily unavailable. Please try again later.");
    }
    throw new ApiError(422, "CONVERT_FAILED", "We couldn't convert that file. Make sure it opens normally on your phone, then try again.");
  }
  const j = await r.json();
  const f = j && j.Files && j.Files[0];
  if (f && f.FileData) return Buffer.from(f.FileData, "base64");
  if (f && f.Url) {
    const d = await fetch(f.Url, { signal: AbortSignal.timeout(60_000) });
    if (d.ok) return Buffer.from(await d.arrayBuffer());
  }
  throw new ApiError(502, "CONVERT_EMPTY", "The converter returned nothing. Please try again.");
}

async function convertToPdf({ buffer, kind }) {
  if (kind === "txt") {
    let text = buffer.toString("utf8");
    if ((text.match(/\uFFFD/g) || []).length > text.length * 0.01) text = buffer.toString("latin1");
    return textToPdf(text);
  }
  return viaConvertApi(buffer, kind);
}

module.exports = { convertToPdf, docKind, textToPdf };
