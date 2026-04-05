'use strict';
var playwright = require('playwright');
var path = require('path');
var fs = require('fs');
var os = require('os');

function parseArgs(argv) {
  var args = {};
  for (var i = 2; i < argv.length; i++) {
    if (argv[i].indexOf('--') === 0) {
      var key = argv[i].slice(2);
      var next = argv[i + 1];
      var val = (next && next.indexOf('--') !== 0) ? argv[++i] : true;
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

var RENDER_URL   = String(args.url);
var PASSWORD     = args.password  ? String(args.password) : null;
var OUTPUT_PATH  = args.output    ? String(args.output)   : null;
var TIMEOUT_SEC  = parseInt(args.timeout || '600', 10);
var HEADLESS     = args.headless !== 'false';
var DOWNLOAD_DIR = args.downloadDir
  ? path.resolve(String(args.downloadDir))
  : path.join(os.homedir(), 'ofoq-renders');

function log(msg, type) {
  var icons = { info: '--', ok: 'OK', warn: '!!', err: 'XX', step: '>>' };
  var icon = icons[type] || '--';
  var ts = new Date().toLocaleTimeString('en-GB');
  console.log('  [' + ts + '] [' + icon + ']  ' + msg);
}

function fmtTime(sec) {
  sec = Math.round(sec);
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
  return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Read blob URL from browser and return as Buffer in Node.js
async function saveBlobFromPage(page, blobUrl, destPath) {
  var base64 = await page.evaluate(function(url) {
    return new Promise(function(resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'blob';
      xhr.onload = function() {
        var reader = new FileReader();
        reader.onloadend = function() {
          // result is "data:video/mp4;base64,AAAA..."
          var b64 = reader.result.split(',')[1];
          resolve(b64);
        };
        reader.onerror = function() { reject('FileReader error'); };
        reader.readAsDataURL(xhr.response);
      };
      xhr.onerror = function() { reject('XHR error fetching blob'); };
      xhr.send();
    });
  }, blobUrl);

  var buf = Buffer.from(base64, 'base64');
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

async function main() {
  console.log('');
  console.log('  =============================================');
  console.log('  OFOQ STUDIO  -  Render Job Runner');
  console.log('  =============================================');
  console.log('');
  log('URL     : ' + RENDER_URL,                    'step');
  log('Password: ' + (PASSWORD ? '(set)' : 'none'), 'step');
  log('Timeout : ' + fmtTime(TIMEOUT_SEC),           'step');
  log('Output  : ' + (OUTPUT_PATH || DOWNLOAD_DIR),  'step');
  console.log('');

  ensureDir(DOWNLOAD_DIR);

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

  var context = await browser.newContext({
    acceptDownloads: true
  });

  context.setDefaultTimeout(TIMEOUT_SEC * 1000);

  var page = await context.newPage();

  page.on('pageerror', function(err) {
    log('Page error: ' + err.message, 'warn');
  });

  page.on('console', function(msg) {
    var txt = msg.text();
    if (msg.type() === 'error') log('Console: ' + txt, 'warn');
    else if (txt.indexOf('[RenderJob]') !== -1) log(txt, 'info');
  });

  var startTime = Date.now();

  log('Opening: ' + RENDER_URL, 'info');

  await page.goto(RENDER_URL, {
    waitUntil: 'load',
    timeout: 90000
  });

  log('Page loaded', 'ok');

  // Check WebCodecs support
  var webCodecsOk = await page.evaluate(function() {
    return typeof window.VideoEncoder !== 'undefined';
  });

  if (!webCodecsOk) {
    log('FATAL: Chromium does NOT support WebCodecs (VideoEncoder)', 'err');
    log('Fix: npx playwright install chromium --with-deps', 'warn');
    await browser.close();
    process.exit(10);
  }

  log('WebCodecs supported - VideoEncoder OK', 'ok');

  // Wait for render overlay to activate
  log('Waiting for render overlay...', 'info');

  await page.waitForFunction(function() {
    var ids = [
      'rj-phase-password',
      'rj-phase-rendering',
      'rj-phase-done',
      'rj-phase-error',
      'rj-phase-loading'
    ];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el && el.style.display && el.style.display !== 'none') return true;
    }
    return false;
  }, { timeout: 40000 }).catch(function() {
    log('Warning: overlay not detected in 40s', 'warn');
  });

  // Handle password
  var needsPassword = await page.evaluate(function() {
    var el = document.getElementById('rj-phase-password');
    return !!(el && el.style.display && el.style.display !== 'none');
  });

  if (needsPassword) {
    if (!PASSWORD) {
      log('ERROR: password-protected. Use --password "pass"', 'err');
      await browser.close();
      process.exit(2);
    }
    log('Entering password...', 'info');
    await page.fill('#rjPasswordInput', PASSWORD);
    await page.click('#rjPasswordBtn');
    await page.waitForTimeout(2500);
    var wrongPw = await page.evaluate(function() {
      return window.OFOQ_PASSWORD_WRONG === true;
    });
    if (wrongPw) {
      log('ERROR: wrong password', 'err');
      await browser.close();
      process.exit(3);
    }
    log('Password accepted', 'ok');
  }

  // Monitor render progress
  log('Render in progress...', 'info');
  console.log('');

  var lastPct = -1;
  var ticker = setInterval(async function() {
    try {
      var pct = await page.evaluate(function() {
        var el = document.getElementById('rjProgressPct');
        return el ? parseInt(el.textContent, 10) || 0 : 0;
      });
      if (pct !== lastPct) {
        lastPct = pct;
        var filled  = Math.floor(pct / 5);
        var empty   = 20 - filled;
        var bar = '[' + new Array(filled + 1).join('#') + new Array(empty + 1).join('-') + ']';
        var elapsed = Math.round((Date.now() - startTime) / 1000);
        process.stdout.write(
          '\r  ' + bar + ' ' + ('  ' + pct).slice(-3) + '%  (' + fmtTime(elapsed) + ')    '
        );
      }
    } catch(e) {}
  }, 1000);

  // Wait for OFOQ_RENDER_DONE
  try {
    await page.waitForFunction(function() {
      return window.OFOQ_RENDER_DONE === true || !!window.OFOQ_RENDER_ERROR;
    }, { timeout: TIMEOUT_SEC * 1000, polling: 1000 });
  } catch(e) {
    clearInterval(ticker);
    console.log('');
    log('ERROR: timed out after ' + fmtTime(TIMEOUT_SEC), 'err');
    await browser.close();
    process.exit(4);
  }

  clearInterval(ticker);
  console.log('');
  console.log('');

  // Check for render error
  var renderError = await page.evaluate(function() {
    return window.OFOQ_RENDER_ERROR || null;
  });
  if (renderError) {
    log('Render failed: ' + renderError, 'err');
    await browser.close();
    process.exit(5);
  }

  // Get render info from page
  var renderInfo = await page.evaluate(function() {
    return {
      filename: window.OFOQ_RENDER_FILENAME || 'render-output.mp4',
      sizeMB:   window.OFOQ_RENDER_SIZE_MB  || '?',
      ext:      window.OFOQ_RENDER_EXT      || 'mp4',
      blobUrl:  window.OFOQ_RENDER_BLOB_URL || null
    };
  });

  log('Render complete: ' + renderInfo.filename + ' (' + renderInfo.sizeMB + ' MB)', 'ok');

  if (!renderInfo.blobUrl) {
    log('ERROR: blob URL not found in page (OFOQ_RENDER_BLOB_URL is null)', 'err');
    log('Make sure the HTML build is c71 or later', 'warn');
    await browser.close();
    process.exit(7);
  }

  // Build final output path
  var finalPath;
  if (OUTPUT_PATH) {
    var resolved = path.resolve(OUTPUT_PATH);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      finalPath = path.join(resolved, renderInfo.filename);
    } else {
      finalPath = resolved;
    }
  } else {
    finalPath = path.join(DOWNLOAD_DIR, renderInfo.filename);
  }

  ensureDir(path.dirname(finalPath));

  // Save blob directly from browser memory - no HTTP download needed
  log('Reading blob from browser memory...', 'info');
  var bytesSaved = await saveBlobFromPage(page, renderInfo.blobUrl, finalPath);
  var savedMB = (bytesSaved / 1024 / 1024).toFixed(2);

  await browser.close();

  var totalTime = (Date.now() - startTime) / 1000;

  console.log('  =============================================');
  console.log('  RENDER COMPLETE');
  console.log('  =============================================');
  console.log('');
  log('File   : ' + renderInfo.filename, 'ok');
  log('Size   : ' + savedMB + ' MB',     'ok');
  log('Time   : ' + fmtTime(totalTime),  'ok');
  log('Saved  : ' + finalPath,           'ok');
  console.log('');
}

main().catch(function(err) {
  console.log('');
  console.log('  FATAL: ' + err.message);
  if (err.stack) console.log(err.stack);
  process.exit(99);
});
