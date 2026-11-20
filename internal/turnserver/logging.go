package turnserver

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"sync/atomic"
	"time"

	"github.com/pion/logging"
)

// pionLoggerFactory routes the TURN library's log output into slog at debug
// level. The relay's ports face the internet, and the library reports every
// malformed datagram and failed authentication as an error; at the default log
// level that is noise an operator cannot act on. LOG_LEVEL=debug shows it.
//
// The library's own trace and debug messages are dropped: several are emitted
// per relayed packet. One of them is its only report of a request it could not
// serve; logRequestFailure takes that over.
type pionLoggerFactory struct {
	logger *slog.Logger
}

func (f pionLoggerFactory) NewLogger(scope string) logging.LeveledLogger {
	return pionLogger{logger: f.logger, scope: scope}
}

type pionLogger struct {
	logger *slog.Logger
	scope  string
}

func (l pionLogger) enabled() bool {
	return l.logger.Enabled(context.Background(), slog.LevelDebug)
}

func (l pionLogger) write(level, message string) {
	if l.enabled() {
		l.logger.Debug("turn_server_library", "scope", l.scope, "level", level, "message", message)
	}
}

func (l pionLogger) writef(level, format string, args ...any) {
	if l.enabled() {
		l.logger.Debug("turn_server_library", "scope", l.scope, "level", level,
			"message", fmt.Sprintf(format, args...))
	}
}

func (pionLogger) Trace(string)          {}
func (pionLogger) Tracef(string, ...any) {}
func (pionLogger) Debug(string)          {}
func (pionLogger) Debugf(string, ...any) {}

func (l pionLogger) Info(message string)               { l.write("info", message) }
func (l pionLogger) Infof(format string, args ...any)  { l.writef("info", format, args...) }
func (l pionLogger) Warn(message string)               { l.write("warn", message) }
func (l pionLogger) Warnf(format string, args ...any)  { l.writef("warn", format, args...) }
func (l pionLogger) Error(message string)              { l.write("error", message) }
func (l pionLogger) Errorf(format string, args ...any) { l.writef("error", format, args...) }

// logRequestFailure returns the TURN library's callback for a request it
// could not serve: a malformed packet, a failed integrity check, a credential
// the relay rejects, an allocation it has no port for. Like the rest of what
// the internet sends the relay's ports, these are logged at debug level.
func logRequestFailure(logger *slog.Logger) func(source, destination net.Addr, protocol, message string) {
	// The library passes "UDP" as the protocol whatever the client's transport
	// is, so the local address is logged instead: it names the listener.
	return func(source, destination net.Addr, _, message string) {
		if !logger.Enabled(context.Background(), slog.LevelDebug) {
			return
		}
		logger.Debug("turn_server_request_failed",
			"remote", addrString(source), "local", addrString(destination), "error", message)
	}
}

func addrString(address net.Addr) string {
	if address == nil {
		return ""
	}
	return address.String()
}

// repeatedWarningInterval is how often a warning about a condition that can
// recur with every request (a full listener, a full relay port range) is
// logged while the condition lasts.
const repeatedWarningInterval = time.Minute

// warningGate lets such a warning through once per repeatedWarningInterval.
// The zero value is ready to use and lets the first one through.
type warningGate struct {
	// last is when a warning last passed, in Unix nanoseconds; zero if never.
	last atomic.Int64
}

// open reports whether a warning may be logged at now, and records that it
// was. Of several concurrent callers one gets true.
func (g *warningGate) open(now time.Time) bool {
	last := g.last.Load()
	if last != 0 && now.UnixNano()-last < int64(repeatedWarningInterval) {
		return false
	}
	return g.last.CompareAndSwap(last, now.UnixNano())
}
