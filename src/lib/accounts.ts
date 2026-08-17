/**
 * 账号体系：对用户只暴露「账号名」，内部仍然用 better-auth 的邮箱字段存。
 * 管理员发号时填的是账号名（admin、xiaoli…），落库时补成 name@clothdesign.local。
 * 早期用真实邮箱注册的账号仍然按邮箱登录，这里原样透传。
 */
export const INTERNAL_EMAIL_DOMAIN = "clothdesign.local";

export const usernamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/;

export function isUsername(value: string) {
  return usernamePattern.test(value.trim());
}

/** 登录框里既可以填账号名，也可以填老账号的邮箱。 */
export function loginIdentifierToEmail(value: string) {
  const trimmed = value.trim();
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  return `${trimmed.toLowerCase()}@${INTERNAL_EMAIL_DOMAIN}`;
}

/** 反过来：内部邮箱只显示账号名，真实邮箱原样显示。 */
export function emailToDisplayName(email?: string | null) {
  const value = String(email || "");
  if (!value) return "";
  return value.endsWith(`@${INTERNAL_EMAIL_DOMAIN}`) ? value.slice(0, -`@${INTERNAL_EMAIL_DOMAIN}`.length) : value;
}
