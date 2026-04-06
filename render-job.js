'use strict';
var playwright = require('playwright');
var path       = require('path');
var fs         = require('fs');
var os         = require('os');

// ---------------------------------------------------------------------------
// 1. Parse CLI args
// ---------------------------------------------------------------------------
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
  console.log('');
  console.log('  ERROR: --url is required');
  console.log('  node render-job.js --url https://reyad.web.app/render/JOB_ID');
  console.log('');
  process.exit(1);
}

var RENDER_URL  = String(args.url);
var PASSWORD    = args.password        ? String(args.password)        : null;
var OUTPUT_PATH = args.output          ? String(args.output)          : null;
var TIMEOUT_SEC = parseInt(args.timeout || '600', 10);
var HEADLESS    = args.headless       !== 'false';
var JOB_ID      = args['job-id']      ? String(args['job-id'])        : null;
var SCENE_NAME  = args['scene-name']  ? String(args['scene-name'])    : 'render';
var RELEASE_TAG = args['release-tag'] ? String(args['release-tag'])   : 'ofoq-renders';

// After video encoding hits 100%, how long to wait for audio mux (seconds)
// Audio AAC encoding on GitHub Actions can take several minutes
var MUX_TIMEOUT_SEC = parseInt(args['mux-timeout'] || '600', 10);

var DOWNLOAD_DIR = args.downloadDir
  ? path.resolve(String(args.downloadDir))
  : path.join(os.homedir(), 'ofoq-renders');

var GH_TOKEN   = process.env.GITHUB_TOKEN             || null;
var GH_REPO    = process.env.GITHUB_REPOSITORY        || null;
var FB_SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT || null;
var FB_PROJECT = process.env.FIREBASE_PROJECT_ID      || null;

// ---------------------------------------------------------------------------
// 2. Helpers
// ---------------------------------------------------------------------------
function log(msg, type) {
  var icons = { info: '--', ok: 'OK', warn: '!!', err: 'XX', step: '>>' };
  var icon  = icons[type] || '--';
  var ts    = new Date().toLocaleTimeString('en-GB');
  console.log('  [' + ts + '] [' + icon + ']  ' + msg);
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
// 3. Firebase service account JWT auth (no SDK)
// ---------------------------------------------------------------------------
async function getFirebaseAccessToken(saJson) {
  var sa;
  try { sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson; }
  catch(e) { throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT JSON: ' + e.message); }

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

  var resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
  });
  if (!resp.ok) {
    var e = await resp.text();
    throw new Error('Token exchange failed: ' + e.slice(0, 200));
  }
  return (await resp.json()).access_token;
}

// ---------------------------------------------------------------------------
// 4. Firestore REST update
// ---------------------------------------------------------------------------
async function firestoreUpdate(status, extraFields) {
  if (!FB_SA_JSON || !FB_PROJECT || !JOB_ID) {
    log('Firestore update skipped (missing credentials)', 'warn');
    return;
  }
  try {
    var token  = await getFirebaseAccessToken(FB_SA_JSON);
    var fields = { status: { stringValue: status } };
    if (extraFields) {
      var rf = {};
      if (extraFields.downloadUrl) rf.downloadUrl = { stringValue: extraFields.downloadUrl };
      if (extraFields.filename)    rf.filename    = { stringValue: extraFields.filename };
      if (extraFields.sizeMB)      rf.sizeMB      = { doubleValue: extraFields.sizeMB };
      if (extraFields.runUrl)      rf.runUrl      = { stringValue: extraFields.runUrl };
      if (extraFields.errorMsg)    rf.errorMsg    = { stringValue: extraFields.errorMsg };
      fields.result = { mapValue: { fields: rf } };
    }
    var docPath = 'projects/' + FB_PROJECT + '/databases/(default)/documents/render_jobs/' + JOB_ID;
    var mask    = 'updateMask.fieldPaths=status' + (extraFields ? '&updateMask.fieldPaths=result' : '');
    var resp    = await fetch('https://firestore.googleapis.com/v1/' + docPath + '?' + mask, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ fields: fields })
    });
    if (resp.ok) {
      log('Firestore updated: status=' + status, 'ok');
    } else {
      log('Firestore update failed: ' + (await resp.text()).slice(0, 120), 'warn');
    }
  } catch(e) {
    log('Firestore error: ' + e.message, 'warn');
  }
}

