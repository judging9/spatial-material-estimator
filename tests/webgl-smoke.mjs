import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Uses installed browsers only. Verifies a real GPU pipeline by reading pixels
// produced by compiled vertex/fragment shaders; no network or application data.
const installed = process.env.CHROME_PATH || [
  'C:/Users/17846/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find(existsSync);
if (!installed) throw new Error('No installed Chromium/Chrome/Edge found; set CHROME_PATH.');
const profiles = [
  { name: 'default', executablePath: installed, args: ['--no-sandbox'] },
  { name: 'software-angle', executablePath: installed, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }
];
const results = [];
for (const profile of profiles) {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: profile.executablePath, headless: true, args: profile.args });
    const page = await browser.newPage();
    await page.goto('about:blank');
    const contexts = await page.evaluate(() => ['webgl2', 'webgl'].map(kind => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
      const gl = canvas.getContext(kind, { alpha: false, antialias: true, stencil: true, preserveDrawingBuffer: true });
      if (!gl) return { kind, ready: false, reason: 'context unavailable' };
      const vertex = kind === 'webgl2'
        ? '#version 300 es\nin vec3 aPosition; void main(){gl_Position=vec4(aPosition,1.0);}'
        : 'attribute vec3 aPosition; void main(){gl_Position=vec4(aPosition,1.0);}';
      const fragment = kind === 'webgl2'
        ? '#version 300 es\nprecision mediump float; out vec4 pixel; void main(){pixel=vec4(0.2,0.6,0.4,1.0);}'
        : 'precision mediump float; void main(){gl_FragColor=vec4(0.2,0.6,0.4,1.0);}';
      const compile = (type, source) => {
        const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        return shader;
      };
      try {
        const vs = compile(gl.VERTEX_SHADER, vertex), fs = compile(gl.FRAGMENT_SHADER, fragment);
        const program = gl.createProgram(); gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        gl.useProgram(program);
        const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,0, 1,-1,0, 0,1,0]), gl.STATIC_DRAW);
        const position = gl.getAttribLocation(program, 'aPosition');
        gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0);
        gl.viewport(0, 0, 64, 64); gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST); gl.drawArrays(gl.TRIANGLES, 0, 3);
        const pixel = new Uint8Array(4); gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        // Exercise the stencil path needed for a floor's real internal holes.
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
        gl.enable(gl.STENCIL_TEST); gl.stencilMask(255); gl.stencilFunc(gl.ALWAYS, 1, 255); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        gl.colorMask(false, false, false, false); gl.depthMask(false); gl.disable(gl.DEPTH_TEST);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-.25,-.25,0, .25,-.25,0, .25,.25,0, -.25,-.25,0, .25,.25,0, -.25,.25,0]), gl.STATIC_DRAW);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.colorMask(true, true, true, true); gl.depthMask(true); gl.enable(gl.DEPTH_TEST);
        gl.stencilMask(0); gl.stencilFunc(gl.EQUAL, 0, 255); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,0, 1,-1,0, 1,1,0, -1,-1,0, 1,1,0, -1,1,0]), gl.STATIC_DRAW);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        const holePixel = new Uint8Array(4), floorPixel = new Uint8Array(4);
        gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, holePixel);
        gl.readPixels(8, 8, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, floorPixel);
        gl.disable(gl.STENCIL_TEST);
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        const result = { kind, ready: true, pixel: [...pixel], holePixel: [...holePixel], floorPixel: [...floorPixel], error: gl.getError(), renderer, stencilBits: gl.getParameter(gl.STENCIL_BITS), attributes: gl.getContextAttributes() };
        gl.deleteBuffer(buffer); gl.deleteProgram(program); gl.deleteShader(vs); gl.deleteShader(fs);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return result;
      } catch (error) { return { kind, ready: false, reason: error.message }; }
    }));
    results.push({ profile: profile.name, executablePath: profile.executablePath, args: profile.args, contexts });
  } catch (error) { results.push({ profile: profile.name, error: error.message }); }
  finally { await browser?.close(); }
}
await mkdir('artifacts/studio', { recursive: true });
await writeFile('artifacts/studio/webgl-environment.json', JSON.stringify(results, null, 2));
const working = results.flatMap(profile => (profile.contexts || []).filter(context => context.ready && context.error === 0 && context.stencilBits > 0 && context.pixel.slice(0,3).every((value,index) => Math.abs(value-[51,153,102][index])<=1) && context.holePixel.slice(0,3).every(value=>value===255) && context.floorPixel.slice(0,3).every((value,index)=>Math.abs(value-[51,153,102][index])<=1)).map(context => `${profile.profile}/${context.kind}`));
console.log(JSON.stringify(results, null, 2));
assert.ok(working.length, 'No installed browser profile produced real WebGL pixels with stencil support.');
console.log('Actual shader/render/readPixels passed:', working.join(', '));
