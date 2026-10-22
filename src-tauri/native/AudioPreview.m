#include "AudioPreview.h"
#include <AudioToolbox/AudioToolbox.h>
#include <math.h>
#include <string.h>

typedef struct {
  const uint8_t *bytes;
  size_t length;
} FFAudioInput;

static OSStatus ff_read_audio(void *context, SInt64 offset, UInt32 requested,
                              void *destination, UInt32 *actual) {
  FFAudioInput *input = context;
  *actual = 0;
  if (offset < 0) return kAudioFilePositionError;
  if ((UInt64)offset >= input->length) return noErr;
  size_t remaining = input->length - (size_t)offset;
  size_t count = remaining < requested ? remaining : requested;
  memcpy(destination, input->bytes + offset, count);
  *actual = (UInt32)count;
  return noErr;
}

static SInt64 ff_audio_size(void *context) {
  return ((FFAudioInput *)context)->length;
}

int32_t ff_audio_preview(const uint8_t *bytes, size_t length, void *context,
                         FFAudioPreviewSink sink, FFAudioPreviewInfo *info) {
  const size_t limit = 16 * 1024 * 1024;
  if (!bytes || !length || !sink || !info) return 1;
  if (length > limit) return 3;
  *info = (FFAudioPreviewInfo){0};
  FFAudioInput input = {bytes, length};
  AudioFileID file = NULL;
  ExtAudioFileRef decoder = NULL;
  int32_t result = 1;
  if (AudioFileOpenWithCallbacks(&input, ff_read_audio, NULL, ff_audio_size,
                                NULL, 0, &file) != noErr)
    return 1;
  if (ExtAudioFileWrapAudioFileID(file, false, &decoder) != noErr) goto done;
  AudioStreamBasicDescription source = {0};
  UInt32 size = sizeof(source);
  if (ExtAudioFileGetProperty(decoder, kExtAudioFileProperty_FileDataFormat,
                             &size, &source) != noErr)
    goto done;
  // This is an additional compatibility path. Other formats keep their
  // original HTML media path; a MIME label cannot widen this decoder policy.
  if ((source.mFormatID != kAudioFormatMPEG4AAC &&
       source.mFormatID != kAudioFormatFLAC) ||
      source.mChannelsPerFrame < 1 || source.mChannelsPerFrame > 2 ||
      !isfinite(source.mSampleRate) || source.mSampleRate < 8000 ||
      source.mSampleRate > 96000 || floor(source.mSampleRate) != source.mSampleRate) {
    result = 2;
    goto done;
  }
  AudioStreamBasicDescription target = {
      source.mSampleRate, kAudioFormatLinearPCM,
      kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
      4 * source.mChannelsPerFrame, 1, 4 * source.mChannelsPerFrame,
      source.mChannelsPerFrame, 32, 0};
  if (ExtAudioFileSetProperty(decoder, kExtAudioFileProperty_ClientDataFormat,
                             sizeof(target), &target) != noErr)
    goto done;
  // No allocation based on an untrusted total sample declaration. Both the
  // native producer and Rust sink independently enforce the output cap.
  float block[4096 * 2];
  uint64_t frames = 0;
  for (;;) {
    UInt32 count = 4096;
    AudioBufferList buffers = {
        1, {{target.mChannelsPerFrame, sizeof(block), block}}};
    if (ExtAudioFileRead(decoder, &count, &buffers) != noErr) goto done;
    if (!count) break;
    if (count > 4096 || frames + count > target.mSampleRate * 600 ||
        (frames + count) * target.mBytesPerFrame > limit - 44) {
      result = 3;
      goto done;
    }
    for (size_t i = 0; i < (size_t)count * target.mChannelsPerFrame; i++) {
      if (!isfinite(block[i])) goto done;
    }
    if (sink(context, block, count, target.mChannelsPerFrame) != 0) {
      result = 4;
      goto done;
    }
    frames += count;
  }
  if (!frames) goto done;
  *info = (FFAudioPreviewInfo){(uint32_t)target.mSampleRate,
                             target.mChannelsPerFrame, frames};
  result = 0;
done:
  if (decoder && ExtAudioFileDispose(decoder) != noErr) result = 1;
  if (AudioFileClose(file) != noErr) result = 1;
  return result;
}
