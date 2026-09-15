// Shared by ingestion and retrieval: old evidence must not bypass output redaction.
export function redactSecrets(value) {
  return String(value ?? "")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/((?:password|passwd|api[_-]?key|access[_-]?token|secret|authorization|cookie)\s*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;，。；]+)/gi, "$1[REDACTED]")
    .replace(/((?:密码|口令|密钥|令牌)\s*(?:是|为|[:：=])\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[A-Za-z0-9_+/@!#$%^&*().=?:-]+)/g, "$1[REDACTED]")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[REDACTED]@");
}
