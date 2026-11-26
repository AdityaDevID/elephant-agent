'use strict';

// Base URL default Ollama: ikut env OLLAMA_HOST kalau ada (mis. "0.0.0.0:11434" atau "http://192.168.1.5:11434").
// Pakai 127.0.0.1, bukan "localhost": di Node baru "localhost" bisa jadi ::1 padahal Ollama hanya di IPv4.
function ollamaBase() {
  const h = String(process.env.OLLAMA_HOST || '').trim();
  if (!h) return 'http://127.0.0.1:11434/v1';
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(h) ? h : 'http://' + h);
    if (u.hostname === '0.0.0.0') u.hostname = '127.0.0.1';
    if (!u.port && u.protocol === 'http:') u.port = '11434';
    return u.origin + '/v1';
  } catch {
    return 'http://127.0.0.1:11434/v1';
  }
}

// kind: 'anthropic' = API Messages Anthropic; 'openai' = semua yang OpenAI-compatible.
// `models` hanya cadangan kalau daftar model live gagal diambil.
const PROVIDERS = [
  {
    id: 'anthropic', name: 'Claude (Anthropic)', kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com', envKey: 'ANTHROPIC_API_KEY',
    keyUrl: 'https://console.anthropic.com/settings/keys', tags: 'claude anthropic sonnet opus haiku',
    models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
  },
  {
    id: 'openai', streamUsage: true, name: 'ChatGPT (OpenAI)', kind: 'openai',
    baseUrl: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY',
    keyUrl: 'https://platform.openai.com/api-keys', tags: 'openai chatgpt gpt',
    models: ['gpt-4o', 'gpt-4o-mini'],
  },
  {
    id: 'gemini', name: 'Gemini (Google)', kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', envKey: 'GEMINI_API_KEY',
    keyUrl: 'https://aistudio.google.com/apikey', tags: 'gemini google aistudio',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  },
  {
    id: 'groq', streamUsage: true, name: 'Groq', kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1', envKey: 'GROQ_API_KEY',
    keyUrl: 'https://console.groq.com/keys', tags: 'groq llama cepat gratis',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  },
  {
    id: 'nvidia', name: 'NVIDIA NIM', kind: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1', envKey: 'NVIDIA_API_KEY',
    keyUrl: 'https://build.nvidia.com/settings/api-keys', tags: 'nvidia nim build',
    models: ['meta/llama-3.1-70b-instruct'],
  },
  {
    id: 'openrouter', name: 'OpenRouter', kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/keys', tags: 'openrouter router banyak model',
    models: ['openrouter/auto'],
  },
  {
    // Base URL Vikey tidak saya temukan di sumber publik: user isi sendiri dari dashboard Vikey.
    id: 'vikey', name: 'Vikey AI', kind: 'openai',
    baseUrl: '', askBaseUrl: true, baseUrlHint: 'Base URL OpenAI-compatible dari dashboard Vikey (berakhiran /v1)',
    envKey: 'VIKEY_API_KEY', keyUrl: '', tags: 'vikey',
    models: [],
  },
  {
    id: 'deepseek', streamUsage: true, name: 'DeepSeek', kind: 'openai',
    baseUrl: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEY',
    keyUrl: 'https://platform.deepseek.com/api_keys', tags: 'deepseek',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'mistral', name: 'Mistral AI', kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1', envKey: 'MISTRAL_API_KEY',
    keyUrl: 'https://console.mistral.ai/api-keys', tags: 'mistral',
    models: ['mistral-large-latest', 'mistral-small-latest'],
  },
  {
    id: 'xai', streamUsage: true, name: 'xAI (Grok)', kind: 'openai',
    baseUrl: 'https://api.x.ai/v1', envKey: 'XAI_API_KEY',
    keyUrl: 'https://console.x.ai', tags: 'xai grok',
    models: ['grok-3'],
  },
  {
    id: 'together', name: 'Together AI', kind: 'openai',
    baseUrl: 'https://api.together.xyz/v1', envKey: 'TOGETHER_API_KEY',
    keyUrl: 'https://api.together.ai/settings/api-keys', tags: 'together',
    models: [],
  },
  {
    id: 'ollama', name: 'Ollama (lokal)', kind: 'openai',
    baseUrl: ollamaBase(), askBaseUrl: true, needsKey: false,
    baseUrlHint: 'default http://127.0.0.1:11434 (Ollama harus sedang jalan: ollama serve)',
    keyUrl: '', tags: 'ollama lokal local offline',
    models: [],
  },
  {
    id: 'custom', name: 'Custom (OpenAI-compatible)', kind: 'openai',
    baseUrl: '', askBaseUrl: true, keyRequired: false, baseUrlHint: 'mis. http://127.0.0.1:8000/v1',
    keyUrl: '', tags: 'custom lainnya other proxy vllm lmstudio litellm',
    models: [],
  },
].map((p) => ({ ...p, host: hostOf(p.baseUrl) }));

function hostOf(u) {
  try { return new URL(u).host; } catch { return ''; }
}

const getProvider = (id) => PROVIDERS.find((p) => p.id === id) || null;

// Tebak provider dari awalan API key (membantu saat key langsung di-paste).
function detectProvider(key) {
  const k = String(key).trim();
  const rules = [
    ['sk-ant-', 'anthropic'],
    ['sk-or-', 'openrouter'],
    ['gsk_', 'groq'],
    ['AIza', 'gemini'],
    ['nvapi-', 'nvidia'],
    ['xai-', 'xai'],
    ['sk-', 'openai'],
  ];
  for (const [prefix, id] of rules) if (k.startsWith(prefix)) return getProvider(id);
  return null;
}

module.exports = { PROVIDERS, getProvider, detectProvider, ollamaBase };
