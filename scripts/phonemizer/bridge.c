/* Original bridge: MIT (see project LICENSE).
 * Linked eSpeak NG candidate: GPL-3.0-or-later; not an Apache phonemizer.
 * Only text-to-IPA is exposed. No synthesis, audio device or transport API.
 */
#include <espeak-ng/speak_lib.h>
#include <stddef.h>

static const void *cursor;

int pv_init(void) {
  if (espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, 0, "/", espeakINITIALIZE_DONT_EXIT) <= 0)
    return -1;
  return espeak_SetVoiceByName("en-us") == EE_OK ? 0 : -1;
}

void pv_begin(const char *text) { cursor = text; }
int pv_pending(void) { return cursor != NULL; }
const char *pv_next(void) {
  const void *before = cursor;
  const char *result = espeak_TextToPhonemes(&cursor, espeakCHARS_UTF8, 2);
  /* Fail closed if an upstream change stops advancing the input. */
  return cursor == before ? NULL : result;
}
