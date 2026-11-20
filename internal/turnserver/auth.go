package turnserver

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/pion/stun/v4"
	"github.com/pion/turn/v5"
)

// newAuthHandler returns the credential check the TURN library runs on every
// authenticated request. It accepts what config.TURNCredentials issues: a
// username "<unix expiry>:<subject>" whose password is the base64 HMAC-SHA1 of
// that username under the shared secret. The handler only names the key such a
// request must be signed with; the library verifies the signature.
//
// The expiry limits when an allocation can be made, not how long it lives.
// The library runs this check again for every Refresh, CreatePermission and
// ChannelBind of an allocation; refusing an expired username there would cut
// each relayed call once its credential's lifetime is over, as a browser keeps
// the credential it joined with. Those requests reach only an allocation the
// same username made from the same client address, so they open nothing an
// expired credential could not already use.
func newAuthHandler(sharedSecret string, now func() time.Time, logger *slog.Logger) turn.AuthHandler {
	return func(request *turn.RequestAttributes) (string, []byte, bool) {
		expiry, _, _ := strings.Cut(request.Username, ":")
		expiresAt, err := strconv.ParseInt(expiry, 10, 64)
		if err != nil {
			logger.Debug("turn_server_credential_rejected", "reason", "username carries no expiry time",
				"remote", addrString(request.SrcAddr))
			return "", nil, false
		}
		if request.Method == stun.MethodAllocate && expiresAt < now().Unix() {
			logger.Debug("turn_server_credential_rejected", "reason", "expired",
				"expiry", expiresAt, "remote", addrString(request.SrcAddr))
			return "", nil, false
		}
		mac := hmac.New(sha1.New, []byte(sharedSecret))
		_, _ = mac.Write([]byte(request.Username))
		password := base64.StdEncoding.EncodeToString(mac.Sum(nil))
		// The whole username identifies the user, so an allocation answers only
		// to the credential that made it.
		return request.Username, turn.GenerateAuthKey(request.Username, request.Realm, password), true
	}
}
