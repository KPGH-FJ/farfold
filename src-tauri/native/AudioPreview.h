#pragma once
#include <stddef.h>
#include <stdint.h>

typedef int32_t (*FFAudioPreviewSink)(void *context, const float *samples,
                                    uint32_t frames, uint32_t channels);
typedef struct {
  uint32_t sample_rate;
  uint32_t channels;
  uint64_t frames;
} FFAudioPreviewInfo;

// Complete memory input; synchronous bounded-block output. No file, device or
// graph is opened. 0 success, 1 invalid, 2 unsupported, 3 limit, 4 sink failure.
int32_t ff_audio_preview(const uint8_t *bytes, size_t length, void *context,
                         FFAudioPreviewSink sink, FFAudioPreviewInfo *info);
