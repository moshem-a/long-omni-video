// AI Video Editor frontend.
// No login: the user pastes their own Gemini API key, which is kept in this
// browser (localStorage) and sent with each request; the server never stores it.
// Flow: key gate -> upload (signed URL to GCS) -> analyze -> review -> voice ->
// options -> render -> download. Steps are freely navigable, and past runs can be
// reopened from History (scoped to this browser) and re-edited / re-rendered.

const DEFAULT_OPTIONS = { burnCaptions: false, musicTrackId: 'none', musicGainDb: -22, videoFitMode: 'stretch' };

const state = {
  mode: 'edit', // 'edit' (upload -> polish) | 'generate' (Omni long video)
  jobId: null,
  analysis: null,
  storyboard: null, // generate: {title, shots:[{id,prompt,narration,durationSec,task,status}]}
  brief: null, // generate: {concept,targetDurationSec,aspectRatio,characterMode,characterDesc,hasCharacter}
  voice: 'Kore',
  options: { ...DEFAULT_OPTIONS },
  job: null, // last fetched public job (status/stage/progress/hasFinal)
  poll: null,
};

const STEP_ORDER_EDIT = ['upload', 'analyze', 'review', 'voice', 'options', 'render', 'done'];
const STEP_ORDER_GEN = ['brief', 'storyboard', 'voice', 'options', 'generate', 'done'];
const RENDER_PHASES = ['planning', 'synthesizing', 'assembling'];
// Generate-mode statuses that mean the background pipeline is still working.
const GEN_ACTIVE = ['storyboarding', 'generating', 'synthesizing', 'assembling'];

// Brief-form selections (mirrored to toggle buttons).
let genAspect = '16:9';
let genCharMode = 'synthetic';

function activeStepOrder() {
  return state.mode === 'generate' ? STEP_ORDER_GEN : STEP_ORDER_EDIT;
}
function prevStep(step) {
  const order = activeStepOrder();
  return order[Math.max(0, order.indexOf(step) - 1)];
}

const $ = (sel) => document.querySelector(sel);
const panels = {};
document.querySelectorAll('[data-panel]').forEach((p) => (panels[p.dataset.panel] = p));

// ---------- View management ----------
// Which steps the user can currently jump to, based on job/analysis state.
function reachable(step) {
  const status = state.job?.status;
  if (state.mode === 'generate') {
    switch (step) {
      case 'brief':
        return true;
      case 'storyboard':
        return Boolean(state.storyboard) || status === 'storyboarding';
      case 'voice':
      case 'options':
      case 'generate':
        return Boolean(state.storyboard);
      case 'done':
        return status === 'done' || Boolean(state.job?.hasFinal);
      default:
        return false;
    }
  }
  switch (step) {
    case 'upload':
      return true;
    case 'analyze':
      return Boolean(state.jobId);
    case 'review':
    case 'voice':
    case 'options':
      return Boolean(state.analysis);
    case 'render':
      return Boolean(state.jobId) && (RENDER_PHASES.includes(status) || status === 'done' || status === 'error');
    case 'done':
      return status === 'done' || Boolean(state.job?.hasFinal);
    default:
      return false;
  }
}

function show(step) {
  // Leaving the key gate / mode chooser behind whenever we enter the wizard.
  $('#gateKey').classList.add('hidden');
  $('#modeChooser').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#steps').classList.toggle('hidden', state.mode !== 'edit');
  $('#stepsGen').classList.toggle('hidden', state.mode !== 'generate');
  Object.values(panels).forEach((p) => p.classList.add('hidden'));
  panels[step]?.classList.remove('hidden');
  // Show only the buttons that belong to the current mode (e.g. render vs generate).
  document.querySelectorAll('[data-mode-only]').forEach((el) => {
    el.classList.toggle('hidden', el.dataset.modeOnly !== state.mode);
  });
  const list = state.mode === 'generate' ? '#stepsGen' : '#steps';
  document.querySelectorAll(`${list} li`).forEach((li) => {
    li.classList.toggle('active', li.dataset.step === step);
    li.classList.toggle('disabled', !reachable(li.dataset.step));
  });
}

// Navigate to a step, preserving edits when leaving Review and restoring UI
// selections when entering Voice/Options.
async function goToStep(step) {
  if (!reachable(step)) return;
  const cur = activePanel();
  if (cur === 'review') captureReviewEdits();
  if (cur === 'storyboard') captureStoryboardEdits();
  clearError();

  if (step === 'review') renderSegments();
  if (step === 'storyboard' && state.storyboard) {
    renderShots();
    $('#sbLoading').classList.add('hidden');
  }
  if (step === 'voice') {
    await loadVoices();
    markSelectedVoice();
  }
  if (step === 'options') applyOptionsToUI();
  if (step === 'done') return showResult();
  show(step);
}

