package config

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	AppName           string
	AppEnv            string
	HTTPAddr          string
	ConfigFile        string
	MeetingPassword   string
	AdminPassword     string
	STUNServers       []string
	TURNURL           string
	TURNURLs          []string
	TURNUsername      string
	TURNPassword      string
	TURNSharedSecret  string
	TURNCredentialTTL time.Duration
	// TURNTCPRotateInterval is how often browsers on a TURN/TCP or TURN/TLS
	// relay request an ICE restart to move media onto fresh TCP connections.
	// Some access networks degrade long-lived real-time TCP flows (~20 s in);
	// zero disables rotation.
	TURNTCPRotateInterval time.Duration
	// TURNServerEnabled runs the built-in TURN relay inside this process. It
	// accepts the shared-secret credentials TURNCredentials issues and relays
	// only to this server's own SFU addresses. The remaining TURNServer*
	// settings are read only when it is enabled.
	TURNServerEnabled bool
	// TURNServerPort is the UDP and TCP port the relay listens on.
	TURNServerPort int
	// TURNServerTLSPort is the TURN-over-TLS port; zero disables the listener,
	// which also stays off until a certificate and key file are configured.
	TURNServerTLSPort     int
	TURNServerTLSCertFile string
	TURNServerTLSKeyFile  string
	TURNServerRealm       string
	// TURNServerRelayPortMin and TURNServerRelayPortMax bound the UDP ports
	// relay allocations bind. Only the SFU in this process ever sends to them.
	TURNServerRelayPortMin int
	TURNServerRelayPortMax int
	// TURNServerRelayIP overrides the local IPv4 address relay sockets bind;
	// empty selects it automatically.
	TURNServerRelayIP string
	// TURNServerListenIP is the one local address the relay's listeners
	// bind; empty for every address of the host.
	TURNServerListenIP       string
	ICEIPv4Only              bool
	ICETransportPolicy       string
	EnabledConnectionMethods []string
	SimulcastEnabled         bool
	// OpusDTXEnabled asks browsers to send discontinuous Opus (a comfort-noise
	// packet every 400 ms while silent instead of 50 packets per second).
	OpusDTXEnabled      bool
	ICEUDPPortMin       int
	ICEUDPPortMax       int
	ICEPublicIP         string
	TrustedProxyCIDRs   []string
	MaxParticipants     int
	DefaultVideoQuality string
	MaxVideoQuality     string
	// VideoCodecs lists the video codecs publishers may use (see
	// video_codecs.go); nil allows all of them. DefaultVideoCodec is the one
	// browsers use unless the participant picks another; empty selects the
	// newest allowed codec.
	VideoCodecs         []string
	DefaultVideoCodec   string
	DefaultVideoFPS     int
	MaxVideoFPS         int
	DefaultAudioBitrate int
	MaxVideoBitrate     int
	MaxAudioBitrate     int
	EnableScreenShare   bool
	RetainChatHistory   bool
	ReconnectTimeout    time.Duration
	LogLevel            string
}

func cloneConfig(cfg Config) Config {
	cfg.STUNServers = cloneStrings(cfg.STUNServers)
	cfg.TURNURLs = cloneStrings(cfg.TURNURLs)
	cfg.EnabledConnectionMethods = cloneStrings(cfg.EnabledConnectionMethods)
	cfg.VideoCodecs = cloneStrings(cfg.VideoCodecs)
	cfg.TrustedProxyCIDRs = cloneStrings(cfg.TrustedProxyCIDRs)
	return cfg
}

func cloneStrings(values []string) []string {
	if values == nil {
		return nil
	}
	cloned := make([]string, len(values))
	copy(cloned, values)
	return cloned
}

const MaxAllowedParticipants = 100

// Bitrate caps keep a mistyped admin update from promising gigabit streams to
// every client. They sit far above any profile the app negotiates.
const (
	maxVideoBitrateCap = 20_000_000
	maxAudioBitrateCap = 512_000
)

