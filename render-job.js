'use strict';
var playwright = require('playwright');
var path       = require('path');
var fs         = require('fs');
var os         = require('os');
var cp         = require('child_process');

function parseArgs(argv) {
  var args = {};
  for (var i = 2; i < argv.length; i++) {
    if (argv[i].indexOf('--') === 0) {
      var key  = argv[i].slice(2);
      var next = argv[i + 1];
      var val  = (next && next.indexOf('--') !== 0) ? argv[++i] : true;
      args[key] = val;
    }
  }
  return args;
}

var args = parseArgs(process.argv);

if (!args.url) {
  console.log('  ERROR: --url is required');
  process.exit(1);
}

var RENDER_URL  = String(args.url);
var PASSWORD    = args.password        ? String(args.password)        : null;
var OUTPUT_PATH = args.output          ? String(args.output)          : null;
var TIMEOUT_SEC = parseInt(args.timeout  || '600', 10);
var HEADLESS    = args.headless        !== 'false';
var JOB_ID      = args['job-id']       ? String(args['job-id'])       : null;
var SCENE_NAME  = args['scene-name']   ? String(args['scene-name'])   : 'render';
var RELEASE_TAG = args['release-tag']  ? String(args['release-tag'])  : 'ofoq-renders';

var DOWNLOAD_DIR = args.downloadDir
  ? path.resolve(String(args.downloadDir))
  : path.join(os.homedir(), 'ofoq-renders');

var GH_TOKEN   = process.env.GITHUB_TOKEN             || null;
var GH_REPO    = process.env.GITHUB_REPOSITORY        || null;
var FB_SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT || null;
var FB_PROJECT = process.env.FIREBASE_PROJECT_ID      || null;

// ---------------------------------------------------------------------------
function log(msg, type) {
  var icons = { info: '--', ok: 'OK', warn: '!!', err: 'XX', step: '>>' };
  var ts    = new Date().toLocaleTimeString('en-GB');
  console.log('  [' + ts + '] [' + (icons[type] || '--') + ']  ' + msg);
}

function fmtTime(sec) {
  sec = Math.round(sec);
  if (sec < 60)   return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
  return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Firebase JWT auth
// ---------------------------------------------------------------------------
async function getFirebaseToken(saJson) {
  var sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
  var crypto = require('crypto');
  var now    = Math.floor(Date.now() / 1000);
  var claim  = {
    iss: sa.client_email, sub: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore'
  };
  var header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  var payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
  var toSign  = header + '.' + payload;
  var sign    = crypto.createSign('RSA-SHA256');
  sign.update(toSign);
  var jwt = toSign + '.' + sign.sign(sa.private_key, 'base64url');
  var r   = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
  });
  if (!r.ok) throw new Error('Token: ' + (await r.text()).slice(0, 200));
  return (await r.json()).access_token;
}

async function firestoreUpdate(status, extra) {
  if (!FB_SA_JSON || !FB_PROJECT || !JOB_ID) return;
  try {
    var token  = await getFirebaseToken(FB_SA_JSON);
    var fields = { status: { stringValue: status } };
    if (extra) {
      var rf = {};
      if (extra.downloadUrl) rf.downloadUrl = { stringValue: extra.downloadUrl };
      if (extra.filename)    rf.filename    = { stringValue: extra.filename };
      if (extra.sizeMB)      rf.sizeMB      = { doubleValue: extra.sizeMB };
      if (extra.runUrl)      rf.runUrl      = { stringValue: extra.runUrl };
      if (extra.errorMsg)    rf.errorMsg    = { stringValue: extra.errorMsg };
      fields.result = { mapValue: { fields: rf } };
    }
    var base = 'https://firestore.googleapis.com/v1/projects/' + FB_PROJECT
             + '/databases/(default)/documents/render_jobs/' + JOB_ID;
    var mask = 'updateMask.fieldPaths=status' + (extra ? '&updateMask.fieldPaths=result' : '');
    var r    = await fetch(base + '?' + mask, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ fields: fields })
    });
    log('Firestore: status=' + status + (r.ok ? '' : ' [FAILED: ' + r.status + ']'), r.ok ? 'ok' : 'warn');
  } catch(e) { log('Firestore error: ' + e.message, 'warn'); }
}

