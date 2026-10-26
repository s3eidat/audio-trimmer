/* Audio Trimmer — decode with WebAudio, cut/fade/gain in plain JS, encode WAV ourselves. Nothing is uploaded. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$;

  // ---------- pure helpers (tested in S3_SELFTEST) ----------
  function encodeWAV(chans, rate) {
    var n = chans.length, len = chans[0].length, block = n * 2, buf = new ArrayBuffer(44 + len * block), v = new DataView(buf);
    function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    str(0, "RIFF"); v.setUint32(4, 36 + len * block, true); str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, n, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * block, true); v.setUint16(32, block, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, len * block, true);
    for (var i = 0, o = 44; i < len; i++) for (var c = 0; c < n; c++, o += 2) {
      var s = Math.max(-1, Math.min(1, chans[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buf;
  }
  // Cut [start,end) seconds, linear fades, gain, optional mono downmix.
  function renderEdit(chans, rate, o) {
    var s0 = Math.max(0, Math.round(o.start * rate)), s1 = Math.min(chans[0].length, Math.round(o.end * rate)), n = Math.max(0, s1 - s0);
    var fi = Math.min(n, Math.round((o.fadeIn || 0) * rate)), fo = Math.min(n, Math.round((o.fadeOut || 0) * rate)), g = o.gain == null ? 1 : o.gain;
    var src = chans;
    if (o.mono && chans.length > 1) {
      var m = new Float32Array(n);
      for (var c = 0; c < chans.length; c++) for (var i = 0; i < n; i++) m[i] += chans[c][s0 + i] / chans.length;
      src = [m]; s0 = 0;
    }
    return src.map(function (ch) {
      var out = new Float32Array(n);
      for (var i = 0; i < n; i++) {
        var e = g;
        if (fi && i < fi) e *= i / fi;
        if (fo && i >= n - fo) e *= (n - 1 - i) / fo;
        out[i] = ch[s0 + i] * e;
      }
      return out;
    });
  }
  function peakOf(chans, a, b) { var p = 0; chans.forEach(function (ch) { for (var i = a; i < b; i++) { var x = Math.abs(ch[i]); if (x > p) p = x; } }); return p; }
  function columnPeaks(ch, cols) { // [min,max] per pixel column
    var out = new Float32Array(cols * 2), per = ch.length / cols;
    for (var c = 0; c < cols; c++) {
      var a = Math.floor(c * per), b = Math.max(a + 1, Math.floor((c + 1) * per)), lo = 0, hi = 0, step = Math.max(1, Math.floor((b - a) / 2000));
      for (var i = a; i < b && i < ch.length; i += step) { var x = ch[i]; if (x < lo) lo = x; if (x > hi) hi = x; }
      out[c * 2] = lo; out[c * 2 + 1] = hi;
    }
    return out;
  }
  function parseTime(s) {
    s = String(s).trim().replace(",", ".");
    if (!/^\d+(:\d+){0,2}(\.\d*)?$/.test(s)) return NaN;
    return s.split(":").reduce(function (acc, p) { return acc * 60 + parseFloat(p); }, 0);
  }
  function fmtT(sec) {
    sec = Math.max(0, sec);
    var ms = Math.round(sec * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, f = ms % 1000;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0") + "." + String(f).padStart(3, "0");
  }
  function tickStep(dur, px) {
    var steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    for (var i = 0; i < steps.length; i++) if (steps[i] / dur * px >= 70) return steps[i];
    return 3600;
  }

  // ---------- state ----------
  var A = null; // {buf, chans, rate, dur, name, peaks}
  var sel = { start: 0, end: 0 }, playheadT = null, ctx = null, play = null;
  var opts = Object.assign({ fadeIn: 0, fadeOut: 0, vol: 100, norm: false, mono: false, loop: false }, S3.store("trimmer") || {});
  var cv = $("#cv"), wave = $("#wave");

  function saveOpts() { S3.store("trimmer", opts); }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function len() { return sel.end - sel.start; }
  function gainTotal() {
    var g = opts.vol / 100;
    if (opts.norm && A) { var p = peakOf(A.chans, Math.floor(sel.start * A.rate), Math.floor(sel.end * A.rate)); if (p > 0) g *= Math.pow(10, -1 / 20) / p; }
    return g;
  }

  // ---------- loading ----------
  var input = S3.drop($("#drop"), function (files) { load(files[0]); }, { accept: "audio/*,.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,.webm,.weba", multiple: false });
  $("#another").addEventListener("click", function () { input.click(); });
  wave.addEventListener("dragover", function (e) { e.preventDefault(); });
  wave.addEventListener("drop", function (e) { e.preventDefault(); var f = e.dataTransfer.files[0]; if (f) load(f); });

  async function load(file) {
    stop();
    $("#finfo").textContent = "Decoding…";
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      var ab = await S3.readFile(file);
      var buf = await new Promise(function (res, rej) { ctx.decodeAudioData(ab, res, rej); });
      setAudio(buf, file.name);
    } catch (e) {
      S3.toast("Couldn't read that file. This browser can't decode its format.", "error");
      if (!A) $("#editor").hidden = true;
    }
  }
  function setAudio(buf, name) {
    var chans = []; for (var c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    A = { buf: buf, chans: chans, rate: buf.sampleRate, dur: buf.duration, name: name, peaks: null };
    sel = { start: 0, end: buf.duration }; playheadT = null;
    $("#drop").hidden = true; $("#editor").hidden = false;
    $("#fname").textContent = name; $("#fname").title = name;
    $("#finfo").textContent = fmtT(buf.duration).replace(/\.\d+$/, "") + " · " + (buf.sampleRate / 1000) + " kHz · " + (buf.numberOfChannels === 1 ? "mono" : buf.numberOfChannels === 2 ? "stereo" : buf.numberOfChannels + " ch");
    $$("#presets button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === "all")); });
    update();
  }

  // ---------- drawing ----------
  function x2t(x) { return Math.max(0, Math.min(A.dur, x / wave.clientWidth * A.dur)); }
  function t2pct(t) { return (t / A.dur * 100) + "%"; }
  function draw() {
    if (!A) return;
    var d = window.devicePixelRatio || 1, W = Math.round(wave.clientWidth * d), H = Math.round(wave.clientHeight * d);
    if (!W) return;
    if (cv.width !== W || cv.height !== H || !A.peaks) {
      cv.width = W; cv.height = H;
      A.peaks = A.chans.map(function (ch) { return columnPeaks(ch, W); });
    }
    var g = cv.getContext("2d"), rulerH = 18 * d, mid = (H - rulerH) / 2, amp = mid * 0.92;
    g.clearRect(0, 0, W, H);
    var a = sel.start / A.dur * W, b = sel.end / A.dur * W, on = cssVar("--accent"), off = cssVar("--text-3");
    var gt = gainTotal();
    for (var x = 0; x < W; x++) {
      var lo = 0, hi = 0;
      A.peaks.forEach(function (p) { if (p[x * 2] < lo) lo = p[x * 2]; if (p[x * 2 + 1] > hi) hi = p[x * 2 + 1]; });
      var inSel = x >= a && x <= b;
      if (inSel) { // show the result: gain + fade envelope
        var t = x / W * A.dur - sel.start, e = gt, L = len();
        if (opts.fadeIn > 0 && t < opts.fadeIn) e *= t / opts.fadeIn;
        if (opts.fadeOut > 0 && t > L - opts.fadeOut) e *= (L - t) / opts.fadeOut;
        lo = Math.max(-1, lo * e); hi = Math.min(1, hi * e);
      }
      g.fillStyle = inSel ? on : off;
      g.globalAlpha = inSel ? 1 : 0.55;
      var y1 = mid - hi * amp, y2 = mid - lo * amp;
      g.fillRect(x, y1, 1, Math.max(d, y2 - y1));
    }
    g.globalAlpha = 1;
    // ruler
    g.fillStyle = cssVar("--line-strong"); g.fillRect(0, H - rulerH, W, d);
    g.fillStyle = cssVar("--text-3"); g.font = (10.5 * d) + "px " + cssVar("--font");
    var st = tickStep(A.dur, wave.clientWidth);
    for (var tt = 0; tt <= A.dur + 1e-9; tt += st) {
      var tx = Math.round(tt / A.dur * W);
      g.fillRect(tx, H - rulerH, d, 5 * d);
      var lbl = fmtT(tt).replace(/\.(\d*?)0+$/, function (m, dd) { return dd ? "." + dd : ""; });
      if (tx < W - 30 * d) g.fillText(lbl, tx + 3 * d, H - 5 * d);
    }
  }
  function update() {
    if (!A) return;
    sel.start = Math.max(0, Math.min(sel.start, A.dur)); sel.end = Math.max(sel.start, Math.min(sel.end, A.dur));
    $("#selBox").style.left = t2pct(sel.start); $("#selBox").style.width = (len() / A.dur * 100) + "%";
    $("#hStart").style.left = t2pct(sel.start); $("#hEnd").style.left = t2pct(sel.end);
    [["#hStart", sel.start], ["#hEnd", sel.end]].forEach(function (p) { var h = $(p[0]); h.setAttribute("aria-valuenow", p[1].toFixed(3)); h.setAttribute("aria-valuetext", fmtT(p[1])); h.setAttribute("aria-valuemin", "0"); h.setAttribute("aria-valuemax", A.dur.toFixed(3)); });
    if (document.activeElement !== $("#tStart")) $("#tStart").value = fmtT(sel.start);
    if (document.activeElement !== $("#tEnd")) $("#tEnd").value = fmtT(sel.end);
    $("#tLen").textContent = fmtT(len());
    var maxF = Math.max(0, Math.min(10, len() / 2));
    ["fadeIn", "fadeOut"].forEach(function (k) { $("#" + k).max = maxF.toFixed(1); if (opts[k] > maxF) opts[k] = +maxF.toFixed(1); $("#" + k).value = opts[k]; });
    $("#fiV").textContent = opts.fadeIn.toFixed(1) + " s"; $("#foV").textContent = opts.fadeOut.toFixed(1) + " s";
    $("#volV").textContent = opts.vol + "%"; $("#vol").value = opts.vol;
    $("#norm").checked = opts.norm; $("#mono").checked = opts.mono; $("#loop").checked = opts.loop;
    var ch = opts.mono ? 1 : A.chans.length;
    $("#estimate").textContent = "≈ " + S3.fmtBytes(44 + Math.round(len() * A.rate) * ch * 2);
    $("#export").disabled = len() <= 0;
    var ph = $("#ph"); ph.hidden = playheadT == null; if (playheadT != null) ph.style.left = t2pct(playheadT);
    draw();
  }

  // ---------- selection interaction ----------
  function dragHandle(el, key) {
    el.addEventListener("pointerdown", function (e) {
      e.stopPropagation(); e.preventDefault(); el.setPointerCapture(e.pointerId); el.focus();
      function mv(ev) {
        var t = x2t(ev.clientX - wave.getBoundingClientRect().left);
        if (key === "start") sel.start = Math.min(t, sel.end); else sel.end = Math.max(t, sel.start);
        clearPreset(); update();
      }
      function up() { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); if (play) restartPlay(); }
      el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
    });
    el.addEventListener("keydown", function (e) {
      var step = e.shiftKey ? 1 : 0.01, dir = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
      if (e.key === "Home") { dir = -1; step = A.dur; } else if (e.key === "End") { dir = 1; step = A.dur; }
      if (!dir) return;
      e.preventDefault();
      if (key === "start") sel.start = Math.min(sel.end, Math.max(0, sel.start + dir * step)); else sel.end = Math.max(sel.start, Math.min(A.dur, sel.end + dir * step));
      clearPreset(); update();
    });
  }
  dragHandle($("#hStart"), "start"); dragHandle($("#hEnd"), "end");
  wave.addEventListener("pointerdown", function (e) {
    if (!A || e.button) return;
    var x0 = e.clientX, rect = wave.getBoundingClientRect(), t0 = x2t(x0 - rect.left), moved = false;
    wave.setPointerCapture(e.pointerId);
    function mv(ev) {
      if (!moved && Math.abs(ev.clientX - x0) < 4) return;
      moved = true;
      var t = x2t(ev.clientX - rect.left);
      sel.start = Math.min(t0, t); sel.end = Math.max(t0, t); clearPreset(); update();
    }
    function up() {
      wave.removeEventListener("pointermove", mv); wave.removeEventListener("pointerup", up); wave.removeEventListener("pointercancel", up);
      if (!moved) { // a click: listen from here (inside the selection) or move the nearest edge
        if (t0 >= sel.start && t0 <= sel.end) { playheadT = t0; if (play) restartPlay(t0); else update(); }
        else { if (Math.abs(t0 - sel.start) < Math.abs(t0 - sel.end)) sel.start = t0; else sel.end = t0; clearPreset(); update(); }
      } else if (play) restartPlay();
    }
    wave.addEventListener("pointermove", mv); wave.addEventListener("pointerup", up); wave.addEventListener("pointercancel", up);
  });
  function timeInput(id, key) {
    $(id).addEventListener("change", function () {
      var t = parseTime(this.value);
      if (isNaN(t)) { S3.toast("Use seconds (12.5) or m:ss.mmm (1:05.250)", "error"); update(); return; }
      if (key === "start") { sel.start = Math.min(t, A.dur); if (sel.end < sel.start) sel.end = sel.start; } else { sel.end = Math.min(t, A.dur); if (sel.start > sel.end) sel.start = sel.end; }
      clearPreset(); update();
    });
    $(id).addEventListener("keydown", function (e) { if (e.key === "Enter") this.blur(); });
    $(id).addEventListener("blur", update);
  }
  timeInput("#tStart", "start"); timeInput("#tEnd", "end");
  function clearPreset() { $$("#presets button").forEach(function (b) { b.setAttribute("aria-pressed", "false"); }); }
  $$("#presets button").forEach(function (b) {
    b.addEventListener("click", function () {
      if (!A) return;
      if (b.dataset.v === "all") { sel.start = 0; sel.end = A.dur; }
      else { var L = +b.dataset.v; if (sel.start + L > A.dur) sel.start = Math.max(0, A.dur - L); sel.end = Math.min(A.dur, sel.start + L); }
      $$("#presets button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      update(); if (play) restartPlay();
    });
  });
  [["#fadeIn", "fadeIn"], ["#fadeOut", "fadeOut"], ["#vol", "vol"]].forEach(function (p) {
    $(p[0]).addEventListener("input", function () { opts[p[1]] = +this.value; update(); if (play) applyGain(); });
    $(p[0]).addEventListener("change", saveOpts);
  });
  ["norm", "mono", "loop"].forEach(function (k) { $("#" + k).addEventListener("change", function () { opts[k] = this.checked; saveOpts(); update(); if (play && k === "norm") applyGain(); }); });

  // ---------- playback (preview with the same fades/gain) ----------
  function envAt(t) { var L = len(), e = 1; if (opts.fadeIn > 0 && t < opts.fadeIn) e *= t / opts.fadeIn; if (opts.fadeOut > 0 && t > L - opts.fadeOut) e *= Math.max(0, L - t) / opts.fadeOut; return e; }
  function applyGain() {
    if (!play) return;
    var gp = play.gain.gain, now = ctx.currentTime, t = play.off + (now - play.t0), L = len(), G = gainTotal();
    gp.cancelScheduledValues(now); gp.setValueAtTime(G * envAt(t - sel.start), now);
    var rel = t - sel.start;
    if (opts.fadeIn > 0 && rel < opts.fadeIn) gp.linearRampToValueAtTime(G, now + (opts.fadeIn - rel));
    var foStart = L - opts.fadeOut;
    if (opts.fadeOut > 0) { if (rel < foStart) gp.setValueAtTime(G, now + (foStart - rel)); gp.linearRampToValueAtTime(0, now + (L - rel)); }
  }
  async function startPlay(from) {
    if (!A || len() <= 0) return;
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    var off = from != null && from >= sel.start && from < sel.end ? from : sel.start;
    var src = ctx.createBufferSource(), gn = ctx.createGain();
    src.buffer = A.buf;
    if (opts.mono && A.chans.length > 1) { gn.channelCount = 1; gn.channelCountMode = "explicit"; }
    src.connect(gn); gn.connect(ctx.destination);
    play = { src: src, gain: gn, off: off, t0: ctx.currentTime };
    applyGain();
    src.start(0, off, sel.end - off);
    src.onended = function () { if (play && play.src === src) { if (opts.loop && !play.stopped) startPlay(); else stop(); } };
    setPlayBtn(true);
    requestAnimationFrame(tickPlay);
  }
  function tickPlay() {
    if (!play) return;
    playheadT = Math.min(sel.end, play.off + ctx.currentTime - play.t0);
    var ph = $("#ph"); ph.hidden = false; ph.style.left = t2pct(playheadT);
    requestAnimationFrame(tickPlay);
  }
  function stop() {
    if (play) { play.stopped = true; var s = play.src; play = null; try { s.stop(); } catch (e) { /* already stopped */ } }
    playheadT = null; setPlayBtn(false); if (A) update();
  }
  function restartPlay(from) { var p = play; if (!p) return; p.stopped = true; play = null; try { p.src.stop(); } catch (e) { /* ignore */ } startPlay(from); }
  function setPlayBtn(on) { $("#play span").textContent = on ? "Stop" : "Play selection"; $("#play use").setAttribute("href", on ? "#i-pause" : "#i-play"); }
  $("#play").addEventListener("click", function () { if (play) stop(); else startPlay(playheadT); });
  document.addEventListener("keydown", function (e) {
    if (!A || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.ctrlKey || e.metaKey) return;
    if (e.key === " " && !/BUTTON/.test(e.target.tagName)) { e.preventDefault(); $("#play").click(); }
  });

  // ---------- export ----------
  $("#export").addEventListener("click", function () {
    if (!A || len() <= 0) return;
    var out = renderEdit(A.chans, A.rate, { start: sel.start, end: sel.end, fadeIn: opts.fadeIn, fadeOut: opts.fadeOut, gain: gainTotal(), mono: opts.mono });
    var base = A.name.replace(/\.[^.]+$/, "") || "audio";
    S3.download(new Blob([encodeWAV(out, A.rate)], { type: "audio/wav" }), base + "-trimmed.wav");
    S3.done();
  });
  window.addEventListener("resize", S3.debounce(function () { if (A) { A.peaks = null; draw(); } }, 120));
  new MutationObserver(function () { draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // ---------- demo + self-test ----------
  window.S3_DEMO = function () {
    var rate = 22050, secs = 14, n = rate * secs, buf = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: rate });
    var L = buf.getChannelData(0), R = buf.getChannelData(1), notes = [261.6, 329.6, 392, 523.3, 440, 349.2, 392, 293.7];
    for (var i = 0; i < n; i++) {
      var t = i / rate, beat = Math.floor(t * 2), ph = t * 2 - beat, f = notes[beat % notes.length];
      var env = Math.exp(-ph * 3.2) * (0.55 + 0.4 * Math.sin(t * 0.45) ** 2), kick = beat % 2 ? 0 : Math.exp(-ph * 18) * Math.sin(2 * Math.PI * 55 * t);
      var v = env * (Math.sin(2 * Math.PI * f * t) * 0.5 + Math.sin(4 * Math.PI * f * t) * 0.2) + kick * 0.35;
      L[i] = v * 0.9; R[i] = v * 0.8 + 0.05 * Math.sin(2 * Math.PI * f * 1.005 * t) * env;
    }
    setAudio(buf, "demo-melody.wav");
    opts.fadeIn = 1; opts.fadeOut = 1.5; sel.start = 2.5; sel.end = 10.5;
    $$("#presets button").forEach(function (b) { b.setAttribute("aria-pressed", "false"); });
    update();
  };

  window.S3_SELFTEST = async function () {
    var wav = encodeWAV([new Float32Array([0, 1, -1]), new Float32Array([0.5, -0.5, 0])], 44100), v = new DataView(wav), u8 = new Uint8Array(wav);
    var hdr = String.fromCharCode.apply(null, u8.subarray(0, 4)) + String.fromCharCode.apply(null, u8.subarray(8, 16)) + String.fromCharCode.apply(null, u8.subarray(36, 40));
    var ok = hdr === "RIFFWAVEfmt data" && wav.byteLength === 56 && v.getUint32(4, true) === 48 && v.getUint16(22, true) === 2 &&
      v.getUint32(24, true) === 44100 && v.getUint32(28, true) === 176400 && v.getUint16(32, true) === 4 && v.getUint32(40, true) === 12 &&
      v.getInt16(44, true) === 0 && v.getInt16(46, true) === 16383 && v.getInt16(48, true) === 32767 && v.getInt16(50, true) === -16384 && v.getInt16(52, true) === -32768;
    // round trip through the browser's decoder
    var src = new Float32Array(300); for (var i = 0; i < 300; i++) src[i] = Math.sin(i / 5) * 0.7;
    var dec = await new Promise(function (res, rej) { new OfflineAudioContext(1, 300, 8000).decodeAudioData(encodeWAV([src], 8000), res, rej); });
    var err = 0, d0 = dec.getChannelData(0); for (i = 0; i < 300; i++) err = Math.max(err, Math.abs(d0[i] - src[i]));
    ok = ok && dec.length === 300 && dec.sampleRate === 8000 && err < 1 / 16000;
    // trim + fades + gain
    var ones = new Float32Array(1000).fill(1), out = renderEdit([ones], 1000, { start: 0.1, end: 0.6, fadeIn: 0.1, fadeOut: 0.1, gain: 0.5 })[0];
    ok = ok && out.length === 500 && out[0] === 0 && Math.abs(out[50] - 0.25) < 1e-6 && out[250] === 0.5 && out[499] === 0 && Math.abs(out[449] - 0.25) < 1e-6;
    var mono = renderEdit([new Float32Array([1, 1, 1, 1]), new Float32Array([0, 0, 0, 0.5])], 4, { start: 0.25, end: 1, mono: true });
    ok = ok && mono.length === 1 && mono[0].length === 3 && mono[0][0] === 0.5 && mono[0][2] === 0.75;
    ok = ok && renderEdit([ones], 1000, { start: 0.9, end: 5 })[0].length === 100; // end clamps to the file
    ok = ok && parseTime("1:05.5") === 65.5 && parseTime("12,25") === 12.25 && parseTime("1:02:03") === 3723 && isNaN(parseTime("abc")) && isNaN(parseTime("-3"));
    ok = ok && "0:10.500".replace(/\.(\d*?)0+$/, function (m, dd) { return dd ? "." + dd : ""; }) === "0:10.5" && fmtT(65.25) === "1:05.250" && fmtT(3723) === "1:02:03.000" && tickStep(60, 700) === 10 && tickStep(1, 700) === 0.1;
    var cp = columnPeaks(new Float32Array([0.1, -0.4, 0.9, -0.2]), 2);
    ok = ok && Math.abs(cp[0] + 0.4) < 1e-6 && Math.abs(cp[1] - 0.1) < 1e-6 && Math.abs(cp[2] + 0.2) < 1e-6 && Math.abs(cp[3] - 0.9) < 1e-6;
    ok = ok && Math.abs(peakOf([new Float32Array([0.2, -0.8, 0.5])], 0, 3) - 0.8) < 1e-6;
    return ok;
  };
})();