function showGate(name) {
  $('#app').classList.add('hidden');
  $('#steps').classList.add('hidden');
  $('#stepsGen').classList.add('hidden');
  $('#modeChooser').classList.add('hidden');
  $('#gateKey').classList.toggle('hidden', name !== 'key');
}

// Big "what do you want to make?" screen shown once a key is set.
function showChooser() {
  $('#app').classList.add('hidden');
  $('#steps').classList.add('hidden');
  $('#stepsGen').classList.add('hidden');
  $('#gateKey').classList.add('hidden');
  $('#modeChooser').classList.remove('hidden');
}

function showError(msg) {
  const box = $('#errorBox');
  box.textContent = '⚠ ' + msg;
  box.classList.remove('hidden');
}
function clearError() {
  $('#errorBox').classList.add('hidden');
}

function fmt(sec) {
  sec = Math.round(sec || 0);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
function parseErr(text) {
  try {
    return JSON.parse(text).error || text;
  } catch {
    return text || 'Request failed';
  }
}

// ---------- No accounts: the key lives in this browser ----------
// The user pastes their Gemini API key once; we keep it in localStorage on this
// device and send it with every request (x-gemini-key). The server never stores
// it — it stays in memory only for the life of a job. A random per-browser id
// (x-client-id) scopes this browser's job history. No login, no sign-up.
const KEY_LS = 'gemini_api_key';       // legacy single-key slot (migrated below)
const KEYS_LS = 'gemini_api_keys';     // ordered list of keys (primary + backups)
const CID_LS = 'client_id';

function clientId() {
  let cid = localStorage.getItem(CID_LS);
  if (!cid) {
    cid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    localStorage.setItem(CID_LS, cid);
  }
  return cid;
}

// The user can store several keys: the first that works is used, and the rest act
// as automatic backups (the server falls through to the next on quota/invalid).
function getStoredKeys() {
  try {
    const arr = JSON.parse(localStorage.getItem(KEYS_LS) || '[]');
    if (Array.isArray(arr) && arr.length) return arr.filter(Boolean);
  } catch { /* fall through to legacy migration */ }
  // Migrate a pre-existing single key from the old slot.
  const legacy = localStorage.getItem(KEY_LS);
  if (legacy) {
    localStorage.setItem(KEYS_LS, JSON.stringify([legacy]));
    localStorage.removeItem(KEY_LS);
    return [legacy];
  }
  return [];
}
function setStoredKeys(keys) {
  const unique = [...new Set(keys.filter(Boolean))];
  localStorage.setItem(KEYS_LS, JSON.stringify(unique));
  localStorage.removeItem(KEY_LS);
  return unique;
}
const hasStoredKey = () => getStoredKeys().length > 0;
// Mask a key for display: keep enough to recognise it, hide the secret middle.
const maskKey = (k) => (k.length <= 12 ? k : `${k.slice(0, 6)}…${k.slice(-4)}`);

// Attach this browser's keys (comma-joined; the server rotates over them) and id.
async function authedFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}), 'x-client-id': clientId() };
  const keys = getStoredKeys();
  if (keys.length) headers['x-gemini-key'] = keys.join(',');
  return fetch(url, { ...opts, headers });
}

// Render the saved-keys list in the gate, with remove buttons and a Continue
// button once at least one key is present.
function renderKeyList() {
  const list = $('#keyList');
  if (!list) return;
  const keys = getStoredKeys();
  list.innerHTML = '';
  keys.forEach((k, i) => {
    const li = document.createElement('li');
    li.className = 'key-row';
    const label = document.createElement('span');
    label.className = 'key-mask';
    label.textContent = i === 0 ? `${maskKey(k)}  (primary)` : `${maskKey(k)}  (backup ${i})`;
    const rm = document.createElement('button');
    rm.className = 'ghost small';
    rm.textContent = 'Remove';
    rm.addEventListener('click', () => {
      setStoredKeys(getStoredKeys().filter((x) => x !== k));
      renderKeyList();
      if (!hasStoredKey()) {
        $('#account').classList.add('hidden');
        $('#modeSwitch').classList.add('hidden');
        $('#keyStatus').textContent = 'All keys removed from this device.';
      }
    });
    li.append(label, rm);
    list.appendChild(li);
  });
  $('#keyDoneBtn').classList.toggle('hidden', keys.length === 0);
  $('#saveKeyBtn').textContent = keys.length ? 'Add backup key' : 'Add key';
}

// Remove all keys from this device (there is nothing stored on the server).
$('#removeKeyBtn').addEventListener('click', () => {
  setStoredKeys([]);
  $('#account').classList.add('hidden');
  $('#modeSwitch').classList.add('hidden');
  $('#keyInput').value = '';
  $('#keyStatus').textContent = 'All keys removed from this device.';
  showGate('key');
  renderKeyList();
});

