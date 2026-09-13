package web

import "embed"

// Files contains the frontend assets shipped with the SlowMeet binary.
//
//go:embed index.html admin.html css js
var Files embed.FS