// ---------------------------------------------------------------------------
// 5. GitHub Release upload
// ---------------------------------------------------------------------------
async function uploadToGitHubRelease(filePath, assetName) {
  if (!GH_TOKEN || !GH_REPO) {
    log('GitHub upload skipped (no credentials)', 'warn');
    return null;
  }
  var headers  = {
    'Authorization': 'Bearer ' + GH_TOKEN,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  var apiBase = 'https://api.github.com/repos/' + GH_REPO;
  var releaseId = null, releaseUrl = null;

  log('Checking GitHub release "' + RELEASE_TAG + '"...', 'info');
  var gr = await fetch(apiBase + '/releases/tags/' + RELEASE_TAG, { headers: headers });
  if (gr.ok) {
    var rel = await gr.json();
    releaseId = rel.id; releaseUrl = rel.html_url;
    log('Release found (id=' + releaseId + ')', 'ok');
  } else if (gr.status === 404) {
    log('Creating release...', 'info');
    var cr = await fetch(apiBase + '/releases', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify({ tag_name: RELEASE_TAG, name: 'Ofoq Renders',
        body: 'Automated renders from Ofoq Studio.', draft: false, prerelease: false })
    });
    if (!cr.ok) throw new Error('Create release failed: ' + (await cr.text()).slice(0, 200));
    var created = await cr.json();
    releaseId = created.id; releaseUrl = created.html_url;
    log('Release created (id=' + releaseId + ')', 'ok');
  } else {
    throw new Error('GitHub API: ' + (await gr.text()).slice(0, 200));
  }

  log('Uploading "' + assetName + '"...', 'info');
  var buf = fs.readFileSync(filePath);
  var uploadUrl = 'https://uploads.github.com/repos/' + GH_REPO
    + '/releases/' + releaseId + '/assets?name=' + encodeURIComponent(assetName);

  var upResp = await fetch(uploadUrl, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) }, headers),
    body: buf
  });
  if (upResp.status === 422) {
    log('Asset exists - replacing...', 'warn');
    var lr = await fetch(apiBase + '/releases/' + releaseId + '/assets', { headers: headers });
    var assets = await lr.json();
    var ex = assets.find(function(a) { return a.name === assetName; });
    if (ex) {
      await fetch(apiBase + '/releases/assets/' + ex.id, { method: 'DELETE', headers: headers });
      upResp = await fetch(uploadUrl, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) }, headers),
        body: buf
      });
    }
  }
  if (!upResp.ok) throw new Error('Upload failed (' + upResp.status + '): ' + (await upResp.text()).slice(0, 200));
  var asset = await upResp.json();
  log('Uploaded: ' + asset.browser_download_url, 'ok');
  return { downloadUrl: asset.browser_download_url, releaseUrl: releaseUrl };
}