// Manage keys (add backups / remove) — reopens the gate as a key manager.
$('#changeKeyBtn').addEventListener('click', () => {
  $('#keyInput').value = '';
  $('#keyStatus').textContent = '';
  showGate('key');
  renderKeyList();
});

// Continue from the key manager into the app once at least one key is saved.
$('#keyDoneBtn').addEventListener('click', () => {
  if (!hasStoredKey()) return;
  $('#account').classList.remove('hidden');
  $('#modeSwitch').classList.remove('hidden');
  showChooser();
});

// Step-indicator navigation (both mode lists).
document.querySelectorAll('#steps li, #stepsGen li').forEach((li) => {
  li.addEventListener('click', () => goToStep(li.dataset.step));
});

// Topbar mode switch: Edit an upload <-> Generate a video.
document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});

// Big mode-chooser cards: pick a mode and enter its first step.
document.querySelectorAll('.choice-card').forEach((card) => {
  card.addEventListener('click', () => chooseMode(card.dataset.choose));
});

// Enter a mode from the chooser (starts fresh; also syncs the topbar switch).
function chooseMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  stopPolling();
  state.jobId = null;
  state.analysis = null;
  state.storyboard = null;
  state.brief = null;
  state.job = null;
  state.voice = 'Kore';
  state.options = { ...DEFAULT_OPTIONS };
  clearError();
  show(mode === 'generate' ? 'brief' : 'upload');
}

// Switch wizards. Resets to the new mode's first step with a clean slate.
function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  stopPolling();
  state.jobId = null;
  state.analysis = null;
  state.storyboard = null;
  state.brief = null;
  state.job = null;
  state.voice = 'Kore';
  state.options = { ...DEFAULT_OPTIONS };
  clearError();
  show(mode === 'generate' ? 'brief' : 'upload');
}

// Boot: no login. If this browser already has a key, go straight to the app;
// otherwise show the key gate.
function boot() {
  renderKeyList();
  if (hasStoredKey()) afterAuth();
  else showGate('key');
}

// With a key present, decide between the key gate and the wizard.
async function afterAuth() {
  try {
    const me = await (await authedFetch('/api/me')).json();
    $('#account').classList.remove('hidden'); // History / Change key / Remove key
    if (me.hasKey) {
      $('#modeSwitch').classList.remove('hidden');
      showChooser();
    } else {
      showGate('key');
    }
  } catch {
    showError('Could not reach the server.');
  }
}

$('#saveKeyBtn').addEventListener('click', async () => {
  const apiKey = $('#keyInput').value.trim();
  if (!apiKey) return;
  if (getStoredKeys().includes(apiKey)) {
    $('#keyStatus').textContent = 'That key is already added.';
    return;
  }
  const btn = $('#saveKeyBtn');
  btn.disabled = true;
  $('#keyStatus').textContent = 'Validating…';
  try {
    // Validate this one key on its own (send just it, not the whole list).
    const res = await fetch('/api/me/key', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-client-id': clientId(), 'x-gemini-key': apiKey },
      body: JSON.stringify({ apiKey }),
    });
    if (!res.ok) {
      $('#keyStatus').textContent = parseErr(await res.text());
      return;
    }
    // Validated: append it to this device's key list (backups included).
    setStoredKeys([...getStoredKeys(), apiKey]);
    $('#keyInput').value = '';
    $('#keyStatus').textContent = 'Key added. Add another as a backup, or Continue.';
    $('#account').classList.remove('hidden');
    $('#modeSwitch').classList.remove('hidden');
    renderKeyList();
  } catch (err) {
    $('#keyStatus').textContent = 'Failed: ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Upload (signed URL -> GCS) ----------
const dropzone = $('#dropzone');
const fileInput = $('#fileInput');
['dragover', 'dragenter'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('hover');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('hover');
  })
);
dropzone.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files?.[0];
  if (f) uploadVideo(f);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) uploadVideo(fileInput.files[0]);
});

async function uploadVideo(file) {
  clearError();
  if (!file.type.startsWith('video/')) return showError('Please choose a video file.');
  const prog = $('#uploadProgress');
  const bar = prog.querySelector('.bar');
  prog.classList.remove('hidden');
  $('#dropText').textContent = `Uploading ${file.name}…`;

  // Fresh job: reset any state carried over from a reopened run.
  state.analysis = null;
  state.voice = 'Kore';
  state.options = { ...DEFAULT_OPTIONS };
  state.job = null;

  try {
    // 1) Create job + get a signed upload URL.
    const createRes = await authedFetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!createRes.ok) throw new Error(parseErr(await createRes.text()));
    const { id, uploadUrl } = await createRes.json();
    state.jobId = id;

    // 2) PUT the file straight to GCS (Content-Type must match the signed URL).
    await putToGcs(uploadUrl, file, (p) => (bar.style.width = `${p * 100}%`));

    // 3) Tell the server to ingest + analyze.
    const startRes = await authedFetch(`/api/jobs/${id}/start`, { method: 'POST' });
    if (!startRes.ok) throw new Error(parseErr(await startRes.text()));

    show('analyze');
    startPolling();
  } catch (err) {
    showError('Upload failed: ' + err.message);
    $('#dropText').textContent = 'Drag & drop a video here, or click to choose';
    prog.classList.add('hidden');
  }
}

