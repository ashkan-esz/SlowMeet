package turnserver

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/pion/logging"
)

// pionLoggerFactory routes the TURN library's log output into slog at debug
// level. The relay's ports face the internet, and the library reports every
// malformed datagram and failed authentication as an error; at the default log
// level that is noise an operator cannot act on. LOG_LEVEL=debug shows it.
//
// The library's own trace and debug messages are dropped: several are emitted
// per relayed packet.
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
