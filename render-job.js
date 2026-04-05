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
var PASSWORD    = args.password      ? String(args.password)      : null;
var OUTPUT_PATH = args.output        ? String(args.output)        : null;
var TIMEOUT_SEC = parseInt(args.timeout || '600', 10);
var HEADLESS    = args.headless     !== 'false';
var JOB_ID      = args['job-id']    ? String(args['job-id'])      : null;
var SCENE_NAME  = args['scene-name'] ? String(args['scene-name']) : 'render';
var RELEASE_TAG = args['release-tag'] ? String(args['release-tag']) : 'ofoq-renders';

var DOWNLOAD_DIR = args.downloadDir
  ? path.resolve(String(args.downloadDir))
  : path.join(os.homedir(), 'ofoq-renders');

// Env vars from GitHub Actions secrets
var GH_TOKEN    = process.env.GITHUB_TOKEN              || null;
var GH_REPO     = process.env.GITHUB_REPOSITORY         || null;
var FB_SA_JSON  = process.env.FIREBASE_SERVICE_ACCOUNT  || null;
var FB_PROJECT  = process.env.FIREBASE_PROJECT_ID       || null;

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
// 3. Firebase service account: get OAuth2 access token via JWT
//    No external SDK needed - pure Node.js crypto + fetch
// ---------------------------------------------------------------------------
async function getFirebaseAccessToken(serviceAccountJson) {
  var sa;
  try {
    sa = typeof serviceAccountJson === 'string'
      ? JSON.parse(serviceAccountJson)
      : serviceAccountJson;
  } catch(e) {
    throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT JSON: ' + e.message);
  }

  var crypto = require('crypto');

  var now   = Math.floor(Date.now() / 1000);
  var claim = {
    iss:   sa.client_email,
    sub:   sa.client_email,
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore'
  };

  // Build JWT header.payload
  var header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  var payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
  var toSign  = header + '.' + payload;

  // Sign with RSA-SHA256 using private key from service account
  var sign    = crypto.createSign('RSA-SHA256');
  sign.update(toSign);
  var sig     = sign.sign(sa.private_key, 'base64url');
  var jwt     = toSign + '.' + sig;

  // Exchange JWT for access token
  var resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
  });

  if (!resp.ok) {
    var e = await resp.text();
    throw new Error('Token exchange failed: ' + e.slice(0, 200));
  }

  var data = await resp.json();
  return data.access_token;
}

// ---------------------------------------------------------------------------
// 4. Firestore REST update using service account access token
// ---------------------------------------------------------------------------
async function firestoreUpdate(status, extraFields) {
  if (!FB_SA_JSON || !FB_PROJECT || !JOB_ID) {
    log('Firestore update skipped (missing FIREBASE_SERVICE_ACCOUNT or FIREBASE_PROJECT_ID)', 'warn');
    return;
  }

  try {
    var token = await getFirebaseAccessToken(FB_SA_JSON);

    var fields = { status: { stringValue: status } };

    if (extraFields) {
      var rf = {};
      if (extraFields.downloadUrl) rf.downloadUrl = { stringValue: extraFields.downloadUrl };
      if (extraFields.filename)    rf.filename    = { stringValue: extraFields.filename };
      if (extraFields.sizeMB)      rf.sizeMB      = { doubleValue: extraFields.sizeMB };
      if (extraFields.runUrl)      rf.runUrl      = { stringValue: extraFields.runUrl };
      fields.result = { mapValue: { fields: rf } };
    }

    var docPath = 'projects/' + FB_PROJECT + '/databases/(default)/documents/render_jobs/' + JOB_ID;
    var mask    = 'updateMask.fieldPaths=status' + (extraFields ? '&updateMask.fieldPaths=result' : '');
    var url     = 'https://firestore.googleapis.com/v1/' + docPath + '?' + mask;

    var resp = await fetch(url, {
      method:  'PATCH',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({ fields: fields })
    });

    if (resp.ok) {
      log('Firestore updated: status=' + status, 'ok');
    } else {
      var errTxt = await resp.text();
      log('Firestore update failed: ' + errTxt.slice(0, 150), 'warn');
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
    log('GitHub upload skipped (no GITHUB_TOKEN or GITHUB_REPOSITORY)', 'warn');
    return null;
  }

  var headers = {
    'Authorization':        'Bearer ' + GH_TOKEN,
    'Accept':               'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  var apiBase    = 'https://api.github.com/repos/' + GH_REPO;
  var releaseId  = null;
  var releaseUrl = null;

  log('Checking GitHub release "' + RELEASE_TAG + '"...', 'info');

  var getResp = await fetch(apiBase + '/releases/tags/' + RELEASE_TAG, { headers: headers });

  if (getResp.ok) {
    var rel    = await getResp.json();
    releaseId  = rel.id;
    releaseUrl = rel.html_url;
    log('Release found (id=' + releaseId + ')', 'ok');
  } else if (getResp.status === 404) {
    log('Release not found - creating it...', 'info');
    var createResp = await fetch(apiBase + '/releases', {
      method:  'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify({
        tag_name:   RELEASE_TAG,
        name:       'Ofoq Renders',
        body:       'Automated video renders from Ofoq Studio.',
        draft:      false,
        prerelease: false
      })
    });
    if (!createResp.ok) {
      var cErr = await createResp.text();
      throw new Error('Could not create release: ' + cErr.slice(0, 200));
    }
    var created = await createResp.json();
    releaseId   = created.id;
    releaseUrl  = created.html_url;
    log('Release created (id=' + releaseId + ')', 'ok');
  } else {
    var gErr = await getResp.text();
    throw new Error('GitHub API error: ' + gErr.slice(0, 200));
  }

  // Upload asset
  log('Uploading "' + assetName + '"...', 'info');
  var fileBuffer = fs.readFileSync(filePath);
  var uploadUrl  = 'https://uploads.github.com/repos/' + GH_REPO
    + '/releases/' + releaseId
    + '/assets?name=' + encodeURIComponent(assetName);

  var upResp = await fetch(uploadUrl, {
    method:  'POST',
    headers: Object.assign({
      'Content-Type':   'application/octet-stream',
      'Content-Length': String(fileBuffer.length)
    }, headers),
    body: fileBuffer
  });

  if (upResp.status === 422) {
    log('Asset exists - replacing old asset...', 'warn');
    var listResp = await fetch(apiBase + '/releases/' + releaseId + '/assets', { headers: headers });
    var assets   = await listResp.json();
    var existing = assets.find(function(a) { return a.name === assetName; });
    if (existing) {
      await fetch(apiBase + '/releases/assets/' + existing.id, { method: 'DELETE', headers: headers });
      upResp = await fetch(uploadUrl, {
        method:  'POST',
        headers: Object.assign({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(fileBuffer.length) }, headers),
        body: fileBuffer
      });
    }
  }

  if (!upResp.ok) {
    var upErr = await upResp.text();
    throw new Error('Upload failed (' + upResp.status + '): ' + upErr.slice(0, 200));
  }

  var asset = await upResp.json();
  log('Uploaded: ' + asset.browser_download_url, 'ok');
  return { downloadUrl: asset.browser_download_url, releaseUrl: releaseUrl };
}