function putToGcs(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'video/mp4');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('GCS upload HTTP ' + xhr.status)));
    xhr.onerror = () => reject(new Error('network error during upload'));
    xhr.send(file);
  });
}

// ---------- Polling ----------
function startPolling() {
  stopPolling();
  state.poll = setInterval(pollJob, 2000);
  pollJob();
}
function stopPolling() {
  if (state.poll) clearInterval(state.poll);
  state.poll = null;
}

async function pollJob() {
  if (!state.jobId) return;
  try {
    const res = await authedFetch(`/api/jobs/${state.jobId}`);
    if (!res.ok) return;
    handleJob(await res.json());
  } catch {
    /* keep polling */
  }
}

function handleJob(job) {
  state.job = job;
  if (job.status === 'error') {
    stopPolling();
    showError(job.error || 'Processing failed.');
    return;
  }
  const current = activePanel();

  if (state.mode === 'generate') {
    if (job.storyboard) state.storyboard = job.storyboard;
    if (job.brief) state.brief = job.brief;
    // Storyboard just finished planning -> render the editable shot cards.
    if (current === 'storyboard' && job.storyboard) {
      renderShots();
      $('#sbLoading').classList.add('hidden');
      if (job.status === 'storyboarded') stopPolling();
    }
    if (current === 'generate') {
      const pct = Math.round((job.progress || 0) * 100);
      $('#generateBar').style.width = `${pct}%`;
      $('#generateStatus').textContent = generateLabel(job.stage) + ` (${pct}%)`;
      if (job.status === 'done') {
        stopPolling();
        showResult();
      }
    }
    return;
  }

  if (job.status === 'analyzed' && !state.analysis) {
    state.analysis = job.analysis;
    stopPolling();
    renderSegments();
    show('review');
  }
  if (current === 'render') {
    const pct = Math.round((job.progress || 0) * 100);
    $('#renderBar').style.width = `${pct}%`;
    $('#renderStatus').textContent = renderLabel(job.stage) + ` (${pct}%)`;
    if (job.status === 'done') {
      stopPolling();
      showResult();
    }
  }
}

function renderLabel(stage) {
  return (
    {
      plan: 'Planning the timeline…',
      tts: 'Generating professional voiceover…',
      captions: 'Building captions…',
      assemble: 'Assembling and rendering video…',
      done: 'Done!',
    }[stage] || 'Working…'
  );
}

function generateLabel(stage) {
  return (
    {
      storyboard: 'Planning the shots…',
      generate: 'Generating each shot with a consistent character…',
      tts: 'Recording your narration…',
      captions: 'Building captions…',
      assemble: 'Assembling your video…',
      done: 'Done!',
    }[stage] || 'Working…'
  );
}

function activePanel() {
  return Object.keys(panels).find((k) => !panels[k].classList.contains('hidden'));
}

// ---------- Review ----------
function renderSegments() {
  const wrap = $('#segments');
  wrap.innerHTML = '';
  if (!state.analysis) return;
  for (const s of state.analysis.segments) {
    const div = document.createElement('div');
    div.className = 'segment';
    div.dataset.id = s.id;
    div.innerHTML = `
      <div class="seg-head">
        <label class="keep"><input type="checkbox" ${s.keep ? 'checked' : ''} data-keep /> Keep</label>
        <span class="time">${s.start}–${s.end}</span>
        <span class="badge cat-${s.category}">${s.category}</span>
        <span class="badge rel">relevance ${(s.relevance * 100) | 0}%</span>
      </div>
      <div class="seg-body">
        <div class="orig"><b>Original:</b> <span>${escapeHtml(s.transcript) || '<i>(no speech)</i>'}</span></div>
        <label class="script"><b>Cleaned script:</b>
          <textarea data-script rows="2">${escapeHtml(s.cleanedScript)}</textarea>
        </label>
        <div class="scene">${escapeHtml(s.sceneDescription)}</div>
      </div>`;
    wrap.appendChild(div);
  }
  updateDurSummary();
  wrap.oninput = updateDurSummary;
}

function updateDurSummary() {
  let orig = 0;
  let kept = 0;
  document.querySelectorAll('.segment').forEach((el) => {
    const s = state.analysis.segments.find((x) => x.id == el.dataset.id);
    const d = s.endSec - s.startSec;
    orig += d;
    if (el.querySelector('[data-keep]').checked) kept += d;
  });
  $('#durSummary').textContent = `— original ${fmt(orig)}, kept ≈ ${fmt(kept)}`;
}