// validICEServerURL checks that an ICE server entry carries one of the
// accepted schemes; browsers silently drop malformed URLs, which reads as
// "not configured on this server" in the UI. ICE server URLs use the
// scheme:opaque form (no "//"), so the address lands in Opaque.
func validICEServerURL(server string, schemes []string) bool {
	parsed, err := url.Parse(strings.TrimSpace(server))
	if err != nil || parsed.Scheme == "" {
		return false
	}
	if parsed.Host == "" && parsed.Opaque == "" {
		return false
	}
	if strings.ContainsAny(parsed.Host+parsed.Opaque, " \t\r\n") {
		return false
	}
	for _, scheme := range schemes {
		if parsed.Scheme == scheme {
			return true
		}
	}
	return false
}

func LoadFromEnv() (Config, error) {
	maxParticipants, err := envInt("MAX_PARTICIPANTS", 5)
	if err != nil {
		return Config{}, err
	}
	defaultVideoFPS, err := envInt("DEFAULT_VIDEO_FPS", 15)
	if err != nil {
		return Config{}, err
	}
	maxVideoFPS, err := envInt("MAX_VIDEO_FPS", 60)
	if err != nil {
		return Config{}, err
	}
	defaultAudioBitrate, err := envInt("DEFAULT_AUDIO_BITRATE", 32000)
	if err != nil {
		return Config{}, err
	}
	maxVideoBitrate, err := envInt("MAX_VIDEO_BITRATE", 3000000)
	if err != nil {
		return Config{}, err
	}
	maxAudioBitrate, err := envInt("MAX_AUDIO_BITRATE", 96000)
	if err != nil {
		return Config{}, err
	}
	enableScreenShare, err := envBool("ENABLE_SCREEN_SHARE", true)
	if err != nil {
		return Config{}, err
	}
	reconnectSeconds, err := envInt("RECONNECT_TIMEOUT_SECONDS", 30)
	if err != nil {
		return Config{}, err
	}
	iceUDPPortMin, err := envInt("ICE_UDP_PORT_MIN", 50000)
	if err != nil {
		return Config{}, err
	}
	iceUDPPortMax, err := envInt("ICE_UDP_PORT_MAX", 50100)
	if err != nil {
		return Config{}, err
	}
	turnCredentialTTLSeconds, err := envInt("TURN_CREDENTIAL_TTL_SECONDS", 86400)
	if err != nil {
		return Config{}, err
	}
	turnTCPRotateSeconds, err := envInt("TURN_TCP_ROTATE_SECONDS", 12)
	if err != nil {
		return Config{}, err
	}
	turnServerEnabled, err := envBool("TURN_SERVER_ENABLED", false)
	if err != nil {
		return Config{}, err
	}
	turnServerPort, err := envInt("TURN_SERVER_PORT", DefaultTURNServerPort)
	if err != nil {
		return Config{}, err
	}
	turnServerTLSPort, err := envInt("TURN_SERVER_TLS_PORT", DefaultTURNServerTLSPort)
	if err != nil {
		return Config{}, err
	}
	turnServerRelayPortMin, err := envInt("TURN_SERVER_RELAY_PORT_MIN", DefaultTURNServerRelayPortMin)
	if err != nil {
		return Config{}, err
	}
	turnServerRelayPortMax, err := envInt("TURN_SERVER_RELAY_PORT_MAX", DefaultTURNServerRelayPortMax)
	if err != nil {
		return Config{}, err
	}
	iceIPv4Only, err := envBool("ICE_IPV4_ONLY", true)
	if err != nil {
		return Config{}, err
	}
	icePublicIP := os.Getenv("ICE_PUBLIC_IP")
	trustedProxyCIDRs := splitCSV(os.Getenv("TRUSTED_PROXY_CIDRS"))
	iceTransportPolicy := envString("ICE_TRANSPORT_POLICY", "all")
	simulcastEnabled, err := envBool("SIMULCAST_ENABLED", false)
	if err != nil {
		return Config{}, err
	}
	opusDTXEnabled, err := envBool("OPUS_DTX_ENABLED", true)
	if err != nil {
		return Config{}, err
	}
	cfg := Config{
		OpusDTXEnabled:        opusDTXEnabled,
		AppName:               envString("APP_NAME", "SlowMeet"),
		AppEnv:                envString("APP_ENV", "production"),
		HTTPAddr:              envString("HTTP_ADDR", ":8080"),
		ConfigFile:            envString("CONFIG_FILE", "config.json"),
		MeetingPassword:       os.Getenv("MEETING_PASSWORD"),
		AdminPassword:         os.Getenv("ADMIN_PASSWORD"),
		STUNServers:           splitCSV(os.Getenv("STUN_SERVERS")),
		TURNURL:               os.Getenv("TURN_URL"),
		TURNURLs:              splitCSV(os.Getenv("TURN_URLS")),
		TURNUsername:          os.Getenv("TURN_USERNAME"),
		TURNPassword:          os.Getenv("TURN_PASSWORD"),
		TURNSharedSecret:      os.Getenv("TURN_SHARED_SECRET"),
		TURNCredentialTTL:     time.Duration(turnCredentialTTLSeconds) * time.Second,
		TURNTCPRotateInterval: time.Duration(turnTCPRotateSeconds) * time.Second,

		TURNServerEnabled:      turnServerEnabled,
		TURNServerPort:         turnServerPort,
		TURNServerTLSPort:      turnServerTLSPort,
		TURNServerTLSCertFile:  os.Getenv("TURN_SERVER_TLS_CERT_FILE"),
		TURNServerTLSKeyFile:   os.Getenv("TURN_SERVER_TLS_KEY_FILE"),
		TURNServerRealm:        envString("TURN_SERVER_REALM", DefaultTURNServerRealm),
		TURNServerRelayPortMin: turnServerRelayPortMin,
		TURNServerRelayPortMax: turnServerRelayPortMax,
		TURNServerRelayIP:      os.Getenv("TURN_SERVER_RELAY_IP"),
		TURNServerListenIP:     strings.TrimSpace(os.Getenv("TURN_SERVER_LISTEN_IP")),

		ICEIPv4Only:         iceIPv4Only,
		ICETransportPolicy:  iceTransportPolicy,
		SimulcastEnabled:    simulcastEnabled,
		ICEUDPPortMin:       iceUDPPortMin,
		ICEUDPPortMax:       iceUDPPortMax,
		ICEPublicIP:         icePublicIP,
		TrustedProxyCIDRs:   trustedProxyCIDRs,
		MaxParticipants:     maxParticipants,
		DefaultVideoQuality: envString("DEFAULT_VIDEO_QUALITY", "low"),
		MaxVideoQuality:     envString("MAX_VIDEO_QUALITY", "ultra"),
		VideoCodecs:         parseVideoCodecs(os.Getenv("VIDEO_CODECS")),
		DefaultVideoCodec:   strings.ToLower(strings.TrimSpace(os.Getenv("DEFAULT_VIDEO_CODEC"))),
		DefaultVideoFPS:     defaultVideoFPS,
		MaxVideoFPS:         maxVideoFPS,
		DefaultAudioBitrate: defaultAudioBitrate,
		MaxVideoBitrate:     maxVideoBitrate,
		MaxAudioBitrate:     maxAudioBitrate,
		EnableScreenShare:   enableScreenShare,
		ReconnectTimeout:    time.Duration(reconnectSeconds) * time.Second,
		LogLevel:            envString("LOG_LEVEL", "info"),
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	if c.HTTPAddr == "" {
		return fmt.Errorf("HTTP_ADDR must not be empty")
	}
	if c.ICEPublicIP != "" && net.ParseIP(c.ICEPublicIP) == nil {
		return fmt.Errorf("ICE_PUBLIC_IP must be a valid IP address")
	}
	for _, cidr := range c.TrustedProxyCIDRs {
		if _, _, err := net.ParseCIDR(strings.TrimSpace(cidr)); err != nil {
			return fmt.Errorf("TRUSTED_PROXY_CIDRS entry %q must be a valid CIDR", cidr)
		}
	}
	if c.ICETransportPolicy != "" && c.ICETransportPolicy != "all" && c.ICETransportPolicy != "relay" {
		return fmt.Errorf("ICE_TRANSPORT_POLICY must be all or relay")
	}
	seenConnectionMethods := make(map[string]struct{}, len(c.EnabledConnectionMethods))
	for _, method := range c.EnabledConnectionMethods {
		switch method {
		case "direct", "turn-udp", "turn-tcp", "turn-tls", "turn-tcp-rotate", "turn-tls-rotate":
		default:
			return fmt.Errorf("enabled connection method %q is invalid", method)
		}
		if _, exists := seenConnectionMethods[method]; exists {
			return fmt.Errorf("enabled connection method %q is duplicated", method)
		}
		seenConnectionMethods[method] = struct{}{}
	}
	if (c.ICEUDPPortMin == 0) != (c.ICEUDPPortMax == 0) ||
		(c.ICEUDPPortMin != 0 &&
			(c.ICEUDPPortMin < 1 || c.ICEUDPPortMin > 65535 ||
				c.ICEUDPPortMax < 1 || c.ICEUDPPortMax > 65535 ||
				c.ICEUDPPortMin > c.ICEUDPPortMax)) {
		return fmt.Errorf("ICE UDP port range must be between 1 and 65535 with minimum <= maximum")
	}
	if c.MaxParticipants < 1 || c.MaxParticipants > MaxAllowedParticipants {
		return fmt.Errorf("MAX_PARTICIPANTS must be between 1 and %d", MaxAllowedParticipants)
	}
	if c.DefaultVideoFPS < 1 || c.DefaultVideoFPS > 60 {
		return fmt.Errorf("DEFAULT_VIDEO_FPS must be between 1 and 60")
	}
	if c.MaxVideoFPS < c.DefaultVideoFPS || c.MaxVideoFPS > 60 {
		return fmt.Errorf("MAX_VIDEO_FPS must be between DEFAULT_VIDEO_FPS and 60")
	}
	if c.DefaultAudioBitrate < 1 || c.MaxAudioBitrate < c.DefaultAudioBitrate ||
		c.MaxAudioBitrate > maxAudioBitrateCap {
		return fmt.Errorf("audio bitrates must be between 1 and %d bps with default <= max", maxAudioBitrateCap)
	}
	if c.MaxVideoBitrate < 1 || c.MaxVideoBitrate > maxVideoBitrateCap {
		return fmt.Errorf("MAX_VIDEO_BITRATE must be between 1 and %d bps", maxVideoBitrateCap)
	}
	for _, server := range c.STUNServers {
		if !validICEServerURL(server, []string{"stun"}) {
			return fmt.Errorf("STUN_SERVERS entries must be stun: URLs, got %q", server)
		}
	}
	for _, server := range append(append([]string(nil), c.TURNURLs...), c.TURNURL) {
		if server == "" {
			continue
		}
		if !validICEServerURL(server, []string{"turn", "turns"}) {
			return fmt.Errorf("TURN URLs must be turn: or turns: URLs, got %q", server)
		}
	}
	if c.ReconnectTimeout < 0 || c.ReconnectTimeout > 10*time.Minute {
		return fmt.Errorf("RECONNECT_TIMEOUT_SECONDS must be between 0 and 600")
	}
	if c.TURNCredentialTTL != 0 &&
		(c.TURNCredentialTTL < time.Minute || c.TURNCredentialTTL > 7*24*time.Hour) {
		return fmt.Errorf("TURN_CREDENTIAL_TTL_SECONDS must be between 60 and 604800")
	}
	if c.TURNTCPRotateInterval != 0 &&
		(c.TURNTCPRotateInterval < 10*time.Second || c.TURNTCPRotateInterval > 10*time.Minute) {
		return fmt.Errorf("TURN_TCP_ROTATE_SECONDS must be 0 or between 10 and 600")
	}
	if err := c.validateVideoCodecs(); err != nil {
		return err
	}
	if err := c.validateTURNServer(); err != nil {
		return err
	}
	if c.DefaultVideoQuality == "" {
		return fmt.Errorf("DEFAULT_VIDEO_QUALITY must not be empty")
	}
	switch c.DefaultVideoQuality {
	case "low", "medium", "high", "very-good", "ultra":
	default:
		return fmt.Errorf("DEFAULT_VIDEO_QUALITY must be one of low, medium, high, very-good, or ultra")
	}
	maxVideoQuality := c.MaxVideoQuality
	if maxVideoQuality == "" {
		maxVideoQuality = "ultra"
	}
	switch maxVideoQuality {
	case "low", "medium", "high", "very-good", "ultra":
	default:
		return fmt.Errorf("MAX_VIDEO_QUALITY must be one of low, medium, high, very-good, or ultra")
	}
	if videoQualityRank(c.DefaultVideoQuality) > videoQualityRank(maxVideoQuality) {
		return fmt.Errorf("DEFAULT_VIDEO_QUALITY must not exceed MAX_VIDEO_QUALITY")
	}
	if c.LogLevel != "" && c.LogLevel != "info" && c.LogLevel != "debug" {
		return fmt.Errorf("LOG_LEVEL must be info or debug")
	}
	return nil
}

// Defaults for the built-in TURN relay. The listen ports are the registered
// TURN and TURN-over-TLS ports browsers assume when a URL names none, and the
// relay range sits below the default ICE UDP range (50000-50100).
const (
	DefaultTURNServerPort         = 3478
	DefaultTURNServerTLSPort      = 5349
	DefaultTURNServerRealm        = "slowmeet"
	DefaultTURNServerRelayPortMin = 49152
	DefaultTURNServerRelayPortMax = 49999
)

// validateTURNServer checks the built-in relay's settings. A disabled relay
// is never validated, so a deployment that does not use it is unaffected by
// whatever those variables hold.
func (c Config) validateTURNServer() error {
	if !c.TURNServerEnabled {
		return nil
	}
	if c.TURNSharedSecret == "" || c.TURNCredentialTTL <= 0 {
		return fmt.Errorf("TURN_SERVER_ENABLED requires TURN_SHARED_SECRET and a nonzero TURN_CREDENTIAL_TTL_SECONDS")
	}
	if c.TURNServerPort < 1 || c.TURNServerPort > 65535 {
		return fmt.Errorf("TURN_SERVER_PORT must be between 1 and 65535")
	}
	if c.TURNServerTLSPort < 0 || c.TURNServerTLSPort > 65535 {
		return fmt.Errorf("TURN_SERVER_TLS_PORT must be 0 or between 1 and 65535")
	}
	if c.TURNServerTLSPort == c.TURNServerPort {
		return fmt.Errorf("TURN_SERVER_TLS_PORT must differ from TURN_SERVER_PORT")
	}
	if (c.TURNServerTLSCertFile == "") != (c.TURNServerTLSKeyFile == "") {
		return fmt.Errorf("TURN_SERVER_TLS_CERT_FILE and TURN_SERVER_TLS_KEY_FILE must be set together")
	}
	if strings.TrimSpace(c.TURNServerRealm) == "" {
		return fmt.Errorf("TURN_SERVER_REALM must not be empty")
	}
	relayMin, relayMax := c.TURNServerRelayPortMin, c.TURNServerRelayPortMax
	if relayMin < 1 || relayMin > 65535 || relayMax < 1 || relayMax > 65535 || relayMin > relayMax {
		return fmt.Errorf("TURN relay port range must be between 1 and 65535 with minimum <= maximum")
	}
	// Relay sockets and the SFU's media sockets bind the same address, so
	// with overlapping ranges each would take ports from the other.
	if c.ICEUDPPortMin != 0 && relayMin <= c.ICEUDPPortMax && c.ICEUDPPortMin <= relayMax {
		return fmt.Errorf("TURN relay port range %d-%d must not overlap the ICE UDP port range %d-%d",
			relayMin, relayMax, c.ICEUDPPortMin, c.ICEUDPPortMax)
	}
	if c.TURNServerPort >= relayMin && c.TURNServerPort <= relayMax {
		return fmt.Errorf("TURN_SERVER_PORT must be outside the TURN relay port range %d-%d", relayMin, relayMax)
	}
	// The relay forwards to the ICE UDP ports; its own listener must not be
	// among them, and the SFU must not find one of its ports taken.
	if c.ICEUDPPortMin != 0 && c.TURNServerPort >= c.ICEUDPPortMin && c.TURNServerPort <= c.ICEUDPPortMax {
		return fmt.Errorf("TURN_SERVER_PORT must be outside the ICE UDP port range %d-%d",
			c.ICEUDPPortMin, c.ICEUDPPortMax)
	}
	if c.TURNServerRelayIP != "" {
		if _, err := ParseTURNServerRelayIP(c.TURNServerRelayIP); err != nil {
			return err
		}
	}
	// The listeners may be on IPv6; only relay sockets are IPv4.
	if c.TURNServerListenIP != "" {
		ip := net.ParseIP(c.TURNServerListenIP)
		if ip == nil || ip.IsUnspecified() || ip.IsMulticast() || ip.Equal(net.IPv4bcast) {
			return fmt.Errorf("TURN_SERVER_LISTEN_IP must be one address of this host, " +
				"or empty to listen on every address")
		}
	}
	return nil
}

// ParseTURNServerRelayIP parses TURN_SERVER_RELAY_IP, the address the built-in
// relay's sockets bind and advertise. It has to be one IPv4 address of this
// host. The wildcard address binds, but it would be advertised to browsers as
// it is and reach nothing; a multicast or broadcast address is no place the
// SFU can be reached from either.
func ParseTURNServerRelayIP(value string) (net.IP, error) {
	ip := net.ParseIP(value).To4()
	if ip == nil {
		return nil, fmt.Errorf("TURN_SERVER_RELAY_IP must be a valid IPv4 address")
	}
	if ip.IsUnspecified() || ip.IsMulticast() || ip.Equal(net.IPv4bcast) {
		return nil, fmt.Errorf("TURN_SERVER_RELAY_IP must be one address of this host, " +
			"not the wildcard, a multicast or the broadcast address")
	}
	return ip, nil
}

// turnRotationOverlap is how long a browser keeps the TURN connections of a
// rotation it has moved away from: Chrome closes them about 90 seconds later.
const turnRotationOverlap = 90 * time.Second

// TURNAllocationsPerParticipant is how many relay allocations one participant
// holds at a time on a rotating TURN method with the given interval: the
// current one, and one for every rotation still inside the overlap. It is one
// when rotation is off (a zero interval).
func TURNAllocationsPerParticipant(rotateInterval time.Duration) int {
	if rotateInterval <= 0 {
		return 1
	}
	return int((turnRotationOverlap+rotateInterval-1)/rotateInterval) + 1
}

// TURNServerTLSEnabled reports whether the built-in relay serves TURN over
// TLS: it needs a port and both certificate files.
func (c Config) TURNServerTLSEnabled() bool {
	return c.TURNServerEnabled && c.TURNServerTLSPort != 0 &&
		c.TURNServerTLSCertFile != "" && c.TURNServerTLSKeyFile != ""
}

func (c Config) EffectiveMaxVideoQuality() string {
	if c.MaxVideoQuality == "" {
		return "ultra"
	}
	return c.MaxVideoQuality
}

// ServerTURNURLs returns the TURN URLs the SFU's own peer connections gather
// relay candidates from. Under a relay-only policy that is every TURN URL, as
// the SFU then has no other candidate. Under any other policy it is none when
// a browser's relay can reach the SFU's host candidates anyway: with a
// configured public address the server is directly reachable, and the built-in
// relay's sockets are on this host. Allocating its own relays on every ICE
// gathering, and so on every relay rotation, would then only load the TURN
// server, and on the built-in relay it would require relay sockets to reach
// each other. A server with neither, which may sit behind NAT with an
// external TURN server as its only way out, keeps the URLs.
func (c Config) ServerTURNURLs() []string {
	if c.ICETransportPolicy != "relay" && (c.ICEPublicIP != "" || c.TURNServerEnabled) {
		return nil
	}
	return c.EffectiveTURNURLs()
}

func (c Config) EffectiveTURNURLs() []string {
	if len(c.TURNURLs) > 0 {
		return append([]string(nil), c.TURNURLs...)
	}
	if c.TURNURL != "" {
		return []string{c.TURNURL}
	}
	return nil
}

func (c Config) EffectiveEnabledConnectionMethods() []string {
	if c.EnabledConnectionMethods != nil {
		methods := make([]string, len(c.EnabledConnectionMethods))
		copy(methods, c.EnabledConnectionMethods)
		return methods
	}
	return []string{"direct", "turn-udp", "turn-tcp", "turn-tls", "turn-tcp-rotate", "turn-tls-rotate"}
}

// RotatingConnectionMethodBase maps a rotating connection method to the TURN
// method whose URLs it uses, or returns "" for any other method. A rotating
// method is its base method plus periodic relay rotation in the browser.
func RotatingConnectionMethodBase(method string) string {
	switch method {
	case "turn-tcp-rotate":
		return "turn-tcp"
	case "turn-tls-rotate":
		return "turn-tls"
	}
	return ""
}

// TURNCredentials returns time-limited TURN REST API credentials when a shared
// secret is configured. The username carries the expiry timestamp and the
// password is its HMAC, the format the built-in relay and coturn's
// use-auth-secret mode both verify.
func (c Config) TURNCredentials(subject string, now time.Time) (string, string, bool) {
	if c.TURNSharedSecret == "" || c.TURNCredentialTTL <= 0 {
		return "", "", false
	}
	expiresAt := now.Add(c.TURNCredentialTTL).Unix()
	username := fmt.Sprintf("%d:%s", expiresAt, subject)
	mac := hmac.New(sha1.New, []byte(c.TURNSharedSecret))
	_, _ = mac.Write([]byte(username))
	return username, base64.StdEncoding.EncodeToString(mac.Sum(nil)), true
}

func videoQualityRank(quality string) int {
	switch quality {
	case "medium":
		return 1
	case "high":
		return 2
	case "very-good":
		return 3
	case "ultra":
		return 4
	default:
		return 0
	}
}

func (c Config) CheckMeetingPassword(candidate string) bool {
	if c.MeetingPassword == "" {
		return true
	}
	// Comparing SHA-256 digests keeps the check constant-time without
	// leaking the configured password's length through an early size test.
	return subtle.ConstantTimeCompare(digest(candidate), digest(c.MeetingPassword)) == 1
}

func digest(value string) []byte {
	sum := sha256.Sum256([]byte(value))
	return sum[:]
}

func envString(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) (int, error) {
	value := os.Getenv(key)
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer: %w", key, err)
	}
	return parsed, nil
}

func envBool(key string, fallback bool) (bool, error) {
	value := os.Getenv(key)
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s must be a boolean: %w", key, err)
	}
	return parsed, nil
}

func splitCSV(value string) []string {
	var values []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			values = append(values, item)
		}
	}
	return values
}