// ---------------------------------------------------------------------------
// GitHub Release upload
// ---------------------------------------------------------------------------
async function uploadToRelease(filePath, assetName) {
  if (!GH_TOKEN || !GH_REPO) { log('GH upload skipped (no credentials)', 'warn'); return null; }
  var hdr     = { 'Authorization': 'Bearer ' + GH_TOKEN, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  var apiBase = 'https://api.github.com/repos/' + GH_REPO;
  var relId   = null, relUrl = null;

  var gr = await fetch(apiBase + '/releases/tags/' + RELEASE_TAG, { headers: hdr });
  if (gr.ok) {
    var rel = await gr.json(); relId = rel.id; relUrl = rel.html_url;
    log('Release found (id=' + relId + ')', 'ok');
  } else {
    log('Creating release...', 'info');
    var cr = await fetch(apiBase + '/releases', {
      method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, hdr),
      body: JSON.stringify({ tag_name: RELEASE_TAG, name: 'Ofoq Renders',
        body: 'Automated renders.', draft: false, prerelease: false })
    });
    if (!cr.ok) throw new Error('Create release: ' + (await cr.text()).slice(0, 200));
    var c = await cr.json(); relId = c.id; relUrl = c.html_url;
    log('Release created (id=' + relId + ')', 'ok');
  }

  log('Uploading "' + assetName + '"...', 'info');
  var buf = fs.readFileSync(filePath);
  var upUrl = 'https://uploads.github.com/repos/' + GH_REPO
            + '/releases/' + relId + '/assets?name=' + encodeURIComponent(assetName);
  var up = await fetch(upUrl, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) }, hdr),
    body: buf
  });
  if (up.status === 422) {
    var lr   = await fetch(apiBase + '/releases/' + relId + '/assets', { headers: hdr });
    var exst = (await lr.json()).find(function(a) { return a.name === assetName; });
    if (exst) {
      await fetch(apiBase + '/releases/assets/' + exst.id, { method: 'DELETE', headers: hdr });
      up = await fetch(upUrl, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) }, hdr),
        body: buf
      });
    }
  }
  if (!up.ok) throw new Error('Upload failed: ' + (await up.text()).slice(0, 200));
  var asset = await up.json();
  log('Uploaded: ' + asset.browser_download_url, 'ok');
  return { downloadUrl: asset.browser_download_url, releaseUrl: relUrl };
}

// ---------------------------------------------------------------------------
// Save blob from browser memory to disk
// ---------------------------------------------------------------------------
async function saveBlobFromPage(page, blobUrl, destPath) {
  var b64 = await page.evaluate(function(url) {
    return new Promise(function(resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true); xhr.responseType = 'blob';
      xhr.onload = function() {
        var r = new FileReader();
        r.onloadend = function() { resolve(r.result.split(',')[1]); };
        r.onerror   = function() { reject('FileReader error'); };
        r.readAsDataURL(xhr.response);
      };
      xhr.onerror = function() { reject('XHR error'); };
      xhr.send();
    });
  }, blobUrl);
  var buf = Buffer.from(b64, 'base64');
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

// ---------------------------------------------------------------------------
// FFmpeg helpers
// ---------------------------------------------------------------------------
function ffmpegAvailable() {
  try {
    cp.execSync('ffmpeg -version', { stdio: 'ignore' });
    return true;
  } catch(e) { return false; }
}

