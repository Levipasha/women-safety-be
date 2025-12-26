// Logging utility that sanitizes sensitive data

const sanitizeUserId = (userId) => {
  if (!userId) return 'unknown';
  const str = userId.toString();
  // Show first 8 chars only for logging purposes
  return str.length > 8 ? `${str.substring(0, 8)}...` : str;
};

const sanitizeAccountId = (accountId) => {
  if (!accountId) return 'unknown';
  // Show first 4 chars only
  return accountId.length > 4 ? `${accountId.substring(0, 4)}...` : accountId;
};

// Safe logger that sanitizes sensitive data
export const safeLog = {
  info: (message, data = {}) => {
    const sanitized = { ...data };
    if (sanitized.userId) sanitized.userId = sanitizeUserId(sanitized.userId);
    if (sanitized.accountId) sanitized.accountId = sanitizeAccountId(sanitized.accountId);
    if (sanitized.user) sanitized.user = { ...sanitized.user, _id: sanitizeUserId(sanitized.user._id) };
    console.log(message, Object.keys(sanitized).length > 0 ? sanitized : '');
  },
  error: (message, error) => {
    // Don't log full error objects that might contain sensitive data
    const safeError = error instanceof Error 
      ? { message: error.message, name: error.name }
      : error;
    console.error(message, safeError);
  },
  warn: (message, data = {}) => {
    const sanitized = { ...data };
    if (sanitized.userId) sanitized.userId = sanitizeUserId(sanitized.userId);
    if (sanitized.accountId) sanitized.accountId = sanitizeAccountId(sanitized.accountId);
    console.warn(message, Object.keys(sanitized).length > 0 ? sanitized : '');
  },
};

export { sanitizeUserId, sanitizeAccountId };

