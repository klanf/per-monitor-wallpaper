/* 探针：测 onnxruntime-node 在本机可用的执行器（DML/CUDA/CPU）+ 耗时对比。 */
const path = require('path');
const ort = require('onnxruntime-node');

const MODEL = path.join(__dirname, '..', 'models', 'depth-anything', 'depth_anything_v2_small.onnx');

async function bench(label, providers) {
  try {
    const t0 = Date.now();
    const session = await ort.InferenceSession.create(MODEL, {
      executionProviders: providers,
      graphOptimizationLevel: 'all',
    });
    const createMs = Date.now() - t0;
    const input = session.inputNames[0];
    const meta = session.inputMetadata[0];
    const dims = meta.dimensions && meta.dimensions.length ? meta.dimensions.map(d => d || 1) : [1, 3, 518, 518];
    const size = dims.reduce((a, b) => a * b, 1);
    const data = new Float32Array(size);
    for (let i = 0; i < size; i++) data[i] = Math.random() - 0.5;
    const feed = { [input]: new ort.Tensor('float32', data, dims) };
    await session.run(feed);
    const times = [];
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      await session.run(feed);
      times.push(Date.now() - t);
    }
    const avg = ((times[1] + times[2]) / 2).toFixed(0);
    console.log(`${label.padEnd(14)} 会话创建 ${String(createMs).padStart(5)}ms | 推理均值 ${avg}ms (${times.join('/')})`);
    return { ok: true, avg: Number(avg) };
  } catch (err) {
    console.log(`${label.padEnd(14)} FAIL ${String(err.message).split('\n')[0].slice(0, 90)}`);
    return { ok: false };
  }
}

(async () => {
  console.log('模型:', MODEL);
  await bench('cpu', ['cpu']);
  await bench('dml(GPU)', ['dml', 'cpu']);
  await bench('cuda(GPU)', ['cuda', 'cpu']);
})();
