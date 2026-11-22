package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestVideoCodecDefaultsAllowEverythingNewestFirst(t *testing.T) {
	cfg := Config{}
	if got := cfg.EffectiveVideoCodecs(); !slices.Equal(got, []string{"av1", "vp9", "vp8", "h264"}) {
		t.Fatalf("EffectiveVideoCodecs() = %v", got)
	}
	if got := cfg.EffectiveDefaultVideoCodec(); got != "av1" {
		t.Fatalf("EffectiveDefaultVideoCodec() = %q, want av1", got)
	}
	// The unset default follows the allowed list instead of pointing at a
	// codec the operator removed.
	cfg.VideoCodecs = []string{"h264", "vp8"}
	if got := cfg.EffectiveVideoCodecs(); !slices.Equal(got, []string{"vp8", "h264"}) {
		t.Fatalf("EffectiveVideoCodecs() = %v, want canonical order", got)
	}
	if got := cfg.EffectiveDefaultVideoCodec(); got != "vp8" {
		t.Fatalf("EffectiveDefaultVideoCodec() = %q, want vp8", got)
	}
}

func TestValidateVideoCodecs(t *testing.T) {
	tests := []struct {
		name    string
		codecs  []string
		def     string
		wantErr string
	}{
		{name: "unset"},
		{name: "subset with default", codecs: []string{"vp8", "vp9"}, def: "vp9"},
		{name: "unknown codec", codecs: []string{"vp8", "h265"}, wantErr: "must be one of"},
		{name: "duplicate", codecs: []string{"vp8", "vp8"}, wantErr: "duplicated"},
		{name: "vp8 removed", codecs: []string{"av1", "vp9"}, wantErr: "must include vp8"},
		{name: "empty list", codecs: []string{}, wantErr: "must include vp8"},
		{name: "default not allowed", codecs: []string{"vp8"}, def: "av1", wantErr: "DEFAULT_VIDEO_CODEC"},
		{name: "unknown default", def: "h265", wantErr: "DEFAULT_VIDEO_CODEC"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := Config{VideoCodecs: test.codecs, DefaultVideoCodec: test.def}.validateVideoCodecs()
			if test.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("error = %v, want one containing %q", err, test.wantErr)
			}
		})
	}
}

func TestLoadFromEnvReadsVideoCodecs(t *testing.T) {
	t.Setenv("VIDEO_CODECS", " VP8, vp9 ")
	t.Setenv("DEFAULT_VIDEO_CODEC", "VP9")
	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(cfg.EffectiveVideoCodecs(), []string{"vp9", "vp8"}) || cfg.EffectiveDefaultVideoCodec() != "vp9" {
		t.Fatalf("codecs = %v default = %q", cfg.EffectiveVideoCodecs(), cfg.EffectiveDefaultVideoCodec())
	}
	t.Setenv("DEFAULT_VIDEO_CODEC", "av1")
	if _, err := LoadFromEnv(); err == nil {
		t.Fatal("a default outside VIDEO_CODECS must be rejected")
	}
}

func TestStorePersistsVideoCodecs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	base, err := LoadFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	base.ConfigFile = path
	store := NewStore(base)
	codecs := []string{"vp8", "vp9"}
	def := "vp9"
	if err := store.Update(AdminUpdate{VideoCodecs: &codecs, DefaultVideoCodec: &def}); err != nil {
		t.Fatal(err)
	}
	// The caller's slice must not alias the stored configuration.
	codecs[0] = "av1"
	if got := store.Snapshot().EffectiveVideoCodecs(); !slices.Equal(got, []string{"vp9", "vp8"}) {
		t.Fatalf("stored codecs = %v", got)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var persisted map[string]json.RawMessage
	if err := json.Unmarshal(data, &persisted); err != nil {
		t.Fatal(err)
	}
	if string(persisted["default_video_codec"]) != `"vp9"` {
		t.Fatalf("persisted default_video_codec = %s", persisted["default_video_codec"])
	}
	if unknown := unknownJSONKeys(data); len(unknown) != 0 {
		t.Fatalf("persisted keys reported as unknown: %v", unknown)
	}

	reloaded, err := LoadStore(base, nil)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := reloaded.Snapshot()
	if !slices.Equal(snapshot.EffectiveVideoCodecs(), []string{"vp9", "vp8"}) || snapshot.EffectiveDefaultVideoCodec() != "vp9" {
		t.Fatalf("reloaded codecs = %v default = %q", snapshot.EffectiveVideoCodecs(), snapshot.EffectiveDefaultVideoCodec())
	}

	// Removing the current default without choosing another is rejected and
	// leaves the stored settings alone.
	onlyVP8 := []string{"vp8"}
	if err := store.Update(AdminUpdate{VideoCodecs: &onlyVP8}); err == nil {
		t.Fatal("removing the default codec must be rejected")
	}
	if got := store.Snapshot().EffectiveDefaultVideoCodec(); got != "vp9" {
		t.Fatalf("default after rejected update = %q", got)
	}
}