function collectEdits() {
  const segments = [];
  document.querySelectorAll('.segment').forEach((el) => {
    segments.push({
      id: Number(el.dataset.id),
      keep: el.querySelector('[data-keep]').checked,
      cleanedScript: el.querySelector('[data-script]').value,
    });
  });
  return segments;
}

// Merge the current Review DOM edits back into state.analysis so navigating away
// and back (or re-rendering) preserves them without a round-trip.
function captureReviewEdits() {
  if (!state.analysis) return;
  const byId = new Map(state.analysis.segments.map((s) => [s.id, s]));
  for (const edit of collectEdits()) {
    const s = byId.get(edit.id);
    if (!s) continue;
    s.keep = edit.keep;
    s.cleanedScript = edit.cleanedScript;
  }
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

$('#toReviewVoice').addEventListener('click', async () => {
  captureReviewEdits();
  await saveTimeline();
  await loadVoices();
  markSelectedVoice();
  show('voice');
});

// ---------- Generate: Brief ----------
$('#genDuration').addEventListener('input', (e) => {
  $('#genDurLabel').textContent = `${e.target.value}s`;
});
$('#genAspect').addEventListener('click', (e) => {
  const b = e.target.closest('[data-aspect]');
  if (!b) return;
  genAspect = b.dataset.aspect;
  $('#genAspect').querySelectorAll('.toggle').forEach((x) => x.classList.toggle('active', x === b));
});
$('#genCharMode').addEventListener('click', (e) => {
  const b = e.target.closest('[data-charmode]');
  if (!b) return;
  genCharMode = b.dataset.charmode;
  $('#genCharMode').querySelectorAll('.toggle').forEach((x) => x.classList.toggle('active', x === b));
  $('#genDescField').classList.toggle('hidden', genCharMode !== 'synthetic');
  $('#genPhotosField').classList.toggle('hidden', genCharMode !== 'upload');
});
$('#genPhotos').addEventListener('change', () => {
  const wrap = $('#genThumbs');
  wrap.innerHTML = '';
  for (const f of Array.from($('#genPhotos').files || []).slice(0, 3)) {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.src = URL.createObjectURL(f);
    wrap.appendChild(img);
  }
});

$('#toStoryboard').addEventListener('click', submitBrief);

// Create the job from the brief, upload any reference photos, and kick off the
// (background) storyboard planning; then poll on the storyboard panel.
async function submitBrief() {
  clearError();
  const concept = $('#genConcept').value.trim();
  if (!concept) return showError('Describe the video you want to generate.');

  const brief = {
    concept,
    targetDurationSec: Number($('#genDuration').value),
    aspectRatio: genAspect,
    characterMode: genCharMode,
    characterDesc: $('#genCharDesc').value.trim(),
  };

  // Fresh run: clear any state from a previous generate.
  state.storyboard = null;
  state.voice = 'Kore';
  state.options = { ...DEFAULT_OPTIONS };
  state.job = null;

  const btn = $('#toStoryboard');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    let files = [];
    let photos = [];
    if (genCharMode === 'upload') {
      files = Array.from($('#genPhotos').files || []).slice(0, 3);
      if (!files.length) throw new Error('Add at least one reference photo.');
      if (!$('#genConsent').checked) {
        throw new Error('Please confirm you have the right and consent to use these images.');
      }
      photos = files.map((f) => ({ contentType: f.type || 'image/jpeg' }));
    } else if (!brief.characterDesc) {
      throw new Error('Describe the character to invent.');
    }

    const res = await authedFetch('/api/jobs/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brief, photos, voice: state.voice, options: state.options }),
    });
    if (!res.ok) throw new Error(parseErr(await res.text()));
    const { id, refUploads } = await res.json();
    state.jobId = id;
    state.brief = { ...brief, hasCharacter: genCharMode === 'upload' };

    // Upload each reference photo straight to GCS (Content-Type must match).
    if (genCharMode === 'upload' && refUploads?.length) {
      await Promise.all(refUploads.map((u, i) => putImageToGcs(u.url, files[i], u.contentType)));
    }

    const startRes = await authedFetch(`/api/jobs/${id}/storyboard/start`, { method: 'POST' });
    if (!startRes.ok) throw new Error(parseErr(await startRes.text()));

    state.job = { status: 'storyboarding' };
    $('#shots').innerHTML = '';
    $('#sbSummary').textContent = '';
    $('#sbLoading').classList.remove('hidden');
    show('storyboard');
    startPolling();
  } catch (err) {
    showError('Could not start: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create storyboard →';
  }
}

