// ─────────────────────────────────────────────────────────
//  MediaPull Frontend — Download-Logik
//  Diesen Block in index.html ersetzen (innerhalb <script>)
// ─────────────────────────────────────────────────────────

// !! Hier nach dem Deploy deine Railway/Render-URL eintragen !!
var BACKEND = 'https://dein-projekt.up.railway.app';

var ytMode = 'auto';

function setMode(m, btn) {
  ytMode = m;
  document.getElementById('yt-qual').style.display = m === 'auto' ? '' : 'none';
  [document.getElementById('yt-m-v'), document.getElementById('yt-m-a')]
    .forEach(function(b) { b.classList.remove('on'); });
  btn.classList.add('on');
}

function dl(type) {
  var isYT   = type === 'youtube';
  var urlEl  = document.getElementById(isYT ? 'yt-url' : 'sp-url');
  var btnEl  = document.getElementById(isYT ? 'yt-btn' : 'sp-btn');
  var stEl   = document.getElementById(isYT ? 'yt-st'  : 'sp-st');
  var url    = urlEl.value.trim();

  if (!url) {
    urlEl.style.borderColor = '#a33';
    urlEl.focus();
    setTimeout(function() { urlEl.style.borderColor = ''; }, 1400);
    return;
  }

  var body = JSON.stringify({
    url:          url,
    downloadMode: isYT ? ytMode : 'audio',
    videoQuality: isYT ? document.getElementById('yt-qual').value : '720',
    audioFormat:  'mp3',
  });

  btnEl.disabled    = true;
  stEl.className    = 'sbox show';
  stEl.innerHTML    = '<span class="sp"></span><span class="st-run">Download läuft…</span>';

  fetch(BACKEND + '/api/download', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    body,
  })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      btnEl.disabled = false;
      if (d.status !== 'success') {
        stEl.innerHTML = '<span class="st-err">Fehler: ' + esc(d.message || 'Unbekannt') + '</span>';
        return;
      }
      stEl.innerHTML =
        '<span class="st-done">&#10003; Bereit! Link gültig für ' + esc(d.expiresIn) + '</span><br>' +
        '<a class="dllink" href="' + esc(d.url) + '" download="' + esc(d.filename) + '" target="_blank">' +
          '<svg width="14" height="14" viewBox="0 0 20 20" fill="none">' +
            '<path d="M10 3v10M5 8l5 5 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
            '<line x1="3" y1="17" x2="17" y2="17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
          '</svg> ' + esc(d.filename) +
        '</a>';
      urlEl.value = '';
    })
    .catch(function(e) {
      btnEl.disabled = false;
      stEl.innerHTML = '<span class="st-err">Netzwerkfehler: ' + esc(e.message) + '</span>';
    });
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Enter-Taste
document.getElementById('yt-url').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') document.getElementById('yt-btn').click();
});
document.getElementById('sp-url').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') document.getElementById('sp-btn').click();
});
