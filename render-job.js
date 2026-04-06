'use strict';
var playwright = require('playwright');
var path       = require('path');
var fs         = require('fs');
var os         = require('os');

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
  console.log('  node render-job.js --url https://reyad.web.app/render/JOB_ID');
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
// Firebase JWT auth (no SDK)
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
  if (!r.ok) throw new Error('Token exchange: ' + (await r.text()).slice(0, 200));
  return (await r.json()).access_token;
}

async function firestoreUpdate(status, extra) {
  if (!FB_SA_JSON || !FB_PROJECT || !JOB_ID) {
    log('Firestore skipped (no credentials)', 'warn');
    return;
  }
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
    log('Firestore: status=' + status + (r.ok ? '' : ' [FAILED ' + r.status + ']'), r.ok ? 'ok' : 'warn');
  } catch(e) { log('Firestore error: ' + e.message, 'warn'); }
}

// ---------------------------------------------------------------------------
// GitHub Release upload
// ---------------------------------------------------------------------------
async function uploadToRelease(filePath, assetName) {
  if (!GH_TOKEN || !GH_REPO) { log('GH upload skipped', 'warn'); return null; }
  var hdr     = {
    'Authorization':        'Bearer ' + GH_TOKEN,
    'Accept':               'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  var apiBase = 'https://api.github.com/repos/' + GH_REPO;
  var relId   = null, relUrl = null;

  var gr = await fetch(apiBase + '/releases/tags/' + RELEASE_TAG, { headers: hdr });
  if (gr.ok) {
    var rel = await gr.json(); relId = rel.id; relUrl = rel.html_url;
    log('Release found (id=' + relId + ')', 'ok');
  } else if (gr.status === 404) {
    log('Creating release...', 'info');
    var cr = await fetch(apiBase + '/releases', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, hdr),
      body: JSON.stringify({ tag_name: RELEASE_TAG, name: 'Ofoq Renders',
        body: 'Automated renders from Ofoq Studio.', draft: false, prerelease: false })
    });
    if (!cr.ok) throw new Error('Create release: ' + (await cr.text()).slice(0, 200));
    var c = await cr.json(); relId = c.id; relUrl = c.html_url;
    log('Release created (id=' + relId + ')', 'ok');
  } else {
    throw new Error('GH API: ' + (await gr.text()).slice(0, 200));
  }

  log('Uploading "' + assetName + '"...', 'info');
  var buf   = fs.readFileSync(filePath);
  var upUrl = 'https://uploads.github.com/repos/' + GH_REPO
            + '/releases/' + relId + '/assets?name=' + encodeURIComponent(assetName);
  var up    = await fetch(upUrl, {
    method:  'POST',
    headers: Object.assign({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) }, hdr),
    body: buf
  });
  if (up.status === 422) {
    var lr   = await fetch(apiBase + '/releases/' + relId + '/assets', { headers: hdr });
    var exst = (await lr.json()).find(function(a) { return a.name === assetName; });
    if (exst) {
      await fetch(apiBase + '/releases/assets/' + exst.id, { method: 'DELETE', headers: hdr });
      up = await fetch(upUrl, {
        method:  'POST',
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
// WebCodecs full support check
// ---------------------------------------------------------------------------
async function checkWebCodecsSupport(page) {
  var support = await page.evaluate(async function() {
    var result = {
      VideoEncoder:  typeof window.VideoEncoder  !== 'undefined',
      VideoDecoder:  typeof window.VideoDecoder  !== 'undefined',
      AudioEncoder:  typeof window.AudioEncoder  !== 'undefined',
      AudioDecoder:  typeof window.AudioDecoder  !== 'undefined',
      AudioContext:  typeof window.AudioContext   !== 'undefined' || typeof window.webkitAudioContext !== 'undefined',
      OfflineAudioContext: typeof window.OfflineAudioContext !== 'undefined',
      VideoFrame:    typeof window.VideoFrame    !== 'undefined',
      EncodedVideoChunk: typeof window.EncodedVideoChunk !== 'undefined',
      EncodedAudioChunk: typeof window.EncodedAudioChunk !== 'undefined',
    };

    // Test if AudioEncoder can actually be configured (not just declared)
    result.AudioEncoderFunctional = false;
    if (result.AudioEncoder) {
      try {
        var enc = new AudioEncoder({
          output: function() {},
          error:  function() {}
        });
        // Try configuring with AAC-LC
        enc.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
        result.AudioEncoderFunctional = (enc.state === 'configured');
        enc.close();
      } catch(e) {
        result.AudioEncoderError = e.message;
      }
    }

    // Test OfflineAudioContext - actually CALL startRendering with a tiny buffer
    // This catches headless CI environments where the API exists but hangs
    result.OfflineAudioContextFunctional = false;
    if (result.OfflineAudioContext) {
      try {
        // Use a callback-based approach so no await needed at this level
        // The page.evaluate callback is not async - we return a Promise instead
        var _oacResult = await new Promise(function(outerResolve) {
          var done = false;
          var timer = setTimeout(function() {
            if (!done) { done = true; outerResolve({ ok: false, error: 'startRendering() timed out after 5s' }); }
          }, 5000);
          try {
            var oac = new OfflineAudioContext(1, 512, 22050);
            var osc = oac.createOscillator();
            osc.connect(oac.destination);
            osc.start(0);
            oac.startRendering().then(function(buf) {
              if (!done) { done = true; clearTimeout(timer); outerResolve({ ok: true, samples: buf.length }); }
            }).catch(function(e) {
              if (!done) { done = true; clearTimeout(timer); outerResolve({ ok: false, error: e.message }); }
            });
          } catch(e) {
            if (!done) { done = true; clearTimeout(timer); outerResolve({ ok: false, error: e.message }); }
          }
        });
        result.OfflineAudioContextFunctional = _oacResult.ok;
        if (!_oacResult.ok) result.OfflineAudioContextError = _oacResult.error;
        else result.OfflineAudioContextSamples = _oacResult.samples;
      } catch(e) {
        result.OfflineAudioContextError = e.message;
      }
    }

    return result;
  });

  console.log('');
  console.log('  +--------------------------------------------------+');
  console.log('  |        WebCodecs Support Report                  |');
  console.log('  +--------------------------------------------------+');
  log('VideoEncoder          : ' + (support.VideoEncoder         ? 'YES' : 'NO'), support.VideoEncoder         ? 'ok' : 'err');
  log('VideoDecoder          : ' + (support.VideoDecoder         ? 'YES' : 'NO'), support.VideoDecoder         ? 'ok' : 'warn');
  log('VideoFrame            : ' + (support.VideoFrame           ? 'YES' : 'NO'), support.VideoFrame           ? 'ok' : 'warn');
  log('EncodedVideoChunk     : ' + (support.EncodedVideoChunk    ? 'YES' : 'NO'), support.EncodedVideoChunk    ? 'ok' : 'warn');
  log('AudioEncoder (API)    : ' + (support.AudioEncoder         ? 'YES' : 'NO'), support.AudioEncoder         ? 'ok' : 'warn');
  log('AudioEncoder (config) : ' + (support.AudioEncoderFunctional ? 'YES' : 'NO - ' + (support.AudioEncoderError || 'failed')), support.AudioEncoderFunctional ? 'ok' : 'err');
  log('AudioDecoder          : ' + (support.AudioDecoder         ? 'YES' : 'NO'), support.AudioDecoder         ? 'ok' : 'warn');
  log('EncodedAudioChunk     : ' + (support.EncodedAudioChunk    ? 'YES' : 'NO'), support.EncodedAudioChunk    ? 'ok' : 'warn');
  log('AudioContext          : ' + (support.AudioContext         ? 'YES' : 'NO'), support.AudioContext         ? 'ok' : 'warn');
  log('OfflineAudioContext   : ' + (support.OfflineAudioContext  ? 'YES' : 'NO'), support.OfflineAudioContext  ? 'ok' : 'warn');
  log('OfflineAC.startRender : ' + (support.OfflineAudioContextFunctional ? 'YES' : 'NO - ' + (support.OfflineAudioContextError || 'failed')), support.OfflineAudioContextFunctional ? 'ok' : 'err');
  console.log('  +--------------------------------------------------+');
  console.log('');

  return support;
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
  console.log('');

  ensureDir(DOWNLOAD_DIR);
  if (OUTPUT_PATH) ensureDir(path.dirname(path.resolve(OUTPUT_PATH)));

  await firestoreUpdate('running', null);

  log('Launching Chromium...', 'info');
  var browser = await playwright.chromium.launch({
    headless: HEADLESS,
    executablePath: '/usr/bin/google-chrome-stable',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--enable-features=WebCodecs,VideoToolbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--ignore-gpu-blocklist',
      '--disable-gpu-sandbox',
      '--js-flags=--max-old-space-size=4096'
    ]
  });
  log('Chromium ready', 'ok');

  var context = await browser.newContext({ acceptDownloads: true });
  context.setDefaultTimeout(TIMEOUT_SEC * 1000);
  var page    = await context.newPage();

  // Page logging - verbose
  page.on('pageerror', function(err) {
    log('[PAGE ERROR] ' + err.message, 'err');
  });
  page.on('console', function(msg) {
    var txt  = msg.text();
    var type = msg.type();
    // Suppress known harmless GSAP plugin 404s and community Firebase errors
    if (txt.indexOf('CustomBounce') !== -1 || txt.indexOf('CustomWiggle') !== -1 ||
        txt.indexOf('Physics2D') !== -1) return;
    if (txt.indexOf('[Comm]') !== -1 && txt.indexOf('permission') !== -1) return;
    if (txt.indexOf('WebChannelConnection') !== -1) return;

    if (type === 'error') {
      log('[PAGE] ' + txt.slice(0, 200), 'err');
    } else if (type === 'warning' || type === 'warn') {
      log('[PAGE] ' + txt.slice(0, 200), 'warn');
    } else if (
      txt.indexOf('[RenderJob]') !== -1 || txt.indexOf('[OfoqAddon]')  !== -1 ||
      txt.indexOf('muxMP4')     !== -1  || txt.indexOf('muxWebM')      !== -1 ||
      txt.indexOf('AAC')        !== -1  || txt.indexOf('Opus')         !== -1 ||
      txt.indexOf('muxer')      !== -1  || txt.indexOf('finalize')     !== -1 ||
      txt.indexOf('Audio')      !== -1  || txt.indexOf('Render')       !== -1
    ) {
      log('[PAGE] ' + txt.slice(0, 200), 'info');
    }
  });

  var startTime = Date.now();

  // -------------------------------------------------------------------------
  // Open render page
  // -------------------------------------------------------------------------
  log('Opening: ' + RENDER_URL, 'info');
  await page.goto(RENDER_URL, { waitUntil: 'load', timeout: 90000 });
  log('Page loaded', 'ok');

  // -------------------------------------------------------------------------
  // WebCodecs full support check
  // -------------------------------------------------------------------------
  var support = await checkWebCodecsSupport(page);

  if (!support.VideoEncoder) {
    log('FATAL: VideoEncoder not supported - cannot render video', 'err');
    await browser.close();
    await firestoreUpdate('error', { errorMsg: 'VideoEncoder not supported in this Chromium build' });
    process.exit(10);
  }

  if (!support.AudioEncoderFunctional) {
    log('WARNING: AudioEncoder not functional - renders will have NO audio', 'warn');
    log('Reason: ' + (support.AudioEncoderError || 'configuration failed'), 'warn');
    log('This is a known Chromium headless limitation on some CI environments', 'warn');
  }

  if (!support.OfflineAudioContextFunctional) {
    log('WARNING: OfflineAudioContext.startRendering() may hang - audio muxing may fail', 'warn');
  }

  // -------------------------------------------------------------------------
  // Wait for render overlay
  // -------------------------------------------------------------------------
  log('Waiting for render overlay...', 'info');
  await page.waitForFunction(function() {
    var ids = ['rj-phase-password','rj-phase-rendering','rj-phase-done','rj-phase-error','rj-phase-loading'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el && el.style.display && el.style.display !== 'none') return true;
    }
    return false;
  }, { timeout: 40000 }).catch(function() { log('Warning: overlay not detected in 40s', 'warn'); });

  // Password
  var needsPw = await page.evaluate(function() {
    var el = document.getElementById('rj-phase-password');
    return !!(el && el.style.display && el.style.display !== 'none');
  });
  if (needsPw) {
    if (!PASSWORD) {
      log('ERROR: password required', 'err');
      await browser.close();
      await firestoreUpdate('error', { errorMsg: 'Password required but not provided' });
      process.exit(2);
    }
    log('Entering password...', 'info');
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

  // -------------------------------------------------------------------------
  // Progress tracking
  // -------------------------------------------------------------------------
  log('Render in progress...', 'info');
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

  // -------------------------------------------------------------------------
  // Wait for OFOQ_RENDER_DONE
  // -------------------------------------------------------------------------
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
          blobUrl:     !!window.OFOQ_RENDER_BLOB_URL,
          hasAudio:    typeof audioBuffer !== 'undefined' ? !!audioBuffer : 'undefined',
          logLines:    spans.slice(-10)
        };
      });
      log('Progress         : ' + dbg.pct,        'info');
      log('Current phase    : ' + dbg.phase,       'info');
      log('OFOQ_RENDER_DONE : ' + dbg.renderDone,  'info');
      log('OFOQ_RENDER_ERROR: ' + dbg.renderError, 'info');
      log('Blob URL present : ' + dbg.blobUrl,     'info');
      log('audioBuffer      : ' + dbg.hasAudio,    'info');
      log('Last log lines:', 'info');
      (dbg.logLines || []).forEach(function(l) { if (l.trim()) log('  >> ' + l.trim(), 'info'); });
      diagMsg = 'Timeout ' + fmtTime(TIMEOUT_SEC)
        + ' | phase=' + dbg.phase
        + ' | pct=' + dbg.pct
        + ' | DONE=' + dbg.renderDone
        + ' | lastLog=' + ((dbg.logLines || []).slice(-1)[0] || '');
    } catch(de) {
      diagMsg = 'Timeout ' + fmtTime(TIMEOUT_SEC) + ' (could not collect debug info)';
    }
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

  // Get render info
  var renderInfo = await page.evaluate(function() {
    return {
      filename: window.OFOQ_RENDER_FILENAME || 'render-output.mp4',
      sizeMB:   window.OFOQ_RENDER_SIZE_MB  || '0',
      ext:      window.OFOQ_RENDER_EXT      || 'mp4',
      blobUrl:  window.OFOQ_RENDER_BLOB_URL || null
    };
  });

  log('Render complete: ' + renderInfo.filename + ' (' + renderInfo.sizeMB + ' MB)', 'ok');

  if (!renderInfo.blobUrl) {
    log('ERROR: OFOQ_RENDER_BLOB_URL is null', 'err');
    await browser.close();
    await firestoreUpdate('error', { errorMsg: 'Blob URL not available after render' });
    process.exit(7);
  }

  // Build output path
  var safeName  = (SCENE_NAME || 'render').replace(/[^a-z0-9_\-]/gi, '_').slice(0, 40);
  var jobSuffix = JOB_ID ? JOB_ID.slice(0, 8) : Date.now().toString(36);
  var ext       = renderInfo.ext || 'mp4';
  var assetName = safeName + '_' + jobSuffix + '.' + ext;

  var finalPath;
  if (OUTPUT_PATH) {
    var resolved = path.resolve(OUTPUT_PATH);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      finalPath = path.join(resolved, assetName);
    } else {
      finalPath = resolved;
    }
  } else {
    finalPath = path.join(DOWNLOAD_DIR, assetName);
  }

  ensureDir(path.dirname(finalPath));

  log('Reading blob from browser memory...', 'info');
  var bytesSaved = await saveBlobFromPage(page, renderInfo.blobUrl, finalPath);
  var savedMB    = (bytesSaved / 1024 / 1024).toFixed(2);
  log('Saved: ' + finalPath + ' (' + savedMB + ' MB)', 'ok');

  await browser.close();

  // Upload to GitHub Release
  var downloadUrl = null;
  var releaseUrl  = null;
  if (GH_TOKEN && GH_REPO) {
    try {
      var r = await uploadToRelease(finalPath, assetName);
      if (r) { downloadUrl = r.downloadUrl; releaseUrl = r.releaseUrl; }
    } catch(e) { log('GH upload error: ' + e.message, 'err'); }
  }

  var totalTime = (Date.now() - startTime) / 1000;
  await firestoreUpdate('done', {
    downloadUrl: downloadUrl || ('local://' + finalPath),
    filename:    assetName,
    sizeMB:      parseFloat(savedMB),
    runUrl:      releaseUrl || ''
  });

  console.log('  =============================================');
  console.log('  RENDER COMPLETE');
  console.log('  =============================================');
  console.log('');
  log('File      : ' + assetName,          'ok');
  log('Size      : ' + savedMB + ' MB',    'ok');
  log('Time      : ' + fmtTime(totalTime), 'ok');
  log('Saved     : ' + finalPath,          'ok');
  if (downloadUrl) log('Download  : ' + downloadUrl, 'ok');
  console.log('');
}

main().catch(function(err) {
  console.log('\n  FATAL: ' + err.message);
  if (err.stack) console.log(err.stack);
  process.exit(99);
});