function putImageToGcs(url, file, contentType) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('GCS upload HTTP ' + xhr.status)));
    xhr.onerror = () => reject(new Error('network error during upload'));
    xhr.send(file);
  });
}

// ---------- Generate: Storyboard ----------
function taskLabel(task) {
  return {
    image_to_video: 'from photo',
    reference_to_video: 'consistent character',
    text_to_video: 'text prompt',
  }[task] || 'shot';
}

function renderShots() {
  const wrap = $('#shots');
  wrap.innerHTML = '';
  const sb = state.storyboard;
  if (!sb?.shots) return;
  sb.shots.forEach((sh, i) => {
    const status = sh.status || 'pending';
    const div = document.createElement('div');
    div.className = 'segment shot';
    div.dataset.id = sh.id;
    div.innerHTML = `
      <div class="seg-head">
        <b>Shot ${i + 1}</b>
        <span class="badge shot-${escapeHtml(status)}">${escapeHtml(status)}</span>
        <span class="time">${Number(sh.durationSec) || 0}s</span>
        <span class="badge task">${escapeHtml(taskLabel(sh.task))}</span>
        <button class="ghost small regen" type="button">↻ Regenerate</button>
      </div>
      <div class="seg-body">
        <label class="script"><b>Visuals:</b>
          <textarea data-prompt rows="2">${escapeHtml(sh.prompt)}</textarea>
        </label>
        <label class="script"><b>Narration:</b>
          <textarea data-narration rows="2">${escapeHtml(sh.narration)}</textarea>
        </label>
      </div>`;
    div.querySelector('.regen').addEventListener('click', () => regenerateShot(sh.id));
    wrap.appendChild(div);
  });
  updateSbSummary();
  wrap.oninput = updateSbSummary;
}

function updateSbSummary() {
  const sb = state.storyboard;
  if (!sb?.shots) return;
  const total = sb.shots.reduce((a, s) => a + (Number(s.durationSec) || 0), 0);
  $('#sbSummary').textContent = `— ${sb.shots.length} shots, ≈ ${fmt(total)}`;
}

function collectShotEdits() {
  const shots = [];
  document.querySelectorAll('#shots .shot').forEach((el) => {
    shots.push({
      id: el.dataset.id,
      prompt: el.querySelector('[data-prompt]').value,
      narration: el.querySelector('[data-narration]').value,
    });
  });
  return shots;
}

// Merge storyboard DOM edits back into state so navigating away preserves them.
function captureStoryboardEdits() {
  if (!state.storyboard?.shots) return;
  const byId = new Map(state.storyboard.shots.map((s) => [s.id, s]));
  for (const edit of collectShotEdits()) {
    const s = byId.get(edit.id);
    if (!s) continue;
    if (edit.prompt !== s.prompt) {
      s.prompt = edit.prompt;
      s.status = 'pending'; // visual change -> shot will be regenerated
    }
    s.narration = edit.narration;
  }
}

