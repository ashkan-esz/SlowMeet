package web

import "embed"

// Files contains the frontend assets shipped with the LowMeet binary.
//
//go:embed index.html admin.html css js
var Files embed.FS
