// Screenshot guide: one folder per guide. After every shot the HTML page and the Word file are rebuilt.
//
//   Guide_2026-10-27_22-40-01\
//     Step 01 - Outlook.png      screenshot with the caption printed at the bottom
//     guide.html                 all steps in one page (images inside, so it is one file to share)
//     guide.docx                 the same as a Word document
//     images\step-01.png         screenshot without caption (used by the HTML and Word files)
//     guide.json                 list of steps, so the guide can carry on after a restart

const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel } = require('docx');

const pad = (n) => String(n).padStart(2, '0');

function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function niceTime(d = new Date()) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}  ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const safeName = (s) => s.replace(/[\\/:*?"<>|]/g, '').trim();
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function stepTitle(step) {
  return step.app ? `Step ${step.n} - ${step.app}` : `Step ${step.n}`;
}

function read(folder) {
  if (!folder) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(folder, 'guide.json'), 'utf8'));
  } catch {
    return null;
  }
}

// Short info for the control bar. null when there is no guide yet.
function info(folder) {
  const g = read(folder);
  return g ? { folder, name: path.basename(folder), count: g.steps.length } : null;
}

function nextStep(folder) {
  const g = read(folder);
  return g ? g.steps.length + 1 : 1;
}

// PNG width/height straight from the file header.
function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Same colours as the FocusRec control bar (SC blue, green, navy on light grey).
function buildHtml(folder, g) {
  const steps = g.steps.map((s) => {
    const data = fs.readFileSync(path.join(folder, s.image)).toString('base64');
    return `  <section class="step">
    <div class="num">Step ${s.n}</div>
    <h2>${escapeHtml(s.app || 'Screenshot')}</h2>
    <div class="time">${escapeHtml(s.time)}</div>
    <img src="data:image/png;base64,${data}" alt="${escapeHtml(stepTitle(s))}">
  </section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(g.title)}</title>
<style>
  body { margin: 0; background: #F5F7FA; color: #1A2433; font: 14px/1.5 "Segoe UI", -apple-system, Arial, sans-serif; }
  .strip { height: 3px; background: linear-gradient(90deg, #0473EA 0%, #0473EA 60%, #38D200 100%); }
  header { background: #FFFFFF; border-bottom: 1px solid #E3E8EF; }
  header .in, main { max-width: 1000px; margin: 0 auto; padding: 0 16px; }
  header .in { padding-top: 20px; padding-bottom: 18px; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; color: #0B1F3A; }
  .meta { color: #5F6B7A; }
  main { padding-top: 24px; padding-bottom: 32px; }
  .step { background: #FFFFFF; border: 1px solid #E3E8EF; border-radius: 8px; padding: 18px; margin-bottom: 20px; break-inside: avoid; }
  .num { color: #0473EA; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
  .step h2 { font-size: 17px; font-weight: 600; margin: 2px 0 2px; color: #0B1F3A; }
  .time { color: #5F6B7A; font-size: 12px; margin-bottom: 12px; }
  .step img { display: block; width: 100%; height: auto; border: 1px solid #E3E8EF; border-radius: 6px; }
  @media print { body { background: #fff; } main { padding-top: 12px; } .step { border: 0; padding: 0; } }
</style>
</head>
<body>
<div class="strip"></div>
<header><div class="in">
  <h1>${escapeHtml(g.title)}</h1>
  <div class="meta">${g.steps.length} step${g.steps.length === 1 ? '' : 's'} &middot; made with FocusRec</div>
</div></header>
<main>
${steps}
</main>
</body>
</html>
`;
}

async function buildDocx(folder, g) {
  const pageWidth = 640;   // pixels at 96 dpi, fits A4 and Letter with the margins below
  const children = [
    new Paragraph({ text: g.title, heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [new TextRun({ text: `${g.steps.length} steps - made with FocusRec`, color: '5F6B7A' })],
      border: { bottom: { color: '0473EA', space: 6, style: 'single', size: 12 } },
    }),
  ];
  for (const s of g.steps) {
    const data = fs.readFileSync(path.join(folder, s.image));
    const { width, height } = pngSize(data);
    children.push(
      new Paragraph({ text: stepTitle(s), heading: HeadingLevel.HEADING_2, keepNext: true }),
      new Paragraph({ children: [new TextRun({ text: s.time, color: '5F6B7A', size: 18 })], keepNext: true }),
      new Paragraph({
        children: [new ImageRun({
          type: 'png',
          data,
          transformation: { width: pageWidth, height: Math.round(pageWidth * height / width) },
          altText: { name: stepTitle(s), description: stepTitle(s), title: stepTitle(s) },
        })],
      }),
    );
  }
  const doc = new Document({
    creator: 'FocusRec',
    title: g.title,
    styles: {
      default: {
        document: { run: { font: 'Segoe UI', size: 21, color: '1A2433' } },
        title: { run: { font: 'Segoe UI', size: 44, bold: true, color: '0B1F3A' } },
        heading2: { run: { font: 'Segoe UI', size: 28, bold: true, color: '0473EA' }, paragraph: { spacing: { before: 360, after: 40 } } },
      },
    },
    sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } }, children }],
  });
  return Packer.toBuffer(doc);
}

// Add one screenshot. Starts a new guide folder when there is none. Returns info() of the guide.
async function addStep(folder, outputDir, shot) {
  let g = read(folder);
  if (!g) {
    folder = path.join(outputDir, `Guide_${stamp()}`);
    g = { title: `Guide - ${niceTime().replace(/:\d\d$/, '')}`, steps: [] };
  }
  fs.mkdirSync(path.join(folder, 'images'), { recursive: true });

  const n = g.steps.length + 1;
  const step = { n, app: shot.app || null, time: shot.time, image: `images/step-${pad(n)}.png` };
  const pngName = safeName(`${stepTitle(step)}.png`).replace(/^Step (\d+)/, (_m, d) => `Step ${pad(Number(d))}`);
  step.png = pngName;

  fs.writeFileSync(path.join(folder, step.image), Buffer.from(shot.marked));
  fs.writeFileSync(path.join(folder, pngName), Buffer.from(shot.captioned));
  g.steps.push(step);
  fs.writeFileSync(path.join(folder, 'guide.json'), JSON.stringify(g, null, 2));

  fs.writeFileSync(path.join(folder, 'guide.html'), buildHtml(folder, g));
  try {
    fs.writeFileSync(path.join(folder, 'guide.docx'), await buildDocx(folder, g));
  } catch (err) {
    // Word open with the file locked: keep going, it is rebuilt on the next shot.
    if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
  }
  return { ...info(folder), step: n };
}

module.exports = { addStep, info, nextStep, niceTime };