// ---------------------------------------------------------------------------
// 6. Save blob from browser memory to local file
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
  log('URL        : ' + RENDER_URL,                        'step');
  log('Password   : ' + (PASSWORD ? '(set)' : 'none'),     'step');
  log('Job ID     : ' + (JOB_ID   || 'none'),              'step');
  log('Release    : ' + RELEASE_TAG,                        'step');
  log('Timeout    : ' + fmtTime(TIMEOUT_SEC),               'step');
  log('GH Upload  : ' + (GH_TOKEN  ? 'yes' : 'no'),        'step');
  log('FB Update  : ' + (FB_SA_JSON ? 'yes' : 'no'),       'step');
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
  var page = await context.newPage();

  page.on('pageerror', function(err) { log('Page error: ' + err.message, 'warn'); });
  page.on('console', function(msg) {
    var txt = msg.text();
    if (msg.type() === 'error') log('Console: ' + txt, 'warn');
    else if (txt.indexOf('[RenderJob]') !== -1) log(txt, 'info');
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
    await firestoreUpdate('error', null);
    process.exit(10);
  }
  log('WebCodecs OK', 'ok');

  // Wait for overlay
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
      await firestoreUpdate('error', null);
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
      await firestoreUpdate('error', null);
      process.exit(3);
    }
    log('Password accepted', 'ok');
  }

  // Progress tracking
  log('Render in progress...', 'info');
  console.log('');
  var lastPct = -1;
  var ticker  = setInterval(async function() {
    try {
      var pct = await page.evaluate(function() {
        var el = document.getElementById('rjProgressPct');
        return el ? parseInt(el.textContent, 10) || 0 : 0;
      });
      if (pct !== lastPct) {
        lastPct    = pct;
        var filled = Math.floor(pct / 5);
        var empty  = 20 - filled;
        var bar    = '[' + new Array(filled + 1).join('#') + new Array(empty + 1).join('-') + ']';
        var el     = Math.round((Date.now() - startTime) / 1000);
        process.stdout.write('\r  ' + bar + ' ' + ('  ' + pct).slice(-3) + '%  (' + fmtTime(el) + ')    ');
      }
    } catch(e) {}
  }, 1000);

  // Wait for done
  try {
    await page.waitForFunction(function() {
      return window.OFOQ_RENDER_DONE === true || !!window.OFOQ_RENDER_ERROR;
    }, { timeout: TIMEOUT_SEC * 1000, polling: 1000 });
  } catch(e) {
    clearInterval(ticker);
    console.log('');
    log('ERROR: timed out after ' + fmtTime(TIMEOUT_SEC), 'err');
    await browser.close();
    await firestoreUpdate('error', null);
    process.exit(4);
  }

  clearInterval(ticker);
  console.log('');
  console.log('');

  var renderErr = await page.evaluate(function() { return window.OFOQ_RENDER_ERROR || null; });
  if (renderErr) {
    log('Render failed: ' + renderErr, 'err');
    await browser.close();
    await firestoreUpdate('error', null);
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
    await firestoreUpdate('error', null);
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
      var uploadResult = await uploadToGitHubRelease(finalPath, assetName);
      if (uploadResult) {
        downloadUrl = uploadResult.downloadUrl;
        releaseUrl  = uploadResult.releaseUrl;
      }
    } catch(e) {
      log('GitHub upload error: ' + e.message, 'err');
    }
  }

  // Update Firestore
  var totalTime = (Date.now() - startTime) / 1000;
  await firestoreUpdate('done', {
    downloadUrl: downloadUrl || ('local://' + finalPath),
    filename:    assetName,
    sizeMB:      parseFloat(savedMB),
    runUrl:      releaseUrl || ''
  });

  // Final report
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