async function saveStoryboard() {
  const body = { shots: collectShotEdits(), voice: state.voice, options: state.options };
  const res = await authedFetch(`/api/jobs/${state.jobId}/storyboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    const job = await res.json();
    if (job.storyboard) state.storyboard = job.storyboard;
  }
}

// Mark a shot for regeneration: persist current edits, drop its cached clip, and
// re-render (the shot is actually re-created on the next Generate run).
async function regenerateShot(shotId) {
  clearError();
  captureStoryboardEdits();
  try {
    await saveStoryboard();
    const res = await authedFetch(`/api/jobs/${state.jobId}/shots/${shotId}/regenerate`, { method: 'POST' });
    if (!res.ok) throw new Error(parseErr(await res.text()));
    const job = await res.json();
    if (job.storyboard) state.storyboard = job.storyboard;
    renderShots();
  } catch (err) {
    showError('Could not queue shot for regeneration: ' + err.message);
  }
}

$('#backToBrief').addEventListener('click', () => goToStep('brief'));
$('#toStoryboardVoice').addEventListener('click', async () => {
  captureStoryboardEdits();
  await saveStoryboard();
  await loadVoices();
  markSelectedVoice();
  show('voice');
});

$('#startGenerate').addEventListener('click', async () => {
  clearError();
  state.options = readOptionsFromUI();
  captureStoryboardEdits();
  await saveStoryboard();
  const res = await authedFetch(`/api/jobs/${state.jobId}/generate/start`, { method: 'POST' });
  if (!res.ok) return showError(parseErr(await res.text()));
  state.job = { ...(state.job || {}), status: 'generating', stage: 'generate', progress: 0.1 };
  $('#generateBar').style.width = '10%';
  $('#generateStatus').textContent = generateLabel('generate');
  show('generate');
  startPolling();
});

// ---------- Voice ----------
let voicesLoaded = false;
async function loadVoices() {
  if (voicesLoaded) return;
  const { voices } = await (await authedFetch('/api/voices')).json();
  const wrap = $('#voices');
  wrap.innerHTML = '';
  for (const v of voices) {
    const div = document.createElement('div');
    div.className = 'voice';
    div.dataset.voice = v.name;
    div.innerHTML = `
      <button class="play" title="Preview">▶</button>
      <div class="vmeta"><b>${v.name}</b><span>${v.style}</span></div>`;
    div.addEventListener('click', (e) => {
      if (e.target.classList.contains('play')) return;
      document.querySelectorAll('.voice').forEach((x) => x.classList.remove('selected'));
      div.classList.add('selected');
      state.voice = v.name;
    });
    div.querySelector('.play').addEventListener('click', (e) => {
      e.stopPropagation();
      previewVoice(v.name, e.target);
    });
    wrap.appendChild(div);
  }
  voicesLoaded = true;
  markSelectedVoice();
}

// Reflect state.voice in the voice grid (used after reopening a run).
function markSelectedVoice() {
  document.querySelectorAll('.voice').forEach((el) => {
    el.classList.toggle('selected', el.dataset.voice === state.voice);
  });
}

let currentAudio = null;
async function previewVoice(voice, btn) {
  clearError();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  btn.textContent = '…';
  try {
    const res = await authedFetch('/api/voices/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice }),
    });
    if (!res.ok) throw new Error(parseErr(await res.text()));
    const blob = await res.blob();
    currentAudio = new Audio(URL.createObjectURL(blob));
    currentAudio.onended = () => (btn.textContent = '▶');
    await currentAudio.play();
    btn.textContent = '⏸';
  } catch (err) {
    showError('Voice preview failed: ' + err.message);
    btn.textContent = '▶';
  }
}

$('#backToReview').addEventListener('click', () => goToStep(prevStep('voice')));
$('#toOptions').addEventListener('click', () => goToStep('options'));
$('#backToVoice').addEventListener('click', () => goToStep('voice'));

// ---------- Options + render ----------
// Populate the options controls from state (used when reopening a run).
function applyOptionsToUI() {
  const o = state.options || DEFAULT_OPTIONS;
  $('#optCaptions').checked = Boolean(o.burnCaptions);
  $('#optMusic').value = o.musicTrackId || 'none';
  $('#optMusicGain').value = o.musicGainDb ?? -22;
  $('#optFit').value = o.videoFitMode || 'stretch';
}

function readOptionsFromUI() {
  return {
    burnCaptions: $('#optCaptions').checked,
    musicTrackId: $('#optMusic').value,
    musicGainDb: Number($('#optMusicGain').value),
    videoFitMode: $('#optFit').value,
  };
}

$('#startRender').addEventListener('click', async () => {
  state.options = readOptionsFromUI();
  await saveTimeline();
  const res = await authedFetch(`/api/jobs/${state.jobId}/render`, { method: 'POST' });
  if (!res.ok) return showError(parseErr(await res.text()));
  state.job = { ...(state.job || {}), status: 'planning' };
  show('render');
  startPolling();
});

async function saveTimeline() {
  const body = { segments: collectEdits(), voice: state.voice, options: state.options };
  await authedFetch(`/api/jobs/${state.jobId}/timeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function showResult() {
  // Stream the protected download through an authed request -> blob URL.
  try {
    const res = await authedFetch(`/api/jobs/${state.jobId}/download`);
    if (!res.ok) throw new Error(parseErr(await res.text()));
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    $('#result').src = url;
    $('#downloadLink').href = url;
    const prefix = state.mode === 'generate' ? 'generated' : 'professional';
    $('#downloadLink').download = `${prefix}-${state.jobId}.mp4`;
  } catch (err) {
    showError('Could not load result: ' + err.message);
  }
  show('done');
}

$('#startOver').addEventListener('click', () => location.reload());

// ---------- History ----------
$('#historyBtn').addEventListener('click', openHistory);
$('#historyClose').addEventListener('click', () => $('#historyOverlay').classList.add('hidden'));
$('#historyOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'historyOverlay') $('#historyOverlay').classList.add('hidden');
});

async function openHistory() {
  const overlay = $('#historyOverlay');
  const list = $('#historyList');
  overlay.classList.remove('hidden');
  list.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { jobs } = await (await authedFetch('/api/jobs')).json();
    if (!jobs?.length) {
      list.innerHTML = '<p class="muted">No runs yet. Upload a video to get started.</p>';
      return;
    }
    list.innerHTML = '';
    for (const j of jobs) list.appendChild(runRow(j));
  } catch (err) {
    list.innerHTML = `<p class="muted">Could not load history: ${escapeHtml(err.message)}</p>`;
  }
}

