// Validation helper (distroless-native-validation.yml): a real @qvac/sdk model load, one chat completion, unload. Importing the SDK is not enough:
// the worker loads native addons that need shared libraries (libatomic, libvulkan) a distroless image does not ship by default.
// Usage inside the server image: node qvac-model-completion-check.mjs /models/<file>.gguf
import { loadModel, completion, unloadModel, close } from '@qvac/sdk'

const modelSrc = process.argv[2]
if (!modelSrc) { console.error('usage: qvac-model-completion-check.mjs <model.gguf>'); process.exit(2) }
const t0 = Date.now()
const id = await loadModel({ modelSrc, modelType: 'llm' })
console.log('LOADED', id, `${Date.now() - t0} ms`)
const run = completion({ modelId: id, history: [{ role: 'user', content: 'Reply with one short sentence about the sea.' }], stream: false })
const text = String(typeof run.text === 'string' ? run.text : await run.text)
console.log('COMPLETION_CHARS', text.length)
await unloadModel({ modelId: id })
console.log('UNLOADED')
try { await close?.() } catch { /* best effort */ }
process.exit(text.trim().length > 0 ? 0 : 3)
