/**
 * 账号名 ↔ 内部邮箱。与 src/lib/accounts.ts 保持同一套规则。
 * better-auth 的用户表以邮箱为唯一键，但界面上只让管理员填「账号名」，
 * 所以这里统一补成 name@clothdesign.local。
 */
export const INTERNAL_EMAIL_DOMAIN = "clothdesign.local";

const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/;

export function normalizeUsername(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return { error: "请填写账号名。" };
  if (value.includes("@")) return { error: "账号名不要带 @，直接写名字就行。" };
  if (!USERNAME_PATTERN.test(value)) {
    return { error: "账号名只能用 2-32 位字母、数字、下划线、点或连字符，且以字母或数字开头。" };
  }
  return { value };
}

export function usernameToEmail(username) {
  return `${username}@${INTERNAL_EMAIL_DOMAIN}`;
}

export function emailToUsername(email) {
  const value = String(email || "");
  if (!value) return "";
  const suffix = `@${INTERNAL_EMAIL_DOMAIN}`;
  return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
}
