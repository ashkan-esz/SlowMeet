package web

import "embed"

// Files contains the frontend assets shipped with the SlowMeet binary.
//
//go:embed index.html admin.html favicon.svg css js
var Files embed.FS
