const $ = id => document.getElementById(id);
const vf = $('viewfinder');
const setStatus = html => { $('status').innerHTML = html; };

function addHistory(n) {
  const h = $('history');
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const p = document.createElement('div');
  p.className = 'pill' + (n > 0 ? ' hit' : '');
  p.textContent = `${t} — ${n} person${n !== 1 ? 's' : ''}`;
  h.prepend(p);
  if (h.children.length > 8) h.lastChild.remove();
}

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 960 } }
    });
    $('video').srcObject = stream;
    $('captureBtn').disabled = false;
    setStatus('Ready. Press <strong>Capture &amp; Analyze</strong>.');
  } catch (e) {
    setStatus(`❌ Camera error: ${e.message}`);
  }
}

// ─── Non-Maximum Suppression ────────────────────────────────────────────────
// Converts normalizedVertices → {x,y,w,h} rect for easy math
function polyToRect(v) {
  return {
    x: v[0].x, y: v[0].y,
    w: v[2].x - v[0].x,
    h: v[2].y - v[0].y
  };
}

function iou(a, b) {
  const ax2 = a.x + a.w, ay2 = a.y + a.h;
  const bx2 = b.x + b.w, by2 = b.y + b.h;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

// Keeps only the highest-scoring box when overlap > threshold (default 0.3)
function nms(people, iouThreshold = 0.3) {
  // Sort descending by score so best box wins
  const sorted = [...people].sort((a, b) => b.score - a.score);
  const kept = [];

  for (const candidate of sorted) {
    const rect = polyToRect(candidate.boundingPoly.normalizedVertices);
    const overlaps = kept.some(k => {
      const kr = polyToRect(k.boundingPoly.normalizedVertices);
      return iou(rect, kr) > iouThreshold;
    });
    if (!overlaps) kept.push(candidate);
  }

  return kept;
}
// ────────────────────────────────────────────────────────────────────────────

// Guard against double-tap / accidental re-fire
let isAnalyzing = false;

async function capture() {
  if (isAnalyzing) return;

  const key = $('apiKey').value.trim();
  if (!key) { setStatus('⚠ Paste your Google API key above first.'); return; }

  const video = $('video');
  const cap   = $('capture');
  cap.width   = video.videoWidth  || 640;
  cap.height  = video.videoHeight || 480;
  cap.getContext('2d').drawImage(video, 0, 0);

  const b64 = cap.toDataURL('image/jpeg', 0.85).split(',')[1];

  isAnalyzing = true;
  $('captureBtn').disabled = true;
  vf.classList.add('scanning');
  setStatus('Analyzing…');

  try {
    const res = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: { content: b64 },
            features: [{ type: 'OBJECT_LOCALIZATION', maxResults: 20 }]
          }]
        })
      }
    );

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message ?? res.statusText);
    }

    const data = await res.json();
    const objs = data.responses[0]?.localizedObjectAnnotations ?? [];

    // 1. Filter to Person labels only
    const rawPeople = objs.filter(o => o.name === 'Person');

    // 2. Deduplicate overlapping boxes with NMS  ← THE FIX
    const people = nms(rawPeople);

    setStatus(
      people.length
        ? `<span class="count">👤 ${people.length} person${people.length > 1 ? 's' : ''} detected</span>`
        : 'No people detected.'
    );

    drawBoxes(cap, people);
    addHistory(people.length);
    if (people.length > 0) speak(`${people.length} person${people.length > 1 ? 's' : ''} detected`);

  } catch (e) {
    setStatus(`❌ ${e.message}`);
  } finally {
    isAnalyzing = false;
    $('captureBtn').disabled = false;
    vf.classList.remove('scanning');
  }
}

function drawBoxes(srcCanvas, people) {
  const overlay = $('overlay');
  const ctx     = overlay.getContext('2d');

  overlay.width  = srcCanvas.width;
  overlay.height = srcCanvas.height;
  overlay.style.display = 'block';

  ctx.drawImage(srcCanvas, 0, 0);

  people.forEach(p => {
    const v     = p.boundingPoly.normalizedVertices;
    const x     = v[0].x * overlay.width;
    const y     = v[0].y * overlay.height;
    const w     = (v[2].x - v[0].x) * overlay.width;
    const h     = (v[2].y - v[0].y) * overlay.height;
    const score = Math.round(p.score * 100);

    // Bounding box
    ctx.strokeStyle = '#00ff9d';
    ctx.lineWidth   = 2;
    ctx.strokeRect(x, y, w, h);

    // Label background
    const label = `Person ${score}%`;
    ctx.font = 'bold 13px monospace';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0, 255, 157, 0.85)';
    ctx.fillRect(x, y - 22, tw + 10, 20);

    // Label text
    ctx.fillStyle = '#000';
    ctx.fillText(label, x + 5, y - 6);
  });
}

function clearOverlay() {
  const overlay = $('overlay');
  overlay.style.display = 'none';
  overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
  setStatus('Ready. Press <strong>Capture &amp; Analyze</strong>.');
}

function speak(text) {
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.1;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// Auto-start camera on load
startCamera();