// Copied from crab-office (hooks/embassy/guard.ts): what must never leave in a post.
const SECRETS: [string, RegExp][] = [
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["API key", /sk-[A-Za-z0-9]{32,}/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,}/],
  ["Slack token", /xox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["Stripe key", /[sr]k_live_[0-9a-zA-Z]{20,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["JWT", /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/],
  ["password or token", /(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{8,}/i],
  ["password in a connection string", /[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i],
]

export function secretsIn(text: string): string[] {
  return SECRETS.filter(([, re]) => re.test(text)).map(([name]) => name)
}
