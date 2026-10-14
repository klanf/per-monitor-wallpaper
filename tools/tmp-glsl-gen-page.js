// 临时工具：生成 Edge/Chromium headless 用的 GLSL 编译测试页
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'stage.js'), 'utf8');
const frag = src.match(/const DEPTH_FS = `([\s\S]*?)`;/)[1];
// 负向控制：--neg 在 main() 开头注入未声明变量，应编译失败 ——
// 证明「通过」是真的通过而不是页面没跑/替换 no-op（r75 追记实锤：旧 neg 目标串
// 被 r73 重构删掉后 --neg 静默失配，负向验了个寂寞）
const fragUse = (process.argv.includes('--neg'))
  ? frag.replace('void main() {', 'void main() { float __neg_probe = undeclared_neg_var;')
  : frag;
const vert = 'attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }';
const html = `<!DOCTYPE html><html><body><div id="r">PENDING</div><script>
const frag = ${JSON.stringify(fragUse)};
const vert = ${JSON.stringify(vert)};
const cv = document.createElement('canvas');
const gl = cv.getContext('webgl', { antialias: false });
const el = document.getElementById('r');
if (!gl) { el.textContent = 'RESULT-NOCONTEXT'; }
else {
  const mk = (type, s) => {
    const sh = gl.createShader(type); gl.shaderSource(sh, s); gl.compileShader(sh);
    return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? null : gl.getShaderInfoLog(sh);
  };
  const ve = mk(gl.VERTEX_SHADER, vert);
  const fe = mk(gl.FRAGMENT_SHADER, frag);
  el.textContent = (!ve && !fe) ? 'GLSL-COMPILE-OK' : ('RESULT-FAIL:' + (ve || fe));
}
</script></body></html>`;
const outName = process.argv.includes('--neg') ? 'tmp-glsl-page-neg.html' : 'tmp-glsl-page-edge.html';
fs.writeFileSync(path.join(__dirname, outName), html);
console.log('written', outName);
