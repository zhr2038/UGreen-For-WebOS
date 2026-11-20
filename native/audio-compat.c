/* LGPL-2.1 compatible Matroska GOP audio compatibility worker (WASM).
 * Demuxes a Matroska header + Cluster byte slice over custom streaming AVIO,
 * copies video bitstreams (converting hvcC/avcC to Annex-B when needed), and
 * transcodes incompatible audio (DTS/TrueHD/PCM/FLAC/etc.) to EAC3/AC3 MPEG-TS.
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <libavcodec/avcodec.h>
#include <libavcodec/bsf.h>
#include <libavformat/avformat.h>
#include <libavutil/audio_fifo.h>
#include <libavutil/channel_layout.h>
#include <libavutil/error.h>
#include <libavutil/mathematics.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>

__attribute__((import_module("env"), import_name("host_read")))
extern int host_read(uint8_t *buf, int size);

__attribute__((import_module("env"), import_name("host_write")))
extern int host_write(const uint8_t *buf, int size);

#define IO_BUF_SIZE 32768
#define MAX_PENDING_PKTS 512

static int avio_read_cb(void *opaque, uint8_t *buf, int size) {
  (void)opaque;
  int n = host_read(buf, size);
  if (n <= 0) return AVERROR_EOF;
  return n;
}

#if LIBAVFORMAT_VERSION_MAJOR >= 61
static int avio_write_cb(void *opaque, const uint8_t *buf, int size) {
#else
static int avio_write_cb(void *opaque, uint8_t *buf, int size) {
#endif
  (void)opaque;
  int n = host_write(buf, size);
  if (n < 0) return AVERROR(EIO);
  return n;
}

typedef struct PendingPkt {
  AVPacket *pkt;
} PendingPkt;

static int64_t pkt_ts_ms(const AVPacket *pkt, AVRational tb) {
  int64_t ts = pkt->pts != AV_NOPTS_VALUE ? pkt->pts : pkt->dts;
  if (ts == AV_NOPTS_VALUE) return INT64_MIN;
  return av_rescale_q(ts, tb, (AVRational){1, 1000});
}

static void init_out_audio_params(AVCodecContext *enc_ctx, const AVCodec *enc,
                                  const AVChannelLayout *in_layout) {
  int in_ch = in_layout->nb_channels;
  int channels = in_ch >= 5 ? 6 : (in_ch >= 2 ? 2 : 1);
  if (channels == 6) {
    AVChannelLayout layout = AV_CHANNEL_LAYOUT_5POINT1;
    av_channel_layout_copy(&enc_ctx->ch_layout, &layout);
  } else {
    av_channel_layout_default(&enc_ctx->ch_layout, channels);
  }
  enc_ctx->sample_rate = 48000;
  enc_ctx->sample_fmt = AV_SAMPLE_FMT_FLTP;
  if (enc->sample_fmts) {
    int ok = 0;
    for (const enum AVSampleFormat *p = enc->sample_fmts; *p != AV_SAMPLE_FMT_NONE; p++) {
      if (*p == AV_SAMPLE_FMT_FLTP) { ok = 1; break; }
    }
    if (!ok) enc_ctx->sample_fmt = enc->sample_fmts[0];
  }
  enc_ctx->bit_rate = channels == 6 ? 640000 : (channels == 2 ? 256000 : 192000);
  enc_ctx->time_base = (AVRational){1, 48000};
}

static int drain_audio_fifo(AVAudioFifo *fifo, int frame_size,
                            AVCodecContext *enc_ctx, AVFrame *enc_frame,
                            AVPacket *enc_pkt, AVFormatContext *out_ctx,
                            AVStream *out_stream, int64_t *next_pts_samples,
                            int pad_last) {
  AVRational tb90k = out_stream->time_base;
  AVRational enc_tb = enc_ctx->time_base;
  while (av_audio_fifo_size(fifo) >= frame_size ||
         (pad_last && av_audio_fifo_size(fifo) > 0)) {
    int to_read = av_audio_fifo_size(fifo);
    if (to_read > frame_size) to_read = frame_size;

    av_frame_unref(enc_frame);
    enc_frame->nb_samples = frame_size;
    av_channel_layout_copy(&enc_frame->ch_layout, &enc_ctx->ch_layout);
    enc_frame->format = enc_ctx->sample_fmt;
    enc_frame->sample_rate = enc_ctx->sample_rate;
    int ret = av_frame_get_buffer(enc_frame, 0);
    if (ret < 0) return ret;

    if (to_read < frame_size) {
      av_samples_set_silence(enc_frame->extended_data, to_read,
                             frame_size - to_read,
                             enc_frame->ch_layout.nb_channels,
                             enc_ctx->sample_fmt);
    }
    int got = av_audio_fifo_read(fifo, (void **)enc_frame->extended_data, to_read);
    if (got < 0) return got;

    enc_frame->pts = *next_pts_samples;
    *next_pts_samples += frame_size;

    ret = avcodec_send_frame(enc_ctx, enc_frame);
    if (ret < 0) return ret;
    while ((ret = avcodec_receive_packet(enc_ctx, enc_pkt)) >= 0) {
      enc_pkt->stream_index = out_stream->index;
      av_packet_rescale_ts(enc_pkt, enc_tb, tb90k);
      enc_pkt->pos = -1;
      int wret = av_interleaved_write_frame(out_ctx, enc_pkt);
      av_packet_unref(enc_pkt);
      if (wret < 0) return wret;
    }
    if (ret != AVERROR(EAGAIN) && ret != AVERROR_EOF) return ret;
  }
  return 0;
}

static int flush_encoder(AVCodecContext *enc_ctx, AVPacket *enc_pkt,
                         AVFormatContext *out_ctx, AVStream *out_stream) {
  int ret = avcodec_send_frame(enc_ctx, NULL);
  if (ret < 0 && ret != AVERROR_EOF) return ret;
  while ((ret = avcodec_receive_packet(enc_ctx, enc_pkt)) >= 0) {
    enc_pkt->stream_index = out_stream->index;
    av_packet_rescale_ts(enc_pkt, enc_ctx->time_base, out_stream->time_base);
    enc_pkt->pos = -1;
    int wret = av_interleaved_write_frame(out_ctx, enc_pkt);
    av_packet_unref(enc_pkt);
    if (wret < 0) return wret;
  }
  if (ret == AVERROR_EOF || ret == AVERROR(EAGAIN)) return 0;
  return ret;
}

__attribute__((export_name("ca_transcode_gop")))
int ca_transcode_gop(int64_t start_ms, int64_t end_ms, int audio_track_index) {
  int rc = -1;
  uint8_t *in_io_buf = NULL, *out_io_buf = NULL;
  AVIOContext *in_avio = NULL, *out_avio = NULL;
  AVFormatContext *in_ctx = NULL, *out_ctx = NULL;
  const AVInputFormat *mkv_fmt = NULL;
  const AVOutputFormat *ts_fmt = NULL;
  AVBSFContext *bsf_ctx = NULL;
  AVCodecContext *dec_ctx = NULL, *enc_ctx = NULL;
  SwrContext *swr_ctx = NULL;
  AVAudioFifo *fifo = NULL;
  AVPacket *pkt = NULL, *bsf_pkt = NULL, *enc_pkt = NULL;
  AVFrame *dec_frame = NULL, *enc_frame = NULL;
  PendingPkt *pending_video = NULL;
  int pending_count = 0;

  av_log_set_level(AV_LOG_QUIET);

  in_io_buf = av_malloc(IO_BUF_SIZE);
  out_io_buf = av_malloc(IO_BUF_SIZE);
  if (!in_io_buf || !out_io_buf) goto cleanup;

  in_avio = avio_alloc_context(in_io_buf, IO_BUF_SIZE, 0, NULL, avio_read_cb, NULL, NULL);
  if (!in_avio) goto cleanup;
  in_io_buf = NULL; /* owned by in_avio */

  in_ctx = avformat_alloc_context();
  if (!in_ctx) goto cleanup;
  in_ctx->pb = in_avio;
  in_ctx->probesize = 65536;
  in_ctx->max_analyze_duration = 0;
  in_ctx->flags |= AVFMT_FLAG_CUSTOM_IO;

  mkv_fmt = av_find_input_format("matroska");
  if (!mkv_fmt) goto cleanup;
  if (avformat_open_input(&in_ctx, NULL, mkv_fmt, NULL) < 0) goto cleanup;

  int v_idx = -1, a_idx = -1, a_seen = 0;
  for (unsigned i = 0; i < in_ctx->nb_streams; i++) {
    enum AVMediaType mt = in_ctx->streams[i]->codecpar->codec_type;
    if (mt == AVMEDIA_TYPE_VIDEO && v_idx < 0) v_idx = (int)i;
    if (mt == AVMEDIA_TYPE_AUDIO) {
      if (audio_track_index >= 0) {
        if (a_seen == audio_track_index) a_idx = (int)i;
      } else if (a_idx < 0) {
        a_idx = (int)i;
      }
      a_seen++;
    }
  }
  if (v_idx < 0 || a_idx < 0) { rc = -2; goto cleanup; }

  AVStream *in_video = in_ctx->streams[v_idx];
  AVStream *in_audio = in_ctx->streams[a_idx];

  /* Prepare video Annex-B BSF if Matroska uses MP4-style extradata. */
  const char *bsf_name = NULL;
  if (in_video->codecpar->codec_id == AV_CODEC_ID_HEVC &&
      in_video->codecpar->extradata_size > 0 && in_video->codecpar->extradata[0] == 1) {
    bsf_name = "hevc_mp4toannexb";
  } else if (in_video->codecpar->codec_id == AV_CODEC_ID_H264 &&
             in_video->codecpar->extradata_size > 0 && in_video->codecpar->extradata[0] == 1) {
    bsf_name = "h264_mp4toannexb";
  }
  if (bsf_name) {
    const AVBitStreamFilter *bsf = av_bsf_get_by_name(bsf_name);
    if (!bsf || av_bsf_alloc(bsf, &bsf_ctx) < 0) goto cleanup;
    if (avcodec_parameters_copy(bsf_ctx->par_in, in_video->codecpar) < 0) goto cleanup;
    bsf_ctx->time_base_in = in_video->time_base;
    if (av_bsf_init(bsf_ctx) < 0) goto cleanup;
  }

  /* Open audio decoder. */
  const AVCodec *dec = avcodec_find_decoder(in_audio->codecpar->codec_id);
  if (!dec) { rc = -3; goto cleanup; }
  dec_ctx = avcodec_alloc_context3(dec);
  if (!dec_ctx) goto cleanup;
  if (avcodec_parameters_to_context(dec_ctx, in_audio->codecpar) < 0) goto cleanup;
  dec_ctx->pkt_timebase = in_audio->time_base;
  if (avcodec_open2(dec_ctx, dec, NULL) < 0) { rc = -4; goto cleanup; }

  /* Prepare output MPEG-TS format context. */
  out_avio = avio_alloc_context(out_io_buf, IO_BUF_SIZE, 1, NULL, NULL, avio_write_cb, NULL);
  if (!out_avio) goto cleanup;
  out_io_buf = NULL; /* owned by out_avio */

  ts_fmt = av_guess_format("mpegts", NULL, NULL);
  if (!ts_fmt || avformat_alloc_output_context2(&out_ctx, ts_fmt, NULL, NULL) < 0 || !out_ctx) goto cleanup;
  out_ctx->pb = out_avio;
  out_ctx->flags |= AVFMT_FLAG_CUSTOM_IO;
  out_ctx->max_delay = 0;
  out_ctx->avoid_negative_ts = AVFMT_AVOID_NEG_TS_DISABLED;
  av_opt_set(out_ctx->priv_data, "mpegts_copyts", "1", 0);
  av_opt_set(out_ctx->priv_data, "mpegts_flags", "+resend_headers", 0);

  AVStream *out_video = avformat_new_stream(out_ctx, NULL);
  AVStream *out_audio = avformat_new_stream(out_ctx, NULL);
  if (!out_video || !out_audio) goto cleanup;
  if (bsf_ctx) {
    if (avcodec_parameters_copy(out_video->codecpar, bsf_ctx->par_out) < 0) goto cleanup;
  } else {
    if (avcodec_parameters_copy(out_video->codecpar, in_video->codecpar) < 0) goto cleanup;
  }
  out_video->codecpar->codec_tag = 0;
  out_video->avg_frame_rate = in_video->avg_frame_rate;
  out_video->r_frame_rate = in_video->r_frame_rate;
  out_video->time_base = (AVRational){1, 90000};
  out_audio->time_base = (AVRational){1, 90000};

  const AVCodec *enc = avcodec_find_encoder(AV_CODEC_ID_EAC3);
  if (!enc) enc = avcodec_find_encoder(AV_CODEC_ID_AC3);
  if (!enc) { rc = -5; goto cleanup; }

  pkt = av_packet_alloc();
  bsf_pkt = av_packet_alloc();
  enc_pkt = av_packet_alloc();
  dec_frame = av_frame_alloc();
  enc_frame = av_frame_alloc();
  pending_video = av_calloc(MAX_PENDING_PKTS, sizeof(PendingPkt));
  if (!pkt || !bsf_pkt || !enc_pkt || !dec_frame || !enc_frame || !pending_video) goto cleanup;

  int header_written = 0;
  int video_started = 0, video_done = 0, audio_done = 0;
  int64_t last_video_dts = AV_NOPTS_VALUE;
  /* Shift all timestamps uniformly by +1s so B-frame negative DTS at t=0
   * stays safely >= 0 across MPEG-TS muxing while preserving exact GOP spacing. */
  const int64_t ts_offset_90k = 90000;
  int64_t audio_next_pts_samples = -1;

  while (av_read_frame(in_ctx, pkt) >= 0) {
    if (pkt->stream_index == v_idx && !video_done) {
      int64_t ts_ms = pkt_ts_ms(pkt, in_video->time_base);
      if (!video_started) {
        if ((pkt->flags & AV_PKT_FLAG_KEY) && (ts_ms == INT64_MIN || ts_ms >= start_ms - 80)) {
          video_started = 1;
        }
      } else if ((pkt->flags & AV_PKT_FLAG_KEY) && end_ms > 0 && ts_ms != INT64_MIN && ts_ms >= end_ms - 20) {
        video_done = 1;
      }

      if (video_started && !video_done) {
        if (bsf_ctx) {
          if (av_bsf_send_packet(bsf_ctx, pkt) < 0) goto loop_next;
          while (av_bsf_receive_packet(bsf_ctx, bsf_pkt) >= 0) {
            av_packet_rescale_ts(bsf_pkt, bsf_ctx->time_base_out, out_video->time_base);
            if (bsf_pkt->pts != AV_NOPTS_VALUE) bsf_pkt->pts += ts_offset_90k;
            if (bsf_pkt->dts != AV_NOPTS_VALUE) bsf_pkt->dts += ts_offset_90k;
            if (bsf_pkt->dts == AV_NOPTS_VALUE) bsf_pkt->dts = bsf_pkt->pts;
            if (bsf_pkt->dts < 0) bsf_pkt->dts = 0;
            if (last_video_dts != AV_NOPTS_VALUE && bsf_pkt->dts <= last_video_dts) {
              bsf_pkt->dts = last_video_dts + 1;
            }
            if (bsf_pkt->pts != AV_NOPTS_VALUE && bsf_pkt->pts < bsf_pkt->dts) {
              bsf_pkt->pts = bsf_pkt->dts;
            }
            last_video_dts = bsf_pkt->dts;
            bsf_pkt->stream_index = out_video->index;
            bsf_pkt->pos = -1;

            if (header_written) {
              int wret = av_interleaved_write_frame(out_ctx, bsf_pkt);
              av_packet_unref(bsf_pkt);
              if (wret < 0) goto cleanup;
            } else if (pending_count < MAX_PENDING_PKTS) {
              pending_video[pending_count++].pkt = av_packet_clone(bsf_pkt);
              av_packet_unref(bsf_pkt);
            } else {
              av_packet_unref(bsf_pkt);
            }
          }
        } else {
          av_packet_rescale_ts(pkt, in_video->time_base, out_video->time_base);
          if (pkt->pts != AV_NOPTS_VALUE) pkt->pts += ts_offset_90k;
          if (pkt->dts != AV_NOPTS_VALUE) pkt->dts += ts_offset_90k;
          if (pkt->dts == AV_NOPTS_VALUE) pkt->dts = pkt->pts;
          if (pkt->dts < 0) pkt->dts = 0;
          if (last_video_dts != AV_NOPTS_VALUE && pkt->dts <= last_video_dts) {
            pkt->dts = last_video_dts + 1;
          }
          if (pkt->pts != AV_NOPTS_VALUE && pkt->pts < pkt->dts) {
            pkt->pts = pkt->dts;
          }
          last_video_dts = pkt->dts;
          pkt->stream_index = out_video->index;
          pkt->pos = -1;
          if (header_written) {
            if (av_interleaved_write_frame(out_ctx, pkt) < 0) goto cleanup;
          } else if (pending_count < MAX_PENDING_PKTS) {
            pending_video[pending_count++].pkt = av_packet_clone(pkt);
          }
        }
      }
    } else if (pkt->stream_index == a_idx && !audio_done) {
      int64_t a_ms = pkt_ts_ms(pkt, in_audio->time_base);
      if (end_ms > 0 && a_ms != INT64_MIN && a_ms >= end_ms + 80) {
        audio_done = 1;
        goto loop_next;
      }
      if (avcodec_send_packet(dec_ctx, pkt) >= 0) {
        int dret;
        while ((dret = avcodec_receive_frame(dec_ctx, dec_frame)) >= 0) {
          int64_t frame_ms = (dec_frame->pts != AV_NOPTS_VALUE)
            ? av_rescale_q(dec_frame->pts, in_audio->time_base, (AVRational){1, 1000})
            : (a_ms != INT64_MIN ? a_ms : 0);
          int sr = dec_frame->sample_rate > 0 ? dec_frame->sample_rate : 48000;
          int64_t dur_ms = (int64_t)dec_frame->nb_samples * 1000 / sr;
          if (frame_ms + dur_ms <= start_ms) { av_frame_unref(dec_frame); continue; }
          if (end_ms > 0 && frame_ms >= end_ms) { audio_done = 1; av_frame_unref(dec_frame); break; }

          if (!enc_ctx) {
            enc_ctx = avcodec_alloc_context3(enc);
            if (!enc_ctx) { av_frame_unref(dec_frame); goto cleanup; }
            init_out_audio_params(enc_ctx, enc, &dec_frame->ch_layout);
            if (avcodec_open2(enc_ctx, enc, NULL) < 0) { av_frame_unref(dec_frame); rc = -6; goto cleanup; }
            if (avcodec_parameters_from_context(out_audio->codecpar, enc_ctx) < 0) { av_frame_unref(dec_frame); goto cleanup; }
            out_audio->codecpar->codec_tag = 0;

            if (swr_alloc_set_opts2(&swr_ctx, &enc_ctx->ch_layout, enc_ctx->sample_fmt, enc_ctx->sample_rate,
                                    &dec_frame->ch_layout, (enum AVSampleFormat)dec_frame->format, sr, 0, NULL) < 0 ||
                !swr_ctx || swr_init(swr_ctx) < 0) {
              av_frame_unref(dec_frame); rc = -7; goto cleanup;
            }
            int fsz = enc_ctx->frame_size > 0 ? enc_ctx->frame_size : 1536;
            fifo = av_audio_fifo_alloc(enc_ctx->sample_fmt, enc_ctx->ch_layout.nb_channels, fsz * 8);
            if (!fifo) { av_frame_unref(dec_frame); goto cleanup; }

            if (avformat_write_header(out_ctx, NULL) < 0) { av_frame_unref(dec_frame); rc = -8; goto cleanup; }
            header_written = 1;
            for (int k = 0; k < pending_count; k++) {
              if (pending_video[k].pkt) {
                int wret = av_interleaved_write_frame(out_ctx, pending_video[k].pkt);
                av_packet_free(&pending_video[k].pkt);
                if (wret < 0) { av_frame_unref(dec_frame); goto cleanup; }
              }
            }
            pending_count = 0;
          }

          /* Convert this decoded PCM frame cleanly into FIFO. */
          int out_cap = (int)swr_get_delay(swr_ctx, sr) + dec_frame->nb_samples;
          int resampled_cap = (int)av_rescale_rnd(out_cap, enc_ctx->sample_rate, sr, AV_ROUND_UP) + 32;
          uint8_t **conv = NULL;
          int linesize = 0;
          if (av_samples_alloc_array_and_samples(&conv, &linesize, enc_ctx->ch_layout.nb_channels,
                                                 resampled_cap, enc_ctx->sample_fmt, 0) < 0) {
            av_frame_unref(dec_frame); goto cleanup;
          }
          int converted = swr_convert(swr_ctx, conv, resampled_cap,
                                      (const uint8_t **)dec_frame->extended_data, dec_frame->nb_samples);
          if (converted > 0) {
            int drop = 0;
            if (frame_ms < start_ms) {
              drop = (int)av_rescale_rnd(start_ms - frame_ms, enc_ctx->sample_rate, 1000, AV_ROUND_NEAR_INF);
              if (drop > converted) drop = converted;
            }
            int keep = converted - drop;
            if (end_ms > 0) {
              int64_t frame_end_ms = frame_ms + (int64_t)converted * 1000 / enc_ctx->sample_rate;
              if (frame_end_ms > end_ms) {
                int max_end = (int)av_rescale_rnd(end_ms - frame_ms, enc_ctx->sample_rate, 1000, AV_ROUND_DOWN);
                if (max_end < drop) keep = 0;
                else if (max_end - drop < keep) keep = max_end - drop;
              }
            }
            if (keep > 0) {
              if (audio_next_pts_samples < 0) {
                int64_t kept_start_ms = frame_ms + (int64_t)drop * 1000 / enc_ctx->sample_rate;
                if (kept_start_ms < start_ms) kept_start_ms = start_ms;
                audio_next_pts_samples = av_rescale_q(kept_start_ms * 90 + ts_offset_90k,
                                                      out_audio->time_base, enc_ctx->time_base);
              }
              if (drop > 0 && av_sample_fmt_is_planar(enc_ctx->sample_fmt)) {
                int bps = av_get_bytes_per_sample(enc_ctx->sample_fmt);
                uint8_t *ptrs[8];
                for (int c = 0; c < enc_ctx->ch_layout.nb_channels && c < 8; c++) {
                  ptrs[c] = conv[c] + drop * bps;
                }
                av_audio_fifo_write(fifo, (void **)ptrs, keep);
              } else if (drop > 0) {
                int step = av_get_bytes_per_sample(enc_ctx->sample_fmt) * enc_ctx->ch_layout.nb_channels;
                uint8_t *ptr = conv[0] + drop * step;
                av_audio_fifo_write(fifo, (void **)&ptr, keep);
              } else {
                av_audio_fifo_write(fifo, (void **)conv, keep);
              }
            }
          }
          if (conv) { av_freep(&conv[0]); av_freep(&conv); }
          av_frame_unref(dec_frame);

          int fsz = enc_ctx->frame_size > 0 ? enc_ctx->frame_size : 1536;
          if (drain_audio_fifo(fifo, fsz, enc_ctx, enc_frame, enc_pkt, out_ctx, out_audio,
                               &audio_next_pts_samples, 0) < 0) goto cleanup;
        }
      }
    }
  loop_next:
    av_packet_unref(pkt);
    if (video_done && audio_done) break;
  }

  /* Flush remaining audio if header wasn't even written yet (very short clip). */
  if (!header_written && pending_count > 0) {
    /* Fallback: open encoder with input channel count if no audio frame decoded yet. */
    if (!enc_ctx) {
      enc_ctx = avcodec_alloc_context3(enc);
      if (enc_ctx) {
        init_out_audio_params(enc_ctx, enc, &dec_ctx->ch_layout);
        if (avcodec_open2(enc_ctx, enc, NULL) >= 0 &&
            avcodec_parameters_from_context(out_audio->codecpar, enc_ctx) >= 0) {
          out_audio->codecpar->codec_tag = 0;
          if (avformat_write_header(out_ctx, NULL) >= 0) {
            header_written = 1;
            for (int k = 0; k < pending_count; k++) {
              if (pending_video[k].pkt) {
                av_interleaved_write_frame(out_ctx, pending_video[k].pkt);
                av_packet_free(&pending_video[k].pkt);
              }
            }
            pending_count = 0;
          }
        }
      }
    }
  }

  if (header_written && enc_ctx) {
    if (swr_ctx && fifo) {
      int rem = (int)swr_get_delay(swr_ctx, enc_ctx->sample_rate);
      if (rem > 0) {
        uint8_t **conv = NULL;
        int linesize = 0;
        if (av_samples_alloc_array_and_samples(&conv, &linesize, enc_ctx->ch_layout.nb_channels,
                                               rem + 32, enc_ctx->sample_fmt, 0) >= 0) {
          int got = swr_convert(swr_ctx, conv, rem + 32, NULL, 0);
          if (got > 0) av_audio_fifo_write(fifo, (void **)conv, got);
          if (conv) { av_freep(&conv[0]); av_freep(&conv); }
        }
      }
    }
    if (fifo) {
      int fsz = enc_ctx->frame_size > 0 ? enc_ctx->frame_size : 1536;
      if (drain_audio_fifo(fifo, fsz, enc_ctx, enc_frame, enc_pkt, out_ctx, out_audio,
                           &audio_next_pts_samples, 1) < 0) goto cleanup;
    }
    if (flush_encoder(enc_ctx, enc_pkt, out_ctx, out_audio) < 0) goto cleanup;
    if (av_write_trailer(out_ctx) < 0) goto cleanup;
    rc = 0;
  } else if (header_written) {
    if (av_write_trailer(out_ctx) < 0) goto cleanup;
    rc = 0;
  }

cleanup:
  if (pending_video) {
    for (int k = 0; k < pending_count; k++) av_packet_free(&pending_video[k].pkt);
    av_free(pending_video);
  }
  if (pkt) av_packet_free(&pkt);
  if (bsf_pkt) av_packet_free(&bsf_pkt);
  if (enc_pkt) av_packet_free(&enc_pkt);
  if (dec_frame) av_frame_free(&dec_frame);
  if (enc_frame) av_frame_free(&enc_frame);
  if (fifo) av_audio_fifo_free(fifo);
  if (swr_ctx) swr_free(&swr_ctx);
  if (bsf_ctx) av_bsf_free(&bsf_ctx);
  if (dec_ctx) avcodec_free_context(&dec_ctx);
  if (enc_ctx) avcodec_free_context(&enc_ctx);
  if (out_ctx) avformat_free_context(out_ctx);
  if (out_avio) { av_freep(&out_avio->buffer); avio_context_free(&out_avio); }
  if (out_io_buf) av_free(out_io_buf);
  if (in_ctx) avformat_close_input(&in_ctx);
  if (in_avio) { av_freep(&in_avio->buffer); avio_context_free(&in_avio); }
  if (in_io_buf) av_free(in_io_buf);
  return rc;
}
