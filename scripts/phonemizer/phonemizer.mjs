/* Original wrapper: MIT (see project LICENSE).
 * Combined native candidate: GPL-3.0-or-later. See adjacent source and notices.
 * createEspeak is the pinned, single-file Emscripten factory prepended at build.
 */
let runtime;
export async function phonemize(text, language) {
  if (language !== "en-us" || typeof text !== "string" || text.length > 1000 || text.includes("\0"))
    throw new Error("Unsupported English phonemizer input");
  if (!text.trim()) return [];
  runtime ??= createEspeak().then(module => {
    if (module._pv_init() !== 0) throw new Error("English phonemizer initialization failed");
    return module;
  });
  const module = await runtime;
  // No await between begin/free: calls cannot interleave the native cursor.
  const pointer = module._malloc(module.lengthBytesUTF8(text) + 1);
  if (!pointer) throw new Error("English phonemizer allocation failed");
  try {
    module.stringToUTF8(text, pointer, module.lengthBytesUTF8(text) + 1);
    module._pv_begin(pointer);
    const clauses = [];
    while (module._pv_pending()) {
      if (clauses.length >= 1000) throw new Error("English phonemizer clause limit");
      const result = module._pv_next();
      if (!result) throw new Error("English phonemizer conversion failed");
      clauses.push(module.UTF8ToString(result));
    }
    return clauses;
  } finally { module._free(pointer); }
}