function runRow(j) {
  const row = document.createElement('div');
  row.className = 'run-row';
  const when = j.createdAt ? new Date(j.createdAt).toLocaleString() : '—';
  const isGen = j.kind === 'generate';
  const dur = isGen
    ? (j.targetDurationSec ? fmt(j.targetDurationSec) : '—')
    : (j.source?.durationSec ? fmt(j.source.durationSec) : '—');
  const detail = isGen ? `${j.shotCount || 0} shots` : `${j.keptSegments || 0} kept`;
  row.innerHTML = `
    <div class="run-meta">
      <div class="run-when">${escapeHtml(when)}</div>
      <div class="run-sub muted">
        <span class="badge kind-${isGen ? 'generate' : 'edit'}">${isGen ? 'Generate' : 'Edit'}</span>
        <span class="badge status-${escapeHtml(j.status || '')}">${escapeHtml(j.status || 'unknown')}</span>
        <span>${dur}</span>
        <span>${detail}</span>
        ${j.voice ? `<span>${escapeHtml(j.voice)}</span>` : ''}
      </div>
    </div>
    <div class="run-actions"></div>`;
  const actions = row.querySelector('.run-actions');

  const openBtn = document.createElement('button');
  openBtn.className = 'primary small';
  openBtn.textContent = 'Open';
  openBtn.addEventListener('click', () => openRun(j.id));
  actions.appendChild(openBtn);

  if (j.hasFinal) {
    const dl = document.createElement('a');
    dl.className = 'ghost small';
    dl.textContent = '⬇ MP4';
    dl.href = `/api/jobs/${j.id}/download`;
    dl.setAttribute('download', `professional-${j.id}.mp4`);
    actions.appendChild(dl);
  }

  const del = document.createElement('button');
  del.className = 'ghost small danger';
  del.textContent = 'Delete';
  del.addEventListener('click', () => deleteRun(j.id, row));
  actions.appendChild(del);

  return row;
}

async function deleteRun(id, row) {
  if (!confirm('Delete this run and its files? This cannot be undone.')) return;
  try {
    const res = await authedFetch(`/api/jobs/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(parseErr(await res.text()));
    row.remove();
    if (state.jobId === id) {
      state.jobId = null;
      state.analysis = null;
      state.job = null;
    }
  } catch (err) {
    showError('Delete failed: ' + err.message);
  }
}

// Reopen a past run: load its record into state and jump to the right step.
async function openRun(id) {
  try {
    const res = await authedFetch(`/api/jobs/${id}`);
    if (!res.ok) throw new Error(parseErr(await res.text()));
    const job = await res.json();
    loadJobIntoState(job);
    $('#historyOverlay').classList.add('hidden');
    stopPolling();

    if (job.kind === 'generate') {
      if (job.status === 'done') {
        await goToStep('done');
      } else if (GEN_ACTIVE.includes(job.status)) {
        show(job.status === 'storyboarding' ? 'storyboard' : 'generate');
        if (job.status === 'storyboarding') $('#sbLoading').classList.remove('hidden');
        startPolling();
      } else if (job.storyboard) {
        await goToStep('storyboard');
      } else {
        populateBriefFromState();
        show('brief');
      }
      return;
    }

    if (job.status === 'done') {
      await goToStep('done');
    } else if (job.analysis) {
      await goToStep('review');
    } else if (RENDER_PHASES.includes(job.status)) {
      show('render');
      startPolling();
    } else {
      show('analyze');
      startPolling();
    }
  } catch (err) {
    showError('Could not open run: ' + err.message);
  }
}

function loadJobIntoState(job) {
  state.jobId = job.id;
  state.mode = job.kind === 'generate' ? 'generate' : 'edit';
  state.analysis = job.analysis || null;
  state.storyboard = job.storyboard || null;
  state.brief = job.brief || null;
  state.voice = job.voice || 'Kore';
  state.options = { ...DEFAULT_OPTIONS, ...(job.options || {}) };
  state.job = job;
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
}

// Reflect a reopened generate brief in the brief form controls.
function populateBriefFromState() {
  const b = state.brief;
  if (!b) return;
  $('#genConcept').value = b.concept || '';
  $('#genDuration').value = b.targetDurationSec || 30;
  $('#genDurLabel').textContent = `${$('#genDuration').value}s`;
  genAspect = b.aspectRatio || '16:9';
  $('#genAspect').querySelectorAll('.toggle').forEach((x) => x.classList.toggle('active', x.dataset.aspect === genAspect));
  genCharMode = b.characterMode || 'synthetic';
  $('#genCharMode').querySelectorAll('.toggle').forEach((x) => x.classList.toggle('active', x.dataset.charmode === genCharMode));
  $('#genCharDesc').value = b.characterDesc || '';
  $('#genDescField').classList.toggle('hidden', genCharMode !== 'synthetic');
  $('#genPhotosField').classList.toggle('hidden', genCharMode !== 'upload');
}

// Start
boot();