// Download a URL to a local file using Node fetch
async function downloadFile(url, destPath) {
  var resp = await fetch(url);
  if (!resp.ok) throw new Error('Download failed (' + resp.status + '): ' + url);
  var buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

// Merge silent video + audio files using FFmpeg
// audioFiles: array of local paths (e.g. [/tmp/seg0.mp3, /tmp/seg1.mp3])
async function mergeAudioWithVideo(videoPath, audioFiles, outputPath) {
  if (!audioFiles || audioFiles.length === 0) {
    log('No audio files to merge', 'warn');
    return false;
  }

  var tmpDir = path.join(os.tmpdir(), 'ofoq-audio-' + Date.now());
  ensureDir(tmpDir);

  var mergedAudio = path.join(tmpDir, 'merged.mp3');

  if (audioFiles.length === 1) {
    // Single audio file - use directly
    mergedAudio = audioFiles[0];
    log('Using single audio file', 'info');
  } else {
    // Multiple segments - concatenate with FFmpeg
    log('Concatenating ' + audioFiles.length + ' audio segments...', 'info');
    var listFile = path.join(tmpDir, 'concat.txt');
    var listContent = audioFiles.map(function(f) {
      return "file '" + f.replace(/'/g, "'\\''") + "'";
    }).join('\n');
    fs.writeFileSync(listFile, listContent);

    var concatCmd = 'ffmpeg -y -f concat -safe 0 -i "' + listFile + '" -c copy "' + mergedAudio + '"';
    log('FFmpeg concat: ' + concatCmd, 'info');
    try {
      cp.execSync(concatCmd, { stdio: 'pipe' });
      log('Audio concatenated: ' + mergedAudio, 'ok');
    } catch(e) {
      log('FFmpeg concat error: ' + (e.stderr ? e.stderr.toString().slice(0, 300) : e.message), 'err');
      return false;
    }
  }

  // Merge video + audio
  // -c:v copy  = keep video as-is (no re-encode)
  // -c:a aac   = encode audio to AAC
  // -shortest  = cut to shortest stream
  var mergeCmd = 'ffmpeg -y -i "' + videoPath + '" -i "' + mergedAudio + '" '
    + '-c:v copy -c:a aac -b:a 192k -shortest "' + outputPath + '"';

  log('FFmpeg merge: video + audio...', 'info');
  try {
    var result = cp.execSync(mergeCmd, { stdio: 'pipe' });
    log('Merge complete: ' + outputPath, 'ok');
    return true;
  } catch(e) {
    var stderr = e.stderr ? e.stderr.toString() : e.message;
    log('FFmpeg merge error: ' + stderr.slice(-400), 'err');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('');
  console.log('  =============================================');
  console.log('  OFOQ STUDIO  -  Render Job Runner');
  console.log('  =============================================');
  console.log('');
  log('URL         : ' + RENDER_URL,                        'step');
  log('Password    : ' + (PASSWORD   ? '(set)' : 'none'),   'step');
  log('Job ID      : ' + (JOB_ID     || 'none'),            'step');
  log('Release     : ' + RELEASE_TAG,                        'step');
  log('Timeout     : ' + fmtTime(TIMEOUT_SEC),               'step');
  log('GH Upload   : ' + (GH_TOKEN   ? 'yes' : 'no'),       'step');
  log('FB Update   : ' + (FB_SA_JSON ? 'yes' : 'no'),       'step');
  log('FFmpeg      : ' + (ffmpegAvailable() ? 'available' : 'NOT FOUND'), ffmpegAvailable() ? 'ok' : 'warn');
  console.log('');

  ensureDir(DOWNLOAD_DIR);
  if (OUTPUT_PATH) ensureDir(path.dirname(path.resolve(OUTPUT_PATH)));

  await firestoreUpdate('running', null);

  // Launch Chromium
  log('Launching Chromium...', 'info');
  var browser = await playwright.chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security',
      '--enable-features=WebCodecs,VideoToolbox', '--use-gl=angle',
      '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox',
      '--js-flags=--max-old-space-size=4096'
    ]
  });
  log('Chromium ready', 'ok');

  var context = await browser.newContext({ acceptDownloads: true });
  context.setDefaultTimeout(TIMEOUT_SEC * 1000);
  var page    = await context.newPage();

  // Verbose page logging
  page.on('pageerror', function(err) {
    log('[PAGE ERROR] ' + err.message, 'err');
  });
  page.on('console', function(msg) {
    var txt  = msg.text();
    var type = msg.type();
    if (type === 'error') {
      // Suppress known non-critical 404s for GSAP optional plugins
      if (txt.indexOf('CustomBounce') !== -1 || txt.indexOf('CustomWiggle') !== -1 ||
          txt.indexOf('Physics2D') !== -1) return;
      log('[PAGE] ' + txt.slice(0, 200), 'err');
    } else if (type === 'warning' || type === 'warn') {
      if (txt.indexOf('Comm') !== -1 && txt.indexOf('permission') !== -1) return;
      log('[PAGE] ' + txt.slice(0, 200), 'warn');
    } else if (txt.indexOf('[RenderJob]') !== -1 || txt.indexOf('[OfoqAddon]') !== -1) {
      log('[PAGE] ' + txt.slice(0, 200), 'info');
    } else if (txt.indexOf('mux') !== -1 || txt.indexOf('Mux') !== -1 ||
               txt.indexOf('AAC') !== -1 || txt.indexOf('Audio') !== -1 ||
               txt.indexOf('encode') !== -1 || txt.indexOf('Render') !== -1) {
      log('[PAGE] ' + txt.slice(0, 200), 'info');
    }
  });

  var startTime = Date.now();

  log('Opening: ' + RENDER_URL, 'info');
  await page.goto(RENDER_URL, { waitUntil: 'load', timeout: 90000 });
  log('Page loaded', 'ok');

  var wcOk = await page.evaluate(function() { return typeof window.VideoEncoder !== 'undefined'; });
  if (!wcOk) {
    log('FATAL: VideoEncoder not supported', 'err');
    await browser.close();
    await firestoreUpdate('error', { errorMsg: 'VideoEncoder not supported' });
    process.exit(10);
  }
  log('WebCodecs OK', 'ok');
  log('Note: AudioEncoder skipped in render job mode - FFmpeg will merge audio', 'info');

  // Wait for overlay
  await page.waitForFunction(function() {
    var ids = ['rj-phase-password','rj-phase-rendering','rj-phase-done','rj-phase-error','rj-phase-loading'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el && el.style.display && el.style.display !== 'none') return true;
    }
    return false;
  }, { timeout: 40000 }).catch(function() { log('Warning: overlay not detected', 'warn'); });

  // Password
  var needsPw = await page.evaluate(function() {
    var el = document.getElementById('rj-phase-password');
    return !!(el && el.style.display && el.style.display !== 'none');
  });
  if (needsPw) {
    if (!PASSWORD) {
      log('ERROR: password required', 'err');
      await browser.close();
      await firestoreUpdate('error', { errorMsg: 'Password required' });
      process.exit(2);
    }
    await page.fill('#rjPasswordInput', PASSWORD);
    await page.click('#rjPasswordBtn');
    await page.waitForTimeout(2500);
    if (await page.evaluate(function() { return window.OFOQ_PASSWORD_WRONG === true; })) {
      log('ERROR: wrong password', 'err');
      await browser.close();
      await firestoreUpdate('error', { errorMsg: 'Wrong password' });
      process.exit(3);
    }
    log('Password accepted', 'ok');
  }

  // Progress tracking
  log('Render in progress (video only - audio merged by FFmpeg)...', 'info');
  console.log('');

  var lastPct = -1;
  var ticker  = setInterval(async function() {
    try {
      var st = await page.evaluate(function() {
        var p = document.getElementById('rjProgressPct');
        var l = document.getElementById('rjLog');
        var last = '';
        if (l) { var s = l.querySelectorAll('span'); if (s.length) last = s[s.length-1].textContent; }
        return { pct: p ? parseInt(p.textContent, 10) || 0 : 0, log: last };
      });
      if (st.pct !== lastPct) {
        lastPct = st.pct;
        var f = Math.floor(st.pct / 5), e = 20 - f;
        var bar = '[' + new Array(f+1).join('#') + new Array(e+1).join('-') + ']';
        var el  = Math.round((Date.now() - startTime) / 1000);
        var lg  = st.log ? '  | ' + st.log.slice(0, 45) : '';
        process.stdout.write('\r  ' + bar + ' ' + ('  ' + st.pct).slice(-3) + '%  (' + fmtTime(el) + ')' + lg + '          ');
      }
    } catch(e) {}
  }, 1000);

  // Wait for OFOQ_RENDER_DONE
  var renderDone = false;
  var diagMsg    = null;

  try {
    await page.waitForFunction(function() {
      return window.OFOQ_RENDER_DONE === true || !!window.OFOQ_RENDER_ERROR;
    }, { timeout: TIMEOUT_SEC * 1000, polling: 500 });
    renderDone = true;
  } catch(e) {
    clearInterval(ticker);
    console.log('\n');
    log('=== TIMEOUT DIAGNOSTIC ===', 'err');
    try {
      var dbg = await page.evaluate(function() {
        var logEl = document.getElementById('rjLog');
        var spans = logEl ? Array.from(logEl.querySelectorAll('span')).map(function(s) { return s.textContent; }) : [];
        var phase = 'unknown';
        ['rj-phase-loading','rj-phase-password','rj-phase-rendering','rj-phase-done','rj-phase-error'].forEach(function(id) {
          var el = document.getElementById(id);
          if (el && el.style.display !== 'none' && el.style.display !== '') phase = id;
        });
        return {
          pct:         (document.getElementById('rjProgressPct') || {}).textContent || '?',
          phase:       phase,
          renderDone:  window.OFOQ_RENDER_DONE,
          renderError: window.OFOQ_RENDER_ERROR,
          blobUrl:     window.OFOQ_RENDER_BLOB_URL,
          logLines:    spans.slice(-8)
        };
      });
      log('Progress  : ' + dbg.pct,         'info');
      log('Phase     : ' + dbg.phase,        'info');
      log('DONE flag : ' + dbg.renderDone,   'info');
      log('ERROR flag: ' + dbg.renderError,  'info');
      log('Blob URL  : ' + (dbg.blobUrl ? 'present' : 'null'), 'info');
      log('Last logs :', 'info');
      (dbg.logLines || []).forEach(function(l) { if (l.trim()) log('  >> ' + l.trim(), 'info'); });
      diagMsg = 'Timeout after ' + fmtTime(TIMEOUT_SEC) + ' | phase=' + dbg.phase + ' | last=' + (dbg.logLines || []).slice(-1)[0];
    } catch(de) { diagMsg = 'Timeout ' + fmtTime(TIMEOUT_SEC); }
  }

  clearInterval(ticker);
  console.log('\n');

  if (!renderDone) {
    log('ERROR: render did not complete', 'err');
    log(diagMsg, 'err');
    await browser.close();
    await firestoreUpdate('error', { errorMsg: diagMsg });
    process.exit(4);
  }

  var renderErr = await page.evaluate(function() { return window.OFOQ_RENDER_ERROR || null; });
  if (renderErr) {
    log('Render error: ' + renderErr, 'err');
    await browser.close();
    await firestoreUpdate('error', { errorMsg: renderErr });
    process.exit(5);
  }

  log('Video encoding complete!', 'ok');

  // Collect render info + audio URLs from page
  var renderInfo = await page.evaluate(function() {
    return {
      filename:    window.OFOQ_RENDER_FILENAME    || 'render-output.mp4',
      sizeMB:      window.OFOQ_RENDER_SIZE_MB     || '0',
      ext:         window.OFOQ_RENDER_EXT         || 'mp4',
      blobUrl:     window.OFOQ_RENDER_BLOB_URL    || null,
      hasAudio:    window.OFOQ_RENDER_HAS_AUDIO   || false,
      audioUrls:   window.OFOQ_RENDER_AUDIO_URLS  || [],
      audioSingle: window.OFOQ_RENDER_AUDIO_SINGLE || null
    };
  });

  log('File: ' + renderInfo.filename + ' (video-only: ' + renderInfo.sizeMB + ' MB)', 'ok');
  log('Has audio: ' + renderInfo.hasAudio + ' | Segment URLs: ' + renderInfo.audioUrls.length, 'info');

  if (!renderInfo.blobUrl) {
    log('ERROR: blob URL is null', 'err');
    await browser.close();
    await firestoreUpdate('error', { errorMsg: 'Blob URL not available' });
    process.exit(7);
  }

  // Build paths
  var safeName  = (SCENE_NAME || 'render').replace(/[^a-z0-9_\-]/gi, '_').slice(0, 40);
  var jobSuffix = JOB_ID ? JOB_ID.slice(0, 8) : Date.now().toString(36);
  var ext       = renderInfo.ext || 'mp4';

  var finalDir  = OUTPUT_PATH
    ? path.dirname(path.resolve(OUTPUT_PATH))
    : DOWNLOAD_DIR;
  ensureDir(finalDir);

  var silentPath  = path.join(finalDir, safeName + '_' + jobSuffix + '_silent.' + ext);
  var finalName   = safeName + '_' + jobSuffix + '.' + ext;
  var finalPath   = path.join(finalDir, finalName);

  // Save silent video blob
  log('Saving silent video blob...', 'info');
  var silentBytes = await saveBlobFromPage(page, renderInfo.blobUrl, silentPath);
  log('Silent video saved: ' + (silentBytes/1024/1024).toFixed(2) + ' MB', 'ok');

  await browser.close();
  log('Browser closed', 'ok');

  // -------------------------------------------------------------------------
  // FFmpeg: download audio + merge
  // -------------------------------------------------------------------------
  var audioUrls = renderInfo.audioUrls.filter(function(u) { return u && u.indexOf('http') === 0; });
  if (!audioUrls.length && renderInfo.audioSingle && renderInfo.audioSingle.indexOf('http') === 0) {
    audioUrls = [renderInfo.audioSingle];
  }

  var usedFFmpeg = false;

  if (audioUrls.length > 0 && ffmpegAvailable()) {
    log('=== Audio merge phase ===', 'info');
    log('Downloading ' + audioUrls.length + ' audio segment(s)...', 'info');

    var tmpAudioDir = path.join(os.tmpdir(), 'ofoq-audio-' + Date.now());
    ensureDir(tmpAudioDir);
    var audioFiles  = [];

    for (var ai = 0; ai < audioUrls.length; ai++) {
      var segPath = path.join(tmpAudioDir, 'seg' + ai + '.mp3');
      try {
        var segBytes = await downloadFile(audioUrls[ai], segPath);
        audioFiles.push(segPath);
        log('Segment ' + (ai+1) + '/' + audioUrls.length + ': ' + (segBytes/1024).toFixed(0) + ' KB', 'ok');
      } catch(e) {
        log('Segment ' + (ai+1) + ' failed: ' + e.message, 'warn');
      }
    }

    if (audioFiles.length > 0) {
      var merged = await mergeAudioWithVideo(silentPath, audioFiles, finalPath);
      if (merged) {
        usedFFmpeg = true;
        // Remove silent video (keep only final)
        try { fs.unlinkSync(silentPath); } catch(e) {}
        var finalBytes = fs.statSync(finalPath).size;
        log('Final video with audio: ' + (finalBytes/1024/1024).toFixed(2) + ' MB', 'ok');
      } else {
        log('FFmpeg merge failed - using silent video as fallback', 'warn');
        try { fs.renameSync(silentPath, finalPath); } catch(e) { finalPath = silentPath; }
      }
    } else {
      log('No audio segments downloaded - using silent video', 'warn');
      try { fs.renameSync(silentPath, finalPath); } catch(e) { finalPath = silentPath; }
    }

    // Cleanup tmp audio
    try {
      audioFiles.forEach(function(f) { try { fs.unlinkSync(f); } catch(e) {} });
      fs.rmdirSync(tmpAudioDir);
    } catch(e) {}

  } else {
    if (audioUrls.length === 0) {
      log('No audio URLs - video is silent', 'info');
    } else {
      log('FFmpeg not available - video will be silent', 'warn');
    }
    try { fs.renameSync(silentPath, finalPath); } catch(e) { finalPath = silentPath; }
  }

  var savedMB = (fs.statSync(finalPath).size / 1024 / 1024).toFixed(2);

  // Upload to GitHub Release
  var downloadUrl = null;
  var releaseUrl  = null;
  if (GH_TOKEN && GH_REPO) {
    try {
      var r = await uploadToRelease(finalPath, finalName);
      if (r) { downloadUrl = r.downloadUrl; releaseUrl = r.releaseUrl; }
    } catch(e) { log('GH upload error: ' + e.message, 'err'); }
  }

  var totalTime = (Date.now() - startTime) / 1000;
  await firestoreUpdate('done', {
    downloadUrl: downloadUrl || ('local://' + finalPath),
    filename:    finalName,
    sizeMB:      parseFloat(savedMB),
    runUrl:      releaseUrl || ''
  });

  console.log('  =============================================');
  console.log('  RENDER COMPLETE');
  console.log('  =============================================');
  console.log('');
  log('File      : ' + finalName,                                  'ok');
  log('Audio     : ' + (usedFFmpeg ? 'merged by FFmpeg' : 'none'), usedFFmpeg ? 'ok' : 'warn');
  log('Size      : ' + savedMB + ' MB',                            'ok');
  log('Time      : ' + fmtTime(totalTime),                         'ok');
  log('Saved     : ' + finalPath,                                   'ok');
  if (downloadUrl) log('Download  : ' + downloadUrl,                'ok');
  console.log('');
}

main().catch(function(err) {
  console.log('\n  FATAL: ' + err.message);
  if (err.stack) console.log(err.stack);
  process.exit(99);
});
