local _ = require("gettext")
return {
    fullname = _("ReadSync"),
    description = _([[
Synchronizes your reading progress to a self-hosted ReadSync server.

Unlike the built-in progress sync, it authenticates with an access token
(created in ReadSync's web UI or via its CLI) instead of the MD5 of your
password, and it also reports reading time so the server can draw statistics.]]),
}
