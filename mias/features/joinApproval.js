export function normalizeInviteCode(input = "") {
  return String(input).trim()
    .replace(/^https?:\/\/chat\.whatsapp\.com\//i, "")
    .replace(/[?#].*$/, "");
}

export function approvalPrompt(groupName) {
  return `This group needs admin approval. Ask an admin to approve your request to join ${groupName || "the group"}? Reply *yes* or *no*.`;
}

export function adminNumberList(admins = []) {
  return admins.map((jid, index) => `${index + 1}. ${String(jid).split("@")[0].split(":")[0]}`).join("\n");
}

export function parseAdminChoice(text, admins = []) {
  const index = Number.parseInt(String(text).trim(), 10) - 1;
  return Number.isInteger(index) && index >= 0 && index < admins.length ? admins[index] : null;
}