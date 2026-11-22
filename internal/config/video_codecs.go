package config

import (
	"fmt"
	"slices"
	"strings"
)

// Video codec names as they appear in configuration, signaling, and the
// admin API. The SFU forwards media without transcoding, so a publisher may
// only use a codec every participant in the room can decode; these names are
// what the server and the browsers agree on.
const (
	VideoCodecAV1  = "av1"
	VideoCodecVP9  = "vp9"
	VideoCodecVP8  = "vp8"
	VideoCodecH264 = "h264"
)

// videoCodecOrder lists every supported codec, newest first. It is the
// canonical order of every codec list the server sends, and the order in which
// an unset default is resolved.
var videoCodecOrder = []string{VideoCodecAV1, VideoCodecVP9, VideoCodecVP8, VideoCodecH264}

// SupportedVideoCodecs returns every codec name the server understands, newest
// first.
func SupportedVideoCodecs() []string {
	return slices.Clone(videoCodecOrder)
}

// IsSupportedVideoCodec reports whether name is one of the codec names the
// server understands.
func IsSupportedVideoCodec(name string) bool {
	return slices.Contains(videoCodecOrder, name)
}

// EffectiveVideoCodecs returns the codecs publishers may use, newest first. An
// unset list allows all of them.
func (c Config) EffectiveVideoCodecs() []string {
	if c.VideoCodecs == nil {
		return SupportedVideoCodecs()
	}
	allowed := make([]string, 0, len(c.VideoCodecs))
	for _, codec := range videoCodecOrder {
		if slices.Contains(c.VideoCodecs, codec) {
			allowed = append(allowed, codec)
		}
	}
	return allowed
}

// EffectiveDefaultVideoCodec returns the codec browsers use unless the
// participant picks another one. An unset default is the newest allowed codec.
func (c Config) EffectiveDefaultVideoCodec() string {
	if c.DefaultVideoCodec != "" {
		return c.DefaultVideoCodec
	}
	if allowed := c.EffectiveVideoCodecs(); len(allowed) > 0 {
		return allowed[0]
	}
	return VideoCodecVP8
}

func (c Config) validateVideoCodecs() error {
	seen := make(map[string]struct{}, len(c.VideoCodecs))
	for _, codec := range c.VideoCodecs {
		if !IsSupportedVideoCodec(codec) {
			return fmt.Errorf("VIDEO_CODECS entry %q must be one of %s", codec, strings.Join(videoCodecOrder, ", "))
		}
		if _, exists := seen[codec]; exists {
			return fmt.Errorf("VIDEO_CODECS entry %q is duplicated", codec)
		}
		seen[codec] = struct{}{}
	}
	// Every WebRTC browser decodes VP8, so keeping it allowed guarantees the
	// room always has a codec all participants share.
	if c.VideoCodecs != nil {
		if _, ok := seen[VideoCodecVP8]; !ok {
			return fmt.Errorf("VIDEO_CODECS must include %s", VideoCodecVP8)
		}
	}
	if c.DefaultVideoCodec != "" && !slices.Contains(c.EffectiveVideoCodecs(), c.DefaultVideoCodec) {
		return fmt.Errorf("DEFAULT_VIDEO_CODEC must be one of VIDEO_CODECS")
	}
	return nil
}

// parseVideoCodecs reads a comma-separated codec list, ignoring case and
// surrounding space. An empty value leaves the list unset.
func parseVideoCodecs(value string) []string {
	codecs := splitCSV(value)
	for i, codec := range codecs {
		codecs[i] = strings.ToLower(codec)
	}
	return codecs
}
