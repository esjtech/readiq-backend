// One error shape for the whole API. The Android app shows `message`/`error`
// to the user, so both are human-readable; `code` is for machines.
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendError(res, err) {
  const status = err.status || 500;
  const message = err.status ? err.message : "Something went wrong on our side. Please try again.";
  if (!err.status) console.error(err);
  res.status(status).json({ success: false, error: message, message, code: err.code || "SERVER_ERROR" });
}

module.exports = { ApiError, sendError };