// ---------------------------------------------------------------------------
// 6. Save blob from browser memory
// ---------------------------------------------------------------------------
async function saveBlobFromPage(page, blobUrl, destPath) {
  var base64 = await page.evaluate(function(url) {
    return new Promise(function(resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'blob';
      xhr.onload = function() {
        var reader = new FileReader();
        reader.onloadend = function() { resolve(reader.result.split(',')[1]); };
        reader.onerror  = function() { reject('FileReader error'); };
        reader.readAsDataURL(xhr.response);
      };
      xhr.onerror = function() { reject('XHR error'); };
      xhr.send();
    });
  }, blobUrl);
  var buf = Buffer.from(base64, 'base64');
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

// ---------------------------------------------------------------------------
// 7. Main
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
  log('Mux timeout : ' + fmtTime(MUX_TIMEOUT_SEC),           'step');
  log('GH Upload   : ' + (GH_TOKEN   ? 'yes' : 'no'),       'step');
  log('FB Update   : ' + (FB_SA_JSON ? 'yes' : 'no'),       'step');
  console.log('');

  ensureDir(DOWNLOAD_DIR);
  if (OUTPUT_PATH) ensureDir(path.dirname(path.resolve(OUTPUT_PATH)));

  await firestoreUpdate('running', null);

  // Launch Chromium
  log('Launching Chromium...', 'info');
  var browser = await playwright.chromium.launch({
    headless: HEADLESS,
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

  // -------------------------------------------------------------------------
  // VERBOSE console logging from the page
  // Every console message from the render page is shown here
  // -------------------------------------------------------------------------
  page.on('pageerror', function(err) {
    log('[PAGE ERROR] ' + err.message, 'err');
    if (err.stack) {
      var lines = err.stack.split('\n').slice(0, 4);
      lines.forEach(function(l) { if (l.trim()) log('  ' + l.trim(), 'err'); });
    }
  });

  page.on('console', function(msg) {
    var txt  = msg.text();
    var type = msg.type();
    // Always show errors and warnings
    if (type === 'error') {
      log('[PAGE] ' + txt.slice(0, 200), 'err');
    } else if (type === 'warning' || type === 'warn') {
      log('[PAGE] ' + txt.slice(0, 200), 'warn');
    // Show render job messages
    } else if (txt.indexOf('[RenderJob]') !== -1 || txt.indexOf('[OfoqAddon]') !== -1) {
      log('[PAGE] ' + txt.slice(0, 200), 'info');
    // Show render progress logs (Arabic render log text)
    } else if (txt.indexOf('Render') !== -1 || txt.indexOf('render') !== -1 ||
               txt.indexOf('Audio') !== -1 || txt.indexOf('audio') !== -1 ||
               txt.indexOf('Audio') !== -1 || txt.indexOf('Mux') !== -1 ||
               txt.indexOf('mux') !== -1 || txt.indexOf('encode') !== -1 ||
               txt.indexOf('WebCodecs') !== -1 || txt.indexOf('AAC') !== -1 ||
               txt.indexOf('Opus') !== -1 || txt.indexOf('ERROR') !== -1) {
      log('[PAGE] ' + txt.slice(0, 200), 'info');
    }
  });

  var startTime = Date.now();

  log('Opening: ' + RENDER_URL, 'info');
  await page.goto(RENDER_URL, { waitUntil: 'load', timeout: 90000 });
  log('Page loaded', 'ok');

  // Check WebCodecs
  var wcOk = await page.evaluate(function() { return typeof window.VideoEncoder !== 'undefined'; });
  if (!wcOk) {
    log('FATAL: VideoEncoder (WebCodecs) not supported', 'err');
    await browser.close();
    await firestoreUpdate('error', { errorMsg: 'VideoEncoder not supported' });
    process.exit(10);
  }
  log('WebCodecs / VideoEncoder: supported', 'ok');

  // Check AudioEncoder (needed for audio muxing)
  var aeOk = await page.evaluate(function() { return typeof window.AudioEncoder !== 'undefined'; });
  log('AudioEncoder: ' + (aeOk ? 'supported' : 'NOT supported - render will have no audio'), aeOk ? 'ok' : 'warn');

  // Wait for render overlay
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
    var wrongPw = await page.evaluate(function() { return window.OFOQ_PASSWORD_WRONG === true; });
    if (wrongPw) {
      log('ERROR: wrong password', 'err');
      await browser.close();
      await firestoreUpdate('error', { errorMsg: 'Wrong password' });
      process.exit(3);
    }
    log('Password accepted', 'ok');
  }

  // -------------------------------------------------------------------------
  // Phase 1: Track encoding progress (0 to 100%)
  // -------------------------------------------------------------------------
  log('Phase 1: Video encoding in progress...', 'info');
  console.log('');

  var lastPct      = -1;
  var encodingDone = false;
  var ticker = setInterval(async function() {
    try {
      var state = await page.evaluate(function() {
        var pctEl  = document.getElementById('rjProgressPct');
        var logEl  = document.getElementById('rjLog');
        var pct    = pctEl ? parseInt(pctEl.textContent, 10) || 0 : 0;
        var lastLog = '';
        if (logEl) {
          var spans = logEl.querySelectorAll('span');
          if (spans.length) lastLog = spans[spans.length - 1].textContent || '';
        }
        return { pct: pct, log: lastLog, done: window.OFOQ_RENDER_DONE === true };
      });

      if (state.done && !encodingDone) {
        encodingDone = true;
      }

      if (state.pct !== lastPct) {
        lastPct    = state.pct;
        var filled = Math.floor(state.pct / 5);
        var empty  = 20 - filled;
        var bar    = '[' + new Array(filled + 1).join('#') + new Array(empty + 1).join('-') + ']';
        var el     = Math.round((Date.now() - startTime) / 1000);
        var logPart = state.log ? '  | ' + state.log.slice(0, 50) : '';
        process.stdout.write('\r  ' + bar + ' ' + ('  ' + state.pct).slice(-3) + '%  (' + fmtTime(el) + ')' + logPart + '          ');
      }
    } catch(e) {}
  }, 1000);

  // -------------------------------------------------------------------------
  // Phase 2: Wait for OFOQ_RENDER_DONE
  // -------------------------------------------------------------------------
  var renderDone = false;
  var renderErrMsg = null;

  try {
    await page.waitForFunction(function() {
      return window.OFOQ_RENDER_DONE === true || !!window.OFOQ_RENDER_ERROR;
    }, { timeout: TIMEOUT_SEC * 1000, polling: 500 });
    renderDone = true;
  } catch(timeoutErr) {
    // Timed out - collect detailed debug info from page
    clearInterval(ticker);
    console.log('\n');
    log('=== TIMEOUT DIAGNOSTIC ===', 'err');

    try {
      var dbg = await page.evaluate(function() {
        var pctEl   = document.getElementById('rjProgressPct');
        var logEl   = document.getElementById('rjLog');
        var logText = logEl ? logEl.innerText : '(no log element)';
        var spans   = logEl ? Array.from(logEl.querySelectorAll('span')).map(function(s) { return s.textContent; }) : [];
        return {
          pct:         pctEl ? pctEl.textContent : '?',
          renderDone:  window.OFOQ_RENDER_DONE,
          renderError: window.OFOQ_RENDER_ERROR,
          blobUrl:     window.OFOQ_RENDER_BLOB_URL,
          filename:    window.OFOQ_RENDER_FILENAME,
          logLines:    spans.slice(-10),
          audioBuffer: typeof audioBuffer !== 'undefined' ? !!audioBuffer : 'undefined',
          phase:       (function() {
            var ids = ['rj-phase-loading','rj-phase-password','rj-phase-rendering','rj-phase-done','rj-phase-error'];
            for (var i = 0; i < ids.length; i++) {
              var el = document.getElementById(ids[i]);
              if (el && el.style.display !== 'none' && el.style.display !== '') return ids[i];
            }
            return 'unknown';
          })()
        };
      });

      log('Progress           : ' + dbg.pct, 'info');
      log('Current phase      : ' + dbg.phase, 'info');
      log('OFOQ_RENDER_DONE   : ' + dbg.renderDone, 'info');
      log('OFOQ_RENDER_ERROR  : ' + dbg.renderError, 'info');
      log('OFOQ_RENDER_BLOB_URL: ' + (dbg.blobUrl ? dbg.blobUrl.slice(0, 40) + '...' : 'null'), 'info');
      log('audioBuffer ready  : ' + dbg.audioBuffer, 'info');
      log('Last log lines:', 'info');
      if (dbg.logLines && dbg.logLines.length) {
        dbg.logLines.forEach(function(l) { if (l.trim()) log('  >> ' + l.trim(), 'info'); });
      }

      renderErrMsg = 'Timed out after ' + fmtTime(TIMEOUT_SEC)
        + ' | progress=' + dbg.pct
        + ' | phase=' + dbg.phase
        + ' | RENDER_DONE=' + dbg.renderDone
        + ' | lastLog=' + (dbg.logLines && dbg.logLines.length ? dbg.logLines[dbg.logLines.length-1] : '');

    } catch(dbgErr) {
      log('Could not collect debug info: ' + dbgErr.message, 'warn');
      renderErrMsg = 'Timed out after ' + fmtTime(TIMEOUT_SEC);
    }
  }

  clearInterval(ticker);
  console.log('\n');

  if (!renderDone) {
    log('ERROR: render did not complete', 'err');
    log(renderErrMsg, 'err');
    await browser.close();
    await firestoreUpdate('error', { errorMsg: renderErrMsg });
    process.exit(4);
  }

  var renderErr = await page.evaluate(function() { return window.OFOQ_RENDER_ERROR || null; });
  if (renderErr) {
    log('Render error: ' + renderErr, 'err');
    await browser.close();
    await firestoreUpdate('error', { errorMsg: renderErr });
    process.exit(5);
  }

  log('Phase 2: Render complete', 'ok');

  // Get render info
  var renderInfo = await page.evaluate(function() {
    return {
      filename: window.OFOQ_RENDER_FILENAME || 'render-output.mp4',
      sizeMB:   window.OFOQ_RENDER_SIZE_MB  || '0',
      ext:      window.OFOQ_RENDER_EXT      || 'mp4',
      blobUrl:  window.OFOQ_RENDER_BLOB_URL || null
    };
  });
  log('File: ' + renderInfo.filename + ' (' + renderInfo.sizeMB + ' MB)', 'ok');

  if (!renderInfo.blobUrl) {
    log('ERROR: OFOQ_RENDER_BLOB_URL is null', 'err');
    await browser.close();
    await firestoreUpdate('error', { errorMsg: 'Blob URL not available after render' });
    process.exit(7);
  }

  // Build file path
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

  log('Phase 3: Reading blob from browser memory...', 'info');
  var bytesSaved = await saveBlobFromPage(page, renderInfo.blobUrl, finalPath);
  var savedMB    = (bytesSaved / 1024 / 1024).toFixed(2);
  log('Saved: ' + finalPath + ' (' + savedMB + ' MB)', 'ok');

  await browser.close();

  // Upload to GitHub Release
  var downloadUrl = null;
  var releaseUrl  = null;
  if (GH_TOKEN && GH_REPO) {
    try {
      var uploadResult = await uploadToGitHubRelease(finalPath, assetName);
      if (uploadResult) {
        downloadUrl = uploadResult.downloadUrl;
        releaseUrl  = uploadResult.releaseUrl;
      }
    } catch(e) {
      log('GitHub upload error: ' + e.message, 'err');
    }
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
  console.log('');
  console.log('  FATAL: ' + err.message);
  if (err.stack) console.log(err.stack);
  process.exit(99);
});
