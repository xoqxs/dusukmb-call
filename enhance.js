// DusukMB Call - alıcı tarafta görüntü netleştirme (WebGL)
// Sürüm 1: GPU'da 2x büyütme + uyarlamalı keskinleştirme (AMD FidelityFX CAS tarzı).
// Eski telefonlarda (iPhone 7 Plus, Redmi Note 9) bile çalışacak kadar hafif.
// Sürüm 2'de bu kısmın yerine küçük bir yapay zekâ modeli (ONNX Runtime Web) takılacak.
window.Enhancer = (() => {
  const VS = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main() {
      v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }`;
  const FS = `
    precision mediump float;
    uniform sampler2D u_tex;
    uniform vec2 u_texel;   // 1 / kaynak çözünürlük
    uniform float u_sharp;  // 0..1
    varying vec2 v_uv;
    void main() {
      vec3 b = texture2D(u_tex, v_uv + vec2(0.0, -u_texel.y)).rgb;
      vec3 d = texture2D(u_tex, v_uv + vec2(-u_texel.x, 0.0)).rgb;
      vec3 e = texture2D(u_tex, v_uv).rgb;
      vec3 f = texture2D(u_tex, v_uv + vec2(u_texel.x, 0.0)).rgb;
      vec3 h = texture2D(u_tex, v_uv + vec2(0.0, u_texel.y)).rgb;
      vec3 mn = min(min(min(d, e), min(f, b)), h);
      vec3 mx = max(max(max(d, e), max(f, b)), h);
      // Kenarda güçlü, düz alanda (sıkıştırma gürültüsü) zayıf keskinleştir
      vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(0.0001)), 0.0, 1.0));
      vec3 w = amp * (-1.0 / mix(8.0, 5.0, u_sharp));
      vec3 col = ((b + d + f + h) * w + e) / (1.0 + 4.0 * w);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`;

  function create(video, canvas) {
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: false }) ||
               canvas.getContext('experimental-webgl');
    const api = { supported: !!gl, enabled: false, lastMs: 0, start, stop, setEnabled };
    if (!gl) { canvas.style.display = 'none'; return api; }

    const compile = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    try {
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
    } catch (e) { console.warn(e); api.supported = false; canvas.style.display = 'none'; return api; }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const uTexel = gl.getUniformLocation(prog, 'u_texel');
    const uSharp = gl.getUniformLocation(prog, 'u_sharp');
    gl.uniform1f(uSharp, 0.6);

    let running = false, frame = 0, handle = null;
    const useRvfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

    function draw() {
      if (!running) return;
      const vw = video.videoWidth, vh = video.videoHeight;
      if (vw && vh && video.readyState >= 2) {
        // 3x'e kadar büyüt, ama ekrandaki gerçek pikselden büyük olmasın
        const maxSide = Math.max(canvas.clientWidth, canvas.clientHeight) * (window.devicePixelRatio || 1);
        const scale = Math.max(1, Math.min(3, maxSide / Math.max(vw, vh)));
        const cw = Math.round(vw * scale), ch = Math.round(vh * scale);
        if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
        const t0 = performance.now();
        gl.viewport(0, 0, cw, ch);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
        gl.uniform2f(uTexel, 1 / vw, 1 / vh);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        if (++frame % 30 === 0) { gl.finish(); api.lastMs = performance.now() - t0; }
      }
      schedule();
    }
    function schedule() {
      handle = useRvfc ? video.requestVideoFrameCallback(draw) : requestAnimationFrame(draw);
    }
    function start() {
      if (!api.enabled && api.enabledOnce !== false) setEnabled(true);
    }
    function stop() {
      running = false;
      if (handle != null) { useRvfc ? video.cancelVideoFrameCallback(handle) : cancelAnimationFrame(handle); handle = null; }
    }
    function setEnabled(on) {
      api.enabled = on;
      api.enabledOnce = on;
      canvas.style.display = on ? 'block' : 'none';
      video.classList.toggle('behind', on); // ses çalmaya devam etsin diye video gizlenmez, arkaya alınır
      if (on && !running) { running = true; schedule(); }
      if (!on) stop();
    }
    return api;
  }
  return { create };
})();
